// Everything an export run needs to know before converting a map: the
// configuration, the pinned source checkout, the staging directory, the
// command-line selection and the incremental baseline.
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { converterDigest, loadBaseline } from './incremental.mjs';
import { changedFilesSince } from './upstream-changes.mjs';
import { isStationConfig, readStationConfig } from './map-source.mjs';

export const SOURCE_ROOT = process.env.ATLAS_SOURCE_ROOT || '.source/S.P.L.U.R.T-tg';
const EXPORT_FLAGS = ['--incremental', '--adopt-baseline', '--full'];
const STAGING_NAME = /^export-[a-f\d-]+$/;

/** Splits the command line into export flags and map IDs. */
export function parseExportArgs(argv = process.argv.slice(2)) {
  const args = argv.filter((arg) => arg !== '--');
  return {
    incremental: args.includes('--incremental'),
    adoptBaseline: args.includes('--adopt-baseline'),
    full: args.includes('--full'),
    flags: args.filter((arg) => EXPORT_FLAGS.includes(arg)),
    mapArgs: args.filter((arg) => !EXPORT_FLAGS.includes(arg)),
  };
}

/** The station configuration files in the source checkout, by ID (the JSON basename). */
export function availableMapIds(root) {
  return readdirSync(path.join(root, '_maps'))
    .filter((name) => name.endsWith('.json'))
    .map((name) => name.slice(0, -5));
}

/**
 * Map IDs to export: those named on the command line, else the configured
 * list, else every available station. Excluded IDs never export.
 */
export function selectMapIds(config, mapArgs, available) {
  const everything = mapArgs.includes('--all') || (!mapArgs.length && config.maps === 'all');
  const requested = everything ? available : mapArgs.length ? mapArgs : config.maps;
  const excluded = new Set(config.excludeMaps || []);
  const selected = [...new Set(requested.filter((id) => !excluded.has(id)))];
  for (const id of selected) if (!/^[\w-]+$/.test(id)) throw new Error(`Invalid map ID: ${id}`);
  return selected;
}

/** The export configuration, with a staged upstream override applied when allowed. */
export function loadExportConfig(env = process.env) {
  const config = JSON.parse(readFileSync(env.ATLAS_CONFIG || 'atlas.config.json'));
  if (env.ATLAS_DME) config.dme = env.ATLAS_DME;
  if (env.ATLAS_SOURCE_REF) {
    if (!/^[a-f\d]{40}$/.test(env.ATLAS_SOURCE_REF) || env.ATLAS_STAGE_ONLY !== '1')
      throw new Error('Local source overrides require a staged export and a full commit SHA');
    config.ref = env.ATLAS_SOURCE_REF;
  }
  return config;
}

/** The provenance of the source checkout, verified against the configured pin. */
export function loadProvenance(config, env = process.env) {
  if (env.ATLAS_SOURCE_ROOT) {
    const root = path.resolve(env.ATLAS_SOURCE_ROOT);
    const git = (...args) =>
      execFileSync('git', ['-c', `safe.directory=${root}`, '-C', root, ...args], {
        encoding: 'utf8',
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
    let commit;
    try {
      if (path.relative(realpathSync(root), realpathSync(git('rev-parse', '--show-toplevel'))))
        throw new Error('Source is an archive inside another repository');
      commit = git('rev-parse', 'HEAD');
    } catch {
      return {
        repository: env.ATLAS_SOURCE_REPOSITORY || config.repository || '',
        commit: env.ATLAS_SOURCE_REVISION || config.ref || 'unversioned',
        dirty: true,
        revisionVerified: false,
      };
    }
    let repository = env.ATLAS_SOURCE_REPOSITORY || config.repository;
    try {
      if (!env.ATLAS_SOURCE_REPOSITORY) repository = git('remote', 'get-url', 'origin');
    } catch {}
    return { repository, commit, dirty: Boolean(git('status', '--porcelain', '--untracked-files=normal')) };
  }
  const provenance = JSON.parse(readFileSync('.source/provenance.json'));
  if (env.ATLAS_SOURCE_REF) provenance.commit = config.ref;
  if (provenance.commit !== config.ref) throw new Error('Source pin changed: run pnpm source first.');
  return provenance;
}

/**
 * The staging directory of this run. It must live directly under .cache as
 * export-<id>, or, for a worker of a staged run, under <run>/workers/.
 */
export function resolveStagingDirectory(cacheRoot, env = process.env) {
  const output = env.ATLAS_EXPORT_OUTPUT
    ? path.resolve(env.ATLAS_EXPORT_OUTPUT)
    : path.join(cacheRoot, `export-${randomUUID()}`);
  const parts = path.relative(cacheRoot, output).split(path.sep);
  const direct = parts.length === 1 && STAGING_NAME.test(parts[0]);
  const worker =
    env.ATLAS_STAGE_ONLY === '1' &&
    parts.length === 3 &&
    STAGING_NAME.test(parts[0]) &&
    parts[1] === 'workers' &&
    STAGING_NAME.test(parts[2]);
  if (!direct && !worker) throw new Error('Invalid export staging directory');
  return output;
}

/** Gathers the inputs of a worker run. */
export function createExportContext(env = process.env) {
  const config = loadExportConfig(env);
  const root = path.resolve(SOURCE_ROOT);
  const cacheRoot = path.resolve('.cache');
  const output = resolveStagingDirectory(cacheRoot, env);
  if (!existsSync(root)) throw new Error('Run pnpm source first.');
  const provenance = loadProvenance(config, env);
  const args = parseExportArgs();
  const baseline =
    args.incremental && !args.full ? loadBaseline(env.ATLAS_BASELINE || '.cache/baseline/data') : null;
  const converter = converterDigest();
  const changed = baseline ? changedFilesSince(root, baseline.manifest.commit, provenance.commit) : null;
  const selected = selectMapIds(config, args.mapArgs, availableMapIds(root)).filter((id) =>
    isStationConfig(readStationConfig(root, id)),
  );
  if (!selected.length) throw new Error('No station maps selected');
  return { config, root, cacheRoot, output, provenance, args, baseline, converter, changed, selected };
}
