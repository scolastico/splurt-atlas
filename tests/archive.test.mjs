import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { packageMaps } from '../scripts/package-maps.mjs';
import { extractArchive } from '../src/archive-extract.js';

test('map ZIPs round-trip every indexed asset with deterministic bytes and correct MIME types', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'atlas-zip-'));
  try {
    mkdirSync(path.join(root, 'one/1'), { recursive: true });
    const assets = [
      { path: 'map.json', bytes: 2 },
      { path: '1/sprite.webp', bytes: 6 },
    ];
    writeFileSync(path.join(root, 'one/assets.json'), JSON.stringify(assets));
    writeFileSync(path.join(root, 'one/map.json'), '{}');
    writeFileSync(path.join(root, 'one/1/sprite.webp'), 'sprite');
    const manifest = { buildId: 'revision', maps: [{ id: 'one', name: 'One', assets: 'one/assets.json' }] },
      catalog = path.join(root, 'manifest.json');
    writeFileSync(catalog, JSON.stringify(manifest));
    const result = await packageMaps(catalog),
      original = readFileSync(path.join(root, 'one.zip'));
    assert.equal(result.maps[0].archive.bytes, original.length);
    const extracted = new Map();
    await extractArchive(new Blob([original]), async (batch) => {
      for (const item of batch) extracted.set(item.path, item.blob);
    });
    assert.equal(extracted.size, 3);
    assert.equal(await extracted.get('1/sprite.webp').text(), 'sprite');
    assert.equal(extracted.get('1/sprite.webp').type, 'image/webp');
    assert.equal(extracted.get('map.json').type, 'application/json');
    writeFileSync(catalog, JSON.stringify(manifest));
    await packageMaps(catalog);
    assert.deepEqual(readFileSync(path.join(root, 'one.zip')), original);
  } finally {
    if (
      path.dirname(path.resolve(root)) !== path.resolve(tmpdir()) ||
      !path.basename(root).startsWith('atlas-zip-')
    )
      throw new Error('Unsafe test workspace');
    rmSync(root, { recursive: true, force: true });
  }
});
test('extraction rejects missing, mismatched and traversal archive entries', async () => {
  for (const extra of ['missing', 'wrong-size', '../escape']) {
    const zip = new JSZip();
    zip.file('assets.json', JSON.stringify([{ path: 'map.json', bytes: 2 }]));
    if (extra !== 'missing') zip.file('map.json', extra === 'wrong-size' ? 'bad' : '{}');
    if (extra === '../escape') zip.file(extra, 'bad');
    await assert.rejects(
      extractArchive(new Blob([await zip.generateAsync({ type: 'uint8array' })]), () => {}),
    );
  }
});
test('current viewport assets are extracted before other chunks', async () => {
  const zip = new JSZip(),
    assets = Array.from({ length: 65 }, (_, index) => ({ path: `1/chunk-${index}.webp`, bytes: 1 }));
  zip.file('assets.json', JSON.stringify(assets));
  for (const asset of assets) zip.file(asset.path, 'x');
  const batches = [];
  await extractArchive(
    new Blob([await zip.generateAsync({ type: 'uint8array' })]),
    (batch) => {
      batches.push(batch.map((item) => item.path));
    },
    () => false,
    ['1/chunk-64.webp'],
  );
  assert.equal(batches[0][0], '1/chunk-64.webp');
  assert.equal(batches.flat().length, 66);
});
