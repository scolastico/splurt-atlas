import Fuse from 'fuse.js';

export function createSearchIndex(items, rooms) {
  const groups = new Map();
  for (const record of [...rooms.map((room) => ({ ...room, kind: 'room' })), ...items]) {
    const key = `${record.kind}:${record.path}`;
    if (!groups.has(key))
      groups.set(key, {
        id: key,
        name: record.name,
        path: record.path,
        kind: record.kind,
        region: record.region,
        points: [],
        sources: new Set(),
        seen: new Set(),
      });
    const group = groups.get(key);
    if (record.spawner) group.sources.add(record.spawner);
    for (let i = 0; i < record.points.length; i += 3) {
      const key = record.points.slice(i, i + 3).join(',');
      if (!group.seen.has(key)) {
        group.seen.add(key);
        group.points.push(...record.points.slice(i, i + 3));
      }
    }
  }
  const records = [...groups.values()].map(({ seen, sources, ...record }) => ({
    ...record,
    spawners: [...sources],
    count: record.points.length / 3,
  }));
  const byId = new Map(records.map((record) => [record.id, record]));
  const tiles = new Map();
  for (const record of records)
    if (record.kind === 'possible')
      for (let p = 0; p < record.points.length; p += 3) {
        const key = record.points.slice(p, p + 3).join(',');
        if (!tiles.has(key)) tiles.set(key, []);
        tiles.get(key).push({ name: record.name, path: record.path });
      }
  const fuse = new Fuse(records, {
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
      if (!query.trim()) return { results: [], total: 0 };
      const matches = fuse
        .search(query.trim())
        .map((result) => result.item)
        .filter((item) => item.kind === 'room' || filters[item.kind]);
      return {
        total: matches.length,
        results: matches.slice(0, 70).map(({ points, spawners, ...record }) => record),
      };
    },
  };
}
