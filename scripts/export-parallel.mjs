// A single preparation coordinator feeds a shared, persistent chunk queue.
import { availableParallelism, totalmem } from 'node:os';
import path from 'node:path';
import { loadExportConfig, SOURCE_ROOT } from './lib/export-context.mjs';
import { runExportWorker } from './lib/export-worker.mjs';
import { RenderPool } from './lib/render-pool.mjs';
/** Memory each worker is assumed to need. */
const WORKER_MEMORY_BYTES = 2 * 1024 ** 3;
const MAX_WORKERS = 8;
const DEFAULT_WORKERS = 4;

/** How many workers to run: the request (default 4) capped by work items, CPUs and memory. */
export function workerCount(
  tasks,
  cpu = availableParallelism(),
  memory = Math.min(totalmem(), process.constrainedMemory?.() || Infinity),
  requested = process.env.ATLAS_WORKERS,
) {
  const safe = Math.max(1, Math.min(cpu, Math.floor(memory / WORKER_MEMORY_BYTES), MAX_WORKERS));
  const wanted = requested === undefined ? DEFAULT_WORKERS : Number(requested);
  if (!Number.isInteger(wanted) || wanted < 1) throw new Error('ATLAS_WORKERS must be a positive integer');
  return Math.max(1, Math.min(tasks, safe, wanted));
}

export async function parallelExport() {
  const config = loadExportConfig();
  // A single map can use the entire pool. Reserve memory for the coordinator.
  const memory = Math.min(totalmem(), process.constrainedMemory?.() || Infinity);
  const count = workerCount(
    Infinity,
    availableParallelism(),
    Math.max(WORKER_MEMORY_BYTES, memory - WORKER_MEMORY_BYTES),
  );
  const pool =
    count > 1
      ? new RenderPool(count, {
          root: path.resolve(SOURCE_ROOT),
          tilePixels: config.tilePixels,
          dme: config.dme,
        })
      : null;
  process.env.ATLAS_CHECKPOINT = '1';
  const controller = new AbortController();
  const stop = () => {
    controller.abort();
    void pool?.close();
    process.exitCode = 1;
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  try {
    console.log('Rendering with ' + count + ' workers sharing station chunks');
    await runExportWorker({ renderPool: pool, workers: count, signal: controller.signal });
  } finally {
    await pool?.close();
    process.removeListener('SIGTERM', stop);
    process.removeListener('SIGINT', stop);
  }
}
