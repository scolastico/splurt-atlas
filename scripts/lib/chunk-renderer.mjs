import sharp from 'sharp';
import { CHANNELS, channelMask, stripName } from './map-format.mjs';
import { writeStrip } from './image-pyramid.mjs';

/** Composites the rendered tiles of one channel into a chunk-sized RGBA buffer, or null. */
export async function renderChunkChannel(entries, channel, { tiles, tilePixels: S, chunkTiles: C }, cx, cy) {
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

/** One independent chunk, including its sprite gutter and overview fragments. */
export async function renderChunk({ entries, geometry, cx, cy, levelDir, naturalRaw }, tiles) {
  const { tilePixels: S, chunkTiles: C } = geometry;
  const P = S * C;
  const slots = [];
  for (const channel of CHANNELS) {
    const raw =
      channel === 'natural'
        ? naturalRaw && Buffer.from(naturalRaw)
        : await renderChunkChannel(entries, channel, { tiles, tilePixels: S, chunkTiles: C }, cx, cy);
    if (raw) slots.push({ channel, raw });
  }
  if (!slots.length) return null;
  await writeStrip(
    levelDir + '/' + stripName(cx, cy),
    Buffer.concat(slots.map((s) => s.raw)),
    P,
    P * slots.length,
  );
  const parts = [];
  for (const { channel, raw } of slots) {
    parts.push({
      channel,
      input: await sharp(raw, { raw: { width: P, height: P, channels: 4 } })
        .resize(C * 4, C * 4, { kernel: 'nearest' })
        .png()
        .toBuffer(),
      left: cx * C * 4,
      top: cy * C * 4,
    });
  }
  return { index: [cx, cy, channelMask(slots.map((s) => s.channel))], parts };
}
