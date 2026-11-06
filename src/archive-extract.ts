// Extracts a packaged map ZIP into blobs, in bounded batches so the archive
// plus a few extracted files are all that sit in memory at once.
import JSZip from 'jszip';

export interface ExtractedAsset {
  path: string;
  blob: Blob;
}

export type BatchHandler = (batch: ExtractedAsset[], complete: number, total: number) => Promise<void> | void;

export function assetMime(path: string): string {
  if (path.endsWith('.json')) return 'application/json';
  if (path.endsWith('.webp')) return 'image/webp';
  if (path.endsWith('.png')) return 'image/png';
  return 'application/octet-stream';
}

const MAX_BATCH_FILES = 32;
const MAX_BATCH_BYTES = 4 * 1048576;

interface AssetIndexEntry {
  path: string;
  bytes: number;
}

export async function extractArchive(
  blob: Blob,
  onBatch: BatchHandler,
  shouldStop: () => boolean = () => false,
  priorities: string[] = [],
): Promise<void> {
  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  const preferred = new Set(priorities);
  const entries = Object.values(zip.files)
    .filter((entry) => !entry.dir)
    .sort((a, b) => Number(preferred.has(b.name)) - Number(preferred.has(a.name)));
  for (const entry of entries) {
    const name = entry.unsafeOriginalName || entry.name;
    const unsafe =
      name !== entry.name ||
      name.startsWith('/') ||
      name.includes('\\') ||
      name.split('/').some((part) => !part || part === '.' || part === '..');
    if (unsafe) throw new Error('Invalid archive path');
  }
  const index = zip.file('assets.json');
  if (!index) throw new Error('Archive has no asset index');
  const assets = JSON.parse(await index.async('string')) as AssetIndexEntry[];
  if (!Array.isArray(assets) || !assets.length) throw new Error('Archive has an invalid asset index');
  const expected = new Map<string, number | null>(assets.map((asset) => [asset.path, asset.bytes]));
  expected.set('assets.json', null);
  if (expected.size !== entries.length || entries.some((entry) => !expected.has(entry.name)))
    throw new Error('Archive does not match its asset index');
  let batch: ExtractedAsset[] = [];
  let bytes = 0;
  let complete = 0;
  for (const entry of entries) {
    if (shouldStop()) throw new DOMException('Offline saving interrupted', 'AbortError');
    const data = await entry.async('uint8array');
    const size = expected.get(entry.name);
    if (size !== null && size !== data.byteLength) throw new Error(`Incomplete archive asset: ${entry.name}`);
    batch.push({ path: entry.name, blob: new Blob([data as BlobPart], { type: assetMime(entry.name) }) });
    bytes += data.byteLength;
    complete++;
    if (batch.length >= MAX_BATCH_FILES || bytes >= MAX_BATCH_BYTES || complete === entries.length) {
      await onBatch(batch, complete, entries.length);
      batch = [];
      bytes = 0;
    }
  }
}
