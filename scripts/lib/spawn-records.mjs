// Search records: placed items, the candidates of random spawners, and one
// anchor point per room and deck.
import { pretty, unquote } from './dm.mjs';

/** Spawners nested deeper than this are not followed. */
const MAX_SPAWNER_DEPTH = 12;
const closetMethods = new WeakMap();
const subtypePools = new WeakMap();

function subtypePool(db, base, includeBase) {
  if (!subtypePools.has(db)) subtypePools.set(db, new Map());
  const cache = subtypePools.get(db),
    key = `${base}:${includeBase}`;
  if (!cache.has(key))
    cache.set(key, [
      ...(includeBase ? [base] : []),
      ...[...(db.types?.keys() || [])].filter((type) => type.startsWith(base + '/')),
    ]);
  return cache.get(key);
}

/** Literal item constructions inside population methods, including conditional contents.
 * These are candidates, since conditions and random rolls are not executed. */
export function closetCandidates(db, type, seen = new Set(), overrides = {}) {
  if (!/^\/obj\/structure\/closet(?:\/|$)/.test(type) || seen.has(type)) return [];
  seen.add(type);
  if (!closetMethods.has(db)) {
    const methods = new Map();
    for (const [, text] of db.files || [])
      for (const match of text.matchAll(
        /^(\/obj\/structure\/closet[\w/]*?)\/(?:proc\/)?(PopulateContents|populate_contents_immediate)\([^\n]*\)\s*\n([\s\S]*?)(?=^\/|^(?![\t \r\n])\S|(?![\s\S]))/gm,
      )) {
        const key = `${match[1]}:${match[2]}`;
        methods.set(key, [...(methods.get(key) || []), match[3]]);
      }
    closetMethods.set(db, methods);
  }
  const methods = closetMethods.get(db);
  const collect = (path, method, visited = new Set()) => {
    if (!path || visited.has(path)) return [];
    visited.add(path);
    const bodies = methods.get(`${path}:${method}`);
    const parent = db.types?.get(path)?.vars?.parent_type || path.slice(0, path.lastIndexOf('/'));
    const inherited =
      !bodies || bodies.some((body) => /\.\.\(/.test(body)) ? collect(parent, method, visited) : [];
    return [
      ...inherited,
      ...(bodies || []).flatMap((body) =>
        [...body.matchAll(/\bnew\s+(\/obj\/[\w/]+)\s*\(\s*src\b/g)].map((match) => match[1]),
      ),
    ];
  };
  const vars = { ...db.resolve(type), ...overrides };
  const declared = vars.possible_loot?.match(/\/(?:obj|mob)\/[\w/]+/g) || [];
  return [
    ...new Set([
      ...collect(type, 'PopulateContents'),
      ...collect(type, 'populate_contents_immediate'),
      ...declared,
    ]),
  ].flatMap((path) =>
    path.includes('/spawner/') ? spawnCandidates(db, path, db.resolve(path), new Set(seen)) : [path],
  );
}

/**
 * The object paths a random spawner may produce, following literal
 * `loot = list(...)` paths, nested spawners and the maintenance pools.
 */
export function spawnCandidates(db, type, vars, seen = new Set()) {
  if (seen.has(type) || seen.size > MAX_SPAWNER_DEPTH) return [];
  seen.add(type);
  let paths = vars.loot?.match(/\/(?:obj|mob)\/[\w/]+/g) || [];
  for (const [property, includeBase] of [
    ['loot_type_path', true],
    ['loot_subtype_path', false],
  ]) {
    const base = db.literal ? db.literal(vars[property] || '') : vars[property];
    if (/^\/(obj|mob)\//.test(base || '')) paths = [...paths, ...subtypePool(db, base, includeBase)];
  }
  if (type.includes('/spawner/random/maintenance'))
    paths = [
      ...paths,
      ...db.pool(vars.loot_table?.includes('DUMPSTER') ? 'dumpster_loot' : 'maintenance_loot'),
    ];
  if (/\/closet_empty\/crate\/with_loot(?:\/|$)/.test(type))
    paths = [...paths, ...db.pool('maintenance_loot')];
  const expanded = paths.flatMap((candidate) =>
    candidate.includes('/spawner/')
      ? spawnCandidates(db, candidate, db.resolve(candidate), new Set(seen))
      : [candidate, ...closetCandidates(db, candidate, new Set(seen))],
  );
  return [...new Set(expanded)];
}

/**
 * The loot records of one tile definition: placed items and the possible
 * results of its spawners. Spawners without any candidate are reported.
 */
export function tileLoot(db, atoms, unresolved) {
  const loot = [];
  for (const atom of atoms) {
    const vars = { ...db.resolve(atom.path), ...atom.vars };
    if (atom.path.startsWith('/obj/item/'))
      loot.push({ path: atom.path, name: unquote(vars.name) || pretty(atom.path), kind: 'placed' });
    for (const candidate of closetCandidates(db, atom.path, new Set(), atom.vars))
      loot.push({
        path: candidate,
        name: unquote(db.resolve(candidate).name) || pretty(candidate),
        kind: 'possible',
        spawner: atom.path,
      });
    if (atom.path.includes('/spawner/') || atom.path.includes('/random')) {
      const possible = spawnCandidates(db, atom.path, vars);
      if (!possible.length) unresolved.push(atom.path);
      for (const candidate of possible)
        loot.push({
          path: candidate,
          name: unquote(db.resolve(candidate).name) || pretty(candidate),
          kind: 'possible',
          spawner: atom.path,
        });
    }
  }
  return loot;
}

/**
 * Groups identical loot records across the map and attaches every location
 * as flat x, y, z triples. Shared records avoid duplicating large maintenance
 * pools for every tile.
 */
export function buildSearchItems(cells, lootByKey) {
  const records = [];
  const recordIds = new Map();
  const locations = new Map();
  for (const cell of cells)
    for (const item of lootByKey.get(cell.key)) {
      const identity = JSON.stringify(item);
      let id = recordIds.get(identity);
      if (id === undefined) {
        id = records.length;
        recordIds.set(identity, id);
        records.push(item);
      }
      let points = locations.get(id);
      if (!points) locations.set(id, (points = []));
      points.push(cell.x, cell.y, cell.z);
    }
  const items = [];
  for (const [id, points] of locations) items.push({ ...records[id], points });
  return items;
}

/** One anchor tile per area and deck: the tile nearest the area's centroid. */
export function buildRooms(areas, cells, areaOfCell, levels) {
  const cellsByRoom = new Map();
  for (const cell of cells) {
    const key = `${areaOfCell(cell)}:${cell.z}`;
    let group = cellsByRoom.get(key);
    if (!group) cellsByRoom.set(key, (group = []));
    group.push(cell);
  }
  return areas
    .map((area, areaId) => {
      const points = [];
      for (const z of levels) {
        const group = cellsByRoom.get(`${areaId}:${z}`);
        if (!group?.length) continue;
        const centerX = group.reduce((sum, cell) => sum + cell.x, 0) / group.length;
        const centerY = group.reduce((sum, cell) => sum + cell.y, 0) / group.length;
        const nearest = group.reduce((best, cell) =>
          Math.hypot(cell.x - centerX, cell.y - centerY) < Math.hypot(best.x - centerX, best.y - centerY)
            ? cell
            : best,
        );
        points.push(nearest.x, nearest.y, z);
      }
      return { ...area, points };
    })
    .filter((room) => room.points.length);
}
