// Access to the exported station data: URL resolution, the offline asset
// cache and JSON loading. The cache reports its progress into the sidebar's
// "Offline storage" section and the floating activity badge.
import { AssetCache, type CacheProgress } from './asset-cache.ts';
import { $ } from '../core/dom.ts';
import type { Manifest } from '../core/types.ts';

/** Location of data/manifest.json. */
export const catalogBase = new URL('./data/', document.baseURI);

/** Location of the current snapshot's map folders; the manifest may point into a subfolder. */
let dataBase = catalogBase;

export function getDataBase(): URL {
  return dataBase;
}

export function setDataBase(url: URL): void {
  dataBase = url;
}

// The activity badge starts as a title plus a note; the progress bars are
// inserted here so the markup stays simple.
const cacheActivity = $('cache-activity');
cacheActivity.querySelector('small')!.id = 'cache-activity-note';
$('cache-activity-note').insertAdjacentHTML(
  'beforebegin',
  `<p id="cache-activity-status"></p>
<div class="cache-progress-label"><span>Current step</span><span id="cache-step-percent"></span></div>
<progress id="cache-step-progress" max="100" aria-label="Current cache step"></progress>
<div class="cache-progress-label"><span>Overall</span><span id="cache-overall-percent"></span></div>
<progress id="cache-overall-progress" max="100" aria-label="Overall cache preparation"></progress>
<p id="cache-remaining"></p>`,
);

function describeRemaining(progress: CacheProgress): string {
  const maps = `${progress.remainingMaps} ${progress.remainingMaps === 1 ? 'map' : 'maps'} left`;
  const percent = `${100 - progress.overallPercent}% remaining`;
  let time = 'Estimating time remaining';
  if (Number.isFinite(progress.remainingSeconds)) {
    const seconds = Math.ceil(progress.remainingSeconds!);
    const minutes = Math.floor(seconds / 60);
    time = `About ${minutes ? `${minutes}m ` : ''}${seconds % 60}s remaining`;
  }
  return `${percent} · ${maps} · ${time}`;
}

function updateCacheStatus(message: string, progress?: CacheProgress): void {
  $('cache-status').textContent = $('cache-activity-status').textContent = message;
  const bars: [string, number | undefined][] = [
    ['step', progress?.stepPercent],
    ['overall', progress?.overallPercent],
  ];
  for (const [kind, value] of bars) {
    const bar = $<HTMLProgressElement>(`cache-${kind}-progress`);
    if (Number.isFinite(value)) {
      bar.value = value!;
      $(`cache-${kind}-percent`).textContent = `${value}%`;
    } else {
      bar.removeAttribute('value');
      $(`cache-${kind}-percent`).textContent = '';
    }
  }
  $('cache-remaining').textContent = progress
    ? describeRemaining(progress)
    : 'Calculating overall progress...';
}

function showCacheActivity(active: boolean, info?: { currentReady: boolean }): void {
  cacheActivity.hidden = !active;
  if (!active) return;
  cacheActivity.querySelector('strong')!.textContent = info?.currentReady
    ? 'Current map is ready'
    : 'Preparing offline cache';
  $('cache-activity-note').textContent = info?.currentReady
    ? 'Other maps are still being downloaded and prepared in the background.'
    : 'The map may be slower while saving. Unready chunks may look blurry or pixelated.';
}

export const assetCache = new AssetCache(catalogBase.href, updateCacheStatus, showCacheActivity);

/**
 * Map-scoped resources carry their export version in the query string, so
 * hosts can mark them immutable while the file names stay stable.
 */
export function resolvePath(path: string): URL {
  return assetCache.versioned(new URL(path, dataBase), path);
}

export function fetchManifest(): Promise<Manifest> {
  return assetCache.catalog(new URL('manifest.json', catalogBase));
}

/** Loads a map-scoped JSON file through the cache. */
export async function fetchJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const blob = await assetCache.get(resolvePath(path), path);
  if (signal?.aborted) throw new DOMException('Map changed', 'AbortError');
  return JSON.parse(await blob.text()) as T;
}

/** Loads a map-scoped file as raw bytes, for transfer to a worker. */
export async function fetchBytes(path: string): Promise<ArrayBuffer> {
  return (await assetCache.get(resolvePath(path), path)).arrayBuffer();
}
