import test from 'node:test';
import assert from 'node:assert/strict';
import { GenerationController, checkpointBaseline } from '../scripts/dev/dev-generation.mjs';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

test('generation debounces changes, cancels stale runs and publishes only current inputs', async () => {
  let key = 'a',
    now = 0;
  const completed = new Set(),
    started = [],
    released = new Map(),
    published = [];
  const controller = new GenerationController({
    inputs: async () => ({ key }),
    current: async (input) => completed.has(input.key),
    debounce: 100,
    now: () => now,
    run: (input, signal) =>
      new Promise((resolve, reject) => {
        started.push(input.key);
        signal.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')));
        released.set(input.key, () =>
          resolve(async () => {
            completed.add(input.key);
            published.push(input.key);
          }),
        );
      }),
  });
  await controller.tick();
  assert.deepEqual(started, []);
  now = 101;
  await controller.tick();
  assert.deepEqual(started, ['a']);
  const obsolete = controller.active.promise;
  key = 'b';
  await controller.tick();
  await obsolete;
  now = 150;
  key = 'c';
  await controller.tick();
  now = 251;
  await controller.tick();
  assert.deepEqual(started, ['a', 'c']);
  released.get('c')();
  await controller.active.promise;
  assert.deepEqual(published, ['c']);
  await controller.tick();
  assert.equal(controller.active, null);
  controller.invalidate();
  await controller.tick();
  assert.deepEqual(started, ['a', 'c', 'c']);
  await controller.close();
});

test('an edit after generation but before the next polling tick discards the result', async () => {
  let key = 'a',
    finish,
    discarded = 0,
    published = 0;
  const controller = new GenerationController({
    inputs: async () => ({ key }),
    current: async () => false,
    debounce: 0,
    run: () =>
      new Promise((resolve) => {
        finish = () => {
          const publish = async () => published++;
          publish.discard = async () => discarded++;
          resolve(publish);
        };
      }),
  });
  await controller.tick();
  const promise = controller.active.promise;
  key = 'b';
  finish();
  await promise;
  assert.equal(published, 0);
  assert.equal(discarded, 1);
  await controller.close();
});

