// Renders one deck of a station: chunk strips with every channel, the
// level-of-detail pyramid, the overview strips, the previews and the deck's
// JSON index.
import { mkdirSync, writeFileSync } from 'node:fs';
import sharp from 'sharp';
import { buildPyramid, writeStrip } from './image-pyramid.mjs';
import {
  CHANNELS,
  OVERVIEW_TERRAIN,
  channelMask,
  encodeLevel,
  levelBounds,
  stripName,
} from './map-format.mjs';

/** Overview strips hold 4×4 pixels per tile. */
const OVERVIEW_PIXELS = 4;
const PREVIEW_WIDTH = 512;

/**
 * Assigns every cell of a deck to the chunks it touches. A sprite may extend
 * one tile beyond its own tile, so cells near a chunk edge belong to the
 * neighboring chunk as well.
 */
function assignChunks(levelCells, { width, height, tilePixels: S, chunkTiles: C }) {
  const P = S * C;
  const chunks = new Map();
  const lastChunkX = Math.ceil(width / C) - 1;
  const lastChunkY = Math.ceil(height / C) - 1;
  for (const cell of levelCells) {
    const px = (cell.x - 1) * S;
    const py = (height - cell.y) * S;
    const firstY = Math.max(0, Math.floor((py - S) / P));
    const lastY = Math.min(lastChunkY, Math.floor((py + S * 2 - 1) / P));
    const firstX = Math.max(0, Math.floor((px - S) / P));
    const lastX = Math.min(lastChunkX, Math.floor((px + S * 2 - 1) / P));
    for (let cy = firstY; cy <= lastY; cy++)
      for (let cx = firstX; cx <= lastX; cx++) {
        const key = `${cx},${cy}`;
        let entries = chunks.get(key);
        if (!entries) chunks.set(key, (entries = []));
        entries.push({ cell, px, py, cx, cy });
      }
  }
  return chunks;
}

/** Composites the rendered tiles of one channel into a chunk-sized RGBA buffer, or null. */
async function renderChunkChannel(entries, channel, { tiles, tilePixels: S, chunkTiles: C }, cx, cy) {
  const P = S * C;
  const composite = [];
  for (const { cell, px, py } of entries) {
    const input = await tiles.render(cell.appearance, channel);
    if (input) composite.push({ input, left: px - cx * P + S, top: py - cy * P + S });
  }
  if (!composite.length) return null;
  // Two-tile gutter provides a fixed nonnegative composite origin.
  const padded = P + S * 4;
  const full = await sharp({
    create: { width: padded, height: padded, channels: 4, background: '#00000000' },
  })
    .composite(composite)
    .raw()
    .toBuffer();
  return sharp(full, { raw: { width: padded, height: padded, channels: 4 } })
    .extract({ left: S * 2, top: S * 2, width: P, height: P })
    .raw()
    .toBuffer();
}

/** Builds the full-map overview buffers per channel from the downscaled chunk parts. */
async function buildOverviews(overviewParts, { width, height, chunkTiles: C }) {
  // The natural overview is the base overview with generated terrain on top.
  if (overviewParts.has('natural'))
    overviewParts.set('natural', [...(overviewParts.get('base') || []), ...overviewParts.get('natural')]);
  const size = Math.ceil(Math.max(width, height) / C) * C * OVERVIEW_PIXELS;
  const overviews = new Map();
  for (const channel of CHANNELS.filter((channel) => overviewParts.has(channel))) {
    const full = await sharp({ create: { width: size, height: size, channels: 4, background: '#00000000' } })
      .composite(overviewParts.get(channel))
      .raw()
      .toBuffer();
    overviews.set(
      channel,
      await sharp(full, { raw: { width: size, height: size, channels: 4 } })
        .extract({ left: 0, top: 0, width: width * OVERVIEW_PIXELS, height: height * OVERVIEW_PIXELS })
        .raw()
        .toBuffer(),
    );
  }
  return overviews;
}

/**
 * Writes the terrain and utility overview strips. They are separate so lower
 * decks only ever decode the small terrain strip; utilities load for the
 * viewed deck. Returns the channel mask of each strip.
 */
async function writeOverviewStrips(overviews, levelDir, { width, height }) {
  const masks = {};
  const strips = [
    ['overview', OVERVIEW_TERRAIN],
    ['overview-utilities', CHANNELS.filter((channel) => !OVERVIEW_TERRAIN.includes(channel))],
  ];
  for (const [file, channels] of strips) {
    const present = channels.filter((channel) => overviews.has(channel));
    masks[file] = channelMask(present);
    if (present.length)
      await sharp(Buffer.concat(present.map((channel) => overviews.get(channel))), {
        raw: {
          width: width * OVERVIEW_PIXELS,
          height: height * OVERVIEW_PIXELS * present.length,
          channels: 4,
        },
      })
        .webp({ lossless: true })
        .toFile(`${levelDir}/${file}.webp`);
  }
  return masks;
}

