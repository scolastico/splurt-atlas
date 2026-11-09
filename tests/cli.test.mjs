import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import sharp from 'sharp';
import { parseCli } from '../scripts/cli.mjs';

test('container CLI validates options', () => {
  assert.deepEqual(parseCli(['--maps', 'one,two', '--viewer']).maps, ['one', 'two']);
  assert.throws(() => parseCli(['--source']), /Missing value/);
  assert.throws(() => parseCli(['--wat']), /Unknown option/);
  assert.throws(() => parseCli(['--workers', '0']), /positive integer/);
});

test('mounted-checkout CLI exports data and static viewer without modifying source or published data', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'atlas-cli-'));
  const source = path.join(root, 'source');
  const put = (file, value) => {
    const target = path.join(source, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, value);
  };
  const git = (...args) => execFileSync('git', ['-C', source, ...args], { encoding: 'utf8' }).trim();
  const run = (...args) =>
    execFileSync(process.execPath, ['scripts/cli.mjs', '--source', source, ...args], {
      encoding: 'utf8',
      timeout: 120000,
    });
  const read = (file) => JSON.parse(readFileSync(file));
  const published = existsSync('public/data/manifest.json')
    ? readFileSync('public/data/manifest.json')
    : null;
  try {
    put('custom.dme', '#include "code/main.dm"');
    put(
      'code/main.dm',
      '/turf/open/floor\n    name = "Floor"\n    icon = \'icons/floor.dmi\'\n/obj/item/overhang\n    icon = \'icons/floor.dmi\'\n    pixel_x = 16\n    color = "#88ff88"\n/area/test\n    name = "Room"\n',
    );
    put('LICENSE', 'Fixture license');
    put('README.md', 'Fixture station');
    put('_maps/one.json', JSON.stringify({ map_name: 'One', map_path: 'one', map_file: 'station.dmm' }));
    put(
      '_maps/one/station.dmm',
      '"a" = (/turf/open/floor,/area/test)\n"b" = (/obj/item/overhang,/turf/open/floor,/area/test)\n(1,1,1) = {"\n' +
        'a'.repeat(15) +
        'b' +
        'a'.repeat(17) +
        '\n"}',
    );
    mkdirSync(path.join(source, 'icons'));
    const icon = async (color) =>
      sharp({ create: { width: 32, height: 32, channels: 4, background: color } })
        .png()
        .toFile(path.join(source, 'icons/floor.dmi'));
    await icon('#ff6600');
    git('init', '-b', 'main');
    git('add', '.');
    git('-c', 'user.name=Atlas test', '-c', 'user.email=atlas@example.test', 'commit', '-m', 'fixture');
    const beforeStatus = git('status', '--porcelain');
    const data = path.join(root, 'data');
    run('--output', data, '--workers', '3');
    assert.equal(git('status', '--porcelain'), beforeStatus);
    assert.equal(read(path.join(data, 'manifest.json')).commit, git('rev-parse', 'HEAD'));
    assert.ok(existsSync(path.join(data, 'one/1/c-2-0.webp')), 'one deck was split into three render jobs');
    const serial = path.join(root, 'serial');
    run('--output', serial, '--workers', '1');
    for (const asset of read(path.join(data, 'one/assets.json')))
      assert.deepEqual(
        readFileSync(path.join(data, 'one', asset.path)),
        readFileSync(path.join(serial, 'one', asset.path)),
        `serial/parallel asset differs: ${asset.path}`,
      );
    await icon('#3366ff'); // Intentionally leave a working-tree sprite edit uncommitted.
    const dirtyStatus = git('status', '--porcelain');
    const viewer = path.join(root, 'viewer');
    run('--output', viewer, '--viewer', '--baseline', data, '--workers', '3');
    assert.equal(git('status', '--porcelain'), dirtyStatus);
    assert.equal(read(path.join(viewer, 'data/manifest.json')).dirty, true);
    assert.deepEqual(read(path.join(viewer, 'data/build-report.json')).rebuilt, ['one']);
    assert.ok(existsSync(path.join(viewer, 'index.html')));
    assert.ok(!existsSync(path.join(viewer, 'diff.html')));
    assert.notDeepEqual(
      readFileSync(path.join(data, 'one/1/c-0-0.webp')),
      readFileSync(path.join(viewer, 'data/one/1/c-0-0.webp')),
    );
    git('restore', 'icons/floor.dmi');
    const restored = path.join(root, 'restored');
    run('--output', restored, '--baseline', path.join(viewer, 'data'), '--workers', '3');
    assert.deepEqual(read(path.join(restored, 'build-report.json')).rebuilt, ['one']);
    assert.deepEqual(
      readFileSync(path.join(restored, 'one/1/c-0-0.webp')),
      readFileSync(path.join(data, 'one/1/c-0-0.webp')),
    );
    assert.throws(() => run('--output', data), /Command failed/);
    const archive = path.join(root, 'archive');
    cpSync(source, archive, { recursive: true, filter: (file) => path.basename(file) !== '.git' });
    const archiveOutput = path.join(root, 'archive-data');
    run(
      '--source',
      archive,
      '--output',
      archiveOutput,
      '--revision',
      'ci-revision',
      '--repository',
      'https://example.test/station',
    );
    const archived = read(path.join(archiveOutput, 'manifest.json'));
    assert.equal(archived.commit, 'ci-revision');
    assert.equal(archived.revisionVerified, false);
    assert.equal(archived.repository, 'https://example.test/station');
    assert.equal(existsSync(path.join(archive, '.git')), false);
    if (published) assert.deepEqual(readFileSync('public/data/manifest.json'), published);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
