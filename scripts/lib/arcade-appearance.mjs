import { unquote } from './dm.mjs';

/** Fullbright arcade cabinets need the computer's screen and optional keyboard overlays. */
export function arcadeOverlays(atom, db) {
  if (!/^\/obj\/machinery\/computer\/arcade(?:\/|$)/.test(atom.path)) return [];
  const vars = { ...db.resolve(atom.path), ...atom.vars };
  return ['icon_keyboard', 'icon_screen'].flatMap((key) => {
    const state = unquote(vars[key]);
    if (!state || state === 'null' || (db.hasIconState && !db.hasIconState(unquote(vars.icon), state)))
      return [];
    return [{ ...atom, vars: { ...atom.vars, icon: vars.icon, icon_state: JSON.stringify(state) } }];
  });
}
