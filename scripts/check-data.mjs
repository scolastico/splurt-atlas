import { readFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { SCHEMA, LODS, decodeMap, decodeLevel, stripName, maskChannels } from './lib/map-format.mjs';
const fail = message => { console.error(message); process.exit(1); };
if (!existsSync('public/data/manifest.json')) fail('No exported data. Run pnpm source && pnpm export first.');
const manifest = JSON.parse(readFileSync('public/data/manifest.json'));
const root = path.resolve('public/data',manifest.dataPath || '.');
if (root !== path.resolve('public/data') && !root.startsWith(path.resolve('public/data') + path.sep)) fail('Invalid data snapshot path');
const config = JSON.parse(readFileSync('atlas.config.json'));
if(manifest.schema!==SCHEMA)fail(`Export uses data schema ${manifest.schema??'legacy'}; this viewer needs schema ${SCHEMA}. Run pnpm export.`);
if(manifest.maps.some(map=>(config.excludeMaps||[]).includes(map.id)))fail('Export contains an excluded development map. Re-export or re-index the selected catalog.');
if(config.maps==='all'&&existsSync('.source/S.P.L.U.R.T-tg/_maps')){
  const expected=readdirSync('.source/S.P.L.U.R.T-tg/_maps').filter(name=>name.endsWith('.json')).map(name=>name.slice(0,-5)).filter(id=>!(config.excludeMaps||[]).includes(id)).sort();
  if(JSON.stringify(expected)!==JSON.stringify(manifest.maps.map(map=>map.id).sort()))fail('The export does not contain every configured station. Run pnpm export.');
}
if (manifest.commit !== config.ref) fail('Export is stale: source pin differs. Run pnpm source && pnpm export.');
if (!manifest.maps.length) fail('Export contains no maps.');
for (const map of manifest.maps) {
  if(!map.assets||!existsSync(path.join(root,map.assets)))fail(`Missing offline asset index: ${map.id}`);
  const meta = decodeMap(JSON.parse(readFileSync(`${root}/${map.id}/map.json`)));
  if(map.preview&&!existsSync(path.join(root,map.preview)))fail(`Missing preview: ${map.id}`);
  for (const z of map.levels) {
    let data;
    try { data = decodeLevel(JSON.parse(readFileSync(`${root}/${map.id}/${z}.json`))); } catch (error) { fail(`Bad level data: ${map.id} Z${z}: ${error.message}`); }
    if (data.grid.length !== meta.width * meta.height) fail(`Bad grid: ${map.id} Z${z}`);
    if (data.grid.some(index => index < -1 || index >= meta.definitions.length)) fail(`Invalid dictionary index: ${map.id} Z${z}`);
    if (!existsSync(`${root}/${map.id}/${z}/aperture.png`)) fail(`Missing aperture mask: ${map.id} Z${z}`);
    if (data.overview && !existsSync(`${root}/${map.id}/${z}/overview.webp`)) fail(`Missing overview strip: ${map.id} Z${z}`);
    if (data.overviewUtilities && !existsSync(`${root}/${map.id}/${z}/overview-utilities.webp`)) fail(`Missing utility overview strip: ${map.id} Z${z}`);
    if (!Array.isArray(data.pyramid) || data.pyramid.length !== LODS.length + 1) fail(`Missing zoom pyramid: ${map.id} Z${z}`);
    for (const [lod, tiles] of data.pyramid.entries()) for (const [x, y, mask] of tiles) {
      if (!maskChannels(mask).length) fail(`Empty strip ${map.id} ${z} ${x},${y} @${lod}`);
      if (!existsSync(`${root}/${map.id}/${z}/${stripName(x, y, lod)}`)) fail(`Missing strip ${map.id} ${z} ${x},${y} @${lod}`);
    }
  }
}
console.log(`Validated ${manifest.maps.length} station exports at ${manifest.commit.slice(0, 12)}`);
