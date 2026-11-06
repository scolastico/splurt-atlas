import test from 'node:test';
import assert from 'node:assert/strict';
import { GenerationController, checkpointBaseline } from '../scripts/dev-generation.mjs';
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
  const { devMaps, DEFAULT_DEV_MAPS } = await import('../scripts/dev-generation.mjs');
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
