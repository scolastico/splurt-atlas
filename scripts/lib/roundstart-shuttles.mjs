// Place fixed roundstart escape pods using the same mobile/stationary port
// alignment and clockwise quarter turns as shuttle docking. No round traits
// or random template choices are simulated.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseDmm } from './dmm.mjs';
import { unquote } from './dm.mjs';

const angles = { 1: 0, 4: 1, 2: 2, 8: 3 };
const vectors = { 1: [0, 1], 2: [0, -1], 4: [1, 0], 8: [-1, 0] };
const mobilePort = (atom) => /^\/obj\/docking_port\/mobile(?:\/|$)/.test(atom.path);
const stationaryPort = (atom) => /^\/obj\/docking_port\/stationary(?:\/|$)/.test(atom.path);

function rotate(x, y, turns) {
  for (let i = 0; i < turns; i++) [x, y] = [y, -x];
  return [x, y];
}

function rotateAtom(atom, turns, db) {
  if (!turns || atom.path.startsWith('/area/')) return atom;
  const vars = { ...db.resolve(atom.path), ...atom.vars };
  const literal = (value) => (db.literal ? db.literal(String(value)) : value);
  let dir = 0;
  const original = Number(literal(vars.dir || 2));
  for (const [bit, vector] of Object.entries(vectors)) {
    if (!(original & Number(bit))) continue;
    const [x, y] = rotate(...vector, turns);
    dir |= x > 0 ? 4 : x < 0 ? 8 : y > 0 ? 1 : 2;
  }
  const [pixelX, pixelY] = rotate(
    Number(literal(vars.pixel_x || 0)),
    Number(literal(vars.pixel_y || 0)),
    turns,
  );
  return {
    ...atom,
    vars: { ...atom.vars, dir: String(dir), pixel_x: String(pixelX), pixel_y: String(pixelY) },
  };
}

/** Mutates only the parsed map. Returns template files for source links and invalidation. */
export function placeRoundstartShuttles(map, root, db) {
  const files = new Set();
  const templates = new Map();
  const spatial = new Map(map.cells.map((cell) => [`${cell.x},${cell.y},${cell.z}`, cell]));
  const docks = map.cells.flatMap((cell) =>
    map.dictionary
      .get(cell.key)
      .filter((atom) => /^\/obj\/docking_port\/stationary\/escape_pod(?:\/|$)/.test(atom.path))
      .map((atom) => ({ cell, atom })),
  );
  for (const [index, { cell: dock, atom: port }] of docks.entries()) {
    const vars = { ...db.resolve(port.path), ...port.vars };
    // json_key takes precedence at runtime; unresolved/dynamic choices are not fixed templates.
    if (vars.json_key && vars.json_key !== 'null') continue;
    const type = vars.roundstart_template;
    if (!type?.startsWith('/datum/map_template/shuttle/')) continue;
    const templateVars = db.resolve(type);
    const prefix = unquote(templateVars.prefix || '"_maps/shuttles/"');
    const id = `${unquote(templateVars.port_id)}_${unquote(templateVars.suffix)}`;
    if (!/^[\w-]+$/.test(id)) continue;
    const file = `${prefix}${id}.dmm`;
    const absolute = path.resolve(root, file);
    if (!absolute.startsWith(path.resolve(root) + path.sep))
      throw new Error(`Unsafe shuttle template: ${file}`);
    if (!templates.has(file)) templates.set(file, parseDmm(readFileSync(absolute, 'utf8')));
    const template = templates.get(file);
    const anchor = template.cells.find((cell) => template.dictionary.get(cell.key).some(mobilePort));
    if (!anchor || template.levels.length !== 1) continue;
    const mobile = template.dictionary.get(anchor.key).find(mobilePort);
    const mobileVars = { ...db.resolve(mobile.path), ...mobile.vars };
    const literal = (value) => (db.literal ? db.literal(String(value)) : value);
    const from = angles[Number(literal(mobileVars.dir || 2))];
    const to = angles[Number(literal(vars.dir || 2))];
    if (from === undefined || to === undefined) continue;
    const turns = (to - from + 4) % 4;
    const placements = template.cells.flatMap((cell) => {
      const atoms = template.dictionary.get(cell.key);
      // Space/no-op cells around a shuttle do not replace the destination.
      if (
        !atoms.some((atom) => atom.path.startsWith('/area/shuttle/')) ||
        atoms.some((atom) => /\/template_noop(?:\/|$)/.test(atom.path))
      )
        return [];
      const [dx, dy] = rotate(cell.x - anchor.x, cell.y - anchor.y, turns);
      return [{ x: dock.x + dx, y: dock.y + dy, z: dock.z, atoms, sourceKey: cell.key }];
    });
    if (placements.some(({ x, y }) => x < 1 || x > map.width || y < 1 || y > map.height)) continue;
    for (const { x, y, z, atoms, sourceKey } of placements) {
      const key = `roundstart:${index}:${sourceKey}`;
      const location = `${x},${y},${z}`;
      const existing = spatial.get(location);
      const stationary = existing ? map.dictionary.get(existing.key).filter(stationaryPort) : [];
      // Dock definitions can carry per-port overrides, so keep them in the tile key.
      const tileKey = stationary.length ? `${key}:${x},${y}` : key;
      map.dictionary.set(tileKey, [...stationary, ...atoms.map((atom) => rotateAtom(atom, turns, db))]);
      if (existing) existing.key = tileKey;
      else {
        const cell = { x, y, z, key: tileKey };
        map.cells.push(cell);
        spatial.set(location, cell);
      }
    }
    files.add(file);
  }
  return [...files];
}
