// Deterministic map-load structures and ordinary bitmask smoothing can be
// resolved statically. Arbitrary Initialize()/update_appearance() code cannot.
import { transitOverlays } from './transit-appearance.mjs';
import { unquote } from './dm.mjs';

/** Reconstruct the static door and status overlays used by closet_update_overlays. */
export function closetOverlays(atom, db) {
  if (!/^\/obj\/structure\/closet(?:\/|$)/.test(atom.path)) return [];
  // Crates override closet_update_overlays and carry their lid in the base sprite.
  if (/^\/obj\/structure\/closet\/crate(?:\/|$)/.test(atom.path)) return [];
  const vars = { ...db.resolve(atom.path), ...atom.vars };
  const flag = (key) => ['TRUE', '1'].includes(String(db.literal ? db.literal(vars[key]) : vars[key]));
  const base = unquote(
    vars.base_icon_state && vars.base_icon_state !== 'null' ? vars.base_icon_state : vars.icon_state,
  );
  const states = [];
  if (flag('enable_door_overlay')) {
    if (flag('opened') && flag('has_opened_overlay')) states.push(`${base}_open`);
    else if (flag('has_closed_overlay'))
      states.push(`${unquote(vars.icon_door && vars.icon_door !== 'null' ? vars.icon_door : base)}_door`);
  }
  if (!flag('opened')) {
    if (flag('welded') && vars.icon_welded) states.push(unquote(vars.icon_welded));
    if (flag('broken') && flag('secure')) states.push(unquote(vars.icon_broken));
    else if (!flag('broken') && flag('secure')) states.push(flag('locked') ? 'locked' : 'unlocked');
  }
  return states
    .filter((state) => !db.hasIconState || db.hasIconState(unquote(vars.icon), state))
    .map((state) => ({ ...atom, vars: { ...atom.vars, icon_state: JSON.stringify(state) } }));
}

/** A stable visual example of the same trash-pile pool used by Initialize. */
export function randomiseTrash(atoms, x, y, z, db) {
  const states = [
    'pile1',
    'pile2',
    'pilechair',
    'piletable',
    'pilevending',
    'brtrashpile',
    'microwavepile',
    'rackpile',
    'boxfort',
    'trashbag',
    'brokecomp',
  ];
  return atoms.map((atom) => {
    if (!/^\/obj\/structure\/trash_pile(?:\/|$)/.test(atom.path)) return atom;
    const vars = { ...db.resolve(atom.path), ...atom.vars };
    if (unquote(vars.icon_state) !== 'randompile') return atom;
    const seed = ((x * 73856093) ^ (y * 19349663) ^ (z * 83492791)) >>> 0;
    return { ...atom, vars: { ...atom.vars, icon_state: JSON.stringify(states[seed % states.length]) } };
  });
}
export function expandStructures(atoms, db, depth = 0) {
  if (depth > 8) return atoms;
  return atoms.flatMap((atom) => {
    const vars = { ...db.resolve(atom.path), ...atom.vars };
    if (/^\/obj\/machinery\/duct(?:\/|$)/.test(atom.path)) {
      const literal = (value) => (db.literal ? db.literal(value) : value);
      const color = literal(vars.duct_color || vars.color || ''),
        raw = String(literal(vars.duct_layer || '4')),
        shift = raw.match(/1\s*<<\s*(\d+)/),
        layer = shift ? 2 ** Number(shift[1]) : Number(raw),
        offset = [1, 2, 4, 8, 16].includes(layer) ? (Math.log2(layer) - 2) * 5 : 0;
      return [{ ...atom, vars: { ...atom.vars, color, pixel_x: String(offset), pixel_y: String(offset) } }];
    }
    if (/^\/obj\/structure\/reflector(?:\/|$)/.test(atom.path)) {
      const base = { ...atom, vars: { ...atom.vars, icon_state: '"reflector_base"', dir: '1' } };
      if (!vars.deflector_icon_state) return [base];
      const angle = Number(vars.rotation_angle),
        rotation =
          Number.isFinite(angle) && angle !== -1
            ? angle
            : { 1: 0, 2: 180, 4: 90, 8: 270, 5: 45, 6: 135, 9: 315, 10: 225 }[Number(vars.dir) || 2] || 0;
      return [
        base,
        {
          ...atom,
          vars: {
            ...atom.vars,
            dir: '1',
            icon_state: vars.deflector_icon_state,
            atlas_rotation: String(rotation),
          },
        },
      ];
    }
    if (atom.path.startsWith('/obj/effect/spawner/structure/')) {
      const paths = vars.spawn_list?.match(/\/obj\/[\w/]+/g);
      if (paths?.length)
        return expandStructures(
          paths.map((path) => ({ path, vars: {} })),
          db,
          depth + 1,
        );
    }
    if (
      /\/window\/.*spawner\/directional\//.test(atom.path) ||
      /\/window\/spawner\/directional\//.test(atom.path)
    ) {
      const parent = atom.path.slice(0, atom.path.indexOf('/spawner/'));
      const directions = { north: '1', south: '2', east: '4', west: '8' };
      return [{ path: parent, vars: { ...atom.vars, dir: directions[atom.path.split('/').at(-1)] || '2' } }];
    }
    return [atom, ...transitOverlays(atom, db), ...closetOverlays(atom, db)];
  });
}

