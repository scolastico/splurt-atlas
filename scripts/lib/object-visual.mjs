import { unquote } from './dm.mjs';
import { objectOffsets } from './object-offsets.mjs';
const numeric = (value, fallback = 0) => (Number.isFinite(Number(value)) ? Number(value) : fallback);
export function createObjectVisual(db, sprites, size = 32) {
  return async (atom, vars = { ...db.resolve(atom.path), ...atom.vars }) => {
    if (!/^\/(obj|mob)\//.test(atom.path)) return undefined;
    vars = objectOffsets(atom.path, vars, db);
    const translation = vars.transform?.match(/^TRANSLATE_MATRIX\(\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\)/),
      dx = numeric(vars.pixel_x) + numeric(vars.pixel_w) + numeric(translation?.[1]),
      dy = numeric(vars.pixel_y) + numeric(vars.pixel_z) + numeric(translation?.[2]);
    if (!dx && !dy) return undefined;
    const icon = unquote(vars.icon);
    if (!icon.endsWith('.dmi')) return undefined;
    const sprite = await sprites.sprite(
      icon,
      unquote(vars.icon_state),
      numeric(vars.dir, 2),
      unquote(vars.color),
      numeric(vars.alpha, 255),
    );
    if (!sprite?.bounds) return undefined;
    return {
      x: dx + (sprite.offsetX || 0) + sprite.bounds.x,
      y: size - sprite.height - dy - (sprite.offsetY || 0) + sprite.bounds.y,
      width: sprite.bounds.width,
      height: sprite.bounds.height,
    };
  };
}
