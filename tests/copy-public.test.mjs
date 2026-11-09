import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const moduleUrl = new URL('../scripts/lib/copy-public.mjs', import.meta.url).href;

for (const publicAssets of [false, true]) {
  test(`viewer packaging uses external data ${publicAssets ? 'with' : 'without'} a public directory`, () => {
    const root = mkdtempSync(path.join(tmpdir(), 'atlas-copy-public-'));
    const put = (file, contents) => {
      const target = path.join(root, file);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, contents);
    };
    try {
      const manifest = { dataPath: 'snapshots/current', maps: [{ id: 'one' }], commit: 'fixture' };
      put('export/manifest.json', JSON.stringify(manifest));
      put('export/snapshots/current/one/map.json', '{"id":"one"}');
      put('export/snapshots/current/UPSTREAM-README.md', 'Fixture credits');
      put('export/snapshots/current/retired/map.json', 'Do not package');
      if (publicAssets) {
        put('public/robots.txt', 'User-agent: *');
        put('public/data/manifest.json', 'Stale local data');
      }
      execFileSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `import { copyPublic } from ${JSON.stringify(moduleUrl)}; copyPublic('output');`,
        ],
        {
          cwd: root,
          env: { ...process.env, ATLAS_DATA_ROOT: path.join(root, 'export') },
        },
      );
      const read = (file) => readFileSync(path.join(root, 'output', file), 'utf8');
      assert.deepEqual(JSON.parse(read('data/manifest.json')), { maps: manifest.maps, commit: 'fixture' });
      assert.equal(read('data/one/map.json'), '{"id":"one"}');
      assert.equal(read('data/UPSTREAM-README.md'), 'Fixture credits');
      assert.equal(existsSync(path.join(root, 'output/data/retired')), false);
      assert.equal(existsSync(path.join(root, 'public')), publicAssets);
      if (publicAssets) assert.equal(read('robots.txt'), 'User-agent: *');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
