import { datasets, getDataBase } from './source.ts';
import { $ } from '../core/dom.ts';
import { redraw } from '../core/frame.ts';
import type { SpriteDataset } from './sprite-diff-worker.ts';
import { state, type DeckLevel, type ViewerState } from '../core/state.ts';
import type { LevelData, Manifest, MapMeta } from '../core/types.ts';
import { decodeLevel, decodeMap, SCHEMA } from '../../scripts/lib/map-format.mjs';
import { compareDeck } from '../../scripts/lib/dataset-diff.mjs';

export const oldView: ViewerState = { ...state, map: null, levels: new Map() };
let base = datasets.old;
let manifestPromise: Promise<Manifest> | undefined;
export const changedKeys = new Set<string>();
let spriteWorker: Worker | undefined;

export function stopSpriteComparison(): void {
  spriteWorker?.terminate();
  spriteWorker = undefined;
}

export function startSpriteComparison(): void {
  stopSpriteComparison();
  if (!datasets.comparing || !oldView.map) return;
  const descriptor = (view: ViewerState, base: URL): SpriteDataset => ({
    base: base.href,
    id: view.map!.id,
    width: view.map!.width,
    height: view.map!.height,
    tilePixels: view.manifest!.tilePixels,
    chunkTiles: view.manifest!.chunkTiles,
    version:
      view.manifest!.maps.find((map) => map.id === view.map!.id)?.assetVersion ||
      view.manifest!.buildId ||
      view.manifest!.commit,
    levels: [...view.levels].map(([z, level]) => [z, level.pyramid[0]]),
  });
  const worker = (spriteWorker = new Worker(new URL('./sprite-diff-worker.ts', import.meta.url), {
    type: 'module',
  }));
  const summary = (note: string) => {
    $('comparison-summary').textContent =
      `${state.changedTiles.length} changed tiles. Green: added; red: removed; amber: modified; blue: sprite only. ${note}`;
  };
  summary('Checking native sprites…');
  worker.onmessage = (event) => {
    if (worker !== spriteWorker) return;
    for (const tile of event.data.changes || []) {
      const key = `${tile.x},${tile.y},${tile.z}`;
      if (changedKeys.has(key)) continue;
      changedKeys.add(key);
      state.changedTiles.push(tile);
    }
    summary(
      event.data.error
        ? `Sprite check incomplete: ${event.data.error}`
        : event.data.done
          ? 'Sprite check complete.'
          : 'Checking native sprites…',
    );
    document.dispatchEvent(new Event('atlas-comparison-updated'));
    redraw();
    if (event.data.done || event.data.error) stopSpriteComparison();
  };
  worker.onerror = () => {
    summary('Sprite check unavailable; source changes are highlighted.');
    stopSpriteComparison();
  };
  worker.postMessage({ before: descriptor(oldView, base), after: descriptor(state, getDataBase()) });
}

async function json(url: URL, signal?: AbortSignal) {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`${response.status}: ${url.pathname}`);
  return response.json();
}

export function oldAssetUrl(path: string): URL {
  const url = new URL(path, base);
  const map = oldView.manifest?.maps.find((map) => map.id === path.split('/')[0]);
  url.searchParams.set('v', map?.assetVersion || oldView.manifest?.buildId || oldView.manifest?.commit || '');
  return url;
}

export async function loadComparison(id: string, generation: number, signal: AbortSignal): Promise<void> {
  stopSpriteComparison();
  changedKeys.clear();
  state.changedTiles = [];
  state.comparisonBounds = undefined;
  oldView.map = null;
  oldView.levels = new Map();
  if (!datasets.comparing) return;
  manifestPromise ??= json(datasets.old).then((manifest: Manifest & { complete?: boolean }) => {
    if (manifest.schema !== SCHEMA || manifest.complete === false || !Array.isArray(manifest.maps))
      throw new Error('The old dataset is incomplete or uses an unsupported schema');
    return manifest;
  });
  const manifest = await manifestPromise;
  if (!manifest.maps.some((map) => map.id === id))
    throw new Error(`The old dataset does not contain station ${id}`);
  const dataBase = new URL(manifest.dataPath || './', datasets.old);
  const map = decodeMap(await json(new URL(`${id}/map.json`, dataBase), signal)) as MapMeta;
  const levels = await Promise.all(
    map.levels.map(async (z) => {
      const level = decodeLevel(await json(new URL(`${id}/${z}.json`, dataBase), signal)) as LevelData;
      return [
        z,
        {
          ...level,
          tileMasks: level.pyramid.map((tiles) => new Map(tiles.map(([x, y, mask]) => [`${x},${y}`, mask]))),
        },
      ] as [number, DeckLevel];
    }),
  );
  if (generation !== state.generation) return;
  base = dataBase;
  oldView.manifest = manifest;
  oldView.map = map;
  oldView.levels = new Map(levels);
  state.comparisonBounds = {
    width: Math.max(map.width, state.map!.width),
    height: Math.max(map.height, state.map!.height),
    offsetY: Math.max(0, map.height - state.map!.height) * 32,
  };
  state.changedTiles = comparisonLevels().flatMap((z) =>
    compareDeck(map, oldView.levels.get(z), state.map!, state.levels.get(z), z),
  );
  for (const tile of state.changedTiles) changedKeys.add(`${tile.x},${tile.y},${tile.z}`);
}

export function comparisonLevels(): number[] {
  return [...new Set([...(state.map?.levels || []), ...(oldView.map?.levels || [])])].sort((a, b) => a - b);
}

/** Selection validation includes tiles and decks present only in the old revision. */
export function comparisonMap(): MapMeta {
  const map = state.map!;
  return state.comparisonBounds ? { ...map, ...state.comparisonBounds, levels: comparisonLevels() } : map;
}

export function previousDefinition(x: number, y: number, z: number) {
  const map = oldView.map;
  if (!map || x < 1 || x > map.width || y < 1 || y > map.height) return undefined;
  return map.definitions[oldView.levels.get(z)?.grid[(map.height - y) * map.width + x - 1] ?? -1];
}
