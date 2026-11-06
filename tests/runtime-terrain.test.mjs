import test from 'node:test';
import assert from 'node:assert/strict';
import { runtimeReplacement } from '../scripts/lib/runtime-terrain.mjs';
test('generator placeholders resolve to the area’s real terrain family', () => {
  const db = {
    resolve: (p) =>
      p === '/area/ice'
        ? { map_generator: '/generator/ice' }
        : p === '/generator/ice'
          ? { weighted_open_turf_types: 'list(/turf/open/snow = 19, /turf/open/ice = 1)' }
          : p === '/turf/open/snow'
            ? { name: '"snow"', desc: '"Cold snow."' }
            : {},
  };
  assert.deepEqual(runtimeReplacement({ turf: '/turf/open/genturf/blue' }, { path: '/area/ice' }, db), {
    type: '/turf/open/snow',
    name: 'snow',
    description: 'Cold snow.',
    approximate: true,
  });
  assert.equal(runtimeReplacement({ turf: '/turf/open/floor/iron' }, { path: '/area/ice' }, db), null);
  assert.equal(runtimeReplacement({ turf: '/turf/open/genturf' }, { path: '/area/unknown' }, db), null);
});
