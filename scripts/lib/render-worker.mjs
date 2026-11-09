import { parentPort, workerData } from 'node:worker_threads';
import sharp from 'sharp';
import { loadTypes } from './dm.mjs';
import { createSpriteReader } from './dmi.mjs';
import { createTileRenderer } from './tile-renderer.mjs';
import { renderChunk } from './chunk-renderer.mjs';

sharp.concurrency(1);
sharp.cache({ memory: 64, files: 10, items: 50 });
const db = loadTypes(workerData.root, workerData.dme);
const sprites = createSpriteReader(workerData.root);
const tiles = createTileRenderer({ db, sprites, tilePixels: workerData.tilePixels });
let mapId;
parentPort.on('message', async (task) => {
  try {
    if (task.mapId !== mapId) {
      tiles.clear();
      mapId = task.mapId;
    }
    const before = { ...sprites.report, samples: sprites.report.samples.length };
    const result = await renderChunk(task, tiles);
    parentPort.postMessage({
      result,
      report: {
        requested: sprites.report.requested - before.requested,
        missingIcon: sprites.report.missingIcon - before.missingIcon,
        missingState: sprites.report.missingState - before.missingState,
        samples: sprites.report.samples.slice(before.samples),
      },
    });
  } catch (error) {
    parentPort.postMessage({ error: error.stack || String(error) });
  }
});
