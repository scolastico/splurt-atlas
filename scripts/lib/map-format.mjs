// Compact on-disk metadata (schema 3) shared by the exporter and the viewer.
// Repeated atom records, strings and access rules are stored once and
// referenced by index; grids are run-length encoded; every image channel of a
// chunk lives in one vertical sprite strip addressed through a channel bitmask.
export const SCHEMA = 3;
export const CHANNELS = [
  'base',
  'foreground',
  'pipes',
  'power',
  'fluid',
  'disposal',
  'transit',
  'disposal-surface',
  'pipes-surface',
  'power-surface',
  'fluid-surface',
  'natural',
  // Mapper-only markers such as mail sorting or area helpers; hidden by default.
  'helpers',
];
export const UTILITIES = ['disposal', 'pipes', 'power', 'fluid', 'transit'];
// Overview strips: terrain channels in overview.webp, everything else in overview-utilities.webp.
export const OVERVIEW_TERRAIN = ['base', 'foreground', 'natural'];
// Coarser levels of detail: level L packs 2^L × 2^L chunks into one strip.
export const LODS = [1, 2];

export const channelBit = (channel) => CHANNELS.indexOf(channel);
export const channelMask = (channels) =>
  channels.reduce((mask, channel) => {
    const bit = channelBit(channel);
    if (bit < 0) throw new Error(`Unknown channel ${channel}`);
    return mask | (1 << bit);
  }, 0);
export const hasChannel = (mask, channel) => {
  const bit = channelBit(channel);
  return bit >= 0 && !!((mask >> bit) & 1);
};
export const maskChannels = (mask) => CHANNELS.filter((channel, bit) => (mask >> bit) & 1);
export function slotIndex(mask, channel) {
  const bit = channelBit(channel);
  if (bit < 0 || !((mask >> bit) & 1)) return -1;
  let slot = 0;
  for (let index = 0; index < bit; index++) if ((mask >> index) & 1) slot++;
  return slot;
}
export const slotCount = (mask) => maskChannels(mask).length;
export const stripName = (x, y, lod = 0) => `${lod ? `l${lod}` : 'c'}-${x}-${y}.webp`;

class Interner {
  constructor() {
    this.list = [];
    this.index = new Map();
  }
  id(key, value = key) {
    let id = this.index.get(key);
    if (id === undefined) {
      id = this.list.length;
      this.index.set(key, id);
      this.list.push(value);
    }
    return id;
  }
}

export function encodeMap(meta) {
  const strings = new Interner(),
    values = new Interner(),
    atoms = new Interner();
  const S = (text) => (text == null ? -1 : strings.id(String(text)));
  const V = (value) => (value === undefined ? -1 : values.id(JSON.stringify(value), value));
  const definitions = meta.definitions.map((definition) => [
    definition.area,
    S(definition.turf),
    definition.aperture,
    V(definition.runtimeTerrain),
    ...definition.atoms.map((atom) =>
      atoms.id(JSON.stringify(atom), [
        S(atom.path),
        S(atom.name),
        S(atom.description),
        S(atom.source),
        S(atom.network),
        Object.keys(atom.vars || {}).length ? V(atom.vars) : -1,
        V(atom.visual),
        V(atom.doorAccess),
        V(atom.controlKeys),
      ]),
    ),
  ]);
  const nodes = meta.infrastructure?.nodes || [],
    keys = [...new Set(nodes.flatMap((node) => Object.keys(node)))].filter((key) => key !== 'id');
  const columns = {},
    types = {};
  for (const key of keys) {
    const sample = nodes.map((node) => node[key]).find((value) => value != null);
    types[key] = typeof sample === 'string' ? 's' : typeof sample === 'boolean' ? 'b' : 'n';
    columns[key] = nodes.map((node) => {
      const value = node[key];
      return value == null
        ? null
        : types[key] === 's'
          ? S(value)
          : types[key] === 'b'
            ? value
              ? 1
              : 0
            : value;
    });
  }
  const { definitions: _definitions, infrastructure, ...rest } = meta;
  return {
    schema: SCHEMA,
    ...rest,
    strings: strings.list,
    values: values.list,
    atoms: atoms.list,
    definitions,
    infrastructure: infrastructure
      ? { ...infrastructure, nodes: { count: nodes.length, types, columns } }
      : infrastructure,
  };
}

