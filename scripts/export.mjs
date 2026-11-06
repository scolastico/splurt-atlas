// Exports the configured stations into a staging directory and promotes it to
// public/data. Without ATLAS_EXPORT_WORKER the parallel driver splits the maps
// across worker processes, each of which runs this same script as a worker.
import { parallelExport } from './export-parallel.mjs';
import { runExportWorker } from './lib/export-worker.mjs';

if (process.env.ATLAS_EXPORT_WORKER === '1') await runExportWorker();
else await parallelExport();