/** Writes the station picker previews from the top deck's overview. */
async function writePreviews(overviews, dir, { width, height }) {
  const previews = [
    ['base', 'preview.webp'],
    ['natural', 'preview-natural.webp'],
  ];
  for (const [channel, file] of previews) {
    if (!overviews.has(channel)) continue;
    await sharp(overviews.get(channel), {
      raw: { width: width * OVERVIEW_PIXELS, height: height * OVERVIEW_PIXELS, channels: 4 },
    })
      .resize(Math.min(width * OVERVIEW_PIXELS, PREVIEW_WIDTH), null, { kernel: 'nearest' })
      .webp({ lossless: true })
      .toFile(`${dir}/${file}`);
  }
}

/**
 * Renders deck `z` into `<dir>/<z>/` and writes `<dir>/<z>.json`.
 * `onChunk(rendered, total)` reports progress. Returns the strip counts per
 * zoom level and how many chunks received generated terrain.
 */
export async function renderLevel({
  z,
  cells,
  definitions,
  definitionIds,
  dir,
  geometry,
  tiles,
  natural,
  isTopDeck,
  onChunk,
  onPyramid,
}) {
  const { width, height, tilePixels: S, chunkTiles: C } = geometry;
  const P = S * C;
  const levelCells = cells.filter((cell) => cell.z === z);
  const grid = new Int32Array(width * height).fill(-1);
  // The aperture image records how much of the deck below shows through each tile.
  const holes = Buffer.alloc(width * height * 4);
  for (const cell of levelCells) {
    const index = (height - cell.y) * width + cell.x - 1;
    const definition = definitionIds.get(cell.key);
    grid[index] = definition;
    holes[index * 4 + 3] = definitions[definition].aperture;
  }
  const chunks = assignChunks(levelCells, geometry);
  const levelDir = `${dir}/${z}`;
  mkdirSync(levelDir, { recursive: true });
  await sharp(holes, { raw: { width, height, channels: 4 } })
    .png()
    .toFile(`${levelDir}/aperture.png`);
  const terrain = natural?.level(z, grid);
  const chunkIndex = [];
  const overviewParts = new Map();
  let rendered = 0;
  for (const [key, entries] of chunks) {
    const [cx, cy] = key.split(',').map(Number);
    onChunk(++rendered, chunks.size);
    // Every channel of a chunk shares one strip, so a view needs one request
    // per chunk instead of one per channel. Slots follow CHANNELS order.
    const slots = [];
    for (const channel of CHANNELS) {
      let raw = null;
      if (channel === 'natural') {
        if (terrain?.chunks.has(key)) raw = await terrain.render(cx, cy);
      } else
        raw = await renderChunkChannel(entries, channel, { tiles, tilePixels: S, chunkTiles: C }, cx, cy);
      if (raw) slots.push({ channel, raw });
    }
    if (!slots.length) continue;
    await writeStrip(
      `${levelDir}/${stripName(cx, cy)}`,
      Buffer.concat(slots.map((slot) => slot.raw)),
      P,
      P * slots.length,
    );
    for (const { channel, raw } of slots) {
      let parts = overviewParts.get(channel);
      if (!parts) overviewParts.set(channel, (parts = []));
      parts.push({
        input: await sharp(raw, { raw: { width: P, height: P, channels: 4 } })
          .resize(C * OVERVIEW_PIXELS, C * OVERVIEW_PIXELS, { kernel: 'nearest' })
          .png()
          .toBuffer(),
        left: cx * C * OVERVIEW_PIXELS,
        top: cy * C * OVERVIEW_PIXELS,
      });
    }
    chunkIndex.push([cx, cy, channelMask(slots.map((slot) => slot.channel))]);
  }
  onPyramid?.();
  const pyramid = await buildPyramid(levelDir, chunkIndex, P);
  const overviews = await buildOverviews(overviewParts, geometry);
  const masks = await writeOverviewStrips(overviews, levelDir, geometry);
  if (isTopDeck) await writePreviews(overviews, dir, geometry);
  writeFileSync(
    `${dir}/${z}.json`,
    JSON.stringify(
      encodeLevel({
        z,
        grid,
        pyramid,
        overview: masks.overview,
        overviewUtilities: masks['overview-utilities'],
        bounds: levelBounds(grid, width, height, definitions),
      }),
    ),
  );
  return { stripCounts: pyramid.map((level) => level.length), terrainChunks: terrain?.chunks.size || 0 };
}
