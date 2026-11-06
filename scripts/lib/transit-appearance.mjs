const directionValues = {
  NORTH: 1,
  SOUTH: 2,
  EAST: 4,
  WEST: 8,
  NORTHEAST: 5,
  NORTHWEST: 9,
  SOUTHEAST: 6,
  SOUTHWEST: 10,
};
const tables = new WeakMap();
export function transitOverlays(atom, db) {
  if (!/^\/obj\/structure\/transit_tube(?:\/|$)/.test(atom.path)) return [];
  if (!tables.has(db)) {
    const methods = new Map();
    for (const [, text] of db.files || [])
      if (text.includes('/obj/structure/transit_tube'))
        for (const method of text.matchAll(
          /^(\/obj\/structure\/transit_tube[\w/]*)\/init_tube_dirs\(\)([\s\S]*?)(?=^\/|$(?![\s\S]))/gm,
        )) {
          const cases = new Map();
          for (const match of method[2].matchAll(
            /if\((NORTH|SOUTH|EAST|WEST)\)\s*\n\s*tube_dirs\s*=\s*list\(([^)]+)\)/g,
          ))
            cases.set(
              directionValues[match[1]],
              match[2]
                .split(',')
                .map((value) => directionValues[value.trim()])
                .filter(Boolean),
            );
          if (cases.size) methods.set(method[1], cases);
        }
    tables.set(db, methods);
  }
  const vars = { ...db.resolve(atom.path), ...atom.vars },
    dir = Number(vars.dir) || directionValues[vars.dir] || 2;
  let path = atom.path,
    directions = [];
  while (path) {
    const found = tables.get(db).get(path)?.get(dir);
    if (found) {
      directions = found;
      break;
    }
    path = path.slice(0, path.lastIndexOf('/'));
  }
  const overlay = (state, direction, x = 0, y = 0) => ({
    path: atom.path,
    vars: {
      ...atom.vars,
      icon_state: JSON.stringify(state),
      dir: String(direction),
      pixel_w: String((Number(vars.pixel_w) || 0) + x),
      pixel_z: String((Number(vars.pixel_z) || 0) + y),
    },
  });
  return directions.flatMap((direction) => {
    if ([1, 2, 4, 8].includes(direction)) return [overlay('decorative', direction)];
    if (!(direction & 1)) return [];
    return [
      overlay('decorative_diag', direction ^ 3, 0, 32),
      overlay('decorative_diag', direction ^ 12, direction & 4 ? 32 : -32, 0),
    ];
  });
}
