import { readFileSync, readdirSync, mkdirSync, cpSync, writeFileSync } from 'node:fs';
import path from 'node:path';
export function copyPublic(out) {
  const publicRoot = path.resolve('public'), dataRoot = path.join(publicRoot,'data');
  const manifest = JSON.parse(readFileSync(path.join(dataRoot,'manifest.json')));
  const selected = path.resolve(dataRoot,manifest.dataPath || '.');
  if (selected !== dataRoot && !selected.startsWith(dataRoot+path.sep)) throw new Error('Invalid snapshot path');
  mkdirSync(out,{recursive:true});
  for (const name of readdirSync(publicRoot)) if (name !== 'data') cpSync(path.join(publicRoot,name),path.join(out,name),{recursive:true});
  const destination = path.join(out,'data');
  mkdirSync(destination,{recursive:true});
  const mapIds=new Set(manifest.maps.map(map=>map.id));
  for(const entry of readdirSync(selected,{withFileTypes:true}))if(!entry.isDirectory()||mapIds.has(entry.name))cpSync(path.join(selected,entry.name),path.join(destination,entry.name),{recursive:true});
  const {dataPath,...staticManifest} = manifest;
  writeFileSync(path.join(destination,'manifest.json'),JSON.stringify(staticManifest,null,2));
}
