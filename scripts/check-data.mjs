import { readFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
const fail = message => { console.error(message); process.exit(1); };
if (!existsSync('public/data/manifest.json')) fail('No exported data. Run pnpm source && pnpm export first.');
const manifest = JSON.parse(readFileSync('public/data/manifest.json'));
const root = path.resolve('public/data',manifest.dataPath || '.');
if (root !== path.resolve('public/data') && !root.startsWith(path.resolve('public/data') + path.sep)) fail('Invalid data snapshot path');
const config = JSON.parse(readFileSync('atlas.config.json'));
if(manifest.maps.some(map=>(config.excludeMaps||[]).includes(map.id)))fail('Export contains an excluded development map. Re-export or re-index the selected catalog.');
if(config.maps==='all'&&existsSync('.source/S.P.L.U.R.T-tg/_maps')){
  const expected=readdirSync('.source/S.P.L.U.R.T-tg/_maps').filter(name=>name.endsWith('.json')).map(name=>name.slice(0,-5)).filter(id=>!(config.excludeMaps||[]).includes(id)).sort();
  if(JSON.stringify(expected)!==JSON.stringify(manifest.maps.map(map=>map.id).sort()))fail('The export does not contain every configured station. Run pnpm export.');
}
if (manifest.commit !== config.ref) fail('Export is stale: source pin differs. Run pnpm source && pnpm export.');
if (!manifest.maps.length) fail('Export contains no maps.');
for (const map of manifest.maps) {
  if(manifest.schema>=2&&(!map.assets||!existsSync(path.join(root,map.assets))))fail(`Missing offline asset index: ${map.id}`);
  const meta = JSON.parse(readFileSync(`${root}/${map.id}/map.json`));
  for (const z of map.levels) {
    const data = JSON.parse(readFileSync(`${root}/${map.id}/${z}.json`));
    if (data.grid.length !== meta.width * meta.height) fail(`Bad grid: ${map.id} Z${z}`);
    if (data.grid.some(index => !Number.isInteger(index) || index < -1 || index >= meta.definitions.length)) fail(`Invalid dictionary index: ${map.id} Z${z}`);
    if (!existsSync(`${root}/${map.id}/${z}/aperture.png`)) fail(`Missing aperture mask: ${map.id} Z${z}`);
    for (const channel of data.overviews || []) if (!existsSync(`${root}/${map.id}/${z}/${channel}-overview.webp`)) fail(`Missing overview: ${map.id} Z${z} ${channel}`);
    for (const [channel, chunks] of Object.entries(data.chunks)) for (const [x, y] of chunks) {
      if (!existsSync(`${root}/${map.id}/${z}/${channel}-${x}-${y}.webp`)) fail(`Missing chunk ${map.id} ${z} ${channel} ${x},${y}`);
      for (const mip of data.mips || []) if (!existsSync(`${root}/${map.id}/${z}/${channel}-${x}-${y}-mip${mip}.webp`)) fail(`Missing mip ${map.id} ${z} ${channel} ${x},${y} @${mip}`);
    }
  }
}
console.log(`Validated ${manifest.maps.length} station exports at ${manifest.commit.slice(0, 12)}`);
