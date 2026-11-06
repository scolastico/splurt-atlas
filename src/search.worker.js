import { createSearchIndex } from './search-index.js';
import { decodeSearch } from '../scripts/lib/map-format.mjs';
let index;
self.onmessage = async ({ data }) => {
  if (data.type === 'init') {
    index = null;
    try {
      let items = data.items;
      if (data.buffer) items = decodeSearch(JSON.parse(new TextDecoder().decode(data.buffer)));
      if (!items) {
        const response = await fetch(data.url);
        if (!response.ok) throw new Error(`Search archive: HTTP ${response.status}`);
        items = decodeSearch(await response.json());
      }
      index = createSearchIndex(items, data.rooms);
      self.postMessage({ type: 'ready', generation: data.generation });
    } catch (error) {
      self.postMessage({ type: 'error', message: error.message, generation: data.generation });
    }
    return;
  }
  if (!index) return;
  if (data.type === 'query')
    self.postMessage({ type: 'results', seq: data.seq, ...index.search(data.query, data) });
  if (data.type === 'locations')
    self.postMessage({ type: 'locations', seq: data.seq, result: index.get(data.id) });
  if (data.type === 'tile') self.postMessage({ type: 'tile', seq: data.seq, possible: index.at(data.tile) });
};
