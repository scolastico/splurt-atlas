import test from 'node:test';
import assert from 'node:assert/strict';
import { randomisePosters } from '../scripts/lib/appearance.mjs';
test('random posters resolve to a deterministic real poster following the game pool rules', () => {
  const types = new Map([
    ['/obj/structure/sign/poster', { icon: "'icons/obj/poster.dmi'" }],
    [
      '/obj/structure/sign/poster/random',
      {
        icon_state: '"random_anything"',
        never_random: 'TRUE',
        random_basetype: '/obj/structure/sign/poster',
        blacklisted_types: 'list(\n\t/obj/structure/sign/poster/traitor)',
      },
    ],
    ['/obj/structure/sign/poster/random/directional/north', { pixel_y: '32' }],
    ['/obj/structure/sign/poster/official', {}],
    ['/obj/structure/sign/poster/official/safety', { icon_state: '"safety"' }],
    ['/obj/structure/sign/poster/official/safety/directional/west', { pixel_x: '-32' }],
    ['/obj/structure/sign/poster/contraband/clown', { icon: "'icons/obj/clown.dmi'", icon_state: '"clown"' }],
    ['/obj/structure/sign/poster/traitor/evil', { icon_state: '"evil"' }],
    ['/obj/structure/sign/poster/greenscreen', { icon_state: '"greenscreen"', never_random: 'TRUE' }],
  ]);
  const resolve = (type) => {
    let merged = {};
    for (const [path, vars] of types)
      if (type === path || type.startsWith(path + '/')) merged = { ...merged, ...vars };
    return merged;
  };
  const db = { types, resolve, literal: (value) => value };
  const poster = (path) => ({ path, vars: {} }),
    cable = poster('/obj/structure/cable'),
    allowed = new Set(['"safety"', '"clown"']);
  const seen = new Set();
  for (let x = 1; x <= 40; x++) {
    const [atom, plain] = randomisePosters(
      [poster('/obj/structure/sign/poster/random/directional/north'), cable],
      x,
      7,
      2,
      db,
    );
    assert.equal(plain, cable);
    assert.equal(atom.path, '/obj/structure/sign/poster/random/directional/north');
    assert.ok(allowed.has(atom.vars.icon_state), atom.vars.icon_state);
    seen.add(atom.vars.icon_state);
    if (atom.vars.icon_state === '"clown"') assert.equal(atom.vars.icon, "'icons/obj/clown.dmi'");
    assert.deepEqual(
      randomisePosters([poster('/obj/structure/sign/poster/random/directional/north')], x, 7, 2, db)[0],
      atom,
    );
  }
  assert.equal(seen.size, 2);
  const [fixed] = randomisePosters([poster('/obj/structure/sign/poster/official/safety')], 3, 3, 1, db);
  assert.deepEqual(fixed.vars, {});
});
