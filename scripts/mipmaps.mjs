// Upgrade an existing export without rendering the source maps again.
import { readFileSync, writeFileSync } from 'node:fs';
import { writeMipmaps } from './lib/image-pyramid.mjs';
const manifest = JSON.parse(readFileSync('public/data/manifest.json'));
const root = `public/data/${manifest.dataPath || ''}`;
for (const map of manifest.maps) for (const z of map.levels) {
  const file = `${root}/${map.id}/${z}.json`, level = JSON.parse(readFileSync(file));
  for (const [channel, chunks] of Object.entries(level.chunks)) {
    for (let i = 0; i < chunks.length; i += 6) await Promise.all(chunks.slice(i, i + 6).map(([x, y]) => writeMipmaps(`${root}/${map.id}/${z}/${channel}-${x}-${y}.webp`, manifest.tilePixels * manifest.chunkTiles)));
  }
  level.mips = [1, 2]; writeFileSync(file, JSON.stringify(level));
  console.log(`${map.name} Z${z}: zoom pyramid ready`);
}
