// Development data generation. The controller watches the generator inputs
// (generator files, the local upstream checkout and the map selection) and,
// in manual mode, only reports that the published data is stale; the dev
// tools then start a background regeneration. A missing or broken dataset is
// still generated automatically, which is the cold start the loading page
// covers.
import { readFile, readdir, mkdir, writeFile, rename, open, rm, stat } from 'node:fs/promises';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
import { availableMapIds } from '../lib/export-context.mjs';
import { isStationConfig, readStationConfig } from '../lib/map-source.mjs';

const exec = promisify(execFile);
const hash = (value) => createHash('sha256').update(value).digest('hex');
const json = async (file) => JSON.parse(await readFile(file, 'utf8'));
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const STAGING_NAME = /^export-[a-f\d-]+$/;
const SOURCE_ROOT = '.source/S.P.L.U.R.T-tg';
/** How many status messages the dev tools can scroll back through. */
const LOG_LENGTH = 80;

export async function checkpointBaseline(cache, input, fallback) {
  try {
    const saved = await json(path.join(cache, 'dev-generation-checkpoint.json')),
      folder = path.resolve(saved.folder);
    if (
      saved.key === input.key &&
      path.dirname(folder) === cache &&
      STAGING_NAME.test(path.basename(folder)) &&
      (await json(path.join(folder, 'manifest.json'))).maps?.length
    )
      return folder;
  } catch {}
  return fallback;
}

// --- Map selection ----------------------------------------------------------

// Development converts a small station subset by default so regeneration stays
// quick. ATLAS_DEV_MAPS takes a comma-separated list of map IDs, or "all"; a
// selection saved from the dev tools (.cache/dev-settings.json) wins over it.
export const DEFAULT_DEV_MAPS = ['boxstation', 'northstar', 'icebox'];

function validateMapIds(maps, source) {
  for (const id of maps) if (!/^[\w-]+$/.test(id)) throw new Error(`Invalid map ID in ${source}: ${id}`);
  return [...new Set(maps)];
}

/** The map selection: an array of IDs, or null for every station. */
export function devMaps(env = process.env, settings = null) {
  if (settings && settings.maps !== undefined) {
    if (settings.maps === null) return null;
    return validateMapIds(settings.maps, 'dev settings');
  }
  const raw = (env.ATLAS_DEV_MAPS ?? '').trim();
  if (['all', '*'].includes(raw.toLowerCase())) return null;
  const maps = raw
    ? raw
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean)
    : DEFAULT_DEV_MAPS;
  return validateMapIds(maps, 'ATLAS_DEV_MAPS');
}

const settingsFile = (root) => path.join(root, '.cache/dev-settings.json');

/** Settings saved from the dev tools; an empty object when none were saved. */
export async function readDevSettings(root) {
  try {
    const settings = await json(settingsFile(root));
    return settings && typeof settings === 'object' ? settings : {};
  } catch {
    return {};
  }
}

export async function writeDevSettings(root, settings) {
  await mkdir(path.dirname(settingsFile(root)), { recursive: true });
  await writeFile(settingsFile(root), JSON.stringify(settings, null, 2));
}

/** Every station of the local checkout that the configuration allows, with its display name. */
export async function availableStations(root) {
  const source = path.join(root, SOURCE_ROOT);
  let config = {};
  try {
    config = await json(path.join(root, 'atlas.config.json'));
  } catch {}
  const excluded = new Set(config.excludeMaps || []);
  let ids = [];
  try {
    ids = availableMapIds(source);
  } catch {
    return [];
  }
  const stations = [];
  for (const id of ids) {
    if (excluded.has(id)) continue;
    try {
      const station = readStationConfig(source, id);
      if (isStationConfig(station)) stations.push({ id, name: station.map_name || id });
    } catch {}
  }
  return stations.sort((a, b) => a.name.localeCompare(b.name));
}

// --- Generator inputs ---------------------------------------------------------

/** The files whose content decides whether exported data is still current. */
async function generatorFiles(root) {
  const files = [
    'scripts/export.mjs',
    'scripts/export-parallel.mjs',
    'scripts/promote.mjs',
    'scripts/package-maps.mjs',
    'scripts/source.mjs',
    'package.json',
    'pnpm-lock.yaml',
    'atlas.config.json',
    'NOTICE',
  ];
  for (const file of await readdir(path.join(root, 'scripts/lib')))
    if (file.endsWith('.mjs')) files.push(`scripts/lib/${file}`);
  return files.sort();
}

