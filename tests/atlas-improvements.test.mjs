import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { createSearchIndex } from '../src/model/search-index.ts';
import { closetOverlays, randomiseTrash } from '../scripts/lib/appearance.mjs';
import { closetCandidates, tileLoot } from '../scripts/lib/spawn-records.mjs';
import { createTileRenderer } from '../scripts/lib/tile-renderer.mjs';
import { utilityExposed } from '../scripts/lib/utility-visibility.mjs';

test('search merges same-name variants with all locations and ranks literal names before fuzzy/path matches', () => {
  const item = (name, path, points = [1, 2, 1]) => ({ name, path, points, kind: 'placed' });
  const index = createSearchIndex(
    [
      item('wrench', '/obj/item/wrench'),
      item('wrench', '/obj/item/wrench/variant', [1, 2, 1, 3, 4, 1]),
      item('wrench kit', '/obj/item/kit'),
      item('wench', '/obj/item/other'),
      item('unrelated', '/obj/item/wrench/path'),
    ],
    [],
  );
  const filters = { placed: true, possible: true };
  const results = index.search('wrench', filters).results;
  assert.deepEqual(
    results.slice(0, 2).map((hit) => hit.name),
    ['wrench', 'wrench kit'],
  );
  assert.equal(results.filter((hit) => hit.name === 'wrench').length, 1);
  assert.deepEqual(index.get('placed:/obj/item/wrench/variant').points, [1, 2, 1, 3, 4, 1]);
  assert.equal(
    index.search('/obj/item/wrench/variant', { ...filters, exact: true }).results[0].name,
    'wrench',
  );
  assert.equal(index.search('wernch', { ...filters, exact: true }).total, 0);
  assert.ok(index.search('wernch', filters).total > 0);
  assert.equal(index.search('WRENCH', { ...filters, exact: true }).results[0].name, 'wrench');
  const named = createSearchIndex(
    [item('wrench', '/obj/item/wrench'), item('custom wrench', '/obj/item/wrench')],
    [],
  );
  const hits = named.search('wrench', filters).results;
  assert.equal(new Set(hits.map((hit) => hit.id)).size, 2);
  for (const hit of hits) assert.equal(named.get(hit.id).name, hit.name);
});

test('search combines placed and possible entries without losing filtered locations or per-tile types', () => {
  const path = '/obj/item/wrench';
  const index = createSearchIndex(
    [
      { name: 'wrench', path, kind: 'placed', points: [1, 2, 1] },
      { name: 'wrench', path, kind: 'possible', spawner: '/spawner/a', points: [1, 2, 1, 3, 4, 1] },
      { name: 'wrench', path: `${path}/variant`, kind: 'possible', spawner: '/spawner/b', points: [5, 6, 1] },
    ],
    [],
  );
  const result = index.search('wrench', { placed: true, possible: true });
  assert.equal(result.total, 1);
  assert.deepEqual(result.results[0].kinds, ['placed', 'possible']);
  assert.equal(result.results[0].count, 3);
  const record = index.get(result.results[0].id);
  assert.deepEqual(record.placedPoints, [1, 2, 1]);
  assert.deepEqual(record.points, [1, 2, 1, 3, 4, 1, 5, 6, 1]);
  assert.equal(index.search('wrench', { placed: true, possible: false }).results[0].count, 1);
  assert.equal(index.search('wrench', { placed: false, possible: true }).results[0].count, 3);
  assert.deepEqual(index.at('5,6,1'), [{ name: 'wrench', path: `${path}/variant` }]);
});

test('closet doors honor separate door states, opened/disabled flags and lock overlays', () => {
  const db = {
    resolve: () => ({
      icon_state: '"eng"',
      icon_door: '"eng_tool"',
      enable_door_overlay: 'TRUE',
      has_opened_overlay: 'TRUE',
      has_closed_overlay: 'TRUE',
      secure: 'TRUE',
      locked: 'TRUE',
    }),
  };
  const atom = { path: '/obj/structure/closet/toolcloset', vars: {} };
  assert.deepEqual(closetOverlays({ ...atom, path: '/obj/structure/closet/crate' }, db), []);
  assert.deepEqual(closetOverlays(atom, { ...db, hasIconState: () => false }), []);
  assert.deepEqual(
    closetOverlays(atom, db).map((a) => a.vars.icon_state),
    ['"eng_tool_door"', '"locked"'],
  );
  assert.deepEqual(
    closetOverlays({ ...atom, vars: { opened: 'TRUE' } }, db).map((a) => a.vars.icon_state),
    ['"eng_open"'],
  );
  assert.deepEqual(
    closetOverlays({ ...atom, vars: { enable_door_overlay: 'FALSE', secure: 'FALSE' } }, db),
    [],
  );
});

