import test from 'node:test';
import assert from 'node:assert/strict';
import { mapStatistics } from '../src/model/map-statistics.ts';
import { boundedCamera } from '../src/model/camera-bounds.ts';

test('statistics count all mapped positions across decks, retaining one consistent label/value format', () => {
  const map = {
    width: 2,
    height: 2,
    levels: [1, 3],
    areas: [{}, {}],
    definitions: [
      {
        turf: '/turf/open/floor/iron',
        atoms: [
          { path: '/turf/open/floor/iron' },
          { path: '/obj/structure/bookcase/random', random: { kind: 'bookcase' } },
          { path: '/obj/machinery/door/airlock' },
        ],
      },
      { turf: '/turf/open/space', atoms: [{ path: '/turf/open/space' }] },
    ],
    infrastructure: {
      powerNetworks: 12,
      nodes: [{ channel: 'power' }, { channel: 'power' }, { channel: 'pipes' }],
      transitions: [{}, {}],
    },
  };
  const rows = mapStatistics(map, [
    { grid: new Int32Array([0, 0, 1, -1]) },
    { grid: new Int32Array([1, 0, 1, 0]) },
  ]);
  const stats = Object.fromEntries(rows.map((row) => [row.label, row.value]));
  assert.deepEqual(
    { ...stats },
    {
      'Grid per deck': '2 × 2',
      Decks: '2',
      'Grid tiles': '8',
      'Non-space tiles': '4',
      'Mapped areas': '2',
      'Mapped objects': '8',
      'Object types': '2',
      'Randomized objects': '4',
      Doors: '4',
      'Deck connection markers': '2',
      'Power networks': '12',
      'Power cable segments': '2',
      'Atmos nodes': '1',
      'Disposal segments': '0',
      'Fluid ducts': '0',
      'Navigation beacons': '0',
      'Transit tube sections': '0',
    },
  );
  assert.ok(rows.every((row) => typeof row.label === 'string' && typeof row.value === 'string'));
});

test('camera limits keep some map on screen with constant padding at every zoom', () => {
  for (const zoom of [0.04, 0.2, 1, 5]) {
    for (const [width, height] of [
      [900, 700],
      [120, 80],
    ]) {
      const min = boundedCamera(-1e9, -1e9, zoom, 255, 255, width, height);
      const max = boundedCamera(1e9, 1e9, zoom, 255, 255, width, height);
      assert.equal(min.x, -Math.min(64, width / 4) / zoom);
      assert.equal(max.y, 255 * 32 + Math.min(64, height / 4) / zoom);
      for (const point of [min, max]) {
        assert.ok(point.x + width / zoom / 2 > 0);
        assert.ok(point.x - width / zoom / 2 < 255 * 32);
        assert.ok(point.y + height / zoom / 2 > 0);
        assert.ok(point.y - height / zoom / 2 < 255 * 32);
      }
      const center = { x: 4000, y: 4000 };
      assert.deepEqual(boundedCamera(center.x, center.y, zoom, 255, 255, width, height), center);
    }
  }
});