const directions = [
  [0, 1, 1],
  [0, -1, 2],
  [1, 0, 4],
  [-1, 0, 8],
  [1, 1, 16, 5],
  [1, -1, 32, 6],
  [-1, -1, 64, 10],
  [-1, 1, 128, 9],
];
export function smoothAtoms(atoms, x, y, z, at, db) {
  return atoms.map((atom) => {
    const vars = { ...db.resolve(atom.path), ...atom.vars };
    if (
      !vars.smoothing_flags?.includes('SMOOTH_BITMASK') ||
      vars.smoothing_flags.includes('SMOOTH_BORDER_OBJECT') ||
      !/^".+"$/.test(vars.base_icon_state || vars.icon_state || '')
    )
      return atom;
    const compatible = (vars.canSmoothWith || '').match(/SMOOTH_GROUP_\w+/g) || [];
    let mask = 0;
    for (const [dx, dy, bit, required] of directions) {
      if (
        required &&
        ((mask & required) !== required || vars.smoothing_flags.includes('SMOOTH_BITMASK_CARDINALS'))
      )
        continue;
      const neighbors = at(x + dx, y + dy, z);
      const join = neighbors?.some((other) => {
        const v = { ...db.resolve(other.path), ...other.vars };
        const groups = (v.smoothing_groups || '').match(/SMOOTH_GROUP_\w+/g) || [];
        return compatible.length
          ? compatible.some((group) => groups.includes(group))
          : other.path === atom.path;
      });
      if (join) mask |= bit;
    }
    const base = (vars.base_icon_state || vars.icon_state).replace(/^"|"$/g, '').replace(/-0$/, '');
    const icon = (vars.icon || '').replace(/^'|'$/g, '');
    if (db.hasIconState && !db.hasIconState(icon, `${base}-${mask}`)) return atom;
    return { ...atom, vars: { ...atom.vars, icon_state: `"${base}-${mask}"` } };
  });
}
// Random posters pick a real poster at map load (/obj/structure/sign/poster/randomise),
// so the mapped placeholder sprite never appears in the game. The pick is
// deterministic per tile so incremental exports and shared links stay stable.
const posterPools = new WeakMap();
export function randomisePosters(atoms, x, y, z, db) {
  return atoms.map((atom) => {
    if (!/^\/obj\/structure\/sign\/poster(?:\/|$)/.test(atom.path)) return atom;
    const vars = { ...db.resolve(atom.path), ...atom.vars };
    if (!vars.random_basetype) return atom;
    const pool = posterPool(db, vars.random_basetype, vars.blacklisted_types);
    if (!pool.length) return atom;
    const chosen = db.resolve(pool[(((x * 73856093) ^ (y * 19349663) ^ (z * 83492791)) >>> 0) % pool.length]);
    return { ...atom, vars: { ...atom.vars, icon: chosen.icon, icon_state: chosen.icon_state } };
  });
}
function posterPool(db, base, blacklist) {
  if (!posterPools.has(db)) posterPools.set(db, new Map());
  const cache = posterPools.get(db),
    key = `${base}|${blacklist || ''}`;
  if (cache.has(key)) return cache.get(key);
  const literal = (value) => String(db.literal ? db.literal(String(value ?? '')) : (value ?? '')),
    flag = (value) => ['TRUE', '1'].includes(literal(value)),
    shifted = (value) => Number(literal(value || '0')) !== 0;
  const banned = [...String(blacklist || '').matchAll(/\/obj\/[\w/]+/g)].map((match) => match[0]);
  // Same rules as the game: an icon state, not banned from the pool, and not pixel shifted (excludes directional helpers).
  const pool = [...db.types.keys()]
    .filter(
      (type) =>
        type.startsWith(`${base}/`) && !banned.some((ban) => type === ban || type.startsWith(`${ban}/`)),
    )
    .filter((type) => {
      const v = db.resolve(type);
      return v.icon_state && !flag(v.never_random) && !shifted(v.pixel_x) && !shifted(v.pixel_y);
    })
    .sort();
  cache.set(key, pool);
  return pool;
}
