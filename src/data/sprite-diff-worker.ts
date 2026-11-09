// Native strips are compared off the UI thread, including hidden channels.
// The small decoded-strip cache also permits maps with different heights.
import { maskChannels, slotIndex, stripName } from '../../scripts/lib/map-format.mjs';
import type { TileEntry } from '../core/types.ts';

export interface SpriteDataset {
  base: string;
  version: string;
  id: string;
  width: number;
  height: number;
  tilePixels: number;
  chunkTiles: number;
  levels: [number, TileEntry[]][];
}
type Strip = { bytes: Uint8Array; pixels?: Uint8ClampedArray; width?: number; mask: number };
type Tile = { strip: Strip; x: number; y: number; size: number };

async function compare(before: SpriteDataset, after: SpriteDataset) {
  const cache = new Map<string, Promise<Strip>>();
  const load = (dataset: SpriteDataset, z: number, entry: TileEntry) => {
    const url = new URL(`${dataset.id}/${z}/${stripName(entry[0], entry[1])}`, dataset.base);
    url.searchParams.set('v', dataset.version);
    const key = url.href;
    let pending = cache.get(key);
    if (!pending) {
      pending = fetch(url).then(async (response) => {
        if (!response.ok) throw new Error(`Sprite comparison: ${response.status} ${url.pathname}`);
        return { bytes: new Uint8Array(await response.arrayBuffer()), mask: entry[2] };
      });
      cache.set(key, pending);
    }
    // Access order, bounded to the strips surrounding this comparison region.
    cache.delete(key);
    cache.set(key, pending);
    while (cache.size > 16) cache.delete(cache.keys().next().value!);
    return pending;
  };
  const decode = async (strip: Strip) => {
    if (strip.pixels) return;
    const image = await createImageBitmap(new Blob([strip.bytes as Uint8Array<ArrayBuffer>]));
    const canvas = new OffscreenCanvas(image.width, image.height);
    const context = canvas.getContext('2d', { willReadFrequently: true })!;
    context.drawImage(image, 0, 0);
    strip.pixels = context.getImageData(0, 0, image.width, image.height).data;
    strip.width = image.width;
    image.close();
  };
  const width = Math.max(before.width, after.width),
    height = Math.max(before.height, after.height);
  const decks = [...new Set([...before.levels, ...after.levels].map(([z]) => z))];
  for (const z of decks) {
    const lookup = [before, after].map(
      (dataset) =>
        new Map(
          (dataset.levels.find(([deck]) => deck === z)?.[1] || []).map((entry) => [
            `${entry[0]},${entry[1]}`,
            entry,
          ]),
        ),
    );
    for (let top = height; top >= 1; top -= 16)
      for (let left = 1; left <= width; left += 16) {
        const right = Math.min(width, left + 15),
          bottom = Math.max(1, top - 15);
        const strips = await Promise.all(
          [before, after].map(async (dataset, side) => {
            const needed = new Map<string, TileEntry>();
            for (let y = bottom; y <= top; y++)
              for (let x = left; x <= right; x++) {
                if (x > dataset.width || y > dataset.height) continue;
                const key = `${Math.floor((x - 1) / dataset.chunkTiles)},${Math.floor((dataset.height - y) / dataset.chunkTiles)}`;
                const entry = lookup[side].get(key);
                if (entry) needed.set(key, entry);
              }
            return new Map(
              await Promise.all(
                [...needed].map(async ([key, entry]) => [key, await load(dataset, z, entry)] as const),
              ),
            );
          }),
        );
        // Equal encoded strips need neither decoding nor a per-pixel scan.
        const equal = new Set<Strip>();
        if (
          before.width === after.width &&
          before.height === after.height &&
          before.chunkTiles === after.chunkTiles &&
          before.tilePixels === after.tilePixels
        )
          for (const [key, a] of strips[0]) {
            const b = strips[1].get(key);
            if (
              b &&
              a.mask === b.mask &&
              a.bytes.length === b.bytes.length &&
              a.bytes.every((v, i) => v === b.bytes[i])
            ) {
              equal.add(a);
              equal.add(b);
            }
          }
        await Promise.all(
          strips.flatMap((set) => [...set.values()].filter((strip) => !equal.has(strip)).map(decode)),
        );
        const at = (dataset: SpriteDataset, set: Map<string, Strip>, x: number, y: number): Tile | null => {
          if (x > dataset.width || y > dataset.height) return null;
          const row = dataset.height - y,
            col = x - 1,
            count = dataset.chunkTiles;
          const strip = set.get(`${Math.floor(col / count)},${Math.floor(row / count)}`);
          return strip ? { strip, x: col % count, y: row % count, size: dataset.tilePixels } : null;
        };
        const changes = [];
        for (let y = bottom; y <= top; y++)
          for (let x = left; x <= right; x++) {
            const a = at(before, strips[0], x, y),
              b = at(after, strips[1], x, y);
            if ((!a && !b) || (a && b && equal.has(a.strip) && equal.has(b.strip))) continue;
            const channels: string[] = [
              ...new Set([...maskChannels(a?.strip.mask || 0), ...maskChannels(b?.strip.mask || 0)]),
            ];
            const pixel = (tile: Tile | null, slot: number, px: number, py: number) => {
              if (!tile || slot < 0) return [0, 0, 0, 0];
              const strip = tile.strip;
              const offset =
                ((slot * tile.size * (strip.width! / tile.size) + tile.y * tile.size + py) * strip.width! +
                  tile.x * tile.size +
                  px) *
                4;
              return strip.pixels!.subarray(offset, offset + 4);
            };
            let changed = false;
            for (const channel of channels) {
              const sa = a ? slotIndex(a.strip.mask, channel) : -1,
                sb = b ? slotIndex(b.strip.mask, channel) : -1;
              const size = Math.max(a?.size || 0, b?.size || 0);
              for (let py = 0; py < size && !changed; py++)
                for (let px = 0; px < size && !changed; px++) {
                  const pa = pixel(
                    a,
                    sa,
                    Math.floor((px * (a?.size || size)) / size),
                    Math.floor((py * (a?.size || size)) / size),
                  );
                  const pb = pixel(
                    b,
                    sb,
                    Math.floor((px * (b?.size || size)) / size),
                    Math.floor((py * (b?.size || size)) / size),
                  );
                  changed =
                    pa[3] !== pb[3] ||
                    (pa[3] !== 0 && (pa[0] !== pb[0] || pa[1] !== pb[1] || pa[2] !== pb[2]));
                }
              if (changed) break;
            }
            if (changed) changes.push({ x, y, z, kind: 'visual' });
          }
        if (changes.length) postMessage({ changes });
      }
  }
  postMessage({ done: true });
}

onmessage = (event: MessageEvent<{ before: SpriteDataset; after: SpriteDataset }>) => {
  void compare(event.data.before, event.data.after).catch((error) => postMessage({ error: String(error) }));
};
