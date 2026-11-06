import { readFile, readdir, mkdir, writeFile, rename, open, rm, stat } from 'node:fs/promises';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';

const exec = promisify(execFile);
const hash = value => createHash('sha256').update(value).digest('hex');
const json = async file => JSON.parse(await readFile(file, 'utf8'));
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

export async function checkpointBaseline(cache, input, fallback) {
  try {
    const saved=await json(path.join(cache,'dev-generation-checkpoint.json')),folder=path.resolve(saved.folder);
    if(saved.key===input.key&&path.dirname(folder)===cache&&/^export-[a-f\d-]+$/.test(path.basename(folder))&&(await json(path.join(folder,'manifest.json'))).maps?.length)return folder;
  }catch{}
  return fallback;
}

// Development converts a small station subset by default so regeneration stays
// quick. ATLAS_DEV_MAPS takes a comma-separated list of map IDs, or "all".
export const DEFAULT_DEV_MAPS = ['boxstation', 'northstar', 'icebox'];
export function devMaps(env = process.env) {
  const raw = (env.ATLAS_DEV_MAPS ?? '').trim();
  if (['all', '*'].includes(raw.toLowerCase())) return null;
  const maps = raw ? raw.split(',').map(id => id.trim()).filter(Boolean) : DEFAULT_DEV_MAPS;
  for (const id of maps) if (!/^[\w-]+$/.test(id)) throw new Error(`Invalid map ID in ATLAS_DEV_MAPS: ${id}`);
  return [...new Set(maps)];
}

export async function generatorInputs(root) {
  const config = await json(path.join(root, 'atlas.config.json'));
  const files = ['scripts/export.mjs', 'scripts/export-parallel.mjs', 'scripts/promote.mjs', 'scripts/package-maps.mjs', 'scripts/source.mjs', 'package.json', 'pnpm-lock.yaml', 'atlas.config.json', 'NOTICE'];
  for (const file of await readdir(path.join(root, 'scripts/lib'))) if (file.endsWith('.mjs')) files.push(`scripts/lib/${file}`);
  const hashes = {};
  for (const file of files.sort()) hashes[file] = hash((await readFile(path.join(root, file), 'utf8')).replaceAll('\r\n', '\n'));
  let commit = config.ref;
  try { commit = (await exec('git', ['rev-parse', 'HEAD'], { cwd: path.join(root, '.source/S.P.L.U.R.T-tg'), timeout: 10000 })).stdout.trim(); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!/^[a-f\d]{40}$/.test(commit)) throw new Error('Invalid upstream commit');
  const maps = devMaps();
  return { key: hash(JSON.stringify([hashes, commit, maps])), hashes, commit, config, maps };
}

// The controller has no Vite or renderer dependencies, so cancellation and
// restart behavior can be tested without rendering a real station.
export class GenerationController {
  constructor({ inputs, current, run, debounce = 600, now = Date.now }) {
    Object.assign(this, { inputs, current, run, debounce, now });
    this.status = { phase: 'checking', percent: 0, message: 'Checking generator hashes and local upstream commit' };
  }
  invalidate() { this.invalid = true; this.failed = null; }
  async tick() {
    if (this.closed || this.ticking) return;
    this.ticking = true;
    try {
      const input = await this.inputs();
      if (this.closed) return;
      if (this.wanted?.key !== input.key) {
        this.wanted = input; this.changed = this.now(); this.failed = null;
        if (this.active) this.active.controller.abort();
        this.status = { phase: 'preparing', percent: 0, message: this.active ? 'Generator inputs changed. Cancelling the old generation...' : 'Checking whether the existing export matches the generator hashes...' };
      }
      if (this.active || this.now() - this.changed < this.debounce) return;
      if (!this.invalid && await this.current(input)) { this.status = null; return; }
      if (this.failed === input.key) return;
      if (this.closed) return;
      const controller = new AbortController(), active = { controller, input };
      this.active = active;
      this.status = { phase: 'preparing', percent: 0, message: 'Regenerating changed map assets...' };
      active.promise = (async () => {
        try {
          const publish = await this.run(input, controller.signal, status => { if (!controller.signal.aborted) this.status = { phase: 'preparing', ...status }; });
          // Recheck hashes immediately before publication, even if no polling
          // tick happened while a short generation was running.
          if (controller.signal.aborted || (await this.inputs()).key !== input.key) { await publish.discard?.(); return; }
          await publish();
          this.invalid = false;
          this.status = null;
        } catch (error) {
          if (!controller.signal.aborted) { this.failed = input.key; this.status = { phase: 'error', percent: 0, message: `Asset generation failed: ${error.message}. Fix the inputs or use Retry preparation.` }; }
        } finally { if (this.active === active) this.active = null; }
      })();
    } catch (error) { this.status = { phase: 'error', percent: 0, message: error.message }; }
    finally { this.ticking = false; }
  }
  async close() { this.closed = true; this.active?.controller.abort(); await this.active?.promise; }
}

