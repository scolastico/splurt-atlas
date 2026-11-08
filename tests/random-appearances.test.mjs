import test from 'node:test';
import assert from 'node:assert/strict';
import {
  randomAppearances,
  randomSourceInfo,
  vendingPreviewPool,
  VENDING_PREVIEW_DESCRIPTION,
  plantPreviewStates,
} from '../scripts/lib/random-appearances.mjs';
import { bakedChannel } from '../scripts/lib/utility-visibility.mjs';
import { channelsForDeck } from '../src/model/deck-channels.ts';
import { randomPreviewMarkup } from '../src/model/random-preview.ts';
import { encodeMap, decodeMap } from '../scripts/lib/map-format.mjs';
import { spawnCandidates } from '../scripts/lib/spawn-records.mjs';
import { objectOffsets } from '../scripts/lib/object-offsets.mjs';
import { createTileRenderer } from '../scripts/lib/tile-renderer.mjs';
import sharp from 'sharp';

const spawner = '/obj/effect/spawner/random/vending/colavend';
const red = '/obj/machinery/vending/cola/red',
  blue = '/obj/machinery/vending/cola/blue';
function database() {
  const types = new Map([
    [
      spawner,
      {
        loot: `list(${red} = 5, ${blue} = 10)`,
        icon: "'icons/effects/random_spawners.dmi'",
        icon_state: '"cola"',
      },
    ],
    [red, { name: '"Red vendor"', icon: "'red.dmi'", icon_state: '"red"' }],
    [blue, { name: '"Blue vendor"', icon: "'blue.dmi'", icon_state: '"blue"' }],
    ['/obj/machinery/vending/cola', { icon: "'cola.dmi'" }],
    ['/obj/structure/sign/poster/random', { random_basetype: '/obj/structure/sign/poster' }],
  ]);
  return { types, files: [], resolve: (type) => types.get(type) || {}, literal: (value) => value };
}

test('guaranteed vending spawns show a deterministic real vendor without leaking mapper sprite overrides', () => {
  const db = database();
  const source = { path: spawner, vars: { dir: '8', pixel_x: '5', icon_state: '"cola"' } };
  assert.deepEqual(vendingPreviewPool(source, db), [blue, red]);
  assert.deepEqual(randomSourceInfo(source, db), { kind: 'vending', guaranteed: true });
  const originals = structuredClone(source);
  const result = randomAppearances([source], [source], 121, 144, 1, db);
  const preview = result.find((atom) => atom.vars.atlas_random_preview);
  assert.ok([red, blue].includes(preview.path));
  assert.equal(preview.vars.icon_state, db.resolve(preview.path).icon_state);
  assert.notEqual(preview.vars.icon_state, '"cola"');
  assert.equal(preview.vars.dir, '8');
  assert.equal(preview.vars.pixel_x, '5');
  assert.deepEqual(result, randomAppearances([source], [source], 121, 144, 1, db));
  assert.deepEqual(source, originals);
  assert.equal(bakedChannel(preview, result, db), 'foreground');
  const choices = new Set();
  for (let x = 1; x <= 20; x++) choices.add(randomAppearances([source], [source], x, 144, 1, db)[0].path);
  assert.equal(choices.size, 2);
});

test('chance-based, scattered, unknown and empty outcomes never masquerade as guaranteed vending', () => {
  const db = database();
  for (const vars of [
    { spawn_loot_chance: '50' },
    { spawn_loot_count: '0' },
    { spawn_loot_count: 'unknown' },
    { spawn_scatter_radius: '2' },
    { spawn_all_loot: 'TRUE' },
    { loot: `list(${red}, null = 1)` },
    { loot: `list(${red}, "" = 1)` },
    { loot: `list(${red}, /obj/item/wrench)` },
  ]) {
    const source = { path: spawner, vars };
    assert.deepEqual(vendingPreviewPool(source, db), [], JSON.stringify(vars));
    assert.equal(randomSourceInfo(source, db).kind, 'spawn');
    assert.ok(
      randomAppearances([source], [source], 1, 1, 1, db)
        .filter((a) => !a.vars.atlas_random_marker)
        .every((a) => a.path === spawner),
    );
  }
});

