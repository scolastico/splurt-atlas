// Search rooms, placed items and possible loot, grouping indistinguishable names.
// Runs inside the search worker.
import Fuse from 'fuse.js';
import type { Room, SearchHit, SearchItem, SearchRecord, TileCandidate } from '../core/types.ts';

export interface SearchFilters {
  placed: boolean;
  possible: boolean;
  exact?: boolean;
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
  paths: Set<string>;
}

export function createSearchIndex(items: SearchItem[], rooms: Room[]): SearchIndex {
  const groups = new Map<string, Group>();
  const aliases = new Map<string, string>();
  const ids = new Set<string>();
  const records = [...rooms.map((room) => ({ ...room, kind: 'room' as const })), ...items];
  for (const record of records) {
    const alias = `${record.kind}:${record.path}`;
    const key = `${record.kind}:${record.name.trim().toLowerCase()}`;
    let group = groups.get(key);
    if (!group) {
      const id = ids.has(alias) ? `${alias}:${encodeURIComponent(record.name)}` : alias;
      ids.add(id);
      group = {
        id,
        name: record.name,
        path: record.path,
        kind: record.kind,
        region: 'region' in record ? record.region : undefined,
        points: [],
        sources: new Set(),
        seen: new Set(),
        paths: new Set(),
      };
      groups.set(key, group);
    }
    if (!aliases.has(alias)) aliases.set(alias, group.id);
    group.paths.add(record.path);
    if ('spawner' in record && record.spawner) group.sources.add(record.spawner);
    for (let i = 0; i < record.points.length; i += 3) {
      const pointKey = record.points.slice(i, i + 3).join(',');
      if (!group.seen.has(pointKey)) {
        group.seen.add(pointKey);
        group.points.push(...record.points.slice(i, i + 3));
      }
    }
  }
  const all = [...groups.values()].map(({ seen: _seen, sources, paths, ...record }) => ({
    ...record,
    paths: [...paths],
    spawners: [...sources],
    count: record.points.length / 3,
  }));
  const byId = new Map<string, SearchRecord>(all.map((record) => [record.id, record]));
  for (const [alias, id] of aliases) byId.set(alias, byId.get(id)!);
  const combinedById = new Map<string, SearchRecord>();
  const placedByName = new Map(
    all
      .filter((record) => record.kind === 'placed')
      .map((record) => [record.name.trim().toLowerCase(), record]),
  );
  for (const possible of all.filter((record) => record.kind === 'possible')) {
    const placed = placedByName.get(possible.name.trim().toLowerCase());
    if (!placed) continue;
    const points = [...placed.points];
    const seen = new Set<string>();
    for (let p = 0; p < points.length; p += 3) seen.add(points.slice(p, p + 3).join(','));
    for (let p = 0; p < possible.points.length; p += 3) {
      const key = possible.points.slice(p, p + 3).join(',');
      if (!seen.has(key)) {
        seen.add(key);
        points.push(...possible.points.slice(p, p + 3));
      }
    }
    const record: SearchRecord = {
      ...placed,
      id: `combined:${placed.id}`,
      kinds: ['placed', 'possible'],
      placedPoints: placed.points,
      points,
      count: points.length / 3,
      spawners: [...new Set([...placed.spawners, ...possible.spawners])],
    };
    byId.set(record.id, record);
    combinedById.set(placed.id, record);
    combinedById.set(possible.id, record);
  }
  const tiles = new Map<string, TileCandidate[]>();
  const tileSeen = new Map<string, Set<string>>();
  // Preserve the actual type on each tile even when search combines same-name variants.
  for (const record of items)
    if (record.kind === 'possible')
      for (let p = 0; p < record.points.length; p += 3) {
        const key = record.points.slice(p, p + 3).join(',');
        let candidates = tiles.get(key);
        if (!candidates) tiles.set(key, (candidates = []));
        let seen = tileSeen.get(key);
        if (!seen) tileSeen.set(key, (seen = new Set()));
        if (seen.has(record.path)) continue;
        seen.add(record.path);
        candidates.push({ name: record.name, path: record.path });
      }
  const fuse = new Fuse(all, {
    keys: [
      { name: 'name', weight: 0.75 },
      { name: 'paths', weight: 0.2 },
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
      const needle = trimmed.toLowerCase();
      const rank = (item: (typeof all)[number]): number => {
        const name = item.name.toLowerCase();
        if (name === needle) return 0;
        if (name.startsWith(needle)) return 1;
        if (name.includes(needle)) return 2;
        if (item.paths.some((path) => path.toLowerCase().includes(needle))) return 3;
        if (item.region?.toLowerCase().includes(needle)) return 4;
        return 5;
      };
      const candidates = filters.exact
        ? all.filter((item) => rank(item) < 5).map((item) => ({ item, score: 0 }))
        : fuse.search(trimmed);
      const seen = new Set<string>();
      const matches = candidates
        .filter(({ item }) => item.kind === 'room' || filters[item.kind])
        .sort(
          (a, b) =>
            rank(a.item) - rank(b.item) ||
            (a.score || 0) - (b.score || 0) ||
            a.item.name.localeCompare(b.item.name) ||
            a.item.id.localeCompare(b.item.id),
        )
        .map(({ item }) => (filters.placed && filters.possible ? combinedById.get(item.id) || item : item))
        .filter((item) => {
          if (seen.has(item.id)) return false;
          seen.add(item.id);
          return true;
        });
      return {
        total: matches.length,
        results: matches.slice(0, MAX_RESULTS).map((item) => {
          const {
            points: _points,
            placedPoints: _placed,
            spawners: _spawners,
            paths: _paths,
            ...record
          } = item as SearchRecord & { paths?: string[] };
          return record;
        }),
      };
    },
  };
}
