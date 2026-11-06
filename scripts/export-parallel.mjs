// Splits an export across worker processes. Each worker converts a share of
// the stations into its own folder; the coordinator merges their manifests,
// hard-links the finished map folders and writes the combined report.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { availableParallelism, totalmem } from 'node:os';
import path from 'node:path';
import { exportProgress } from './export-progress.mjs';
import {
  SOURCE_ROOT,
  availableMapIds,
  loadExportConfig,
  loadProvenance,
  parseExportArgs,
  selectMapIds,
} from './lib/export-context.mjs';
import { copyCredits, writeAssetSources, writeBuildReport } from './lib/export-output.mjs';
import { converterDigest, loadBaseline, reuseMap } from './lib/incremental.mjs';
import { SCHEMA } from './lib/map-format.mjs';
import { isStationConfig, readStationConfig } from './lib/map-source.mjs';
import { promote } from './promote.mjs';

/** Memory each worker is assumed to need. */
const WORKER_MEMORY_BYTES = 2 * 1024 ** 3;
const MAX_WORKERS = 8;
const DEFAULT_WORKERS = 4;
const MONITOR_INTERVAL_MS = 500;

/** How many workers to run: the request (default 4) capped by maps, CPUs and memory. */
export function workerCount(
  maps,
  cpu = availableParallelism(),
  memory = totalmem(),
  requested = process.env.ATLAS_WORKERS,
) {
  const safe = Math.max(1, Math.min(cpu, Math.floor(memory / WORKER_MEMORY_BYTES), MAX_WORKERS));
  const wanted = requested === undefined ? DEFAULT_WORKERS : Number(requested);
  if (!Number.isInteger(wanted) || wanted < 1) throw new Error('ATLAS_WORKERS must be a positive integer');
  return Math.max(1, Math.min(maps, safe, wanted));
}

/** Balances maps across workers by their previously exported size, largest first. */
export function distributeMaps(maps, count, baseline) {
  const groups = Array.from({ length: count }, () => ({ maps: [], weight: 0 }));
  const weight = (id) => baseline?.manifest.maps.find((map) => map.id === id)?.bytes || 1;
  for (const id of [...maps].sort((a, b) => weight(b) - weight(a))) {
    const group = groups.reduce((a, b) => (a.weight <= b.weight ? a : b));
    group.maps.push(id);
    group.weight += weight(id);
  }
  return groups;
}

