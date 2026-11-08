import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CHANNELS,
  channelMask,
  slotIndex,
  maskChannels,
  stripName,
  encodeMap,
  decodeMap,
  encodeLevel,
  decodeLevel,
  encodeSearch,
  decodeSearch,
  runLength,
  expandRuns,
  levelBounds,
} from '../scripts/lib/map-format.mjs';

const door = {
  path: '/obj/machinery/door/airlock',
  name: 'Airlock',
  description: 'It opens.',
  network: null,
  vars: { name: '"Airlock"' },
  source: 'code/doors.dm',
  doorAccess: {
    kind: 'restricted',
    roles: ['Captain'],
    expandedRoles: [],
    sources: { requirements: [], helpers: [] },
  },
  controlKeys: [],
};
const wall = {
  path: '/turf/closed/wall',
  name: 'wall',
  description: '',
  network: null,
  vars: {},
  source: 'code/walls.dm',
};
const pipe = {
  path: '/obj/machinery/atmospherics/pipe',
  name: 'pipe',
  description: null,
  network: 'pipes',
  vars: { dir: '4' },
  source: null,
  visual: { x: 3, y: -4, width: 20, height: 12 },
};
const meta = {
  id: 'fixture',
  name: 'Fixture',
  width: 3,
  height: 2,
  levels: [1],
  areas: [{ path: '/area/a', name: 'A', region: 'a', gravity: null, source: null }],
  rooms: [],
  jobRoles: ['Captain'],
  jobRoleSources: {},
  doorControls: [],
  files: ['_maps/fixture.dmm'],
  traits: [],
  unresolvedSpawners: [],
  definitions: [
    { area: 0, turf: '/turf/closed/wall', aperture: 0, atoms: [wall] },
    {
      area: 0,
      turf: '/turf/closed/wall',
      aperture: 0,
      atoms: [door, wall],
      runtimeTerrain: { type: '/turf/open/snow', name: 'snow', description: 'Cold.', approximate: true },
    },
    { area: 0, turf: '/turf/closed/wall', aperture: 0, atoms: [pipe, door, wall] },
  ],
  infrastructure: {
    powerNetworks: 1,
    nodes: [
      {
        id: 0,
        x: 1,
        y: 1,
        z: 1,
        channel: 'pipes',
        layer: 3,
        ports: 15,
        links: 6,
        network: 0,
        exposed: false,
        color: '#0000FF',
        simpleEligible: true,
      },
      {
        id: 1,
        x: 2,
        y: 1,
        z: 1,
        channel: 'power',
        layer: 2,
        ports: 3,
        links: 1,
        network: 0,
        exposed: true,
        color: null,
        simpleEligible: false,
      },
    ],
    transitions: [{ x: 1, y: 2, z: 1, kind: 'Stairs', targets: [] }],
  },
};

