// Renders the sprites of one tile that belong to one channel into a 3×3-tile
// image (a one-tile gutter on every side keeps offset sprites intact).
import sharp from 'sharp';
import { aperture, unquote } from './dm.mjs';
import { objectOffsets } from './object-offsets.mjs';
import { bakedChannel, underCatwalk, beaconVisibility } from './utility-visibility.mjs';

const numeric = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback);

/** Atoms that draw nothing: areas, landmarks and spawner placeholders. */
const invisible = (atom) =>
  atom.path.startsWith('/area/') ||
  /^\/obj\/docking_port(?:\/|$)/.test(atom.path) ||
  /\/landmark|\/spawner\//.test(atom.path);
const SPACE_TURF = /\/space(?:\/|$)|\/openspace(?:\/|$)/;
const DISPOSAL_PIPE = /^\/obj\/structure\/disposal(pipe|construct)(?:\/|$)/;
/** Disposal pipes render beneath other pipes and wiring. */
const DISPOSAL_LAYER = 2.25;

/** The game's default layer of an atom when the declaration sets none. */
function defaultLayer(path) {
  if (path.startsWith('/turf/')) return 1;
  if (path.includes('turf_decal')) return 2;
  if (path.startsWith('/mob/')) return 5;
  return 3;
}

export function createTileRenderer({ db, sprites, tilePixels }) {
  const S = tilePixels;
  /** Rendered images keyed by the exact atom list, so identical tiles render once. */
  const cache = new Map();

  async function renderLayers(atoms, underfloor = []) {
    const layers = [];
    for (const atom of atoms) {
      const vars = objectOffsets(atom.path, { ...db.resolve(atom.path), ...atom.vars }, db);
      if (SPACE_TURF.test(atom.path)) continue;
      const icon = unquote(vars.icon);
      const state = unquote(vars.icon_state);
      if (!icon || !icon.endsWith('.dmi')) continue;
      // Turfs that show the deck below are drawn partially transparent.
      const seeThrough =
        atom.path.startsWith('/turf/') && aperture(atom.path) ? 255 - aperture(atom.path) : 255;
      const opacity = Math.min(numeric(vars.alpha, 255), seeThrough);
      const sprite = await sprites.sprite(
        icon,
        state,
        numeric(vars.dir, 2),
        unquote(vars.color),
        opacity,
        numeric(vars.atlas_rotation, 0),
      );
      if (!sprite) continue;
      const translation = vars.transform?.match(/^TRANSLATE_MATRIX\(\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\)/);
      const left = Math.round(
        S +
          numeric(vars.pixel_x, 0) +
          numeric(vars.pixel_w, 0) +
          (sprite.offsetX || 0) +
          numeric(translation?.[1], 0),
      );
      const top = Math.round(
        S +
          S -
          sprite.height -
          numeric(vars.pixel_y, 0) -
          numeric(vars.pixel_z, 0) -
          (sprite.offsetY || 0) -
          numeric(translation?.[2], 0),
      );
      // Sprites may be up to 96px and offset by a tile; anything further is dropped.
      if (left < 0 || top < 0 || left + sprite.width > S * 3 || top + sprite.height > S * 3) continue;
      const layer = DISPOSAL_PIPE.test(atom.path)
        ? DISPOSAL_LAYER
        : numeric(vars.layer, defaultLayer(atom.path));
      layers.push({ input: sprite.input, left, top, layer: underfloor.includes(atom) ? layer - 100 : layer });
    }
    return layers;
  }

  return {
    /** A PNG of the channel's sprites on a 3×3-tile canvas, or null when nothing draws. */
    render(atoms, channel) {
      const underfloor =
        channel === 'base'
          ? atoms.filter(
              (atom) =>
                !atom.vars?.atlas_random_marker &&
                !atom.vars?.atlas_random_preview &&
                (underCatwalk(atom, atoms, db) || beaconVisibility(atom, atoms, db) === 'underfloor'),
            )
          : [];
      const selected = atoms.filter(
        (atom) =>
          ((channel === 'foreground-mapper'
            ? bakedChannel(atom, atoms, db) === 'foreground' && atom.vars?.atlas_random_preview !== '1'
            : bakedChannel(atom, atoms, db) === channel) ||
            underfloor.includes(atom)) &&
          (atom.vars?.atlas_random_marker === '1' || !invisible(atom)),
      );
      const key = JSON.stringify([selected, underfloor]);
      let job = cache.get(key);
      if (!job) {
        job = renderLayers(selected, underfloor).then((layers) => {
          if (!layers.length) return null;
          layers.sort((a, b) => a.layer - b.layer);
          return sharp({ create: { width: S * 3, height: S * 3, channels: 4, background: '#00000000' } })
            .composite(layers.map(({ layer: _layer, ...rest }) => rest))
            .png()
            .toBuffer();
        });
        cache.set(key, job);
      }
      return job;
    },
    clear() {
      cache.clear();
    },
  };
}