async function command(root, script, args, signal, env = {}) {
  if (signal.aborted) throw new DOMException('Generation cancelled', 'AbortError');
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { cwd: root, env: { ...process.env, ...env }, stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true });
    const stop = () => {
      if (!child.pid) return;
      if (process.platform === 'win32') execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
      else child.kill('SIGTERM');
    };
    signal.addEventListener('abort', stop, { once: true });
    process.once('exit', stop);
    const detach = () => { signal.removeEventListener('abort', stop); process.removeListener('exit', stop); };
    child.once('error', error => { detach(); reject(error); });
    child.once('exit', code => { detach(); signal.aborted ? reject(new DOMException('Generation cancelled', 'AbortError')) : code === 0 ? resolve() : reject(new Error(`${script} exited with code ${code}`)); });
  });
}

export function localGenerator(root) {
  const cache = path.join(root, '.cache'), catalog = path.join(root, 'public/data/manifest.json'), stamp = path.join(cache, 'dev-generation-stamp.json');
  return new GenerationController({
    inputs: () => generatorInputs(root),
    current: async input => {
      try { const saved = await json(stamp), manifest = await json(catalog); return saved.key === input.key && saved.buildId === manifest.buildId; } catch { return false; }
    },
    run: async (input, signal, report) => {
      await mkdir(cache, { recursive: true });
      const lockFile = path.join(cache, 'dev-generation.lock');
      let lock;
      try { lock = await open(lockFile, 'wx'); }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        let owner; try { owner = await json(lockFile); } catch {}
        if (owner && alive(owner.pid)) throw new Error('Another development server is generating these assets');
        await rm(lockFile, { force: true }); lock = await open(lockFile, 'wx');
      }
      await lock.writeFile(JSON.stringify({ pid: process.pid, key: input.key }));
      await lock.close();
      const stage = path.join(cache, `export-${randomUUID()}`);
      let published = false, phase = 'render', started = Date.now();
      let complete = false;
      const timer = setInterval(async () => {
        try { const progress = await json(path.join(cache, 'export-progress.json')); if (progress.updated >= started && progress.phase === 'preparing') report({ message: progress.message, percent: phase === 'render' ? progress.percent * .9 : 90 + progress.percent * .09 }); } catch {}
      }, 500); timer.unref();
      const cleanup = async () => {
        clearInterval(timer);
        try {
          let saved=false;
          // Completed maps are safe to reuse after interruption. A checkpoint
          // never becomes the public catalog and is tied to the exact inputs.
          if(!published){try{const manifest=await json(path.join(stage,'manifest.json'));if(manifest.maps?.length){await writeFile(path.join(cache,'dev-generation-checkpoint.json'),JSON.stringify({key:input.key,folder:stage,complete}));saved=true;}}catch{}}
          // Only this run's generated staging directory can be removed.
          if (!published && !saved && path.dirname(stage) === cache && /^export-[a-f\d-]+$/.test(path.basename(stage))) await rm(stage, { recursive: true, force: true });
        }finally{await rm(lockFile, { force: true });}
      };
      try {
        try { await stat(path.join(root, '.source/S.P.L.U.R.T-tg/tgstation.dme')); }
        catch { report({ message: 'Downloading the pinned upstream source...', percent: 0 }); await command(root, 'scripts/source.mjs', [], signal); }
        try { await readFile(path.join(root, '.source/provenance.json')); }
        catch { await writeFile(path.join(root, '.source/provenance.json'), JSON.stringify({repository:input.config.repository,commit:input.commit})); }
        const baseline=await checkpointBaseline(cache,input,path.join(root,'public/data'));
        if(baseline!==path.join(root,'public/data'))report({message:'Resuming completed maps from the previous generation checkpoint',percent:0});
        await command(root, 'scripts/export.mjs', ['--incremental', ...(input.maps || [])], signal, { ATLAS_SOURCE_REF: input.commit, ATLAS_STAGE_ONLY: '1', ATLAS_EXPORT_OUTPUT: stage, ATLAS_BASELINE: baseline, ATLAS_REUSE_LINKS: '1',ATLAS_CHECKPOINT:'1' });
        complete=true;
        phase = 'archive'; started = Date.now();
        report({ message: 'Preparing ZIP downloads; unchanged archives are reused', percent: 90 });
        let previous;try{previous=await json(stamp);}catch{}
        await command(root, 'scripts/package-maps.mjs', [path.join(stage, 'manifest.json')], signal, {ATLAS_REPACKAGE:previous&&previous.hashes['scripts/package-maps.mjs']!==input.hashes['scripts/package-maps.mjs']?'1':'0'});
        const publish = async () => {
          try {
            if (signal.aborted) throw new DOMException('Generation cancelled', 'AbortError');
            const manifest = await json(path.join(stage, 'manifest.json'));
            const relative = `snapshots/${path.basename(stage).slice(7)}/`, destination = path.join(root, 'public/data', relative);
            await mkdir(path.dirname(destination), { recursive: true });
            await rename(stage, destination);
            const temporary = path.join(root, 'public/data/manifest.next.json');
            await writeFile(temporary, JSON.stringify({ ...manifest, dataPath: relative }, null, 2));
            if (signal.aborted) throw new DOMException('Generation cancelled', 'AbortError');
            await rename(temporary, catalog);
            published = true;
            await writeFile(stamp, JSON.stringify({ key: input.key, hashes: input.hashes, commit: input.commit, buildId: manifest.buildId }, null, 2));
          } finally { await cleanup(); }
        };
        publish.discard = cleanup;
        return publish;
      } catch (error) { await cleanup(); throw error; }
    }
  });
}
