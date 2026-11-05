import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { parseDmm, splitTop } from '../scripts/lib/dmm.mjs';
import { dmiMetadata } from '../scripts/lib/dmi.mjs';
import { classify, aperture, stripComments, loadTypes, unquote } from '../scripts/lib/dm.mjs';
import { fileURLToPath } from 'node:url';
import { expandStructures, smoothAtoms } from '../scripts/lib/appearance.mjs';

test('DMM preserves coordinate origin and reverses rows into BYOND north-up coordinates', () => {
  const map = parseDmm('"a" = (/turf/open/floor,/area/test)\n"b" = (/obj/item/test{name = "comma, and ; semicolon"; loot = list(/obj/item/a, /obj/item/b)},/turf/open/space,/area/test)\n(3,5,2) = {"\nab\nba\n"}');
  assert.deepEqual(map.cells.map(c => [c.x, c.y, c.z, c.key]), [[3, 6, 2, 'a'], [4, 6, 2, 'b'], [3, 5, 2, 'b'], [4, 5, 2, 'a']]);
  assert.equal(map.dictionary.get('b')[0].vars.name, '"comma, and ; semicolon"');
  assert.equal(map.dictionary.get('b')[0].vars.loot, 'list(/obj/item/a, /obj/item/b)');
});
test('TGM column blocks use their own Y origin and share a dictionary', () => {
  const map = parseDmm('"aaa" = (/turf/open/floor)\n(1,2,1) = {"\naaa\naaa\n"}\n(2,2,1) = {"\naaa\naaa\n"}');
  assert.deepEqual([map.width, map.height, map.cells.length], [2, 3, 4]);
  assert.throws(() => parseDmm('"a" = (/turf/open/floor)\n(1,1,1) = {"b"}'), /Unknown map key/);
});
test('nested strings and comments do not break static declarations', () => {
  assert.deepEqual(splitTop('list("a,b", /obj/a), /obj/b'), ['list("a,b", /obj/a)', '/obj/b']);
  assert.equal(stripComments('name = "https://example.com" // comment\n/* block */\n/obj/a').includes('"https://example.com"'), true);
  assert.equal(stripComments('/* /obj/invalid */').trim(), '');
});
test('DMI state offsets include every direction and animation frame', () => {
  const description = '# BEGIN DMI\nwidth = 32\nheight = 48\nstate = "first"\ndirs = 4\nframes = 3\nstate = "second"\ndirs = 1\nframes = 1\n# END DMI';
  const data = Buffer.concat([Buffer.from('Description\0\0'), deflateSync(description)]), chunk = Buffer.alloc(data.length + 12);
  chunk.writeUInt32BE(data.length, 0); chunk.write('zTXt', 4); data.copy(chunk, 8);
  const meta = dmiMetadata(Buffer.concat([Buffer.alloc(8), chunk]));
  assert.equal(meta.height, 48); assert.equal(meta.states.get('second').offset, 12);
});
test('cutaway opens only through known transparent turf families', () => {
  assert.equal(aperture('/turf/open/floor/glass'), 190);
  assert.equal(aperture('/turf/open/floor/iron'), 0);
  assert.equal(aperture('/turf/open/openspace'), 255);
  assert.equal(classify('/obj/structure/disposalpipe/sorting'), 'disposal');
  assert.equal(classify('/obj/machinery/atmospherics/pipe/simple'), 'pipes');
  assert.equal(classify('/obj/structure/transit_tube/curved'), 'transit');
});
test('deterministic structure spawners expand into rendered window and grille', () => {
  const db = { resolve: p => p.includes('/spawner/') ? { spawn_list: 'list(/obj/structure/grille, /obj/structure/window/fulltile)' } : {} };
  const result = expandStructures([{ path: '/obj/effect/spawner/structure/window', vars: {} }], db);
  assert.deepEqual(result.map(a => a.path), ['/obj/structure/grille', '/obj/structure/window/fulltile']);
});
test('smoothing uses BYOND north and only fills diagonals with both cardinal neighbors', () => {
  const db = { resolve: () => ({ icon_state: '"wall-0"', smoothing_flags: 'SMOOTH_BITMASK', canSmoothWith: 'SMOOTH_GROUP_WALLS', smoothing_groups: 'SMOOTH_GROUP_WALLS' }) };
  const atom = { path: '/turf/closed/wall', vars: {} };
  const at = (x, y) => (x === 1 && y === 2 || x === 2 && y === 1 || x === 2 && y === 2) ? [atom] : [];
  assert.equal(smoothAtoms([atom], 1, 1, 1, at, db)[0].vars.icon_state, '"wall-21"');
  assert.equal(smoothAtoms([atom], 1, 1, 1, at, {...db,hasIconState:()=>false})[0],atom);
});
test('DM inheritance respects explicit parents, include order, constants and nested global loot pools', () => {
  const db = loadTypes(fileURLToPath(new URL('./fixtures/', import.meta.url)));
  assert.equal(db.resolve('/obj/item/alias').name, '"tool after modular override"');
  assert.equal(db.resolve('/obj/item/alias').icon, "'icons/test.dmi'");
  assert.equal(db.resolve('/obj/item/alias').color, '"#ffcc88"');
  assert.deepEqual(db.pool('test_parent_pool').sort(), ['/obj/item/alias', '/obj/item/tool']);
  assert.equal(unquote('"tile_tram";\\'), 'tile_tram');
  assert.equal(db.resolve('/turf/closed/mineral/random').icon, "'icons/runtime-rock.dmi'");
  assert.equal(db.resolve('/turf/closed/mineral/random').transform, 'TRANSLATE_MATRIX(-8, -8)');
});
