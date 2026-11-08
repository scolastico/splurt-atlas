import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { placeRoundstartShuttles } from '../scripts/lib/roundstart-shuttles.mjs';
import { createTileRenderer } from '../scripts/lib/tile-renderer.mjs';

test('docking-port mapper icons are not drawn over spawned pods', async () => {
  const renderer = createTileRenderer({
    db: { resolve: () => ({ icon: "'ports.dmi'" }) },
    sprites: {
      sprite: () => {
        throw new Error('Invisible port must not request a sprite');
      },
    },
    tilePixels: 32,
  });
  assert.equal(
    await renderer.render([{ path: '/obj/docking_port/mobile/pod', vars: {} }], 'foreground'),
    null,
  );
});

test('fixed escape pods align mobile ports, rotate footprints/atoms, preserve docks and track source templates', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'atlas-pods-'));
  try {
    mkdirSync(path.join(root, '_maps/shuttles'), { recursive: true });
    writeFileSync(
      path.join(root, '_maps/shuttles/escape_pod_default.dmm'),
      `
"a" = (/obj/docking_port/mobile/pod,/turf/open/floor/plating,/area/shuttle/pod_1)
"b" = (/obj/structure/chair{dir = 1; pixel_x = 3; pixel_y = 4},/turf/closed/wall,/area/shuttle/pod_1)
"c" = (/turf/template_noop,/area/shuttle/pod_1)
(1,1,1) = {"
ba
ca
"}
`,
    );
    const db = {
      resolve: (type) =>
        type.startsWith('/datum/')
          ? { prefix: '"_maps/shuttles/"', port_id: '"escape_pod"', suffix: '"default"' }
          : type.includes('/stationary/')
            ? { dir: '1', roundstart_template: '/datum/map_template/shuttle/escape_pod/default' }
            : { dir: '1' },
    };
    for (const [dir, expected] of [
      [1, [9, 10]],
      [4, [10, 11]],
      [2, [11, 10]],
      [8, [10, 9]],
    ]) {
      const dock = { path: '/obj/docking_port/stationary/escape_pod', vars: { dir: String(dir) } };
      const map = {
        width: 20,
        height: 20,
        levels: [4],
        cells: [{ x: 10, y: 10, z: 4, key: 'dock' }],
        dictionary: new Map([['dock', [dock, { path: '/turf/open/space', vars: {} }]]]),
      };
      assert.deepEqual(placeRoundstartShuttles(map, root, db), ['_maps/shuttles/escape_pod_default.dmm']);
      const at = (x, y) => map.dictionary.get(map.cells.find((c) => c.x === x && c.y === y).key);
      assert.ok(at(10, 10).some((atom) => atom === dock));
      const mobile = at(10, 10).find((atom) => atom.path.includes('/mobile/'));
      assert.equal(Number(mobile.vars.dir || db.resolve(mobile.path).dir), dir);
      const chair = at(...expected).find((atom) => atom.path.includes('/chair'));
      assert.equal(Number(chair.vars.dir), dir);
      if (dir === 8) assert.deepEqual([chair.vars.pixel_x, chair.vars.pixel_y], ['-4', '3']);
      assert.equal(map.cells.length, 3); // template_noop is left untouched
      assert.ok(map.cells.every((cell) => cell.z === 4));
    }
    const map = {
      width: 20,
      height: 20,
      cells: [{ x: 10, y: 10, z: 1, key: 'dock' }],
      dictionary: new Map([
        [
          'dock',
          [{ path: '/obj/docking_port/stationary/escape_pod', vars: { roundstart_template: 'null' } }],
        ],
      ]),
    };
    assert.deepEqual(placeRoundstartShuttles(map, root, db), []);
    assert.equal(map.cells.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
