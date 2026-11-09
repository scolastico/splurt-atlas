// Exports the configured stations into a staging directory and promotes it to
// public/data. The coordinator shares render chunks across persistent workers.
import { parallelExport } from './export-parallel.mjs';

await parallelExport();
