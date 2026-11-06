import JSZip from 'jszip';

export const assetMime = (path) =>
  path.endsWith('.json')
    ? 'application/json'
    : path.endsWith('.webp')
      ? 'image/webp'
      : path.endsWith('.png')
        ? 'image/png'
        : 'application/octet-stream';

// Bounded batches keep the archive plus a few extracted blobs in memory.
export async function extractArchive(blob, onBatch, shouldStop = () => false, priorities = []) {
  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  const preferred = new Set(priorities),
    entries = Object.values(zip.files)
      .filter((entry) => !entry.dir)
      .sort((a, b) => Number(preferred.has(b.name)) - Number(preferred.has(a.name)));
  for (const entry of entries) {
    const name = entry.unsafeOriginalName || entry.name;
    if (
      name !== entry.name ||
      name.startsWith('/') ||
      name.includes('\\') ||
      name.split('/').some((part) => !part || part === '.' || part === '..')
    )
      throw new Error('Invalid archive path');
  }
  const index = zip.file('assets.json');
  if (!index) throw new Error('Archive has no asset index');
  const assets = JSON.parse(await index.async('string'));
  if (!Array.isArray(assets) || !assets.length) throw new Error('Archive has an invalid asset index');
  const expected = new Map(assets.map((asset) => [asset.path, asset.bytes]));
  expected.set('assets.json', null);
  if (expected.size !== entries.length || entries.some((entry) => !expected.has(entry.name)))
    throw new Error('Archive does not match its asset index');
  let batch = [],
    bytes = 0,
    complete = 0;
  for (const entry of entries) {
    if (shouldStop()) throw new DOMException('Offline saving interrupted', 'AbortError');
    const data = await entry.async('uint8array'),
      size = expected.get(entry.name);
    if (size !== null && size !== data.byteLength) throw new Error(`Incomplete archive asset: ${entry.name}`);
    batch.push({ path: entry.name, blob: new Blob([data], { type: assetMime(entry.name) }) });
    bytes += data.byteLength;
    complete++;
    if (batch.length >= 32 || bytes >= 4 * 1048576 || complete === entries.length) {
      await onBatch(batch, complete, entries.length);
      batch = [];
      bytes = 0;
    }
  }
}
