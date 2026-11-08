import test from 'node:test';
import assert from 'node:assert/strict';
import { selectedArea, selectionBounds, selectionCamera, viewFragment } from '../src/model/view-state.ts';
import { selectionDefinitions, selectionTiles } from '../src/model/selection-data.ts';
import { solarOverlays, expandStructures } from '../scripts/lib/appearance.mjs';
import { buildInfrastructure } from '../scripts/lib/infrastructure.mjs';

test('tile-only links center on the tile and supply the deck without pixel camera parameters', () => {
  const map = { width: 200, height: 200, levels: [1, 3] };
  assert.deepEqual(selectionCamera(new URLSearchParams({ t: '81,183,3' }), map), {
    x: 2576,
    y: 560,
    z: 3,
    zoom: 1,
  });
  assert.deepEqual(selectionCamera(new URLSearchParams({ t: '81,183,3', s: '2' }), map), {
    x: 2576,
    y: 560,
    z: 3,
    zoom: 2,
  });
  assert.equal(selectionCamera(new URLSearchParams({ t: '81,183,3', x: '12', y: '13' }), map), null);
  assert.equal(selectionCamera(new URLSearchParams({ t: '999,183,3' }), map), null);
});

test('area bounds normalize reverse drags, roundtrip in links and reject out-of-map selections', () => {
  const area = selectionBounds({ x: 5, y: 8, z: 3 }, { x: 2, y: 6, z: 3 });
  assert.deepEqual(area, { x1: 2, y1: 6, x2: 5, y2: 8, z: 3 });
  const map = { id: 'fixture', width: 10, height: 10, levels: [1, 3] };
  const fragment = viewFragment({
    map,
    x: 112,
    y: 112,
    z: 3,
    zoom: 2,
    selected: { x: 2, y: 6, z: 3 },
    selectedArea: area,
    optionMask: 123,
  });
  assert.deepEqual(selectedArea(new URLSearchParams(fragment.slice(1)), map), area);
  assert.equal(selectionTiles(area).length, 12);
  for (const raw of ['0,1,3,4,3', '2,3,1,4,3', '1,1,11,3,3', '1,1,3,3,2', '1,1,3,3,3,4', '1,1,3.5,3,3'])
    assert.equal(selectedArea(new URLSearchParams({ a: raw }), map), null, raw);
});

test('area inspection groups repeated definitions while retaining every selected coordinate', () => {
  const plain = { area: 0, turf: '/turf/floor', atoms: [] };
  const filled = { area: 1, turf: '/turf/snow', atoms: [{ name: 'solar panel' }] };
  const area = { x1: 2, y1: 3, x2: 4, y2: 4, z: 1 };
  const groups = selectionDefinitions(area, (x, y, z) => (x === 3 && y === 4 && z === 1 ? filled : plain));
  assert.equal(groups.length, 2);
  assert.equal(groups[0].tiles.length, 5);
  assert.deepEqual(groups[1], { definition: filled, tiles: [{ x: 3, y: 4, z: 1 }] });
});

test('solar panels and trackers include raised faces and edges, with mapped placement retained', () => {
  const db = {
    resolve: (path) =>
      path.startsWith('/datum/material')
        ? { name: '"glass"' }
        : { icon: "'solar.dmi'", icon_state: '"sp_base"' },
    hasIconState: () => true,
  };
  for (const [path, states] of [
    ['/obj/machinery/power/solar', ['solar_panel_glass_edge', 'solar_panel_glass']],
    ['/obj/machinery/power/tracker', ['tracker_edge', 'tracker']],
  ]) {
    const atom = { path, vars: { pixel_x: '4', pixel_z: '2' } };
    const overlays = solarOverlays(atom, db);
    assert.deepEqual(
      overlays.map((a) => JSON.parse(a.vars.icon_state)),
      states,
    );
    assert.deepEqual(
      overlays.map((a) => a.vars.pixel_z),
      ['13', '15'],
    );
    assert.ok(overlays.every((a) => a.vars.pixel_x === '4' && a.vars.layer === '5'));
    assert.equal(expandStructures([atom], db).length, 3);
  }
  assert.deepEqual(solarOverlays({ path: '/obj/machinery/power/solar_control', vars: {} }, db), []);
  db.hasIconState = () => false;
  assert.deepEqual(solarOverlays({ path: '/obj/machinery/power/solar', vars: {} }, db), []);
});

test('descending stair markers align with the actual stair tile rather than the adjacent landing', () => {
  for (const dir of [1, 2, 4, 8]) {
    const atom = {
      path: '/obj/structure/stairs',
      vars: { dir: String(dir), terminator_mode: 'STAIR_TERMINATOR_YES' },
    };
    const cells = [{ x: 4, y: 5, z: 1, appearance: [atom] }];
    const db = { resolve: () => ({}) };
    const data = buildInfrastructure(
      cells,
      (x, y, z) => (x === 4 && y === 5 && z === 1 ? [atom] : []),
      db,
      [1, 2],
    );
    const upper = data.transitions.find((t) => t.z === 2);
    assert.deepEqual([upper.x, upper.y], [4, 5]);
    assert.equal(upper.targets[0].z, 1);
  }
});
