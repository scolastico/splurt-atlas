// Search records: placed items, the candidates of random spawners, and one
// anchor point per room and deck.
import { pretty, unquote } from './dm.mjs';

/** Spawners nested deeper than this are not followed. */
const MAX_SPAWNER_DEPTH = 12;

/**
 * The object paths a random spawner may produce, following literal
 * `loot = list(...)` paths, nested spawners and the maintenance pools.
 */
export function spawnCandidates(db, type, vars, seen = new Set()) {
  if (seen.has(type) || seen.size > MAX_SPAWNER_DEPTH) return [];
  seen.add(type);
  let paths = vars.loot?.match(/\/(?:obj|mob)\/[\w/]+/g) || [];
  if (type.includes('/spawner/random/maintenance'))
    paths = [
      ...paths,
      ...db.pool(vars.loot_table?.includes('DUMPSTER') ? 'dumpster_loot' : 'maintenance_loot'),
    ];
  const expanded = paths.flatMap((candidate) =>
    candidate.includes('/spawner/')
      ? spawnCandidates(db, candidate, db.resolve(candidate), new Set(seen))
      : [candidate],
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