test('failed generations wait for retry or changed inputs instead of looping forever', async () => {
  let key = 'a',
    runs = 0;
  const controller = new GenerationController({
    inputs: async () => ({ key }),
    current: async () => false,
    debounce: 0,
    run: async () => {
      runs++;
      throw Error('Broken generator');
    },
  });
  await controller.tick();
  await controller.active?.promise;
  await controller.tick();
  assert.equal(runs, 1);
  assert.equal(controller.status.phase, 'error');
  controller.invalidate();
  await controller.tick();
  await controller.active?.promise;
  assert.equal(runs, 2);
  key = 'b';
  await controller.tick();
  await controller.active?.promise;
  assert.equal(runs, 3);
  await controller.close();
});
test('completed-map checkpoints resume only with matching input hashes and safe paths', async () => {
  const cache = await mkdtemp(path.join(os.tmpdir(), 'atlas-checkpoint-')),
    folder = path.join(cache, 'export-123abc');
  try {
    await mkdir(folder);
    await writeFile(
      path.join(folder, 'manifest.json'),
      JSON.stringify({ complete: false, maps: [{ id: 'finished' }] }),
    );
    const pointer = path.join(cache, 'dev-generation-checkpoint.json');
    await writeFile(pointer, JSON.stringify({ key: 'same', folder }));
    assert.equal(await checkpointBaseline(cache, { key: 'same' }, 'published'), folder);
    assert.equal(await checkpointBaseline(cache, { key: 'changed' }, 'published'), 'published');
    await writeFile(pointer, JSON.stringify({ key: 'same', folder: path.dirname(cache) }));
    assert.equal(await checkpointBaseline(cache, { key: 'same' }, 'published'), 'published');
  } finally {
    await rm(cache, { recursive: true, force: true });
  }
});
test('development converts a small default station subset unless ATLAS_DEV_MAPS widens it', async () => {
  const { devMaps, DEFAULT_DEV_MAPS } = await import('../scripts/dev/dev-generation.mjs');
  assert.deepEqual(devMaps({}), DEFAULT_DEV_MAPS);
  assert.deepEqual(DEFAULT_DEV_MAPS, ['boxstation', 'northstar', 'icebox']);
  assert.equal(devMaps({ ATLAS_DEV_MAPS: 'all' }), null);
  assert.equal(devMaps({ ATLAS_DEV_MAPS: ' * ' }), null);
  assert.deepEqual(devMaps({ ATLAS_DEV_MAPS: 'tramstation, metastation,tramstation' }), [
    'tramstation',
    'metastation',
  ]);
  assert.throws(() => devMaps({ ATLAS_DEV_MAPS: '../etc' }), /Invalid map ID/);
});
test('manual mode reports stale inputs, regenerates on request in the background and keeps results', async () => {
  let key = 'a',
    dataset = true,
    runs = 0,
    finish;
  const published = [];
  const controller = new GenerationController({
    mode: 'manual',
    inputs: async () => ({ key }),
    current: async (input) => published.includes(input.key),
    hasDataset: async () => dataset,
    describe: (input) => [{ kind: 'file', detail: `inputs are now ${input.key}` }],
    debounce: 0,
    run: (input, signal, report, options) =>
      new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')));
        runs++;
        finish = () => resolve(async () => published.push(`${input.key}${options.full ? '!' : ''}`));
      }),
  });
  // Out-of-date data with a dataset present: nothing runs, the change is described.
  await controller.tick();
  assert.equal(runs, 0);
  assert.equal(controller.status, null);
  assert.deepEqual(controller.stale.changes, [{ kind: 'file', detail: 'inputs are now a' }]);
  // A request starts a background job that keeps serving (status stays null).
  assert.equal(await controller.request(), true);
  assert.equal(runs, 1);
  assert.equal(controller.status, null);
  assert.equal(controller.job.phase, 'running');
  assert.equal(await controller.request(), false, 'no second job while one runs');
  // Inputs changing during the run neither cancel it nor discard its result.
  key = 'b';
  await controller.tick();
  finish();
  await controller.active.promise;
  assert.deepEqual(published, ['a']);
  assert.equal(controller.job.phase, 'published');
  await controller.tick();
  assert.deepEqual(controller.stale.changes, [{ kind: 'file', detail: 'inputs are now b' }]);
  // Full rebuilds pass the flag through; cancelling aborts the active job.
  await controller.request({ full: true });
  assert.equal(controller.job.full, true);
  assert.equal(controller.cancel(), true);
  await controller.active?.promise;
  assert.equal(controller.job.phase, 'cancelled');
  assert.deepEqual(published, ['a']);
  // Without any dataset the controller still generates by itself (cold start).
  dataset = false;
  published.length = 0;
  await controller.tick();
  assert.equal(runs, 3);
  assert.equal(controller.status.phase, 'preparing');
  finish();
  await controller.active.promise;
  assert.deepEqual(published, ['b']);
  assert.equal(controller.status, null);
  await controller.close();
});

test('describeChanges lists upstream, map selection and generator file differences', async () => {
  const { describeChanges } = await import('../scripts/dev/dev-generation.mjs');
  const stamp = {
    commit: 'a'.repeat(40),
    maps: ['boxstation'],
    hashes: { 'scripts/lib/dm.mjs': '1', 'scripts/lib/old.mjs': '2' },
  };
  const input = {
    commit: 'b'.repeat(40),
    maps: null,
    hashes: { 'scripts/lib/dm.mjs': '3', 'scripts/lib/new.mjs': '4' },
  };
  assert.deepEqual(
    describeChanges(stamp, input).map((change) => change.detail),
    [
      `Upstream checkout moved from ${'a'.repeat(12)} to ${'b'.repeat(12)}.`,
      'Map selection changed from boxstation to all stations.',
      'scripts/lib/dm.mjs changed.',
      'scripts/lib/new.mjs was added.',
      'scripts/lib/old.mjs was removed.',
    ],
  );
  assert.deepEqual(
    describeChanges(stamp, { ...input, commit: stamp.commit, maps: ['boxstation'], hashes: stamp.hashes }),
    [],
  );
  assert.equal(describeChanges(null, input)[0].kind, 'stamp');
});