test('typed vendor pools match possible-find records and nested vending selections are guarded', () => {
  const db = database();
  const source = { path: spawner, vars: { loot: 'null', loot_type_path: '/obj/machinery/vending/cola' } };
  assert.deepEqual(vendingPreviewPool(source, db), ['/obj/machinery/vending/cola', blue, red]);
  assert.deepEqual(
    new Set(spawnCandidates(db, spawner, { ...db.resolve(spawner), ...source.vars })),
    new Set(vendingPreviewPool(source, db)),
  );
  const nested = '/obj/effect/spawner/random/vending/nested';
  db.types.set(nested, { loot: `list(${spawner})` });
  assert.deepEqual(vendingPreviewPool({ path: nested, vars: {} }, db), [blue, red]);
  db.types.set('/obj/effect/spawner/random/vending/cycle', {
    loot: 'list(/obj/effect/spawner/random/vending/cycle)',
  });
  assert.deepEqual(
    vendingPreviewPool({ path: '/obj/effect/spawner/random/vending/cycle', vars: {} }, db),
    [],
  );
});

test('trash, posters, vendors and item spawns all get rainbow question markers while fixed objects do not', () => {
  const db = database();
  for (const source of [
    { path: '/obj/structure/trash_pile', vars: { icon_state: '"pile1"' } },
    { path: '/obj/structure/sign/poster/random', vars: { icon_state: '"real-poster"' } },
    { path: spawner, vars: {} },
    { path: '/obj/effect/spawner/random/tools', vars: { loot: 'list(/obj/item/wrench)' } },
  ]) {
    const result = randomAppearances([source], [source], 1, 2, 3, db);
    const markers = result.filter((atom) => atom.vars.atlas_random_marker);
    assert.deepEqual(
      markers.map((atom) => atom.vars.icon_state),
      ['"rainbow"', '"questionmark"'],
    );
    assert.ok(markers.every((atom) => bakedChannel(atom, result, db) === 'random-markers'));
  }
  for (const source of [
    { path: '/obj/machinery/vending/cola/red', vars: {} },
    { path: '/obj/structure/sign/poster/official/safety', vars: {} },
    { path: '/obj/item/wrench', vars: {} },
    {
      path: '/obj/effect/spawner/structure/window/reinforced',
      vars: { spawn_list: 'list(/obj/structure/grille)' },
    },
  ]) {
    assert.equal(randomSourceInfo(source, db), null);
    assert.deepEqual(randomAppearances([source], [source], 1, 2, 3, db), [source]);
  }
});

test('mapper mode replaces only the random channel, and inspector metadata survives compact map encoding', () => {
  for (const viewed of [false, true]) {
    const ordinary = channelsForDeck(viewed, new Set(), false, false);
    const mapper = channelsForDeck(viewed, new Set(), false, false, undefined, false, true);
    assert.ok(ordinary.includes('foreground') && !ordinary.includes('random-markers'));
    assert.ok(mapper.includes('random-markers') && !mapper.includes('foreground'));
    assert.ok(mapper.includes('foreground-mapper'));
  }
  const atom = {
    path: spawner,
    name: '<random cola>',
    description: VENDING_PREVIEW_DESCRIPTION,
    vars: {},
    network: null,
    source: null,
    random: { kind: 'vending', guaranteed: true },
  };
  const packed = encodeMap({
    definitions: [{ area: 0, turf: '/turf/open/floor', aperture: 0, atoms: [atom] }],
  });
  assert.deepEqual(decodeMap(packed).definitions[0].atoms[0], atom);
  const note = randomPreviewMarkup([atom], false);
  assert.match(note, /one possible outcome/);
  assert.match(note, /&lt;random cola&gt;/);
  assert.ok(!note.includes('<random cola>'));
  assert.match(randomPreviewMarkup([atom], true), /Rainbow question marks/);
  const legacy = structuredClone(packed);
  legacy.atoms[0].pop();
  assert.equal(decodeMap(legacy).definitions[0].atoms[0].random, undefined);
});

