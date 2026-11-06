import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync, copyFileSync, renameSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { availableParallelism, totalmem } from 'node:os';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { converterDigest, loadBaseline, reuseMap } from './lib/incremental.mjs';
import { exportProgress } from './export-progress.mjs';
import { promote } from './promote.mjs';

export function workerCount(maps, cpu = availableParallelism(), memory = totalmem(), requested = process.env.ATLAS_WORKERS) {
  const safe = Math.max(1, Math.min(cpu, Math.floor(memory / (2 * 1024 ** 3)), 8));
  const wanted = requested === undefined ? 4 : Number(requested);
  if (!Number.isInteger(wanted) || wanted < 1) throw new Error('ATLAS_WORKERS must be a positive integer');
  return Math.max(1, Math.min(maps, safe, wanted));
}

export function distributeMaps(maps, count, baseline) {
  const groups = Array.from({ length: count }, () => ({ maps: [], weight: 0 }));
  const weight = id => baseline?.manifest.maps.find(map => map.id === id)?.bytes || 1;
  for (const id of [...maps].sort((a, b) => weight(b) - weight(a))) {
    const group = groups.reduce((a, b) => a.weight <= b.weight ? a : b);
    group.maps.push(id); group.weight += weight(id);
  }
  return groups;
}

