import test from 'node:test';
import assert from 'node:assert/strict';
import { compareDeck, tileDefinition } from '../scripts/lib/dataset-diff.mjs';

const floor = {
  area: 0,
  turf: '/turf/floor',
  atoms: [{ path: '/obj/chair', vars: { dir: '2', name: 'Seat' } }],
};
const meta = {
  id: 'station',
  width: 2,
  height: 2,
  definitions: [floor],
  areas: [{ path: '/area/a', name: 'Room' }],
};
test('diff compares values rather than dictionary, area indices or object key order', () => {
  const after = {
    ...meta,
    definitions: [
      { ...floor, area: 1, atoms: [{ vars: { name: 'Seat', dir: '2' }, path: '/obj/chair' }] },
      floor,
    ],
    areas: [{ path: '/unused' }, meta.areas[0]],
  };
  assert.deepEqual(compareDeck(meta, { grid: [0, 0, -1, -1] }, after, { grid: [0, 0, -1, -1] }, 1), []);
});
test('diff preserves north-up BYOND coordinates across resized and missing decks', () => {
  const after = { ...meta, width: 3, height: 3 };
  const changes = compareDeck(
    meta,
    { grid: [0, -1, -1, 0] },
    after,
    { grid: [-1, -1, 0, 0, -1, -1, -1, -1, -1] },
    4,
  );
  assert.deepEqual(changes, [
    { x: 3, y: 3, z: 4, kind: 'added' },
    { x: 2, y: 1, z: 4, kind: 'removed' },
  ]);
  assert.equal(compareDeck(meta, undefined, meta, { grid: [0, -1, -1, 0] }, 7).length, 2);
  assert.equal(compareDeck(meta, { grid: [0, -1, -1, 0] }, meta, undefined, 7)[0].kind, 'removed');
});
test('diff notices inherited metadata, overrides and area changes at every affected tile', () => {
  const after = { ...meta, areas: [{ ...meta.areas[0], name: 'New room' }] };
  assert.deepEqual(
    compareDeck(meta, { grid: [0, -1, -1, 0] }, after, { grid: [0, -1, -1, 0] }, 1).map((c) => c.kind),
    ['modified', 'modified'],
  );
  assert.equal(tileDefinition(meta, { grid: [0, -1, -1, 0] }, 1, 2).area.name, 'Room');
  assert.equal(tileDefinition(meta, undefined, 1, 1), null);
  assert.throws(() => compareDeck(meta, {}, { ...meta, id: 'other' }, {}, 1), /same station/);
});