test('closet contents include conditional items, inherited populations and nested spawners', () => {
  const db = {
    files: [
      [
        'fixture.dm',
        '/obj/structure/closet/PopulateContents()\n\tnew /obj/item/base(src)\n/obj/structure/closet/tool/PopulateContents()\n\t..()\n\tif(prob(50))\n\t\tnew /obj/item/wrench(src)\n\tnew /obj/effect/spawner/random/tool(src)\n/obj/structure/closet/tool/empty/PopulateContents()\n\treturn\n',
      ],
    ],
    resolve: (path) => (path.includes('/spawner/') ? { loot: 'list(/obj/item/screwdriver)' } : {}),
  };
  assert.deepEqual(closetCandidates(db, '/obj/structure/closet/tool'), [
    '/obj/item/base',
    '/obj/item/wrench',
    '/obj/item/screwdriver',
  ]);
  assert.deepEqual(closetCandidates(db, '/obj/structure/closet/tool/empty'), []);
  const loot = tileLoot(db, [{ path: '/obj/structure/closet/tool', vars: {} }], []);
  assert.equal(loot.length, 3);
  assert.ok(loot.every((item) => item.kind === 'possible' && item.spawner === '/obj/structure/closet/tool'));
});

test('trash piles use stable real states and preserve explicitly mapped appearances', () => {
  const db = { resolve: () => ({ icon_state: '"randompile"' }) };
  const atom = { path: '/obj/structure/trash_pile', vars: {} };
  const chosen = randomiseTrash([atom], 125, 51, 1, db);
  assert.notEqual(chosen[0].vars.icon_state, '"randompile"');
  assert.deepEqual(chosen, randomiseTrash([atom], 125, 51, 1, db));
  const fixed = { ...atom, vars: { icon_state: '"pile1"' } };
  assert.deepEqual(randomiseTrash([fixed], 125, 51, 1, db), [fixed]);
});

test('catwalk utilities are below the transparent floor by default and available in reveal channels', async () => {
  const floor = { path: '/turf/open/floor/catwalk_floor/iron_smooth', vars: {} };
  for (const [path, channel] of [
    ['/obj/structure/cable', 'power'],
    ['/obj/structure/disposalpipe/segment', 'disposal'],
    ['/obj/machinery/atmospherics/pipe/simple', 'pipes'],
  ]) {
    const db = {
      resolve: (path) => ({
        icon: "'test.dmi'",
        icon_state: path.startsWith('/turf/') ? '"floor"' : '"utility"',
        underfloor_accessibility: '1',
      }),
    };
    const sprites = {
      sprite: async (_icon, state, _dir, _color, opacity) => ({
        width: 1,
        height: 1,
        input: await sharp({
          create: {
            width: 1,
            height: 1,
            channels: 4,
            background: state === 'floor' ? { r: 0, g: 0, b: 255, alpha: opacity / 255 } : '#ff0000',
          },
        })
          .png()
          .toBuffer(),
      }),
    };
    const renderer = createTileRenderer({ db, sprites, tilePixels: 1 });
    const atoms = [floor, { path, vars: {} }];
    assert.equal(utilityExposed(atoms[1], atoms, db), false);
    const base = await sharp(await renderer.render(atoms, 'base'))
      .raw()
      .toBuffer();
    // Center pixel contains both the red utility underneath and the blue floor above.
    assert.ok(base[16] > 0 && base[18] > 0);
    assert.equal(await renderer.render(atoms, `${channel}-surface`), null);
    assert.ok(await renderer.render(atoms, channel));
  }
});