export async function generatorInputs(root) {
  const config = await json(path.join(root, 'atlas.config.json'));
  const hashes = {};
  for (const file of await generatorFiles(root))
    hashes[file] = hash((await readFile(path.join(root, file), 'utf8')).replaceAll('\r\n', '\n'));
  let commit = config.ref;
  try {
    commit = (
      await exec('git', ['rev-parse', 'HEAD'], { cwd: path.join(root, SOURCE_ROOT), timeout: 10000 })
    ).stdout.trim();
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (!/^[a-f\d]{40}$/.test(commit)) throw new Error('Invalid upstream commit');
  const maps = devMaps(process.env, await readDevSettings(root));
  return { key: hash(JSON.stringify([hashes, commit, maps])), hashes, commit, config, maps };
}

/**
 * Explains, for the dev tools, what differs between the inputs of the
 * published data (its stamp) and the current inputs.
 */
export function describeChanges(stamp, input) {
  if (!stamp)
    return [{ kind: 'stamp', detail: 'The published data was not generated by this development server.' }];
  const changes = [];
  if (stamp.commit !== input.commit)
    changes.push({
      kind: 'upstream',
      detail: `Upstream checkout moved from ${stamp.commit.slice(0, 12)} to ${input.commit.slice(0, 12)}.`,
    });
  const describe = (maps) => (maps === null ? 'all stations' : maps.length ? maps.join(', ') : 'no stations');
  if (stamp.maps === undefined)
    changes.push({
      kind: 'maps',
      detail: `Map selection is now ${describe(input.maps)}; the previous generation did not record its selection.`,
    });
  else if (JSON.stringify(stamp.maps) !== JSON.stringify(input.maps))
    changes.push({
      kind: 'maps',
      detail: `Map selection changed from ${describe(stamp.maps)} to ${describe(input.maps)}.`,
    });
  const files = new Set([...Object.keys(stamp.hashes || {}), ...Object.keys(input.hashes)]);
  for (const file of [...files].sort()) {
    const previous = stamp.hashes?.[file];
    const current = input.hashes[file];
    if (previous === current) continue;
    const what = previous === undefined ? 'was added' : current === undefined ? 'was removed' : 'changed';
    changes.push({ kind: 'file', detail: `${file} ${what}.`, file });
  }
  return changes;
}

// --- Controller ---------------------------------------------------------------

/**
 * Decides when to generate. `mode: 'auto'` regenerates whenever the inputs
 * change (used by tests); `mode: 'manual'` only regenerates a missing or
 * broken dataset by itself and otherwise waits for `request()`.
 *
 * The controller has no Vite or renderer dependencies, so cancellation and
 * restart behavior can be tested without rendering a real station.
 */
export class GenerationController {
  constructor({
    inputs,
    current,
    run,
    debounce = 600,
    now = Date.now,
    mode = 'auto',
    hasDataset = async () => true,
    describe = () => [],
  }) {
    Object.assign(this, { inputs, current, run, debounce, now, mode, hasDataset, describe });
    /** Loading-page state while no usable dataset exists; null once data is served. */
    this.status = {
      phase: 'checking',
      percent: 0,
      message: 'Checking generator hashes and local upstream commit',
    };
    /** Why the published data no longer matches the inputs (manual mode). */
    this.stale = null;
    /** The background job the dev tools show: running, published, error or cancelled. */
    this.job = null;
    this.log = [];
    this.requested = null;
  }

  invalidate() {
    this.invalid = true;
    this.failed = null;
  }

  /** Asks for a regeneration of the current inputs (manual mode). */
  async request({ full = false } = {}) {
    if (this.active) return false;
    this.requested = { full };
    this.failed = null;
    await this.tick();
    return true;
  }

  cancel() {
    if (!this.active) return false;
    this.active.controller.abort();
    return true;
  }

  record(message) {
    const last = this.log.at(-1);
    if (last?.message === message) return;
    this.log.push({ time: this.now(), message });
    if (this.log.length > LOG_LENGTH) this.log.splice(0, this.log.length - LOG_LENGTH);
  }

  async tick() {
    if (this.closed || this.ticking) return;
    this.ticking = true;
    try {
      const input = await this.inputs();
      if (this.closed) return;
      if (this.wanted?.key !== input.key) {
        this.wanted = input;
        this.changed = this.now();
        this.failed = null;
        if (this.mode === 'auto') {
          if (this.active) this.active.controller.abort();
          this.status = {
            phase: 'preparing',
            percent: 0,
            message: this.active
              ? 'Generator inputs changed. Cancelling the old generation...'
              : 'Checking whether the existing export matches the generator hashes...',
          };
        }
      }
      if (this.active || this.now() - this.changed < this.debounce) return;
      const fresh = !this.invalid && (await this.current(input));
      if (fresh) {
        this.status = null;
        this.stale = null;
        this.requested = null;
        return;
      }
      if (this.failed === input.key && !this.requested) return;
      if (this.mode === 'manual' && !this.requested) {
        // The data exists but is out of date: tell the dev tools and wait.
        if (!this.invalid && (await this.hasDataset())) {
          this.status = null;
          if (this.stale?.key !== input.key)
            this.stale = { key: input.key, since: this.now(), changes: this.describe(input) };
          return;
        }
        this.requested = { full: false, automatic: true };
      }
      if (this.closed) return;
      this.start(input);
    } catch (error) {
      this.status = { phase: 'error', percent: 0, message: error.message };
    } finally {
      this.ticking = false;
    }
  }

  start(input) {
    const options = this.requested || { full: false };
    this.requested = null;
    const controller = new AbortController();
    const active = { controller, input, full: !!options.full };
    this.active = active;
    const coldStart = this.mode === 'auto' || options.automatic;
    const message = options.full
      ? 'Rebuilding every selected map from scratch...'
      : 'Regenerating changed map assets...';
    if (coldStart) this.status = { phase: 'preparing', percent: 0, message };
    this.job = {
      phase: 'running',
      percent: 0,
      message,
      started: this.now(),
      full: !!options.full,
      key: input.key,
    };
    this.record(message);
    active.promise = (async () => {
      try {
        const publish = await this.run(
          input,
          controller.signal,
          (status) => {
            if (controller.signal.aborted) return;
            if (coldStart) this.status = { phase: 'preparing', ...status };
            this.job = { ...this.job, ...status };
            this.record(status.message);
          },
          { full: !!options.full },
        );
        // In automatic mode a result for outdated inputs is thrown away: a
        // polling tick may not have run while a short generation was running.
        if (controller.signal.aborted || (this.mode === 'auto' && (await this.inputs()).key !== input.key)) {
          await publish.discard?.();
          this.job = { ...this.job, phase: 'cancelled', message: 'Generation cancelled.' };
          return;
        }
        await publish();
        this.invalid = false;
        this.status = null;
        this.stale = null;
        this.job = {
          ...this.job,
          phase: 'published',
          percent: 100,
          message: 'New map data published.',
          finished: this.now(),
        };
        this.record('New map data published.');
      } catch (error) {
        if (controller.signal.aborted) {
          this.job = { ...this.job, phase: 'cancelled', message: 'Generation cancelled.' };
          this.record('Generation cancelled.');
          return;
        }
        this.failed = input.key;
        const message = `Asset generation failed: ${error.message}. Fix the inputs or use Retry preparation.`;
        if (coldStart) this.status = { phase: 'error', percent: 0, message };
        this.job = { ...this.job, phase: 'error', message, finished: this.now() };
        this.record(message);
      } finally {
        if (this.active === active) this.active = null;
      }
    })();
  }

  async close() {
    this.closed = true;
    this.active?.controller.abort();
    await this.active?.promise;
  }
}

// --- Running the real pipeline ---------------------------------------------

async function command(root, script, args, signal, env = {}) {
  if (signal.aborted) throw new DOMException('Generation cancelled', 'AbortError');
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: root,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'inherit', 'inherit'],
      windowsHide: true,
    });
    const stop = () => {
      if (!child.pid) return;
      if (process.platform === 'win32')
        execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
      else child.kill('SIGTERM');
    };
    signal.addEventListener('abort', stop, { once: true });
    process.once('exit', stop);
    const detach = () => {
      signal.removeEventListener('abort', stop);
      process.removeListener('exit', stop);
    };
    child.once('error', (error) => {
      detach();
      reject(error);
    });
    child.once('exit', (code) => {
      detach();
      if (signal.aborted) reject(new DOMException('Generation cancelled', 'AbortError'));
      else if (code === 0) resolve();
      else reject(new Error(`${script} exited with code ${code}`));
    });
  });
}

