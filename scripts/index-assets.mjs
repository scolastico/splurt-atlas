import {readFileSync,readdirSync,statSync,writeFileSync,existsSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {SCHEMA} from './lib/map-format.mjs';
const catalog='public/data/manifest.json',manifest=JSON.parse(readFileSync(catalog)),root=`public/data/${manifest.dataPath||''}`;
const config=JSON.parse(readFileSync('atlas.config.json'));manifest.maps=manifest.maps.filter(map=>!(config.excludeMaps||[]).includes(map.id));
for(const map of manifest.maps){
  const assets=[];const visit=(folder,prefix='')=>{for(const item of readdirSync(folder,{withFileTypes:true})){if(item.name==='assets.json')continue;const path=prefix+item.name;if(item.isDirectory())visit(`${folder}/${item.name}`,path+'/');else assets.push({path,bytes:statSync(`${folder}/${item.name}`).size});}};
  visit(`${root}/${map.id}`);writeFileSync(`${root}/${map.id}/assets.json`,JSON.stringify(assets));map.assets=`${map.id}/assets.json`;map.bytes=assets.reduce((n,a)=>n+a.bytes,0);map.preview=existsSync(`${root}/${map.id}/preview.webp`)?`${map.id}/preview.webp`:null;
  map.naturalPreview=existsSync(`${root}/${map.id}/preview-natural.webp`)?`${map.id}/preview-natural.webp`:undefined;
}
manifest.schema=SCHEMA;manifest.buildId=randomUUID();writeFileSync(catalog,JSON.stringify(manifest,null,2));
if(manifest.dataPath)writeFileSync(`${root}/manifest.json`,JSON.stringify({...manifest,dataPath:undefined},null,2));
console.log(`Indexed assets for ${manifest.maps.length} maps · ${(manifest.maps.reduce((n,m)=>n+m.bytes,0)/1048576).toFixed(1)} MiB`);
