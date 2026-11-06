import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  cpSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import sharp from 'sharp';
import { localGenerator, generatorInputs } from '../scripts/dev-generation.mjs';
// The fixture workspace carries its own small map set, so development mode must not narrow it to the default station subset.
process.env.ATLAS_DEV_MAPS = 'all';

test('incremental exporter reuses unchanged maps and invalidates map, sprite, inherited-code and missing-asset changes', async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'splurt-incremental-'));
  const source = path.join(workspace, '.source/S.P.L.U.R.T-tg');
  const put = (file, text) => {
    mkdirSync(path.dirname(path.join(workspace, file)), { recursive: true });
    writeFileSync(path.join(workspace, file), text);
  };
  const git = (args) =>
    execFileSync('git', args, { cwd: source, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const config = {
    repository: 'https://example.test/upstream.git',
    ref: '',
    maps: 'all',
    excludeMaps: [],
    chunkTiles: 16,
    tilePixels: 32,
  };
  const commit = () => {
    git(['add', '.']);
    git([
      '-c',
      'user.name=Atlas test',
      '-c',
      'user.email=atlas@example.test',
      'commit',
      '--allow-empty',
      '-m',
      'fixture',
    ]);
    config.ref = git(['rev-parse', 'HEAD']);
    put('atlas.config.json', JSON.stringify(config));
    put('.source/provenance.json', JSON.stringify({ repository: config.repository, commit: config.ref }));
  };
  const baseline = () =>
    cpSync(path.join(workspace, 'public/data'), path.join(workspace, '.cache/baseline/data'), {
      recursive: true,
    });
  const run = (...args) => {
    execFileSync(process.execPath, ['scripts/export.mjs', ...args], {
      cwd: workspace,
      encoding: 'utf8',
      timeout: 120000,
    });
    return JSON.parse(readFileSync(path.join(workspace, 'public/data/build-report.json')));
  };
  const pixels = (id) => readFileSync(path.join(workspace, `public/data/${id}/1/c-0-0.webp`));
  try {
    cpSync('scripts', path.join(workspace, 'scripts'), { recursive: true });
    cpSync('package.json', path.join(workspace, 'package.json'));
    cpSync('pnpm-lock.yaml', path.join(workspace, 'pnpm-lock.yaml'));
    cpSync('NOTICE', path.join(workspace, 'NOTICE'));
    symlinkSync(
      path.resolve('node_modules'),
      path.join(workspace, 'node_modules'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    put('.source/S.P.L.U.R.T-tg/tgstation.dme', '#include "code/main.dm"');
    let code =
      '/turf/open/floor\n    color = "#ffffff"\n/turf/open/floor/one\n    name = "First floor"\n    icon = \'icons/one.dmi\'\n/turf/open/floor/two\n    name = "Second floor"\n    icon = \'icons/two.dmi\'\n/area/test\n    name = "Test room"\n';
    put('.source/S.P.L.U.R.T-tg/code/main.dm', code);
    put('.source/S.P.L.U.R.T-tg/LICENSE', 'Fixture license');
    put('.source/S.P.L.U.R.T-tg/README.md', 'Fixture');
    for (const id of ['one', 'two']) {
      put(
        `.source/S.P.L.U.R.T-tg/_maps/${id}.json`,
        JSON.stringify({ map_name: id, map_path: id, map_file: 'station.dmm' }),
      );
      put(
        `.source/S.P.L.U.R.T-tg/_maps/${id}/station.dmm`,
        `"a" = (/turf/open/floor/${id},/area/test)\n(1,1,1) = {"\na\n"}`,
      );
      mkdirSync(path.join(source, 'icons'), { recursive: true });
      await sharp({ create: { width: 32, height: 32, channels: 4, background: '#ff6600' } })
        .png()
        .toFile(path.join(source, `icons/${id}.dmi`));
    }
    git(['init', '-b', 'main']);
    commit();
    assert.deepEqual(run('--full').rebuilt, ['one', 'two']);
    const parallelPixels = pixels('one');
    execFileSync(process.execPath, ['scripts/export.mjs', '--full'], {
      cwd: workspace,
      env: { ...process.env, ATLAS_WORKERS: '1' },
      timeout: 120000,
    });
    assert.deepEqual(
      pixels('one'),
      parallelPixels,
      'Serial and parallel conversion must produce identical pixels',
    );
    baseline();
    const original = pixels('one');
    put('.source/S.P.L.U.R.T-tg/README.md', 'Only documentation changed');
    commit();
    let report = run('--incremental');
    assert.deepEqual(report.rebuilt, []);
    assert.deepEqual(report.reused, ['one', 'two']);
    assert.ok(report.changedFiles.includes('README.md'));
    assert.deepEqual(pixels('one'), original);
    baseline();
    code += '\n/obj/unrelated\n    name = "Unused type"\n';
    put('.source/S.P.L.U.R.T-tg/code/main.dm', code);
    commit();
    report = run('--incremental');
    assert.deepEqual(report.rebuilt, [], 'Unrelated code does not rerender stations');
    baseline();
    put(
      '.source/S.P.L.U.R.T-tg/_maps/one/station.dmm',
      '"a" = (/obj/item/test,/turf/open/floor/one,/area/test)\n(1,1,1) = {"\na\n"}',
    );
    commit();
    report = run('--incremental');
    assert.deepEqual(report.rebuilt, ['one']);
    assert.deepEqual(report.reused, ['two']);
    baseline();
    await sharp({ create: { width: 32, height: 32, channels: 4, background: '#3366ff' } })
      .png()
      .toFile(path.join(source, 'icons/one.dmi'));
    commit();
    report = run('--incremental');
    assert.deepEqual(report.rebuilt, ['one']);
    assert.deepEqual(report.reused, ['two']);
    assert.notDeepEqual(pixels('one'), original);
    baseline();
    code = code.replace('#ffffff', '#aaffaa');
    put('.source/S.P.L.U.R.T-tg/code/main.dm', code);
    commit();
    report = run('--incremental');
    assert.deepEqual(report.rebuilt, ['one', 'two'], 'Shared parent changes invalidate both maps');
    baseline();
    const file = path.join(workspace, '.cache/baseline/data/manifest.json'),
      legacy = JSON.parse(readFileSync(file));
    delete legacy.converter;
    for (const map of legacy.maps) {
      delete map.fingerprint;
      delete map.inputs;
    }
    writeFileSync(file, JSON.stringify(legacy));
    report = run('--incremental', '--adopt-baseline');
    assert.deepEqual(
      report.rebuilt,
      [],
      'Same-revision legacy output is adopted after metadata verification',
    );
    baseline();
    rmSync(path.join(workspace, '.cache/baseline/data/one/1/c-0-0.webp'));
    report = run('--incremental');
    assert.deepEqual(report.rebuilt, ['one'], 'Missing cached assets require conversion');
    baseline();
    report = run('--incremental', '--full');
    assert.deepEqual(report.rebuilt, ['one', 'two']);
    const generate = async () => {
      const controller = localGenerator(workspace);
      controller.debounce = 0;
      await controller.tick();
      await controller.active?.promise;
      assert.equal(controller.status, null, controller.status?.message);
      await controller.close();
    };
    await generate();
    const stamp = JSON.parse(readFileSync(path.join(workspace, '.cache/dev-generation-stamp.json')));
    const current = () => JSON.parse(readFileSync(path.join(workspace, 'public/data/manifest.json')));
    assert.equal(stamp.buildId, current().buildId);
    assert.ok(
      current().maps.every((map) => map.archive),
      'Automatic development generation packages downloads before publishing',
    );
    put('src/main.js', 'console.log("UI-only change")');
    put('src/style.css', 'body{color:red}');
    await generate();
    assert.equal(
      current().buildId,
      stamp.buildId,
      'Restarts and UI edits reuse the persisted completed export',
    );
    put(
      'scripts/lib/dmm.mjs',
      readFileSync(path.join(workspace, 'scripts/lib/dmm.mjs'), 'utf8') + '\n// Generator edit\n',
    );
    assert.notEqual((await generatorInputs(workspace)).key, stamp.key);
    await generate();
    assert.notEqual(current().buildId, stamp.buildId, 'Generator hashes invalidate old exports');
    const configuredRef = config.ref;
    put('.source/S.P.L.U.R.T-tg/README.md', 'A newly checked-out local commit');
    git(['add', '.']);
    git([
      '-c',
      'user.name=Atlas test',
      '-c',
      'user.email=atlas@example.test',
      'commit',
      '-m',
      'local checkout',
    ]);
    await generate();
    assert.equal(current().commit, git(['rev-parse', 'HEAD']));
    assert.notEqual(current().commit, configuredRef);
    assert.equal(
      JSON.parse(readFileSync(path.join(workspace, 'atlas.config.json'))).ref,
      configuredRef,
      'Development follows the checkout without changing the production pin',
    );
    assert.deepEqual(
      JSON.parse(readFileSync(path.join(workspace, 'public/data', current().dataPath, 'build-report.json')))
        .reused,
      ['one', 'two'],
    );
    rmSync(path.join(workspace, 'public/data/manifest.json'));
    await generate();
    assert.deepEqual(
      JSON.parse(readFileSync(path.join(workspace, 'public/data', current().dataPath, 'build-report.json')))
        .rebuilt,
      ['one', 'two'],
      'Missing generated data starts a fresh automatic generation',
    );
    const beforeCancel = current().buildId;
    put(
      'scripts/export.mjs',
      readFileSync(path.join(workspace, 'scripts/export.mjs'), 'utf8') +
        '\nawait new Promise(resolve=>setTimeout(resolve,1500));\n',
    );
    const cancelled = localGenerator(workspace);
    cancelled.debounce = 0;
    await cancelled.tick();
    let checkpointReady = false;
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline && !checkpointReady) {
      for (const name of readdirSync(path.join(workspace, '.cache')).filter((name) =>
        /^export-[a-f\d-]+$/.test(name),
      )) {
        try {
          const partial = JSON.parse(readFileSync(path.join(workspace, '.cache', name, 'manifest.json')));
          if (partial.maps?.length) checkpointReady = true;
        } catch {}
      }
      if (!checkpointReady) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(checkpointReady, true);
    await cancelled.close();
    assert.equal(
      current().buildId,
      beforeCancel,
      'Cancelling real worker processes must preserve the public catalog',
    );
    assert.ok(JSON.parse(readFileSync(path.join(workspace, '.cache/dev-generation-checkpoint.json'))).folder);
    await generate();
    assert.ok(
      JSON.parse(readFileSync(path.join(workspace, 'public/data', current().dataPath, 'build-report.json')))
        .reused.length > 0,
      'Restarting reuses maps completed before cancellation',
    );
  } finally {
    const resolved = path.resolve(workspace);
    if (
      path.dirname(resolved) !== path.resolve(tmpdir()) ||
      !path.basename(resolved).startsWith('splurt-incremental-')
    )
      throw new Error('Unsafe test workspace');
    rmSync(resolved, { recursive: true, force: true });
  }
});