/** The stamp of the published data: the inputs it was generated from. */
export async function readStamp(root) {
  try {
    return await json(path.join(root, '.cache/dev-generation-stamp.json'));
  } catch {
    return null;
  }
}

export function localGenerator(root, { mode = 'manual' } = {}) {
  const cache = path.join(root, '.cache'),
    catalog = path.join(root, 'public/data/manifest.json'),
    stamp = path.join(cache, 'dev-generation-stamp.json');
  let lastStamp = null;
  return new GenerationController({
    mode,
    inputs: async () => {
      lastStamp = await readStamp(root);
      return generatorInputs(root);
    },
    current: async (input) => {
      try {
        const saved = await json(stamp),
          manifest = await json(catalog);
        return saved.key === input.key && saved.buildId === manifest.buildId;
      } catch {
        return false;
      }
    },
    hasDataset: async () => {
      try {
        return (await json(catalog)).maps?.length > 0;
      } catch {
        return false;
      }
    },
    describe: (input) => describeChanges(lastStamp, input),
    run: async (input, signal, report, { full = false } = {}) => {
      await mkdir(cache, { recursive: true });
      const lockFile = path.join(cache, 'dev-generation.lock');
      let lock;
      try {
        lock = await open(lockFile, 'wx');
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        let owner;
        try {
          owner = await json(lockFile);
        } catch {}
        if (owner && alive(owner.pid))
          throw new Error('Another development server is generating these assets');
        await rm(lockFile, { force: true });
        lock = await open(lockFile, 'wx');
      }
      await lock.writeFile(JSON.stringify({ pid: process.pid, key: input.key }));
      await lock.close();
      const stage = path.join(cache, `export-${randomUUID()}`);
      let published = false,
        phase = 'render',
        started = Date.now();
      let complete = false;
      const timer = setInterval(async () => {
        try {
          const progress = await json(path.join(cache, 'export-progress.json'));
          if (progress.updated >= started && progress.phase === 'preparing')
            report({
              message: progress.message,
              percent: phase === 'render' ? progress.percent * 0.9 : 90 + progress.percent * 0.09,
            });
        } catch {}
      }, 500);
      timer.unref();
      const cleanup = async () => {
        clearInterval(timer);
        try {
          let saved = false;
          // Completed maps are safe to reuse after interruption. A checkpoint
          // never becomes the public catalog and is tied to the exact inputs.
          if (!published) {
            try {
              const manifest = await json(path.join(stage, 'manifest.json'));
              if (manifest.maps?.length) {
                await writeFile(
                  path.join(cache, 'dev-generation-checkpoint.json'),
                  JSON.stringify({ key: input.key, folder: stage, complete }),
                );
                saved = true;
              }
            } catch {}
          }
          // Only this run's generated staging directory can be removed.
          if (
            !published &&
            !saved &&
            path.dirname(stage) === cache &&
            STAGING_NAME.test(path.basename(stage))
          )
            await rm(stage, { recursive: true, force: true });
        } finally {
          await rm(lockFile, { force: true });
        }
      };
      try {
        try {
          await stat(path.join(root, SOURCE_ROOT, 'tgstation.dme'));
        } catch {
          report({ message: 'Downloading the pinned upstream source...', percent: 0 });
          await command(root, 'scripts/source.mjs', [], signal);
        }
        try {
          await readFile(path.join(root, '.source/provenance.json'));
        } catch {
          await writeFile(
            path.join(root, '.source/provenance.json'),
            JSON.stringify({ repository: input.config.repository, commit: input.commit }),
          );
        }
        const baseline = full
          ? path.join(root, 'public/data')
          : await checkpointBaseline(cache, input, path.join(root, 'public/data'));
        if (baseline !== path.join(root, 'public/data'))
          report({ message: 'Resuming completed maps from the previous generation checkpoint', percent: 0 });
        const flags = full ? ['--incremental', '--full'] : ['--incremental'];
        await command(root, 'scripts/export.mjs', [...flags, ...(input.maps || [])], signal, {
          ATLAS_SOURCE_REF: input.commit,
          ATLAS_STAGE_ONLY: '1',
          ATLAS_EXPORT_OUTPUT: stage,
          ATLAS_BASELINE: baseline,
          ATLAS_REUSE_LINKS: '1',
          ATLAS_CHECKPOINT: '1',
        });
        complete = true;
        phase = 'archive';
        started = Date.now();
        report({ message: 'Preparing ZIP downloads; unchanged archives are reused', percent: 90 });
        let previous;
        try {
          previous = await json(stamp);
        } catch {}
        await command(root, 'scripts/package-maps.mjs', [path.join(stage, 'manifest.json')], signal, {
          ATLAS_REPACKAGE:
            full ||
            (previous &&
              previous.hashes['scripts/package-maps.mjs'] !== input.hashes['scripts/package-maps.mjs'])
              ? '1'
              : '0',
        });
        const publish = async () => {
          try {
            if (signal.aborted) throw new DOMException('Generation cancelled', 'AbortError');
            const manifest = await json(path.join(stage, 'manifest.json'));
            const relative = `snapshots/${path.basename(stage).slice(7)}/`,
              destination = path.join(root, 'public/data', relative);
            await mkdir(path.dirname(destination), { recursive: true });
            await rename(stage, destination);
            const temporary = path.join(root, 'public/data/manifest.next.json');
            await writeFile(temporary, JSON.stringify({ ...manifest, dataPath: relative }, null, 2));
            if (signal.aborted) throw new DOMException('Generation cancelled', 'AbortError');
            await rename(temporary, catalog);
            published = true;
            await writeFile(
              stamp,
              JSON.stringify(
                {
                  key: input.key,
                  hashes: input.hashes,
                  commit: input.commit,
                  maps: input.maps,
                  buildId: manifest.buildId,
                  generated: Date.now(),
                },
                null,
                2,
              ),
            );
          } finally {
            await cleanup();
          }
        };
        publish.discard = cleanup;
        return publish;
      } catch (error) {
        await cleanup();
        throw error;
      }
    },
  });
}

