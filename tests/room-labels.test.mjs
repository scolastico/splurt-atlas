import test from 'node:test';
import assert from 'node:assert/strict';
import { roomLabels } from '../src/model/room-labels.ts';

function labels(rows) {
  const map = {
    width: rows[0].length,
    height: rows.length,
    definitions: [
      { area: 0, turf: '/turf/open/space' },
      { area: 1, turf: '/turf/open/floor/iron' },
      { area: 2, turf: '/turf/open/floor/wood' },
      { area: 1, turf: '/turf/closed/wall' },
      { area: 0, turf: '/turf/open/openspace' },
    ],
  };
  const level = { grid: new Int32Array(rows.flat()) };
  return { map, level, labels: roomLabels(map, level) };
}

test('rectangular room labels use the geometric middle, including half-tile centers', () => {
  assert.deepEqual(
    labels([
      [1, 1, 1],
      [1, 1, 1],
    ]).labels,
    [{ area: 1, x: 1.5, y: 1 }],
  );
  assert.deepEqual(
    labels([
      [1, 1],
      [1, 1],
    ]).labels,
    [{ area: 1, x: 1, y: 1 }],
  );
});

test('concave room labels stay inside their room instead of sitting in the missing corner', () => {
  const fixture = labels([
    [1, 0, 0],
    [1, 0, 0],
    [1, 1, 1],
  ]);
  const anchor = fixture.labels[0];
  const tile = fixture.level.grid[Math.floor(anchor.y) * fixture.map.width + Math.floor(anchor.x)];
  assert.equal(tile, 1);
  assert.notDeepEqual(anchor, { area: 1, x: 0.5, y: 0.5 });
});

test('disconnected rooms sharing an area each get a center and space gets no label', () => {
  assert.deepEqual(
    labels([
      [1, 1, 0, 2, 2],
      [1, 1, 4, 2, 2],
      [0, 0, 0, 0, 0],
      [1, 1, 0, 0, 0],
    ]).labels,
    [
      { area: 1, x: 1, y: 1 },
      { area: 2, x: 4, y: 1 },
      { area: 1, x: 1, y: 3.5 },
    ],
  );
});

test('room labels prefer usable interior tiles over walls', () => {
  const fixture = labels([
    [3, 3, 3],
    [3, 3, 3],
    [3, 1, 3],
  ]);
  assert.deepEqual(fixture.labels, [{ area: 1, x: 1.5, y: 2.5 }]);
});
