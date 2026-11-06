import sharp from 'sharp';
import path from 'node:path';
import { LODS, CHANNELS, channelMask, maskChannels, slotIndex, stripName } from './map-format.mjs';

// One vertical strip holds every rendered channel of a tile.
export async function writeStrip(file, raw, width, height) {
  await sharp(raw, { raw: { width, height, channels: 4 } })
    .webp({ lossless: true })
    .toFile(file);
}

// Nearest-neighbor decimation of one RGBA square into the quadrant of a larger one.
export function decimateInto(source, size, target, targetSize, offsetX, offsetY) {
  const half = size / 2;
  for (let y = 0; y < half; y++) {
    const sourceRow = y * 2 * size * 4,
      targetRow = ((offsetY + y) * targetSize + offsetX) * 4;
    for (let x = 0; x < half; x++)
      source.copy(target, targetRow + x * 4, sourceRow + x * 8, sourceRow + x * 8 + 4);
  }
}

// Level-of-detail tiles: every coarser level packs 2×2 finer tiles into one
// strip of the same pixel size, so a view needs a similar number of images at
// any zoom. Each level is built from the previous level's files.
export async function buildPyramid(folder, tiles, size) {
  const pyramid = [tiles];
  for (const lod of LODS) {
    const groups = new Map();
    for (const [x, y, mask] of pyramid[lod - 1]) {
      const key = `${x >> 1},${y >> 1}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push([x, y, mask]);
    }
    const level = [];
    for (const [key, members] of [...groups].sort(([a], [b]) =>
      a.localeCompare(b, undefined, { numeric: true }),
    )) {
      const [tx, ty] = key.split(',').map(Number),
        mask = members.reduce((union, [, , memberMask]) => union | memberMask, 0),
        channels = maskChannels(mask);
      const slots = new Map(channels.map((channel) => [channel, Buffer.alloc(size * size * 4)]));
      for (const [x, y, memberMask] of members) {
        const raw = await sharp(path.join(folder, stripName(x, y, lod - 1)))
          .ensureAlpha()
          .raw()
          .toBuffer();
        for (const channel of maskChannels(memberMask)) {
          const slot = slotIndex(memberMask, channel),
            start = slot * size * size * 4;
          decimateInto(
            raw.subarray(start, start + size * size * 4),
            size,
            slots.get(channel),
            size,
            ((x & 1) * size) / 2,
            ((y & 1) * size) / 2,
          );
        }
      }
      await writeStrip(
        path.join(folder, stripName(tx, ty, lod)),
        Buffer.concat(channels.map((channel) => slots.get(channel))),
        size,
        size * channels.length,
      );
      level.push([tx, ty, mask]);
    }
    pyramid.push(level);
  }
  return pyramid;
}
