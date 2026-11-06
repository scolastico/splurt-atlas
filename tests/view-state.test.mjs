import test from 'node:test';
import assert from 'node:assert/strict';
import {
  detailForZoom,
  deckScale,
  selectedTile,
  viewFragment,
  encodeOptions,
  decodeOptions,
  optionBits,
} from '../src/view-state.ts';
import { createSearchIndex } from '../src/search-index.ts';

test('image detail changes at fixed zoom thresholds', () => {
  assert.deepEqual([0.04, 0.124, 0.125, 0.249, 0.25, 0.499, 0.5, 1, 5].map(detailForZoom), [
    'overview',
    'overview',
    2,
    2,
    1,
    1,
    0,
    0,
    0,
  ]);
});
test('deck perspective scales the camera continuously with depth', () => {
  assert.equal(deckScale(2, 0, true), 2);
  assert.ok(deckScale(2, 2, true) < deckScale(2, 1, true));
  assert.equal(deckScale(2, 3, false), 2);
});
test('selected tile roundtrips with the camera and rejects malformed coordinates', () => {
  const map = { id: 'northstar', width: 255, height: 255, levels: [1, 2, 3, 4] };
  const state = {
    map,
    z: 3,
    x: 1234,
    y: 5678,
    zoom: 1.25,
    selected: { x: 42, y: 77, z: 3 },
    query: 'wernch',
    result: 'possible:/obj/item/wrench',
    finding: 2,
    optionMask: encodeOptions({ possible: true, transit: true }),
  };
  const params = new URLSearchParams(viewFragment(state).slice(1));
  assert.deepEqual(selectedTile(params, map), state.selected);
  assert.equal(params.get('q'), 'wernch');
  assert.equal(params.get('r'), state.result);
  assert.equal(params.get('f'), '3');
  assert.equal(decodeOptions(params.get('o')).placed, false);
  assert.deepEqual([...params.keys()], ['m', 'z', 'x', 'y', 's', 't', 'q', 'r', 'f', 'o']);
  for (const tile of ['0,1,1', '256,1,1', '1,1,9', '1,2,3,4', '1.5,2,3', 'NaN,1,1'])
    assert.equal(selectedTile(new URLSearchParams({ t: tile }), map), null);
  assert.equal(new URLSearchParams(viewFragment({ ...state, selected: null }).slice(1)).has('t'), false);
  assert.equal(
    new URLSearchParams(
      viewFragment({ ...state, doorRoles: ['Chief Engineer', 'Security Officer'] }).slice(1),
    ).get('j'),
    'Chief Engineer,Security Officer',
  );
  assert.equal(
    new URLSearchParams(viewFragment({ ...state, offsetHighlights: new Set([8, 3]) }).slice(1)).get('h'),
    '3,8',
  );
  const encoded = new URLSearchParams(viewFragment({ ...state, query: 'wrench & cable / Δ' }).slice(1));
  assert.equal(encoded.get('q'), 'wrench & cable / Δ');
});
test('option bitmasks preserve every sidebar toggle independently', () => {
  for (const [key, bit] of Object.entries(optionBits)) {
    const mask = encodeOptions({ [key]: true });
    assert.equal(mask, 2 ** bit);
    assert.deepEqual(
      Object.entries(decodeOptions(mask))
        .filter(([, value]) => value)
        .map(([name]) => name),
      [key],
    );
  }
  assert.equal(decodeOptions('-1'), null);
  assert.equal(decodeOptions('no'), null);
});
test('offline storage is device-local and cannot be read or written through URL options', () => {
  assert.equal(encodeOptions({ 'offline-cache': true, 'storage-mode': 'all' }), 0);
  assert.equal(Object.hasOwn(decodeOptions(4096), 'offline-cache'), false);
});
test('offline fuzzy search tolerates typos and keeps every distinct location', () => {
  const index = createSearchIndex(
    [
      {
        name: 'wrench',
        path: '/obj/item/wrench',
        kind: 'possible',
        spawner: '/spawner/a',
        points: [1, 2, 1, 3, 4, 2],
      },
      {
        name: 'wrench',
        path: '/obj/item/wrench',
        kind: 'possible',
        spawner: '/spawner/b',
        points: [1, 2, 1, 5, 6, 2],
      },
      { name: 'wrench', path: '/obj/item/wrench', kind: 'placed', points: [7, 8, 1] },
    ],
    [{ name: 'Engineering', path: '/area/station/engineering', region: 'engineering', points: [4, 4, 1] }],
  );
  const result = index.search('wernch', { possible: true, placed: false });
  assert.equal(result.total, 1);
  assert.equal(result.results[0].count, 3);
  assert.deepEqual(index.get(result.results[0].id).points, [1, 2, 1, 3, 4, 2, 5, 6, 2]);
  assert.equal(index.search('enginering', { placed: false, possible: false }).results[0].kind, 'room');
});
