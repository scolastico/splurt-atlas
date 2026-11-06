import sharp from 'sharp';
import { unquote, pretty, aperture } from './dm.mjs';
import { expandStructures, smoothAtoms } from './appearance.mjs';
import { bakedChannel } from './utility-visibility.mjs';
export function runtimeReplacement(def, area, db) {
  if (!/^\/turf\/open\/genturf(?:\/|$)/.test(def.turf)) return null;
  const generator = db.resolve(area.path).map_generator;
  const target = db.resolve(generator || '').weighted_open_turf_types?.match(/\/turf\/[\w/]+/)?.[0];
  if (!target) return null;
  const vars = db.resolve(target);
  return {
    type: target,
    name: unquote(vars.name) || pretty(target),
    description: unquote(vars.desc),
    approximate: true,
  };
}
// Renders the representative terrain of a chunk as the "natural" strip slot.
// Returns null when the map has no generator placeholders.
export function createNaturalTerrain(meta, db, reader, S = 32, C = 16) {
  if (!meta.definitions.some((def) => def.runtimeTerrain)) return null;
  const P = S * C,
    expanded = meta.definitions.map((def) =>
      expandStructures(
        [
          ...def.atoms.map((a) => ({ path: a.path, vars: a.vars })),
          { path: meta.areas[def.area].path, vars: {} },
        ],
        db,
      ),
    ),
    cache = new Map();
  const num = (v, f) => (Number.isFinite(+v) ? +v : f);
  async function tile(atoms) {
    const visible = atoms.filter(
        (a) =>
          bakedChannel(a, atoms, db) === 'base' &&
          !a.path.startsWith('/area/') &&
          !/\/landmark|\/spawner\//.test(a.path),
      ),
      key = JSON.stringify(visible);
    if (cache.has(key)) return cache.get(key);
    const parts = [];
    for (const atom of visible) {
      if (/\/space(?:\/|$)|\/openspace(?:\/|$)/.test(atom.path)) continue;
      const v = { ...db.resolve(atom.path), ...atom.vars },
        icon = unquote(v.icon);
      if (!icon.endsWith('.dmi')) continue;
      const alpha = Math.min(
          num(v.alpha, 255),
          atom.path.startsWith('/turf/') && aperture(atom.path) ? 255 - aperture(atom.path) : 255,
        ),
        sprite = await reader.sprite(icon, unquote(v.icon_state), num(v.dir, 2), unquote(v.color), alpha);
      if (!sprite) continue;
      const translation = v.transform?.match(/^TRANSLATE_MATRIX\(\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\)/),
        left = Math.round(S + num(v.pixel_x, 0) + num(translation?.[1], 0)),
        top = Math.round(S * 2 - sprite.height - num(v.pixel_y, 0) - num(translation?.[2], 0));
      if (left < 0 || top < 0 || left + sprite.width > S * 3 || top + sprite.height > S * 3) continue;
      parts.push({
        input: sprite.input,
        left,
        top,
        layer: num(
          v.layer,
          atom.path.startsWith('/turf/')
            ? 1
            : atom.path.includes('turf_decal')
              ? 2
              : atom.path.startsWith('/mob/')
                ? 5
                : 3,
        ),
      });
    }
    parts.sort((a, b) => a.layer - b.layer);
    const result = parts.length
      ? await sharp({ create: { width: S * 3, height: S * 3, channels: 4, background: '#00000000' } })
          .composite(parts.map(({ layer, ...part }) => part))
          .png()
          .toBuffer()
      : null;
    cache.set(key, result);
    return result;
  }
  return {
    level(z, grid) {
      const chunks = new Set();
      for (let i = 0; i < grid.length; i++)
        if (meta.definitions[grid[i]]?.runtimeTerrain)
          chunks.add(`${Math.floor((i % meta.width) / C)},${Math.floor(Math.floor(i / meta.width) / C)}`);
      const at = (x, y, zz) =>
        zz === z && x >= 1 && x <= meta.width && y >= 1 && y <= meta.height
          ? expanded[grid[(meta.height - y) * meta.width + x - 1]]
          : undefined;
      return {
        chunks,
        async render(cx, cy) {
          const parts = [];
          for (let iy = Math.max(0, cy * C - 1); iy < Math.min(meta.height, (cy + 1) * C + 1); iy++)
            for (let ix = Math.max(0, cx * C - 1); ix < Math.min(meta.width, (cx + 1) * C + 1); ix++) {
              const def = meta.definitions[grid[iy * meta.width + ix]];
              if (!def) continue;
              let atoms = at(ix + 1, meta.height - iy, z);
              if (def.runtimeTerrain) {
                const target = def.runtimeTerrain.type,
                  v = db.resolve(target),
                  icon = unquote(v.icon),
                  base = unquote(v.icon_state),
                  hash = ((ix * 73856093) ^ (iy * 19349663) ^ (z * 83492791)) >>> 0;
                let state = base;
                if (base === 'snow' && db.hasIconState(icon, `snow${hash % 13}`)) state = `snow${hash % 13}`;
                else if (base === '0,0' && db.hasIconState(icon, `${ix % 10},${iy % 10}`))
                  state = `${ix % 10},${iy % 10}`;
                atoms = atoms.map((atom) =>
                  atom.path === def.turf
                    ? { path: target, vars: { icon_state: JSON.stringify(state) } }
                    : atom,
                );
              }
              atoms = smoothAtoms(atoms, ix + 1, meta.height - iy, z, at, db);
              const input = await tile(atoms);
              if (input) parts.push({ input, left: ix * S - cx * P + S, top: iy * S - cy * P + S });
            }
          const full = await sharp({
            create: { width: P + S * 4, height: P + S * 4, channels: 4, background: '#00000000' },
          })
            .composite(parts)
            .raw()
            .toBuffer();
          return sharp(full, { raw: { width: P + S * 4, height: P + S * 4, channels: 4 } })
            .extract({ left: S * 2, top: S * 2, width: P, height: P })
            .raw()
            .toBuffer();
        },
      };
    },
  };
}
