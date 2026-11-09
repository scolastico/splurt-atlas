#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function parseCli(argv) {
  const options = { maps: [] };
  const values = new Set([
    'source',
    'output',
    'maps',
    'workers',
    'baseline',
    'config',
    'base',
    'dme',
    'revision',
    'repository',
  ]);
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].replace(/^--/, '');
    if (!argv[i].startsWith('--')) throw new Error(`Unexpected argument: ${argv[i]}`);
    if (['viewer', 'full', 'help'].includes(key)) options[key] = true;
    else if (values.has(key)) {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for --${key}`);
      options[key] = key === 'maps' ? value.split(',').filter(Boolean) : value;
    } else throw new Error(`Unknown option: --${key}`);
  }
  if (options.workers && (!/^\d+$/.test(options.workers) || Number(options.workers) < 1))
    throw new Error('--workers must be a positive integer');
  return options;
}

const help = `Station Atlas generator
  --source PATH     Mounted tgstation-family source directory (required, read-only)
  --output PATH     Empty output directory (required)
  --maps ID,ID      Station configuration basenames; default: all stations
  --viewer          Include the static atlas with dataset comparison; default: data only
  --baseline PATH   Previous data directory for incremental generation
  --full            Ignore the baseline
  --workers N       Render workers (resource capped, default: up to four)
  --config PATH     Atlas configuration (dimensions, exclusions, selection)
  --dme PATH        Source-relative DM project (auto-detected when omitted)
  --revision ID     Revision label for source without accessible Git metadata
  --repository URL  Source URL, also used for archives without Git metadata
  --base PATH       Viewer hosting base, default: ./
  --help            Show this help

The mounted checkout's current HEAD and working files are used without checkout,
fetch, or source writes. Mount a different checkout to generate another branch.
`;

export async function runCli(argv = process.argv.slice(2)) {
  const options = parseCli(argv);
  if (options.help) {
    console.log(help);
    return;
  }
  if (!options.source || !options.output) throw new Error('--source and --output are required (see --help)');
  // Resolve user paths before changing to the installed generator directory.
  for (const key of ['source', 'output', 'config', 'baseline'])
    if (options[key]) options[key] = path.resolve(options[key]);
  if (!existsSync(path.join(options.source, '_maps'))) throw new Error('Source is missing _maps/');
  const relative = path.relative(options.source, options.output);
  if (!relative || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative)))
    throw new Error('Output must be outside the source checkout');
  if (existsSync(options.output) && readdirSync(options.output).length)
    throw new Error('Output directory must be empty; use a new directory for each dataset');
  const project = fileURLToPath(new URL('../', import.meta.url));
  const runId = randomUUID();
  const stage = path.join(project, '.cache', `export-${runId}`);
  const configPath = path.join(project, '.cache', `cli-config-${runId}.json`);
  const viewerStage = path.join(project, '.cache', `viewer-${runId}`);
  mkdirSync(path.dirname(stage), { recursive: true });
  const config = options.config
    ? JSON.parse(readFileSync(options.config))
    : {
        repository: '',
        maps: 'all',
        excludeMaps: [],
        tilePixels: 32,
        chunkTiles: 16,
      };
  writeFileSync(configPath, JSON.stringify(config));
  const env = {
    ...process.env,
    ATLAS_SOURCE_ROOT: options.source,
    ATLAS_CONFIG: configPath,
    ATLAS_EXPORT_OUTPUT: stage,
    ATLAS_STAGE_ONLY: '1',
    ATLAS_PROGRESS_FILE: `cli-${runId}.json`,
    ATLAS_DATA_ROOT: stage,
  };
  // A mounted source has its own provenance; do not inherit a dev pin override.
  delete env.ATLAS_SOURCE_REF;
  delete env.ATLAS_EXPORT_WORKER;
  if (options.workers) env.ATLAS_WORKERS = options.workers;
  if (options.dme) env.ATLAS_DME = options.dme;
  if (options.revision) env.ATLAS_SOURCE_REVISION = options.revision;
  if (options.repository) env.ATLAS_SOURCE_REPOSITORY = options.repository;
  if (options.baseline) env.ATLAS_BASELINE = options.baseline;
  const run = (args) =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, args, { cwd: project, env, stdio: 'inherit', windowsHide: true });
      const stop = () => child.kill('SIGTERM');
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
      const cleanup = () => {
        process.removeListener('SIGINT', stop);
        process.removeListener('SIGTERM', stop);
      };
      child.once('error', (error) => {
        cleanup();
        reject(error);
      });
      child.once('exit', (code) => {
        cleanup();
        code === 0 ? resolve() : reject(new Error(`Command failed (${code}): ${args[0]}`));
      });
    });
  try {
    const flags = options.full ? ['--full'] : options.baseline ? ['--incremental'] : [];
    await run(['scripts/export.mjs', ...flags, ...options.maps]);
    let result = stage;
    if (options.viewer) {
      await run([
        'node_modules/vite/bin/vite.js',
        'build',
        '--outDir',
        viewerStage,
        '--base',
        options.base || './',
      ]);
      result = viewerStage;
    }
    mkdirSync(options.output, { recursive: true });
    cpSync(result, options.output, { recursive: true });
    console.log(`Atlas ${options.viewer ? 'viewer and data' : 'data'} written to ${options.output}`);
  } finally {
    // All removable paths are literal children of this installation's .cache.
    for (const target of [stage, viewerStage, configPath, path.join(project, '.cache', `cli-${runId}.json`)])
      rmSync(target, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  runCli().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