export async function parallelExport() {
  const config = loadExportConfig();
  const source = path.resolve(SOURCE_ROOT);
  const cache = path.resolve('.cache');
  const args = parseExportArgs();
  const maps = selectMapIds(config, args.mapArgs, availableMapIds(source)).filter((id) =>
    isStationConfig(readStationConfig(source, id)),
  );
  if (!maps.length) throw new Error('No station maps selected');
  const output = process.env.ATLAS_EXPORT_OUTPUT
    ? path.resolve(process.env.ATLAS_EXPORT_OUTPUT)
    : path.join(cache, `export-${randomUUID()}`);
  if (path.dirname(output) !== cache || !/^export-[a-f\d-]+$/.test(path.basename(output)))
    throw new Error('Invalid export staging directory');
  const provenance = loadProvenance(config);
  mkdirSync(output, { recursive: true });
  const progress = exportProgress();
  const baseline = loadBaseline(process.env.ATLAS_BASELINE || '.cache/baseline/data');
  const count = workerCount(maps.length);
  const groups = distributeMaps(maps, count, baseline);
  const manifest = {
    schema: SCHEMA,
    buildId: randomUUID(),
    converter: converterDigest(),
    ...provenance,
    tilePixels: config.tilePixels,
    chunkTiles: config.chunkTiles,
    maps: [],
  };
  const merged = new Set();
  const jobs = [];
  const workersDir = path.join(output, 'workers');
  mkdirSync(workersDir);

  /** Writes the combined manifest; incomplete until every worker finished. */
  const saveManifest = (complete) => {
    manifest.maps.sort((a, b) => maps.indexOf(a.id) - maps.indexOf(b.id));
    const temporary = path.join(output, 'manifest.next.json');
    writeFileSync(temporary, JSON.stringify(complete ? manifest : { ...manifest, complete: false }, null, 2));
    renameSync(temporary, path.join(output, 'manifest.json'));
  };
  /** Adopts every map a worker has completed so far. */
  const collectFinishedMaps = () => {
    for (const job of jobs) {
      let data;
      try {
        data = JSON.parse(readFileSync(path.join(job.folder, 'manifest.json')));
      } catch {
        continue;
      }
      for (const map of data.maps) {
        if (merged.has(map.id)) continue;
        manifest.maps.push(
          reuseMap({ manifest: data, root: job.folder }, map, path.join(output, map.id), { links: true }),
        );
        merged.add(map.id);
        saveManifest(false);
      }
    }
  };
  const terminate = () => {
    for (const job of jobs) if (job.child.exitCode === null) job.child.kill('SIGTERM');
  };
  // The dev supervisor kills the entire process tree on Windows. On POSIX the
  // coordinator forwards termination to every worker before exiting.
  const abort = () => {
    terminate();
    process.exitCode = 1;
  };
  process.once('SIGTERM', abort);
  process.once('SIGINT', abort);
  process.once('exit', terminate);
  console.log(`Converting ${maps.length} stations with ${count} separate Node workers`);
  let monitorError;
  const monitor = () => {
    try {
      collectFinishedMaps();
      let percent = 0;
      const messages = [];
      for (const job of jobs) {
        let status;
        try {
          status = JSON.parse(readFileSync(path.join(cache, job.progress)));
        } catch {}
        percent += ((job.done ? 100 : status?.percent || 0) * job.maps.length) / maps.length;
        if (!job.done) messages.push(status?.message || job.maps.join(', '));
      }
      progress.update(`${count} workers · ${messages.join(' | ')}`, percent);
    } catch (error) {
      monitorError = error;
      terminate();
    }
  };
  const timer = setInterval(monitor, MONITOR_INTERVAL_MS);

  const startWorker = (group, index) => {
    const folder = path.join(workersDir, `export-${randomUUID()}`);
    const progressFile = `worker-progress-${randomUUID()}.json`;
    const child = spawn(process.execPath, ['scripts/export.mjs', ...args.flags, ...group.maps], {
      stdio: 'inherit',
      windowsHide: true,
      env: {
        ...process.env,
        ATLAS_EXPORT_WORKER: '1',
        ATLAS_STAGE_ONLY: '1',
        ATLAS_EXPORT_OUTPUT: folder,
        ATLAS_PROGRESS_FILE: progressFile,
        ATLAS_CHECKPOINT: '1',
        ATLAS_SHARP_THREADS: '1',
      },
    });
    const job = { ...group, folder, progress: progressFile, child, done: false };
    jobs.push(job);
    console.log(`Worker ${index + 1}: ${group.maps.join(', ')}`);
    return new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code) => {
        job.done = true;
        if (code === 0) resolve();
        else reject(new Error(`Worker ${index + 1} exited with code ${code}`));
      });
    });
  };

  try {
    await Promise.all(groups.map(startWorker));
    if (monitorError) throw monitorError;
    collectFinishedMaps();
    if (merged.size !== maps.length) throw new Error('Workers did not produce every requested station');
    const reports = jobs.map((job) => JSON.parse(readFileSync(path.join(job.folder, 'build-report.json'))));
    const ordered = (key) =>
      reports.flatMap((report) => report[key]).sort((a, b) => maps.indexOf(a) - maps.indexOf(b));
    writeBuildReport(output, {
      commit: provenance.commit,
      baseline: baseline?.manifest.commit || null,
      changedFiles: reports[0]?.changedFiles || null,
      rebuilt: ordered('rebuilt'),
      reused: ordered('reused'),
      forced: args.full,
      workers: count,
    });
    copyCredits(source, output);
    writeAssetSources(output, provenance, manifest.maps);
    saveManifest(true);
    // The parent now owns hard links to every completed asset. Worker scratch
    // directories are confined inside this run's staging directory.
    if (path.dirname(workersDir) === output) rmSync(workersDir, { recursive: true });
    if (process.env.ATLAS_STAGE_ONLY !== '1') promote(output);
    progress.finish();
    console.log(`Exported ${maps.length} stations using ${count} workers`);
  } finally {
    clearInterval(timer);
    terminate();
    process.removeListener('SIGTERM', abort);
    process.removeListener('SIGINT', abort);
    process.removeListener('exit', terminate);
    for (const job of jobs)
      try {
        rmSync(path.join(cache, job.progress), { force: true });
      } catch {}
  }
}
