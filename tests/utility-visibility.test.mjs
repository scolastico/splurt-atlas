import test from 'node:test';
import assert from 'node:assert/strict';
import { classify } from '../scripts/lib/dm.mjs';
import { renderChannel, bakedChannel } from '../scripts/lib/utility-visibility.mjs';
test('exposed utilities remain in always-visible channels while covered pipes, cables, ducts and waste use reveal toggles', () => {
  const db = {
    resolve: (type) =>
      type.includes('plating')
        ? { underfloor_accessibility: '2' }
        : type.includes('glass')
          ? { underfloor_accessibility: '1' }
          : type.startsWith('/turf/')
            ? { underfloor_accessibility: '0' }
            : {},
    literal: (value) => value,
  };
  const atom = (path) => ({ path, vars: {} }),
    closed = atom('/turf/open/floor/iron'),
    plating = atom('/turf/open/floor/plating'),
    glass = atom('/turf/open/floor/glass');
  for (const [path, channel] of [
    ['/obj/structure/cable', 'power'],
    ['/obj/machinery/duct', 'fluid'],
    ['/obj/structure/disposalpipe/segment', 'disposal'],
    ['/obj/machinery/atmospherics/pipe/simple', 'pipes'],
  ]) {
    const utility = atom(path);
    assert.equal(classify(path), channel);
    assert.equal(renderChannel(utility, [closed, utility], db), channel);
    assert.equal(renderChannel(utility, [plating, utility], db), channel + '-surface');
    assert.equal(renderChannel(utility, [glass, utility], db), channel + '-surface');
  }
  const pump = atom('/obj/machinery/atmospherics/components/binary/pump');
  assert.equal(renderChannel(pump, [closed, pump], db), 'pipes-surface');
  const visible = { ...atom('/obj/machinery/atmospherics/pipe/simple/visible'), vars: { hide: 'FALSE' } };
  assert.equal(renderChannel(visible, [closed, visible], db), 'pipes-surface');
  const bin = atom('/obj/machinery/disposal');
  assert.equal(renderChannel(bin, [closed, bin], db), 'disposal-surface');
  assert.equal(bakedChannel(atom('/obj/structure/lattice'), [closed], db), 'base');
  assert.equal(bakedChannel(atom('/obj/machinery/meter'), [closed], db), 'pipes-equipment');
  assert.equal(
    bakedChannel(atom('/obj/machinery/portable_atmospherics/canister'), [closed], db),
    'foreground',
  );
});
test('atmospherics components stay visible under intact floors while their pipe caps follow the pipe layer', () => {
  const db = {
    resolve: (type) =>
      type.startsWith('/turf/')
        ? { underfloor_accessibility: '0' }
        : type.includes('/vent_')
          ? { hide: 'TRUE' }
          : {},
    literal: (value) => value,
  };
  const closed = { path: '/turf/open/floor/iron', vars: {} },
    vent = { path: '/obj/machinery/atmospherics/components/unary/vent_scrubber', vars: {} };
  assert.equal(renderChannel(vent, [closed, vent], db), 'pipes');
  assert.equal(bakedChannel(vent, [closed, vent], db), 'pipes-equipment');
  const cap = {
    ...vent,
    vars: { icon: "'icons/obj/pipes_n_cables/pipe_underlays.dmi'", icon_state: '"intact_1_3"' },
  };
  assert.equal(bakedChannel(cap, [closed, cap], db), 'pipes');
});
