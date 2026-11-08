// Builds and queries the search index off the main thread. The page sends the
// raw search.json bytes; decoding them here keeps the large object graph out
// of the main thread entirely.
/// <reference lib="webworker" />
import { createSearchIndex, type SearchFilters, type SearchIndex } from '../model/search-index.ts';
import { decodeSearch } from '../../scripts/lib/map-format.mjs';
import type { Room, SearchItem } from '../core/types.ts';
import type { AreaSelection } from '../model/view-state.ts';
import { selectionTiles } from '../model/selection-data.ts';

export type SearchWorkerRequest =
  | {
      type: 'init';
      generation: number;
      rooms: Room[];
      buffer?: ArrayBuffer;
      items?: SearchItem[];
      url?: string;
    }
  | ({ type: 'query'; seq: number; query: string } & SearchFilters)
  | { type: 'locations'; seq: number; id: string }
  | { type: 'tile'; seq: number; tile: string; area?: AreaSelection | null };

const scope = self as unknown as DedicatedWorkerGlobalScope;
let index: SearchIndex | null = null;

async function loadItems(request: Extract<SearchWorkerRequest, { type: 'init' }>): Promise<SearchItem[]> {
  if (request.buffer) return decodeSearch(JSON.parse(new TextDecoder().decode(request.buffer)));
  if (request.items) return request.items;
  const response = await fetch(request.url!);
  if (!response.ok) throw new Error(`Search archive: HTTP ${response.status}`);
  return decodeSearch(await response.json());
}

scope.onmessage = async ({ data }: MessageEvent<SearchWorkerRequest>) => {
  if (data.type === 'init') {
    index = null;
    try {
      index = createSearchIndex(await loadItems(data), data.rooms);
      scope.postMessage({ type: 'ready', generation: data.generation });
    } catch (error) {
      scope.postMessage({ type: 'error', message: (error as Error).message, generation: data.generation });
    }
    return;
  }
  if (!index) return;
  if (data.type === 'query')
    scope.postMessage({ type: 'results', seq: data.seq, ...index.search(data.query, data) });
  if (data.type === 'locations')
    scope.postMessage({ type: 'locations', seq: data.seq, result: index.get(data.id) });
  if (data.type === 'tile') {
    const possible = data.area
      ? [
          ...new Map(
            selectionTiles(data.area)
              .flatMap((tile) => index!.at(`${tile.x},${tile.y},${tile.z}`))
              .map((item) => [JSON.stringify(item), item]),
          ).values(),
        ]
      : index.at(data.tile);
    scope.postMessage({ type: 'tile', seq: data.seq, possible });
  }
};
