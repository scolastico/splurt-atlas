import { Worker } from 'node:worker_threads';

/** Bounded dispatch: a free worker immediately takes the next chunk. */
export async function mapConcurrent(items, count, fn) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(count, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await fn(items[index], index);
      }
    }),
  );
  return results;
}

/** Persistent render workers share a queue, including within the last deck. */
export class RenderPool {
  constructor(size, workerData, url = new URL('./render-worker.mjs', import.meta.url)) {
    this.size = size;
    this.queue = [];
    this.workers = [];
    this.failure = null;
    this.closed = false;
    this.workerData = workerData;
    this.url = url;
    this.report = { requested: 0, missingIcon: 0, missingState: 0, samples: [] };
  }
  createWorker() {
    const worker = new Worker(this.url, { workerData: this.workerData });
    const slot = { worker, job: null };
    this.workers.push(slot);
    worker.on('message', (message) => {
      const job = slot.job;
      if (!job) return this.fail(new Error('Unexpected render worker response'));
      slot.job = null;
      if (message.error) {
        job.reject(new Error(message.error));
        this.fail(new Error(message.error));
      } else {
        if (message.report) {
          for (const key of ['requested', 'missingIcon', 'missingState'])
            this.report[key] += message.report[key];
          this.report.samples.push(
            ...message.report.samples.slice(0, Math.max(0, 20 - this.report.samples.length)),
          );
        }
        job.resolve(message.result);
        this.dispatch();
      }
    });
    worker.on('error', (error) => this.fail(error));
    worker.on('exit', (code) => {
      if (!this.closed) this.fail(new Error(`Render worker exited unexpectedly (${code})`));
    });
    return slot;
  }
  run(task) {
    if (this.failure || this.closed) return Promise.reject(this.failure || new Error('Render pool closed'));
    return new Promise((resolve, reject) => {
      this.queue.push({ task, resolve, reject });
      this.dispatch();
    });
  }
  dispatch() {
    if (this.failure || this.closed) return;
    while (this.queue.length) {
      let slot = this.workers.find((slot) => !slot.job);
      if (!slot && this.workers.length >= this.size) return;
      try {
        slot ||= this.createWorker();
        slot.job = this.queue.shift();
        slot.worker.postMessage(slot.job.task);
      } catch (error) {
        this.fail(error);
        return;
      }
    }
  }
  fail(error) {
    this.failure ||= error;
    for (const job of this.queue.splice(0)) job.reject(this.failure);
    for (const slot of this.workers) {
      slot.job?.reject(this.failure);
      slot.job = null;
    }
  }
  async close() {
    this.closed = true;
    this.fail(new Error('Render pool closed'));
    await Promise.all(this.workers.map(({ worker }) => worker.terminate()));
  }
}
