// Everything an export run needs to know before converting a map: the
// configuration, the pinned source checkout, the staging directory, the
// command-line selection and the incremental baseline.
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { converterDigest, loadBaseline } from './incremental.mjs';
import { changedFilesSince } from './upstream-changes.mjs';

export const SOURCE_ROOT = '.source/S.P.L.U.R.T-tg';
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
  const config = JSON.parse(readFileSync('atlas.config.json'));
  if (env.ATLAS_SOURCE_REF) {
    if (!/^[a-f\d]{40}$/.test(env.ATLAS_SOURCE_REF) || env.ATLAS_STAGE_ONLY !== '1')
      throw new Error('Local source overrides require a staged export and a full commit SHA');
    config.ref = env.ATLAS_SOURCE_REF;
  }
  return config;
}

/** The provenance of the source checkout, verified against the configured pin. */
export function loadProvenance(config, env = process.env) {
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
  const selected = selectMapIds(config, args.mapArgs, availableMapIds(root));
  return { config, root, cacheRoot, output, provenance, args, baseline, converter, changed, selected };
}
