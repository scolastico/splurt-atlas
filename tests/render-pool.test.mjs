import test from 'node:test';
import assert from 'node:assert/strict';
import { RenderPool, mapConcurrent } from '../scripts/lib/render-pool.mjs';

const worker = new URL(
  'data:text/javascript,' +
    encodeURIComponent(`
import { parentPort, threadId } from 'node:worker_threads';
parentPort.on('message', task => {
  if (task.crash) process.exit(3);
  setTimeout(() => parentPort.postMessage({ result: { id: task.id, worker: threadId }, report: { requested: 1, missingIcon: 0, missingState: 0, samples: [] } }), task.delay || 0);
});`),
);
test('idle render workers take remaining chunks of one map and preserve result order', async () => {
  const pool = new RenderPool(3, {}, worker);
  try {
    const tasks = Array.from({ length: 12 }, (_, id) => ({
      id,
      mapId: 'last-station',
      delay: id === 0 ? 120 : 5,
    }));
    const results = await mapConcurrent(tasks, 3, (task) => pool.run(task));
    assert.deepEqual(
      results.map((r) => r.id),
      tasks.map((t) => t.id),
    );
    assert.equal(new Set(results.map((r) => r.worker)).size, 3);
    assert.equal(pool.report.requested, tasks.length, 'sprite diagnostics are collected from every worker');
    assert.ok(
      results.slice(3).some((r) => r.worker !== results[0].worker),
      'free workers continue while the first chunk is still busy',
    );
  } finally {
    await pool.close();
  }
});
test('worker failure rejects running and queued work without hanging', async () => {
  const pool = new RenderPool(2, {}, worker);
  try {
    const results = await Promise.allSettled([
      pool.run({ crash: true }),
      pool.run({ delay: 2000 }),
      pool.run({ id: 3 }),
    ]);
    assert.ok(results.every((result) => result.status === 'rejected'));
    await assert.rejects(pool.run({ id: 4 }), /unexpectedly/);
  } finally {
    await pool.close();
  }
});
