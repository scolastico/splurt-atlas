import type { LevelData, MapMeta, Network } from '../core/types.ts';

export interface MapStatistic {
  label: string;
  value: string;
  id?: string;
}

/** Counts mapped positions, rather than counting shared dictionary definitions once. */
export function mapStatistics(map: MapMeta, levels: Iterable<LevelData>): MapStatistic[] {
  const format = (value: number) => value.toLocaleString('en-US');
  const frequency = new Map<number, number>();
  for (const level of levels)
    for (const id of level.grid) if (map.definitions[id]) frequency.set(id, (frequency.get(id) || 0) + 1);
  let terrain = 0,
    objects = 0,
    random = 0,
    doors = 0;
  const types = new Set<string>();
  for (const [id, count] of frequency) {
    const definition = map.definitions[id];
    if (!/\/(space|openspace)(?:\/|$)/.test(definition.turf)) terrain += count;
    for (const atom of definition.atoms) {
      if (!/^\/(obj|mob)\//.test(atom.path)) continue;
      objects += count;
      types.add(atom.path);
      if (atom.random) random += count;
      if (/^\/obj\/(machinery|structure)\/door(?:\/|$)/.test(atom.path)) doors += count;
    }
  }
  const nodes = new Map<Network, number>();
  for (const node of map.infrastructure?.nodes || [])
    nodes.set(node.channel, (nodes.get(node.channel) || 0) + 1);
  return [
    { label: 'Grid per deck', value: `${map.width} × ${map.height}` },
    { label: 'Decks', value: format(map.levels.length) },
    { label: 'Grid tiles', value: format(map.width * map.height * map.levels.length) },
    { label: 'Non-space tiles', value: format(terrain) },
    { label: 'Mapped areas', value: format(map.areas.length) },
    { label: 'Mapped objects', value: format(objects) },
    { label: 'Object types', value: format(types.size) },
    { label: 'Randomized objects', value: format(random) },
    { label: 'Doors', value: format(doors) },
    { label: 'Deck connection markers', value: format(map.infrastructure?.transitions.length || 0) },
    { label: 'Power networks', value: format(map.infrastructure?.powerNetworks || 0), id: 'network-summary' },
    ...(
      [
        ['power', 'Power cable segments'],
        ['pipes', 'Atmos nodes'],
        ['disposal', 'Disposal segments'],
        ['fluid', 'Fluid ducts'],
        ['navigation', 'Navigation beacons'],
        ['transit', 'Transit tube sections'],
      ] as [Network, string][]
    ).map(([key, label]) => ({ label, value: format(nodes.get(key) || 0) })),
  ];
}
