// Fuzzy search over rooms, placed items and possible loot, grouped per type.
// Runs inside the search worker.
import Fuse from 'fuse.js';
import type { Room, SearchHit, SearchItem, SearchRecord, TileCandidate } from '../core/types.ts';

export interface SearchFilters {
  placed: boolean;
  possible: boolean;
}

export interface SearchResults {
  results: SearchHit[];
  total: number;
}

export interface SearchIndex {
  /** The full record, including its locations. */
  get(id: string): SearchRecord | undefined;
  /** Possible spawns recorded on a tile, keyed as "x,y,z". */
  at(tile: string): TileCandidate[];
  search(query: string, filters: SearchFilters): SearchResults;
}

const MAX_RESULTS = 70;

interface Group extends Omit<SearchRecord, 'spawners' | 'count'> {
  sources: Set<string>;
  seen: Set<string>;
}

export function createSearchIndex(items: SearchItem[], rooms: Room[]): SearchIndex {
  const groups = new Map<string, Group>();
  const records = [...rooms.map((room) => ({ ...room, kind: 'room' as const })), ...items];
  for (const record of records) {
    const key = `${record.kind}:${record.path}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        id: key,
        name: record.name,
        path: record.path,
        kind: record.kind,
        region: 'region' in record ? record.region : undefined,
        points: [],
        sources: new Set(),
        seen: new Set(),
      };
      groups.set(key, group);
    }
    if ('spawner' in record && record.spawner) group.sources.add(record.spawner);
    for (let i = 0; i < record.points.length; i += 3) {
      const pointKey = record.points.slice(i, i + 3).join(',');
      if (!group.seen.has(pointKey)) {
        group.seen.add(pointKey);
        group.points.push(...record.points.slice(i, i + 3));
      }
    }
  }
  const all: SearchRecord[] = [...groups.values()].map(({ seen: _seen, sources, ...record }) => ({
    ...record,
    spawners: [...sources],
    count: record.points.length / 3,
  }));
  const byId = new Map(all.map((record) => [record.id, record]));
  const tiles = new Map<string, TileCandidate[]>();
  for (const record of all)
    if (record.kind === 'possible')
      for (let p = 0; p < record.points.length; p += 3) {
        const key = record.points.slice(p, p + 3).join(',');
        let candidates = tiles.get(key);
        if (!candidates) tiles.set(key, (candidates = []));
        candidates.push({ name: record.name, path: record.path });
      }
  const fuse = new Fuse(all, {
    keys: [
      { name: 'name', weight: 0.75 },
      { name: 'path', weight: 0.2 },
      { name: 'region', weight: 0.05 },
    ],
    threshold: 0.38,
    ignoreLocation: true,
    includeScore: true,
    minMatchCharLength: 1,
  });
  return {
    get: (id) => byId.get(id),
    at: (tile) => tiles.get(tile) || [],
    search(query, filters) {
      const trimmed = query.trim();
      if (!trimmed) return { results: [], total: 0 };
      const matches = fuse
        .search(trimmed)
        .map((result) => result.item)
        .filter((item) => item.kind === 'room' || filters[item.kind]);
      return {
        total: matches.length,
        results: matches
          .slice(0, MAX_RESULTS)
          .map(({ points: _points, spawners: _spawners, ...record }) => record),
      };
    },
  };
}
