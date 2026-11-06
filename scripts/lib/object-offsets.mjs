// Known map-load placement rules shared by raster rendering and inspector bounds.
// These are source rules, not guesses based on the nearest wall.
export function objectOffsets(type, vars, db) {
  const value = raw => db.literal ? db.literal(raw) : raw;
  const result = { ...vars };
  for (const key of ['pixel_x', 'pixel_y', 'pixel_w', 'pixel_z']) if (result[key] !== undefined) { const resolved=value(result[key]);result[key]=resolved==='null'?'0':resolved; }
  const dir = Number(value(vars.dir || '2'));
  if (/^\/obj\/machinery\/power\/apc(?:\/|$)/.test(type)) {
    // APC Initialize(mapload) always calls setDir, including non-helper subtypes.
    const shift = Number(value('APC_PIXEL_OFFSET'));
    if (Number.isFinite(shift)) {
      if (dir === 1 || dir === 2) result.pixel_y = String(dir === 1 ? shift : -shift);
      if (dir === 4 || dir === 8) result.pixel_x = String(dir === 4 ? shift : -shift);
    }
  }
  if (/^\/obj\/machinery\/shower(?:\/|$)/.test(type)) {
    const shift = Number(value(vars.pixel_shift || '16'));
    if (Number.isFinite(shift)) {
      result.pixel_x = String(dir === 4 ? -shift : dir === 8 ? shift : 0);
      result.pixel_y = String(dir === 1 ? -shift : dir === 2 ? shift : 0);
    }
  }
  return result;
}
