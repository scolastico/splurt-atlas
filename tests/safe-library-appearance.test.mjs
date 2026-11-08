import test from 'node:test';
import assert from 'node:assert/strict';
import { expandStructures } from '../scripts/lib/appearance.mjs';
import { safeAppearances } from '../scripts/lib/safe-appearance.mjs';
import { randomAppearances, randomSourceInfo } from '../scripts/lib/random-appearances.mjs';
import { floorSafeVisibility, bakedChannel } from '../scripts/lib/utility-visibility.mjs';
import { createTileRenderer } from '../scripts/lib/tile-renderer.mjs';
import { randomPreviewMarkup } from '../src/model/random-preview.ts';

const forgery = '/obj/item/fakeartefact';
const safe = '/obj/structure/safe/floor';
const shelf = '/obj/structure/bookcase/random/religion';
const atom = (path, vars = {}) => ({ path, vars });
function database() {
  const types = new Map([
    [
      forgery,
      {
        icon: "'hud.dmi'",
        icon_state: '"x2"',
        w_class: '2',
        possible: 'list(/obj/item/prize/a, /obj/item/prize/b)',
      },
    ],
    ['/obj/item/prize/a', { icon: "'a.dmi'", icon_state: '"a"' }],
    ['/obj/item/prize/b', { icon: "'b.dmi'", icon_state: '"b"' }],
    [safe, { icon: "'safe.dmi'", icon_state: '"floorsafe"', open: 'FALSE', locked: 'TRUE', maxspace: '24' }],
    [
      shelf,
      {
        icon: "'library.dmi'",
        icon_state: '"random_bookcase"',
        books_to_load: '2',
        load_random_books: 'TRUE',
      },
    ],
  ]);
  return {
    types,
    resolve: (path) => types.get(path) || {},
    literal: (value) => value,
    hasIconState: () => true,
  };
}

test('forgeries use a stable disguise, retain their own identity and support random markers', () => {
  const db = database(),
    source = atom(forgery, { pixel_x: '3' });
  const result = randomAppearances([source], [source], 166, 152, 1, db);
  assert.deepEqual(randomSourceInfo(source, db), { kind: 'forgery' });
  const preview = result[0];
  assert.equal(preview.path, forgery);
  assert.ok(["'a.dmi'", "'b.dmi'"].includes(preview.vars.icon));
  assert.notEqual(preview.vars.icon_state, '"x2"');
  assert.equal(preview.vars.pixel_x, '3');
  assert.equal(preview.vars.atlas_random_preview, '1');
  assert.equal(result.filter((a) => a.vars.atlas_random_marker).length, 2);
  assert.deepEqual(result, randomAppearances([source], [source], 166, 152, 1, db));
  assert.match(
    randomPreviewMarkup([{ name: 'expensive forgery', random: { kind: 'forgery' } }], false),
    /not the real item/,
  );
});

test('closed safes collect fitting mapped items and use their closed icon', () => {
  const db = database();
  const originals = [atom(forgery), atom(safe), atom('/turf/closed/wall/r_wall')];
  const snapshot = structuredClone(originals);
  const expanded = expandStructures(originals, db);
  assert.equal(
    expanded.some((a) => a.path === forgery),
    false,
  );
  assert.equal(expanded.find((a) => a.path === safe).vars.icon_state, '"floorsafe_locked"');
  const appearances = randomAppearances(expanded, originals, 166, 152, 1, db);
  assert.equal(
    appearances.some((a) => a.vars.atlas_random_preview),
    false,
    'stored items have no visible preview',
  );
  assert.equal(
    appearances.filter((a) => a.vars.atlas_random_marker).length,
    2,
    'mapper mode still identifies the random location',
  );
  assert.deepEqual(originals, snapshot, 'inspector retains the original mapped objects');
});

test('safe capacity and open/unlocked settings control which items remain outside', () => {
  const db = database();
  const items = [
    atom(forgery, { w_class: '3' }),
    atom(forgery, { w_class: '2' }),
    atom(forgery, { w_class: '1' }),
  ];
  let result = safeAppearances([atom(safe, { maxspace: '3' }), ...items], db);
  assert.deepEqual(
    result.filter((a) => a.path === forgery),
    items.slice(1),
  );
  result = safeAppearances([atom(safe, { maxspace: '2' }), ...items], db);
  assert.deepEqual(
    result.filter((a) => a.path === forgery),
    [items[0], items[2]],
  );
  result = safeAppearances([atom(safe, { open: 'TRUE', locked: 'FALSE' }), ...items], db);
  assert.equal(result.filter((a) => a.path === forgery).length, 3);
  assert.equal(result[0].vars.icon_state, '"floorsafe"');
  result = safeAppearances([atom(safe, { maxspace: '2' }), atom(safe, { maxspace: '4' }), ...items], db);
  assert.equal(result.filter((a) => a.path === forgery).length, 0);
});

test('floor safes hide below walls and covered floors but show on plating and through grates', async () => {
  const db = database(),
    source = atom(safe),
    calls = [];
  const sprites = {
    sprite: async (_icon, state) => {
      calls.push(state);
      return null;
    },
  };
  const renderer = createTileRenderer({ db, sprites, tilePixels: 32 });
  for (const turf of ['/turf/closed/wall/r_wall', '/turf/open/floor/iron']) {
    const atoms = [source, atom(turf)];
    assert.equal(floorSafeVisibility(source, atoms, db), 'hidden');
    calls.length = 0;
    await renderer.render(atoms, 'foreground');
    await renderer.render(atoms, 'base');
    assert.equal(calls.length, 0);
  }
  const plating = [source, atom('/turf/open/floor/plating')];
  assert.equal(floorSafeVisibility(source, plating, db), 'surface');
  calls.length = 0;
  await renderer.render(plating, 'foreground');
  assert.deepEqual(calls, ['floorsafe']);
  const grate = [source, atom('/turf/open/floor/catwalk_floor')];
  assert.equal(floorSafeVisibility(source, grate, db), 'underfloor');
  assert.equal(bakedChannel(source, grate, db), 'base');
});

test('random library shelves preview the source fullness range and toggle to rainbow markers', () => {
  const db = database(),
    source = atom(shelf);
  assert.deepEqual(randomSourceInfo(source, db), { kind: 'bookcase' });
  const states = new Set();
  for (let x = 1; x <= 30; x++) {
    const result = randomAppearances([source], [source], x, 136, 1, db);
    states.add(result[0].vars.icon_state);
    assert.equal(result[0].path, shelf);
    assert.equal(result[0].vars.atlas_random_preview, '1');
    assert.equal(result.filter((a) => a.vars.atlas_random_marker).length, 2);
    assert.deepEqual(result, randomAppearances([source], [source], x, 136, 1, db));
  }
  assert.deepEqual(states, new Set(['"book-1"', '"book-2"', '"book-3"']));
  for (const [vars, state] of [
    [{ books_to_load: '0' }, '"book-0"'],
    [{ books_to_load: '20' }, '"book-5"'],
    [{ load_random_books: 'FALSE' }, '"book-0"'],
  ])
    assert.equal(randomAppearances([atom(shelf, vars)], [source], 171, 136, 1, db)[0].vars.icon_state, state);
  assert.match(
    randomPreviewMarkup([{ name: 'Religion bookcase', random: { kind: 'bookcase' } }], false),
    /live library database/,
  );
});