test('map metadata round-trips through shared atom, string and value tables', () => {
  const packed = encodeMap(meta),
    text = JSON.stringify(packed);
  assert.equal(packed.schema, 3);
  assert.equal(packed.atoms.length, 3, 'identical atoms are stored once');
  assert.ok(text.length < JSON.stringify(meta).length);
  const restored = decodeMap(packed);
  assert.deepEqual(JSON.parse(JSON.stringify(restored)), JSON.parse(JSON.stringify({ schema: 3, ...meta })));
  assert.equal(
    restored.definitions[1].atoms[0],
    restored.definitions[2].atoms[1],
    'decoded definitions share atom objects',
  );
  assert.equal(restored.infrastructure.nodes[1].color, null);
  assert.equal(restored.infrastructure.nodes[0].exposed, false);
  assert.equal(decodeMap(JSON.parse(text)).definitions[2].atoms[0].visual.width, 20);
  const legacy = { definitions: [], width: 1 };
  assert.equal(decodeMap(legacy), legacy, 'already expanded metadata passes through');
});
test('levels store run-length grids, bounds and chunk channel masks', () => {
  const grid = Int32Array.from([-1, -1, 0, 1, 1, 2]);
  assert.deepEqual(runLength(grid), [-1, 2, 0, 1, 1, 2, 2, 1]);
  assert.deepEqual([...expandRuns(runLength(grid), 6)], [...grid]);
  assert.throws(() => expandRuns([0, 5], 6), /cover/);
  assert.throws(() => expandRuns([0, 7], 6), /exceed/);
  const definitions = [
    { turf: '/turf/open/space' },
    { turf: '/turf/open/floor' },
    { turf: '/turf/open/openspace' },
  ];
  assert.deepEqual(levelBounds(grid, 3, 2, definitions), [0, 1, 2, 2]);
  assert.equal(levelBounds(Int32Array.from([0, 0, 2, 2, -1, -1]), 3, 2, definitions), null);
  const mask = channelMask(['base', 'foreground', 'transit']);
  const level = decodeLevel(
    JSON.parse(
      JSON.stringify(
        encodeLevel({
          z: 2,
          grid,
          pyramid: [
            [
              [0, 0, mask],
              [1, 0, mask],
            ],
            [[0, 0, mask]],
            [[0, 0, mask]],
          ],
          overview: mask,
          bounds: [0, 1, 2, 2],
        }),
      ),
    ),
  );
  assert.deepEqual([...level.grid], [...grid]);
  assert.equal(level.z, 2);
  assert.equal(level.pyramid.length, 3);
  assert.deepEqual(level.pyramid[0][1], [1, 0, mask]);
  assert.deepEqual(level.bounds, [0, 1, 2, 2]);
  assert.equal(level.overviewUtilities, 0);
  assert.throws(() => decodeLevel({ z: 1, grid: [0, 1] }), /schema/);
});
test('strip slots follow the canonical channel order and skip absent channels', () => {
  const mask = channelMask(['foreground', 'transit', 'natural']);
  assert.deepEqual(maskChannels(mask), ['foreground', 'transit', 'natural']);
  assert.equal(slotIndex(mask, 'foreground'), 0);
  assert.equal(slotIndex(mask, 'transit'), 1);
  assert.equal(slotIndex(mask, 'natural'), 2);
  assert.equal(slotIndex(mask, 'base'), -1);
  assert.equal(slotIndex(mask, 'unknown'), -1);
  assert.equal(slotIndex(channelMask(CHANNELS), 'natural'), CHANNELS.indexOf('natural'));
  assert.equal(slotIndex(channelMask(CHANNELS), 'helpers'), 12);
  assert.equal(slotIndex(channelMask(CHANNELS), 'navigation-surface'), 14);
  assert.equal(slotIndex(channelMask(CHANNELS), 'pipes-equipment'), CHANNELS.length - 1);
  assert.throws(() => channelMask(['sky']), /Unknown channel/);
  assert.equal(stripName(3, 4), 'c-3-4.webp');
  assert.equal(stripName(3, 4, 2), 'l2-3-4.webp');
});
test('search records share point sets and spawner strings', () => {
  const items = [
    {
      path: '/obj/item/wrench',
      name: 'wrench',
      kind: 'possible',
      spawner: '/obj/effect/spawner/random/maintenance',
      points: [1, 2, 1, 3, 4, 2],
    },
    {
      path: '/obj/item/screwdriver',
      name: 'screwdriver',
      kind: 'possible',
      spawner: '/obj/effect/spawner/random/maintenance',
      points: [1, 2, 1, 3, 4, 2],
    },
    { path: '/obj/item/wrench', name: 'wrench', kind: 'placed', points: [7, 8, 1] },
  ];
  const packed = encodeSearch(items);
  assert.equal(packed.sets.length, 2);
  const restored = decodeSearch(JSON.parse(JSON.stringify(packed)));
  assert.deepEqual(restored, items);
  assert.equal(restored[0].points, restored[1].points, 'identical point lists are shared after decoding');
  assert.equal(Object.hasOwn(restored[2], 'spawner'), false);
  assert.equal(decodeSearch(items), items);
});
