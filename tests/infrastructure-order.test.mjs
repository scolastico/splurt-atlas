import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_INFRASTRUCTURE_ORDER,
  normalizeInfrastructureOrder,
  infrastructureOrderParam,
  networkSummary,
  utilitySymbolOffset,
} from '../src/model/infrastructure-order.ts';
import { channelsForDeck } from '../src/model/deck-channels.ts';
import { viewFragment } from '../src/model/view-state.ts';
import { expandStructures } from '../scripts/lib/appearance.mjs';
import { buildInfrastructure } from '../scripts/lib/infrastructure.mjs';
import { bakedChannel, underCatwalk } from '../scripts/lib/utility-visibility.mjs';
import { classify } from '../scripts/lib/dm.mjs';

test('custom infrastructure orders draw topmost first in the sidebar and last in rendering, including symbols', () => {
  const order = normalizeInfrastructureOrder(['disposal', 'power', 'power', 'transit', 'unknown']);
  assert.deepEqual(order, ['disposal', 'power', 'navigation', 'fluid', 'pipes']);
  assert.deepEqual(normalizeInfrastructureOrder({}), DEFAULT_INFRASTRUCTURE_ORDER);
  const enabled = new Set(order);
  for (const simple of [false, true]) {
    const channels = channelsForDeck(true, enabled, simple, false, order, true);
    assert.ok(channels.indexOf('disposal') > channels.indexOf(simple ? 'power-symbols' : 'power'));
    assert.ok(channels.indexOf('disposal') > channels.indexOf('power-symbols'));
    assert.ok(channels.indexOf('disposal') > channels.indexOf('foreground'));
  }
  const native = channelsForDeck(true, enabled, false, false);
  for (const [top, below] of [
    ['navigation', 'fluid'],
    ['fluid', 'pipes'],
    ['pipes', 'power'],
    ['power', 'disposal'],
  ])
    assert.ok(native.indexOf(top) > native.indexOf(below));
});

test('enabling a network reveals both concealed and exposed segments above doors and windows', () => {
  const ordinary = channelsForDeck(true, new Set(), false, false);
  assert.ok(ordinary.indexOf('pipes-surface') < ordinary.indexOf('foreground'));
  assert.equal(ordinary.includes('pipes'), false);
  for (const channel of DEFAULT_INFRASTRUCTURE_ORDER) {
    const revealed = channelsForDeck(true, new Set([channel]), false, false);
    assert.ok(revealed.indexOf(channel) > revealed.indexOf('foreground'));
    assert.ok(revealed.indexOf(`${channel}-surface`) > revealed.indexOf('foreground'));
    assert.equal(revealed.filter((entry) => entry === `${channel}-surface`).length, 1);
  }
});

test('atmos equipment stays visible and above its own network, including in reveal and symbol modes', () => {
  assert.equal(classify('/obj/machinery/meter'), 'pipes');
  assert.equal(
    underCatwalk(
      { path: '/obj/machinery/meter', vars: {} },
      [{ path: '/turf/open/floor/catwalk_floor', vars: {} }],
      { resolve: () => ({}) },
    ),
    false,
  );
  for (const simple of [false, true]) {
    const enabled = channelsForDeck(true, new Set(['pipes']), simple, false);
    assert.ok(enabled.indexOf('pipes-equipment') > enabled.indexOf(simple ? 'pipes-symbols' : 'pipes'));
    const ordinary = channelsForDeck(true, new Set(), simple, false);
    assert.ok(ordinary.includes('pipes-equipment'));
    assert.ok(ordinary.indexOf('pipes-equipment') > ordinary.indexOf('foreground'));
  }
  assert.equal(
    bakedChannel({ path: '/obj/machinery/meter', vars: {} }, [], { resolve: () => ({}) }),
    'pipes-equipment',
  );
});

test('infrastructure order survives URL round trips and resetting omits the custom field', () => {
  const order = normalizeInfrastructureOrder(['disposal']);
  const view = { map: { id: 'boxstation' }, z: 1, x: 0, y: 0, zoom: 1, infrastructureOrder: order };
  const params = new URLSearchParams(viewFragment(view).slice(1));
  assert.deepEqual(normalizeInfrastructureOrder(params.get('u').split(',')), order);
  assert.equal(infrastructureOrderParam(DEFAULT_INFRASTRUCTURE_ORDER), null);
  assert.equal(
    new URLSearchParams(
      viewFragment({ ...view, infrastructureOrder: DEFAULT_INFRASTRUCTURE_ORDER }).slice(1),
    ).has('u'),
    false,
  );
});

test('map statistics retain just the mapped power-network count', () => {
  assert.equal(networkSummary(12), '12 separate mapped power networks.');
});

test('simple utility symbols keep the five native pipe offsets without shifting cable layers', () => {
  assert.deepEqual(
    [1, 2, 3, 4, 5].map((layer) => utilitySymbolOffset('pipes', layer)),
    [-10, -5, 0, 5, 10],
  );
  assert.deepEqual(
    [1, 2, 4].map((layer) => utilitySymbolOffset('power', layer)),
    [0, 0, 0],
  );
});

test('vents use runtime bodies and retain concealed connectors for the Atmospherics reveal layer', () => {
  const vent = '/obj/machinery/atmospherics/components/unary/vent_pump/on/layer4';
  const pipe = '/obj/machinery/atmospherics/pipe/simple';
  const db = {
    resolve: (path) =>
      path.startsWith('/turf/')
        ? { underfloor_accessibility: '0' }
        : path === vent
          ? {
              icon: "'vent.dmi'",
              icon_state: '"vent_map_on-4"',
              on: 'TRUE',
              hide: 'TRUE',
              shift_underlay_only: 'FALSE',
              piping_layer: '4',
              dir: '4',
            }
          : { icon: "'pipe.dmi'", hide: 'TRUE', piping_layer: '4', initialize_directions: '15', dir: '8' },
    hasIconState: () => true,
  };
  const floor = { path: '/turf/open/floor/wood', vars: {} };
  const cells = [
    { x: 1, y: 1, z: 1, appearance: expandStructures([floor, { path: vent, vars: {} }], db) },
    { x: 2, y: 1, z: 1, appearance: expandStructures([floor, { path: pipe, vars: {} }], db) },
  ];
  const at = (x, y, z) => cells.find((cell) => cell.x === x && cell.y === y && cell.z === z)?.appearance;
  buildInfrastructure(cells, at, db, [1]);
  const atoms = cells[0].appearance;
  const body = atoms.find((a) => a.path === vent && !a.vars.icon?.includes('underlays'));
  const cap = atoms.find((a) => a.vars.icon?.includes('pipe_underlays'));
  assert.equal(body.vars.icon_state, '"vent_out"');
  assert.equal(bakedChannel(body, atoms, db), 'pipes-equipment');
  assert.ok(cap);
  assert.equal(bakedChannel(cap, atoms, db), 'pipes');
  // Even always-visible pumps must not force their connector above intact flooring.
  assert.equal(bakedChannel({ ...cap, vars: { ...cap.vars, hide: 'FALSE' } }, atoms, db), 'pipes');
  const catwalk = { path: '/turf/open/floor/catwalk_floor', vars: { underfloor_accessibility: '1' } };
  assert.equal(underCatwalk(cap, [catwalk, cap], db), true);
  const scrubber = expandStructures(
    [
      {
        path: vent.replace('vent_pump', 'vent_scrubber'),
        vars: { icon_state: '"scrub_map_on-4"', on: 'TRUE' },
      },
    ],
    db,
  )[0];
  assert.equal(scrubber.vars.icon_state, '"scrub_on"');
});