export async function parallelExport() {
  const config = JSON.parse(readFileSync('atlas.config.json'));
  const source = path.resolve('.source/S.P.L.U.R.T-tg'), cache = path.resolve('.cache');
  const args = process.argv.slice(2).filter(arg => arg !== '--'), flags = args.filter(arg => ['--incremental', '--full', '--adopt-baseline'].includes(arg));
  const mapArgs = args.filter(arg => !flags.includes(arg));
  const available = readdirSync(path.join(source, '_maps')).filter(name => name.endsWith('.json')).map(name => name.slice(0, -5));
  const selected = [...new Set((mapArgs.includes('--all') || (!mapArgs.length && config.maps === 'all') ? available : mapArgs.length ? mapArgs : config.maps).filter(id => !(config.excludeMaps || []).includes(id)))];
  for (const id of selected) if (!/^[\w-]+$/.test(id)) throw new Error(`Invalid map ID: ${id}`);
  const maps = selected.filter(id => { const meta = JSON.parse(readFileSync(path.join(source, '_maps', `${id}.json`))); return meta.map_path && meta.map_file; });
  if (!maps.length) throw new Error('No station maps selected');
  const output = process.env.ATLAS_EXPORT_OUTPUT ? path.resolve(process.env.ATLAS_EXPORT_OUTPUT) : path.join(cache, `export-${randomUUID()}`);
  if (path.dirname(output) !== cache || !/^export-[a-f\d-]+$/.test(path.basename(output))) throw new Error('Invalid export staging directory');
  const provenance = JSON.parse(readFileSync('.source/provenance.json'));
  if (process.env.ATLAS_SOURCE_REF) {
    if (process.env.ATLAS_STAGE_ONLY !== '1' || !/^[a-f\d]{40}$/.test(process.env.ATLAS_SOURCE_REF)) throw new Error('Invalid staged upstream override');
    provenance.commit = process.env.ATLAS_SOURCE_REF;
  } else if (provenance.commit !== config.ref) throw new Error('Source pin changed: run pnpm source first.');
  mkdirSync(output, { recursive: true });
  const progress = exportProgress(), baseline = loadBaseline(process.env.ATLAS_BASELINE || '.cache/baseline/data');
  const count = workerCount(maps.length), groups = distributeMaps(maps, count, baseline);
  const manifest = { schema: 2, buildId: randomUUID(), converter: converterDigest(), ...provenance, tilePixels: config.tilePixels, chunkTiles: config.chunkTiles, maps: [] };
  const merged = new Set(), jobs = [], workers = path.join(output, 'workers');
  mkdirSync(workers);
  const save = complete => {
    manifest.maps.sort((a, b) => maps.indexOf(a.id) - maps.indexOf(b.id));
    const temporary = path.join(output, 'manifest.next.json');
    writeFileSync(temporary, JSON.stringify(complete ? manifest : { ...manifest, complete: false }, null, 2));
    renameSync(temporary, path.join(output, 'manifest.json'));
  };
  const collect = () => {
    for (const job of jobs) {
      let data; try { data = JSON.parse(readFileSync(path.join(job.folder, 'manifest.json'))); } catch { continue; }
      for (const map of data.maps) if (!merged.has(map.id)) {
        manifest.maps.push(reuseMap({ manifest: data, root: job.folder }, map, path.join(output, map.id), { links: true }));
        merged.add(map.id);
        save(false);
      }
    }
  };
  const terminate = () => { for (const job of jobs) if (job.child.exitCode === null) job.child.kill('SIGTERM'); };
  // The dev supervisor kills the entire process tree on Windows. On POSIX the
  // coordinator forwards termination to every worker before exiting.
  const abort = () => { terminate(); process.exitCode = 1; };
  process.once('SIGTERM', abort); process.once('SIGINT', abort); process.once('exit', terminate);
  console.log(`Converting ${maps.length} stations with ${count} separate Node workers`);
  let monitorError;
  const monitor = () => {
    try {
      collect();
      let percent = 0; const messages = [];
      for (const job of jobs) {
        let status; try { status = JSON.parse(readFileSync(path.join(cache, job.progress))); } catch {}
        percent += (job.done ? 100 : status?.percent || 0) * job.maps.length / maps.length;
        if (!job.done) messages.push(status?.message || job.maps.join(', '));
      }
      progress.update(`${count} workers · ${messages.join(' | ')}`, percent);
    } catch (error) { monitorError = error; terminate(); }
  };
  const timer = setInterval(monitor, 500);
  try {
    const promises = groups.map((group, index) => {
      const folder = path.join(workers, `export-${randomUUID()}`), progressFile = `worker-progress-${randomUUID()}.json`;
      const child = spawn(process.execPath, ['scripts/export.mjs', ...flags, ...group.maps], { stdio: 'inherit', windowsHide: true, env: { ...process.env, ATLAS_EXPORT_WORKER: '1', ATLAS_STAGE_ONLY: '1', ATLAS_EXPORT_OUTPUT: folder, ATLAS_PROGRESS_FILE: progressFile, ATLAS_CHECKPOINT: '1', ATLAS_SHARP_THREADS: '1' } });
      const job = { ...group, folder, progress: progressFile, child, done: false }; jobs.push(job);
      console.log(`Worker ${index + 1}: ${group.maps.join(', ')}`);
      return new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', code => { job.done = true; code === 0 ? resolve() : reject(new Error(`Worker ${index + 1} exited with code ${code}`)); });
      });
    });
    await Promise.all(promises);
    if (monitorError) throw monitorError;
    collect();
    if (merged.size !== maps.length) throw new Error('Workers did not produce every requested station');
    const reports = jobs.map(job => JSON.parse(readFileSync(path.join(job.folder, 'build-report.json'))));
    const ordered=key=>reports.flatMap(report=>report[key]).sort((a,b)=>maps.indexOf(a)-maps.indexOf(b));
    writeFileSync(path.join(output, 'build-report.json'), JSON.stringify({ commit: provenance.commit, baseline: baseline?.manifest.commit || null, changedFiles: reports[0]?.changedFiles || null, rebuilt: ordered('rebuilt'), reused: ordered('reused'), forced: flags.includes('--full'), workers: count }, null, 2));
    for (const [from, to] of [['LICENSE', 'UPSTREAM-LICENSE.txt'], ['README.md', 'UPSTREAM-README.md']]) copyFileSync(path.join(source, from), path.join(output, to));
    copyFileSync('NOTICE', path.join(output, 'ATLAS-NOTICE.txt'));
    writeFileSync(path.join(output, 'asset-sources.json'), JSON.stringify({ ...provenance, icons: [...new Set(manifest.maps.flatMap(map => (map.inputs || []).filter(file => file.endsWith('.dmi'))))].sort() }, null, 2));
    save(true);
    // The parent now owns hard links to every completed asset. Worker scratch
    // directories are confined inside this run's staging directory.
    if (path.dirname(workers) === output) rmSync(workers, { recursive: true });
    if (process.env.ATLAS_STAGE_ONLY !== '1') promote(output);
    progress.finish();
    console.log(`Exported ${maps.length} stations using ${count} workers`);
  } finally {
    clearInterval(timer); terminate();
    process.removeListener('SIGTERM', abort); process.removeListener('SIGINT', abort); process.removeListener('exit', terminate);
    for (const job of jobs) try { rmSync(path.join(cache, job.progress), { force: true }); } catch {}
  }
}
