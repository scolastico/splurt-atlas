const tables = new WeakMap(),
  values = { NORTH: 1, SOUTH: 2, EAST: 4, WEST: 8 };
export function atmosPorts(path, vars, db, parse) {
  if (!tables.has(db)) {
    const methods = new Map();
    for (const [, text] of db.files || [])
      if (text.includes('/set_init_directions('))
        for (const method of text.matchAll(
          /^(\/obj\/machinery\/atmospherics[\w/]*)\/set_init_directions\([^)]*\)([\s\S]*?)(?=^\/|$(?![\s\S]))/gm,
        )) {
          const directions = new Map();
          for (const match of method[2].matchAll(
            /if\(((?:(?:NORTH|SOUTH|EAST|WEST)\s*,?\s*)+)\)\s*\n\s*initialize_directions\s*=\s*([A-Z_| ()]+)/g,
          ))
            for (const direction of match[1].split(','))
              directions.set(values[direction.trim()], parse(match[2], 15));
          if (directions.size) methods.set(method[1], directions);
        }
    tables.set(db, methods);
  }
  const dir = parse(vars.dir, 2);
  let parent = path;
  while (parent) {
    const ports = tables.get(db).get(parent)?.get(dir);
    if (ports !== undefined) return ports;
    parent = parent.slice(0, parent.lastIndexOf('/'));
  }
  if (path.includes('/components/unary/')) return dir;
  if (path.includes('/components/binary/')) return [1, 2].includes(dir) ? 3 : 12;
  if (path.includes('/pipe/bridge_pipe')) return [1, 2].includes(dir) ? 3 : 12;
  return parse(vars.initialize_directions, 15);
}
