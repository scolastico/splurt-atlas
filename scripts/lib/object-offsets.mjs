// Known map-load placement rules shared by raster rendering and inspector bounds.
// These are source rules, not guesses based on the nearest wall.
export function objectOffsets(type, vars, db) {
  const value = (raw) => (db.literal ? db.literal(raw) : raw);
  const result = { ...vars };
  for (const key of ['pixel_x', 'pixel_y', 'pixel_w', 'pixel_z'])
    if (result[key] !== undefined) {
      const resolved = value(result[key]);
      result[key] = resolved === 'null' ? '0' : resolved;
    }
  const dir = Number(value(vars.dir || '2'));
  if (
    type.includes('/atmospherics/components/') &&
    ['FALSE', '0'].includes(String(value(vars.shift_underlay_only || 'TRUE')))
  ) {
    // PIPING_LAYER_SHIFT moves only the axis perpendicular to the device's
    // ports. Keep the configured layer in the atlas reveal view as well.
    const layer = Number(value(vars.piping_layer || '3'));
    const componentDir = Number(value(vars.atlas_component_dir || vars.dir || '2'));
    const xStep = Number(value('PIPING_LAYER_P_X'));
    const yStep = Number(value('PIPING_LAYER_P_Y'));
    const floating = Number(value(vars.layer || '3')) <= -1;
    if (componentDir & 3)
      result[floating ? 'pixel_w' : 'pixel_x'] = String((layer - 3) * (Number.isFinite(xStep) ? xStep : 5));
    if (componentDir & 12)
      result[floating ? 'pixel_z' : 'pixel_y'] = String((layer - 3) * (Number.isFinite(yStep) ? yStep : 5));
  }
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
