import test from 'node:test';
import assert from 'node:assert/strict';
import {
  arcadePreviewPool,
  randomAppearances,
  randomSourceInfo,
  ARCADE_PREVIEW_DESCRIPTION,
} from '../scripts/lib/random-appearances.mjs';
import { expandStructures } from '../scripts/lib/appearance.mjs';
import { bakedChannel } from '../scripts/lib/utility-visibility.mjs';
import { randomPreviewMarkup } from '../src/model/random-preview.ts';

const spawn = '/obj/effect/spawner/random/entertainment/arcade';
const arcade = '/obj/machinery/computer/arcade';
function database() {
  const types = new Map([
    [
      spawn,
      {
        loot: `list(${arcade}/orion_trail = 49, ${arcade}/battle = 49, ${arcade}/amputation = 2)`,
        icon: "'random_spawners.dmi'",
        icon_state: '"arcade"',
      },
    ],
    ...['orion_trail', 'battle', 'amputation'].map((name) => [
      `${arcade}/${name}`,
      {
        icon: "'computer.dmi'",
        icon_state: '"arcade"',
        icon_keyboard: 'null',
        icon_screen: JSON.stringify(
          name === 'battle' ? 'fighters' : name === 'orion_trail' ? 'orion' : 'invaders',
        ),
      },
    ]),
    [
      '/obj/structure/extinguisher_cabinet/directional/south',
      { icon: "'wallmounts.dmi'", icon_state: '"extinguisher"', opened: 'FALSE', pixel_y: '-29', dir: '2' },
    ],
  ]);
  return {
    types,
    resolve: (path) => types.get(path) || {},
    literal: (value) => value,
    hasIconState: () => true,
  };
}

test('random arcades use a stable real cabinet and screen, preserve direction and toggle both to rainbow markers', () => {
  const db = database(),
    source = { path: spawn, vars: { dir: '1', pixel_x: '4' } };
  assert.equal(arcadePreviewPool(source, db).length, 3);
  assert.deepEqual(randomSourceInfo(source, db), { kind: 'arcade', guaranteed: true });
  const result = randomAppearances([source], [source], 93, 96, 1, db);
  const previews = result.filter((a) => a.vars.atlas_random_preview);
  assert.equal(previews.length, 2, 'cabinet plus screen');
  assert.ok(
    previews.every((a) => a.path.startsWith(arcade + '/') && a.vars.dir === '1' && a.vars.pixel_x === '4'),
  );
  assert.equal(previews[0].vars.icon, "'computer.dmi'");
  assert.equal(previews[1].vars.icon_state, db.resolve(previews[0].path).icon_screen);
  assert.ok(previews.every((a) => bakedChannel(a, result, db) === 'foreground'));
  assert.equal(result.filter((a) => a.vars.atlas_random_marker).length, 2);
  assert.deepEqual(result, randomAppearances([source], [source], 93, 96, 1, db));
  assert.match(
    randomPreviewMarkup(
      [{ name: 'Random arcade', random: { kind: 'arcade' }, description: ARCADE_PREVIEW_DESCRIPTION }],
      false,
    ),
    /actual game is chosen/,
  );
  for (const vars of [
    { spawn_loot_chance: '50' },
    { spawn_scatter_radius: '2' },
    { loot: `list(${arcade}/battle, null)` },
  ])
    assert.deepEqual(arcadePreviewPool({ path: spawn, vars }, db), []);
});

test('directly mapped arcade cabinets also get their screen overlay', () => {
  const db = database();
  const result = expandStructures([{ path: arcade + '/battle', vars: { dir: '8' } }], db);
  assert.equal(result.length, 2);
  assert.equal(result[1].vars.icon_state, '"fighters"');
  assert.equal(result[1].vars.dir, '8');
  assert.ok(result.every((a) => !a.vars.atlas_random_preview));
});

test('map-loaded extinguisher cabinets include the extinguisher and the correct door at the same offset', () => {
  const db = database(),
    path = '/obj/structure/extinguisher_cabinet/directional/south';
  for (const opened of ['FALSE', 'TRUE']) {
    const source = { path, vars: { opened, pixel_y: '-29', dir: '2' } };
    const result = expandStructures([source], db);
    assert.deepEqual(
      result.map((a) => a.vars.icon_state),
      ['"extinguisher_default"', opened === 'TRUE' ? '"door_open"' : '"door"'],
    );
    assert.ok(result.every((a) => a.vars.pixel_y === '-29' && a.vars.dir === '2'));
  }
  const frame = { path: '/obj/item/wallframe/extinguisher_cabinet', vars: {} };
  assert.deepEqual(
    expandStructures([frame], db),
    [frame],
    'unassembled empty frames do not acquire an extinguisher',
  );
});