test('floor-mounted atmos bodies stay below chairs even when pipes are revealed', () => {
  const vent = { path: '/obj/machinery/atmospherics/components/unary/vent_pump/on/layer4', vars: {} };
  const chair = { path: '/obj/structure/chair/comfy/shuttle', vars: {} };
  const db = { resolve: () => ({}) };
  assert.equal(bakedChannel(vent, [vent, chair], db), 'pipes-floor-equipment');
  assert.equal(bakedChannel(chair, [vent, chair], db), 'foreground');
  for (const networks of [new Set(), new Set(['pipes'])]) {
    const channels = channelsForDeck(true, networks, false, false);
    assert.ok(channels.indexOf('pipes-floor-equipment') < channels.indexOf('foreground'));
    if (networks.has('pipes')) assert.ok(channels.indexOf('pipes-equipment') > channels.indexOf('pipes'));
  }
});

test('vent bodies and connection images share the configured directional pipe-layer offset', () => {
  const type = '/obj/machinery/atmospherics/components/unary/vent_pump';
  const db = { literal: (value) => value };
  for (const layer of [1, 2, 3, 4, 5])
    for (const dir of [1, 2, 4, 8]) {
      const vars = {
        shift_underlay_only: 'FALSE',
        piping_layer: String(layer),
        dir: String(dir),
        pixel_x: '0',
        pixel_y: '0',
      };
      const body = objectOffsets(type, vars, db);
      const cap = objectOffsets(type, { ...vars, dir: '2', atlas_component_dir: String(dir) }, db);
      const offset = String((layer - 3) * 5);
      assert.deepEqual([body.pixel_x, body.pixel_y], dir & 3 ? [offset, '0'] : ['0', offset]);
      assert.deepEqual([cap.pixel_x, cap.pixel_y], [body.pixel_x, body.pixel_y]);
    }
});

test('random plants use the source plant pool, with dead and synthetic variants preserved', () => {
  const db = database();
  db.types.set('/obj/item/kirbyplants', { icon: "'plants.dmi'", random_state_cap: '43' });
  db.types.set('/obj/item/kirbyplants/random', {
    icon: "'flora.dmi'",
    icon_state: '"random_plant"',
    random_state_cap: '43',
  });
  const source = { path: '/obj/item/kirbyplants/random', vars: {} };
  const pool = plantPreviewStates(source, db);
  assert.equal(pool.length, 45);
  assert.ok(pool.includes('plant-43') && pool.includes('applebush') && pool.includes('monkeyplant'));
  assert.deepEqual(randomSourceInfo(source, db), { kind: 'plant' });
  const preview = randomAppearances([source], [source], 52, 134, 3, db)[0];
  assert.equal(preview.vars.icon, "'plants.dmi'");
  assert.ok(pool.includes(JSON.parse(preview.vars.icon_state)));
  assert.notEqual(preview.vars.icon_state, '"random_plant"');
  assert.deepEqual(preview, randomAppearances([source], [source], 52, 134, 3, db)[0]);
  const dead = { ...source, vars: { dead: 'TRUE' } };
  assert.equal(randomAppearances([dead], [dead], 1, 2, 3, db)[0].vars.icon_state, '"plant-25"');
  const synthetic = { ...source, path: source.path + '/fullysynthetic' };
  assert.deepEqual(plantPreviewStates(synthetic, db), ['plant-26', 'plant-27', 'plant-28', 'plant-29']);
});

test('mapper rendering omits previews, keeps ordinary furniture and permits spawner question markers', async () => {
  const db = database();
  db.types.set('/obj/structure/chair', { icon: "'chair.dmi'", icon_state: '"chair"', layer: '3' });
  const source = { path: spawner, vars: {} },
    chair = { path: '/obj/structure/chair', vars: {} };
  const atoms = randomAppearances([source, chair], [source, chair], 1, 2, 3, db);
  const calls = [];
  const input = await sharp({ create: { width: 1, height: 1, channels: 4, background: '#ff0000' } })
    .png()
    .toBuffer();
  const sprites = {
    sprite: async (icon, state) => {
      calls.push(state);
      return { input, width: 1, height: 1 };
    },
  };
  const renderer = createTileRenderer({ db, sprites, tilePixels: 1 });
  assert.ok(await renderer.render(atoms, 'foreground'));
  assert.ok(calls.includes('chair') && calls.some((state) => state === 'red' || state === 'blue'));
  calls.length = 0;
  assert.ok(await renderer.render(atoms, 'foreground-mapper'));
  assert.deepEqual(calls, ['chair']);
  calls.length = 0;
  assert.ok(await renderer.render(atoms, 'random-markers'));
  assert.deepEqual(calls, ['rainbow', 'questionmark']);
});
