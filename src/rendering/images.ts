// The strip image cache: downloads tile strips through the asset cache,
// decodes them off the main thread and keeps them as renderer textures
// within a memory budget.
import { renderer } from './canvases.ts';
import { assetCache, resolvePath } from '../data/source.ts';
import { $ } from '../core/dom.ts';
import { redraw } from '../core/frame.ts';
import type { TextureHandle } from './gl-renderer.ts';
import { state } from '../core/state.ts';
import { slotCount } from '../../scripts/lib/map-format.mjs';

export interface ImageEntry {
  path: string;
  /** Channel mask of the strip, which determines its slot count. */
  mask: number;
  ready: boolean;
  image: TextureHandle | null;
  bytes: number;
  generation: number;
  urgent: boolean;
  /** When the image was last drawn or prefetched. */
  used: number;
  /** Resolves with the texture, or null when the load was dropped or failed. */
  promise: Promise<TextureHandle | null>;
  resolve: (handle: TextureHandle | null) => void;
}

const CACHE_BYTES = 128 * 1024 * 1024;
const MAX_REQUESTS = 12;
/** Tiles used this recently are never evicted. */
const RECENT_USE_MS = 2000;

const images = new Map<string, ImageEntry>();
const queue: ImageEntry[] = [];
const failures = new Set<string>();
let activeRequests = 0;
let imageBytes = 0;

/** Images drawn (or borrowed from) in the current frame. */
export const frameImages = new Set<string>();
/** Images prefetched for the direction the camera moves in. */
export const prefetchImages = new Set<string>();
/** Images loaded ahead for the initial zoom neighborhood of a station. */
let warmImages = new Set<string>();

export function setWarmImages(paths: Iterable<string>): void {
  warmImages = new Set(paths);
}

/** Forgets the previous frame's usage before a new frame starts. */
export function beginFrame(): void {
  frameImages.clear();
  prefetchImages.clear();
}

export function getImage(path: string): ImageEntry | undefined {
  return images.get(path);
}

function requestReadyRedraw(path: string): void {
  if (state.loadingStation) return;
  if (frameImages.has(path)) redraw();
}

/**
 * Decode off the main thread where possible; drawing a freshly loaded
 * HTMLImageElement would otherwise decode synchronously inside the frame.
 * Premultiplied bitmaps draw about twice as fast in Chromium; their only cost
 * is a rounding error of one unit at translucent sprite edges.
 */
function decodeImage(blob: Blob): Promise<ImageBitmap> {
  if (typeof createImageBitmap === 'function') return createImageBitmap(blob);
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img as unknown as ImageBitmap);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Image decode failed'));
    };
    img.src = url;
  });
}

/** Queues a strip for loading unless it is known already. */
export function ensureImage(path: string, urgent = false, mask = 0): ImageEntry {
  const existing = images.get(path);
  if (existing) return existing;
  let resolve!: ImageEntry['resolve'];
  const promise = new Promise<TextureHandle | null>((done) => (resolve = done));
  const entry: ImageEntry = {
    path,
    mask,
    ready: false,
    image: null,
    bytes: 0,
    generation: state.generation,
    urgent,
    used: performance.now(),
    promise,
    resolve,
  };
  images.set(path, entry);
  if (urgent) queue.unshift(entry);
  else queue.push(entry);
  drain();
  return entry;
}

/** The texture of a strip the current frame wants, or null while it loads. */
export function imageForFrame(path: string, mask: number): TextureHandle | null {
  frameImages.add(path);
  if (failures.has(path)) return null;
  const cached = images.get(path);
  if (!cached) {
    ensureImage(path, true, mask);
    return null;
  }
  // Re-insert so the map keeps least-recently-used order for eviction.
  images.delete(path);
  images.set(path, cached);
  cached.used = performance.now();
  // A strip that became visible jumps ahead of background warm-up loads.
  if (!cached.ready && !cached.urgent) {
    cached.urgent = true;
    const index = queue.indexOf(cached);
    if (index > 0) {
      queue.splice(index, 1);
      queue.unshift(cached);
    }
  }
  return cached.ready ? cached.image : null;
}

function drain(): void {
  while (activeRequests < MAX_REQUESTS && queue.length) {
    const entry = queue.shift()!;
    const { path } = entry;
    if (entry.generation !== state.generation) {
      if (images.get(path) === entry) images.delete(path);
      entry.resolve(null);
      continue;
    }
    activeRequests++;
    assetCache
      .get(resolvePath(path), path, entry.urgent ? 'high' : 'auto')
      .then(decodeImage)
      .then((bitmap) => renderer.prepare(bitmap, Math.max(1, slotCount(entry.mask))))
      .then((handle) => {
        activeRequests--;
        if (images.get(path) !== entry) {
          renderer.release(handle);
          entry.resolve(null);
        } else {
          entry.image = handle;
          entry.bytes = handle.bytes;
          imageBytes += entry.bytes;
          entry.ready = true;
          entry.resolve(handle);
        }
        drain();
        requestReadyRedraw(path);
      })
      .catch(() => {
        activeRequests--;
        failures.add(path);
        if (images.get(path) === entry) images.delete(path);
        drain();
        entry.resolve(null);
        $('coords').textContent = 'Some image chunks failed · reload to retry';
        requestReadyRedraw(path);
      });
  }
}

function dropImage(path: string, entry: ImageEntry): void {
  images.delete(path);
  if (entry.ready && entry.image) {
    imageBytes -= entry.bytes;
    renderer.release(entry.image);
  }
}

/** Releases every texture, for example when another station loads. */
export function clearImages(): void {
  for (const [path, entry] of images) dropImage(path, entry);
  for (const pending of queue) pending.resolve(null);
  queue.length = 0;
  failures.clear();
  imageBytes = 0;
}

/**
 * Evicts least-recently-used textures once the cache exceeds its budget.
 * This viewport's images and the tiles prefetched for it are protected, and
 * the budget grows when a large viewport needs more than the target itself:
 * evicting what the next frame draws only causes churn and re-downloads.
 */
export function trimImages(): void {
  if (imageBytes <= CACHE_BYTES) return;
  let needed = 0;
  for (const key of new Set([...frameImages, ...prefetchImages])) needed += images.get(key)?.bytes || 0;
  const budget = Math.max(CACHE_BYTES, needed * 1.5);
  const now = performance.now();
  for (const [key, entry] of images) {
    if (imageBytes <= budget) break;
    // Tiles used within the last two seconds stay: a drag that changes
    // direction would otherwise evict and re-download its own prefetches.
    const protectedEntry =
      now - entry.used <= RECENT_USE_MS ||
      frameImages.has(key) ||
      prefetchImages.has(key) ||
      warmImages.has(key) ||
      key.endsWith('/overview.webp');
    if (entry.ready && !protectedEntry) dropImage(key, entry);
  }
}