// --- Snapshots ----------------------------------------------------------------

async function folderSize(folder) {
  let total = 0;
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const full = path.join(folder, entry.name);
    if (entry.isDirectory()) total += await folderSize(full);
    else total += (await stat(full)).size;
  }
  return total;
}

const sizeCache = new Map();

/** The data snapshots on disk, newest first, with the one the catalog points at marked. */
export async function listSnapshots(root) {
  const data = path.join(root, 'public/data');
  let current = null;
  try {
    current =
      (await json(path.join(data, 'manifest.json'))).dataPath?.replace(/^snapshots\/|\/$/g, '') || null;
  } catch {}
  let names = [];
  try {
    names = await readdir(path.join(data, 'snapshots'));
  } catch {
    return [];
  }
  const snapshots = [];
  for (const id of names) {
    if (!/^[a-f\d-]+$/.test(id)) continue;
    const folder = path.join(data, 'snapshots', id);
    let info;
    try {
      info = await stat(folder);
    } catch {
      continue;
    }
    if (!info.isDirectory()) continue;
    let maps = [];
    let commit = null;
    try {
      const manifest = await json(path.join(folder, 'manifest.json'));
      maps = (manifest.maps || []).map((map) => map.id);
      commit = manifest.commit || null;
    } catch {}
    const cacheKey = `${id}:${info.mtimeMs}`;
    if (!sizeCache.has(cacheKey)) sizeCache.set(cacheKey, await folderSize(folder));
    snapshots.push({
      id,
      current: id === current,
      maps,
      commit,
      bytes: sizeCache.get(cacheKey),
      modified: info.mtimeMs,
    });
  }
  return snapshots.sort((a, b) => b.modified - a.modified);
}

/** Deletes a snapshot that the catalog does not point at. */
export async function deleteSnapshot(root, id) {
  if (!/^[a-f\d-]+$/.test(id)) throw new Error('Invalid snapshot id');
  const snapshots = await listSnapshots(root);
  const snapshot = snapshots.find((entry) => entry.id === id);
  if (!snapshot) throw new Error('Unknown snapshot');
  if (snapshot.current) throw new Error('The current snapshot cannot be deleted');
  const folder = path.join(root, 'public/data/snapshots', id);
  await rm(folder, { recursive: true, force: true });
}