export function decodeMap(data) {
  if (!data?.strings) return data;
  const { strings, values, atoms: packed, definitions: packedDefinitions, infrastructure, ...rest } = data;
  const str = (index) => (index < 0 ? null : strings[index]);
  const atoms = packed.map(
    ([path, name, description, source, network, vars, visual, doorAccess, controlKeys]) => {
      const atom = {
        path: str(path),
        name: str(name),
        description: str(description),
        network: str(network),
        vars: vars < 0 ? {} : values[vars],
        source: str(source),
      };
      if (visual >= 0) atom.visual = values[visual];
      if (doorAccess >= 0) atom.doorAccess = values[doorAccess];
      if (controlKeys >= 0) atom.controlKeys = values[controlKeys];
      return atom;
    },
  );
  const definitions = packedDefinitions.map(([area, turf, aperture, runtimeTerrain, ...ids]) => {
    const definition = { area, turf: str(turf), aperture, atoms: ids.map((id) => atoms[id]) };
    if (runtimeTerrain >= 0) definition.runtimeTerrain = values[runtimeTerrain];
    return definition;
  });
  let nodes = infrastructure?.nodes;
  if (nodes && !Array.isArray(nodes)) {
    const { count, types, columns } = nodes,
      keys = Object.keys(columns);
    nodes = Array.from({ length: count }, (_, id) => {
      const node = { id };
      for (const key of keys) {
        const value = columns[key][id];
        node[key] =
          value === null
            ? null
            : types[key] === 's'
              ? strings[value]
              : types[key] === 'b'
                ? value === 1
                : value;
      }
      return node;
    });
  }
  return {
    ...rest,
    definitions,
    infrastructure: infrastructure ? { ...infrastructure, nodes } : infrastructure,
  };
}

export function runLength(grid) {
  const runs = [];
  for (let index = 0; index < grid.length; ) {
    let end = index;
    while (end < grid.length && grid[end] === grid[index]) end++;
    runs.push(grid[index], end - index);
    index = end;
  }
  return runs;
}
export function expandRuns(runs, length) {
  const grid = new Int32Array(length);
  let cursor = 0;
  for (let index = 0; index < runs.length; index += 2) {
    const value = runs[index],
      count = runs[index + 1];
    if (cursor + count > length) throw new Error('Grid runs exceed the map size');
    grid.fill(value, cursor, cursor + count);
    cursor += count;
  }
  if (cursor !== length) throw new Error('Grid runs do not cover the map');
  return grid;
}
const spaceTurf = /\/space(?:\/|$)|\/openspace/;
export function levelBounds(grid, width, height, definitions) {
  let minX = width,
    minY = height,
    maxX = 0,
    maxY = 0;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const definition = definitions[grid[y * width + x]];
      if (definition && !spaceTurf.test(definition.turf)) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x + 1 > maxX) maxX = x + 1;
        if (y + 1 > maxY) maxY = y + 1;
      }
    }
  return maxX > minX ? [minX, minY, maxX, maxY] : null;
}
export function encodeLevel({ z, grid, pyramid, overview, overviewUtilities = 0, bounds = null }) {
  return {
    schema: SCHEMA,
    z,
    cells: grid.length,
    grid: runLength(grid),
    bounds,
    pyramid,
    overview,
    overviewUtilities,
  };
}
export function decodeLevel(level) {
  if (level.schema !== SCHEMA)
    throw new Error(`Unsupported level schema ${level.schema ?? 'legacy'}; export the maps again`);
  return { ...level, grid: expandRuns(level.grid, level.cells) };
}

export function encodeSearch(items) {
  const strings = new Interner(),
    sets = new Interner();
  const S = (text) => (text == null ? -1 : strings.id(String(text)));
  return {
    schema: SCHEMA,
    strings: strings.list,
    items: items.map((item) => [
      S(item.path),
      S(item.name),
      item.kind === 'placed' ? 0 : 1,
      S(item.spawner),
      sets.id(item.points.join(','), item.points),
    ]),
    sets: sets.list,
  };
}
export function decodeSearch(data) {
  if (Array.isArray(data)) return data;
  const str = (index) => (index < 0 ? null : data.strings[index]);
  return data.items.map(([path, name, kind, spawner, set]) => {
    const item = {
      path: str(path),
      name: str(name),
      kind: kind ? 'possible' : 'placed',
      points: data.sets[set],
    };
    if (spawner >= 0) item.spawner = str(spawner);
    return item;
  });
}
