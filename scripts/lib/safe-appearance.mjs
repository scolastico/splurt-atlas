import { unquote } from './dm.mjs';

const SAFE = /^\/obj\/structure\/safe(?:\/|$)/;

/** Safes collect fitting items from their tile at map load, unless open and unlocked. */
export function safeAppearances(atoms, db) {
  const literal = (value) => String(db.literal ? db.literal(String(value ?? '')) : (value ?? ''));
  const vars = (atom) => ({ ...db.resolve(atom.path), ...atom.vars });
  const flag = (value) => ['TRUE', '1'].includes(literal(value));
  const contained = new Set();
  for (const safe of atoms.filter((atom) => SAFE.test(atom.path))) {
    const v = vars(safe);
    if (flag(v.open) && !flag(v.locked)) continue;
    const capacity = Number(literal(v.maxspace ?? '24'));
    let space = Number(literal(v.space ?? '0'));
    for (const item of atoms) {
      if (space >= capacity) break;
      if (contained.has(item) || !item.path.startsWith('/obj/item/')) continue;
      const weight = Number(literal(vars(item).w_class));
      if (!Number.isFinite(weight) || weight <= 0 || weight + space > capacity) continue;
      contained.add(item);
      space += weight;
    }
  }
  return atoms
    .filter((atom) => !contained.has(atom))
    .map((atom) => {
      if (!SAFE.test(atom.path)) return atom;
      const v = vars(atom);
      const initial = db.resolve(atom.path).icon_state;
      if (!initial) return atom;
      const state = `${unquote(initial)}${flag(v.open) ? '' : '_locked'}`;
      if (db.hasIconState && !db.hasIconState(unquote(v.icon), state)) return atom;
      return { ...atom, vars: { ...atom.vars, icon_state: JSON.stringify(state) } };
    });
}
