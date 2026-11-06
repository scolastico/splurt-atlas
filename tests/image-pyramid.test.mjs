import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { buildPyramid, writeStrip, decimateInto } from '../scripts/lib/image-pyramid.mjs';
import { channelMask, slotIndex, stripName } from '../scripts/lib/map-format.mjs';

sharp.cache(false);
const square = (size, [r, g, b, a]) => {
  const raw = Buffer.alloc(size * size * 4);
  for (let i = 0; i < raw.length; i += 4) raw.set([r, g, b, a], i);
  return raw;
};
const pixel = async (file, x, y) => {
  const raw = await sharp(file).ensureAlpha().raw().toBuffer();
  const i = (y * 64 + x) * 4;
  return [...raw.subarray(i, i + 4)];
};

test('level-of-detail strips pack 2×2 finer strips and merge their channel masks', async () => {
  const folder = mkdtempSync(path.join(tmpdir(), 'atlas-pyramid-'));
  try {
    const size = 64,
      base = channelMask(['base']),
      both = channelMask(['base', 'foreground']);
    await writeStrip(path.join(folder, stripName(0, 0)), square(size, [255, 0, 0, 255]), size, size);
    await writeStrip(
      path.join(folder, stripName(1, 1)),
      Buffer.concat([square(size, [0, 0, 255, 255]), square(size, [0, 255, 0, 128])]),
      size,
      size * 2,
    );
    await writeStrip(path.join(folder, stripName(2, 0)), square(size, [9, 9, 9, 255]), size, size);
    const pyramid = await buildPyramid(
      folder,
      [
        [0, 0, base],
        [1, 1, both],
        [2, 0, base],
      ],
      size,
    );
    assert.deepEqual(pyramid[1], [
      [0, 0, both],
      [1, 0, base],
    ]);
    assert.deepEqual(pyramid[2], [[0, 0, both]]);
    const first = path.join(folder, stripName(0, 0, 1)),
      meta = await sharp(first).metadata();
    assert.deepEqual([meta.width, meta.height], [size, size * 2]);
    assert.deepEqual(await pixel(first, 0, 0), [255, 0, 0, 255], 'top-left quadrant comes from chunk 0,0');
    assert.deepEqual(
      await pixel(first, 32, 32),
      [0, 0, 255, 255],
      'bottom-right quadrant comes from chunk 1,1',
    );
    assert.deepEqual(await pixel(first, 63, 0), [0, 0, 0, 0], 'missing chunk 1,0 stays transparent');
    assert.deepEqual(
      await pixel(first, 32, 32 + size * slotIndex(both, 'foreground')),
      [0, 255, 0, 128],
      'foreground slot keeps its alpha',
    );
    assert.deepEqual(
      await pixel(first, 0, size * slotIndex(both, 'foreground')),
      [0, 0, 0, 0],
      'chunks without a channel leave that slot empty',
    );
    const second = path.join(folder, stripName(0, 0, 2));
    assert.deepEqual(await pixel(second, 0, 0), [255, 0, 0, 255]);
    assert.deepEqual(await pixel(second, 16, 16), [0, 0, 255, 255]);
    assert.deepEqual(
      await pixel(second, 32, 0),
      [9, 9, 9, 255],
      'level-1 tile 1,0 lands in the top-right quadrant of level 2',
    );
    assert.deepEqual(
      await pixel(second, 16, 0),
      [0, 0, 0, 0],
      'missing chunk 1,0 stays transparent at level 2',
    );
    const target = Buffer.alloc(4 * 4 * 4),
      source = Buffer.alloc(4 * 4 * 4);
    for (let i = 0; i < 16; i++) source.set([i, i, i, 255], i * 4);
    decimateInto(source, 4, target, 4, 2, 2);
    assert.deepEqual([...target.subarray((2 * 4 + 2) * 4, (2 * 4 + 2) * 4 + 4)], [0, 0, 0, 255]);
    assert.deepEqual([...target.subarray((3 * 4 + 3) * 4, (3 * 4 + 3) * 4 + 4)], [10, 10, 10, 255]);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
