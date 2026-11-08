import test from 'node:test';
import assert from 'node:assert/strict';
import { expandStructures, lightOverlays } from '../scripts/lib/appearance.mjs';
import { aperture } from '../scripts/lib/dm.mjs';
import { closetCandidates, spawnCandidates } from '../scripts/lib/spawn-records.mjs';
import { bakedChannel, beaconVisibility } from '../scripts/lib/utility-visibility.mjs';
import { channelsForDeck } from '../src/model/deck-channels.ts';

test('transit tubes draw over walls/windows on the viewed deck and respect their toggle', () => {
  const channels = channelsForDeck(true, new Set(['transit', 'power']), false, true);
  assert.ok(channels.indexOf('transit') > channels.indexOf('foreground'));
  assert.ok(channels.indexOf('helpers') > channels.indexOf('transit'));
  assert.ok(!channelsForDeck(true, new Set(), false, false).includes('transit'));
  assert.deepEqual(channelsForDeck(false, new Set(['transit']), false, true), [
    'base',
    'foreground',
    'pipes-equipment',
  ]);
});

test('beacon infrastructure toggles reveal hidden devices while exposed sprites remain visible', () => {
  const disabled = channelsForDeck(true, new Set(), false, false);
  assert.ok(disabled.includes('navigation-surface'));
  assert.ok(!disabled.includes('navigation'));
  assert.ok(channelsForDeck(true, new Set(['navigation']), false, false).includes('navigation'));
});

test('healthy tube, bulb, floor and custom lights get lit overlays with their mapped direction and offsets', () => {
  const base = { icon: "'fixture.dmi'", overlay_icon: "'lit.dmi'", status: 'LIGHT_OK', base_state: '"tube"' };
  const db = {
    resolve: () => base,
    literal: (value) =>
      ({ LIGHT_OK: '0', LIGHT_BROKEN: '1', LIGHT_EMPTY: '2', LIGHT_BURNED: '3' })[value] || value,
    hasIconState: (icon, state) => icon === 'lit.dmi' && ['tube', 'bulb', 'floor', 'custom'].includes(state),
  };
  for (const variant of ['tube', 'bulb', 'floor', 'custom']) {
    const atom = {
      path: '/obj/machinery/light/directional/south',
      vars: { base_state: JSON.stringify(variant), dir: '2', pixel_y: '-16' },
    };
    const [overlay] = lightOverlays(atom, db);
    assert.equal(overlay.vars.icon, "'lit.dmi'");
    assert.equal(overlay.vars.icon_state, JSON.stringify(variant));
    assert.equal(overlay.vars.dir, '2');
    assert.equal(overlay.vars.pixel_y, '-16');
    assert.equal(expandStructures([atom], db).length, 2);
    for (const status of ['LIGHT_BROKEN', 'LIGHT_EMPTY', 'LIGHT_BURNED'])
      assert.deepEqual(lightOverlays({ ...atom, vars: { ...atom.vars, status } }, db), []);
  }
  assert.deepEqual(
    lightOverlays({ path: '/obj/machinery/light', vars: { base_state: '"missing"' } }, db),
    [],
  );
});

test('navigation beacons hide under intact tiles, show under transparent floors and are exposed on plating', () => {
  const beacon = { path: '/obj/machinery/navbeacon', vars: {} };
  const db = { resolve: () => ({}) };
  for (const [type, visibility, channel] of [
    ['iron', 'hidden', 'navigation'],
    ['plating', 'surface', 'navigation-surface'],
    ['glass', 'underfloor', 'navigation'],
    ['catwalk_floor', 'underfloor', 'navigation'],
  ]) {
    const atoms = [beacon, { path: `/turf/open/floor/${type}`, vars: {} }];
    assert.equal(beaconVisibility(beacon, atoms, db), visibility);
    assert.equal(bakedChannel(beacon, atoms, db), channel);
  }
});

test('crate appearances use runtime state and retain intentionally preopened crates', () => {
  const db = { resolve: () => ({ base_icon_state: '"crate"', icon_state: '"crateopen"', opened: 'TRUE' }) };
  const atom = { path: '/obj/structure/closet/crate/preopen', vars: {} };
  assert.equal(expandStructures([atom], db)[0].vars.icon_state, '"crateopen"');
  const closed = expandStructures(
    [{ ...atom, vars: { opened: 'FALSE', secure: 'TRUE', locked: 'TRUE' } }],
    db,
  );
  assert.deepEqual(
    closed.map((a) => a.vars.icon_state),
    ['"crate"', '"securecrater"'],
  );
  const lid = expandStructures([{ ...atom, vars: { lid_icon_state: '"lid"', lid_w: '7' } }], db);
  assert.equal(lid[1].vars.icon_state, '"lid"');
  assert.equal(lid[1].vars.pixel_w, '7');
});

test('backed catwalk floors cannot show deeper decks; glass and open catwalks can', () => {
  const db = { resolve: () => ({ catwalk_type: '"maint"', covered: 'TRUE' }) };
  const atom = { path: '/turf/open/floor/catwalk_floor', vars: {} };
  const atoms = expandStructures([atom], db);
  assert.deepEqual(
    atoms.map((a) => a.vars.icon_state),
    ['"maint_below"', '"maint_above"'],
  );
  assert.equal(atoms[0].vars.layer, '-200');
  assert.equal(aperture(atom.path), 0);
  assert.ok(aperture('/turf/open/floor/glass') > 0);
  assert.ok(aperture('/turf/open/floor/catwalk') > 0);
  assert.equal(
    expandStructures([{ ...atom, vars: { covered: 'FALSE' } }], db)[1].vars.icon_state,
    '"maint_overlay"',
  );
});

test('abandoned crate tables and random maintenance-filled crates expose their actual candidate contents', () => {
  const db = {
    files: [],
    resolve: (type) =>
      type.endsWith('/crate/secure/loot')
        ? { possible_loot: 'list(/obj/item/wrench, /obj/effect/spawner/random/tool)' }
        : type.endsWith('/random/tool')
          ? { loot: 'list(/obj/item/screwdriver)' }
          : type.endsWith('/with_loot')
            ? { loot: 'list(/obj/structure/closet/crate)' }
            : {},
    pool: () => ['/obj/item/flashlight'],
  };
  assert.deepEqual(closetCandidates(db, '/obj/structure/closet/crate/secure/loot'), [
    '/obj/item/wrench',
    '/obj/item/screwdriver',
  ]);
  assert.deepEqual(closetCandidates(db, '/obj/structure/closet/crate/preopen'), []);
  const type = '/obj/effect/spawner/random/structure/closet_empty/crate/with_loot';
  assert.ok(spawnCandidates(db, type, db.resolve(type)).includes('/obj/item/flashlight'));
});
