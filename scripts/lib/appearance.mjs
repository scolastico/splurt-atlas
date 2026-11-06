// Deterministic map-load structures and ordinary bitmask smoothing can be
// resolved statically. Arbitrary Initialize()/update_appearance() code cannot.
import {transitOverlays} from './transit-appearance.mjs';
export function expandStructures(atoms, db, depth = 0) {
  if (depth > 8) return atoms;
  return atoms.flatMap(atom => {
    const vars = { ...db.resolve(atom.path), ...atom.vars };
    if(/^\/obj\/machinery\/duct(?:\/|$)/.test(atom.path)){
      const literal=value=>db.literal?db.literal(value):value;
      const color=literal(vars.duct_color||vars.color||''),raw=String(literal(vars.duct_layer||'4')),shift=raw.match(/1\s*<<\s*(\d+)/),layer=shift?2**Number(shift[1]):Number(raw),offset=[1,2,4,8,16].includes(layer)?(Math.log2(layer)-2)*5:0;
      return[{...atom,vars:{...atom.vars,color,pixel_x:String(offset),pixel_y:String(offset)}}];
    }
    if(/^\/obj\/structure\/reflector(?:\/|$)/.test(atom.path)){
      const base={...atom,vars:{...atom.vars,icon_state:'"reflector_base"',dir:'1'}};
      if(!vars.deflector_icon_state)return[base];
      const angle=Number(vars.rotation_angle),rotation=Number.isFinite(angle)&&angle!==-1?angle:({1:0,2:180,4:90,8:270,5:45,6:135,9:315,10:225}[Number(vars.dir)||2]||0);
      return[base,{...atom,vars:{...atom.vars,dir:'1',icon_state:vars.deflector_icon_state,atlas_rotation:String(rotation)}}];
    }
    if (atom.path.startsWith('/obj/effect/spawner/structure/')) {
      const paths = vars.spawn_list?.match(/\/obj\/[\w/]+/g);
      if (paths?.length) return expandStructures(paths.map(path => ({ path, vars: {} })), db, depth + 1);
    }
    if (/\/window\/.*spawner\/directional\//.test(atom.path) || /\/window\/spawner\/directional\//.test(atom.path)) {
      const parent = atom.path.slice(0, atom.path.indexOf('/spawner/'));
      const directions = { north: '1', south: '2', east: '4', west: '8' };
      return [{ path: parent, vars: { ...atom.vars, dir: directions[atom.path.split('/').at(-1)] || '2' } }];
    }
    return [atom,...transitOverlays(atom,db)];
  });
}

const directions = [[0, 1, 1], [0, -1, 2], [1, 0, 4], [-1, 0, 8], [1, 1, 16, 5], [1, -1, 32, 6], [-1, -1, 64, 10], [-1, 1, 128, 9]];
export function smoothAtoms(atoms, x, y, z, at, db) {
  return atoms.map(atom => {
    const vars = { ...db.resolve(atom.path), ...atom.vars };
    if (!vars.smoothing_flags?.includes('SMOOTH_BITMASK') || vars.smoothing_flags.includes('SMOOTH_BORDER_OBJECT') || !/^".+"$/.test(vars.base_icon_state || vars.icon_state || '')) return atom;
    const compatible = (vars.canSmoothWith || '').match(/SMOOTH_GROUP_\w+/g) || [];
    let mask = 0;
    for (const [dx, dy, bit, required] of directions) {
      if (required && ((mask & required) !== required || vars.smoothing_flags.includes('SMOOTH_BITMASK_CARDINALS'))) continue;
      const neighbors = at(x + dx, y + dy, z);
      const join = neighbors?.some(other => {
        const v = { ...db.resolve(other.path), ...other.vars };
        const groups = (v.smoothing_groups || '').match(/SMOOTH_GROUP_\w+/g) || [];
        return compatible.length ? compatible.some(group => groups.includes(group)) : other.path === atom.path;
      });
      if (join) mask |= bit;
    }
    const base = (vars.base_icon_state || vars.icon_state).replace(/^"|"$/g, '').replace(/-0$/, '');
    const icon = (vars.icon || '').replace(/^'|'$/g, '');
    if (db.hasIconState && !db.hasIconState(icon, `${base}-${mask}`)) return atom;
    return { ...atom, vars: { ...atom.vars, icon_state: `"${base}-${mask}"` } };
  });
}
