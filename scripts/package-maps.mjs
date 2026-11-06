import {readFileSync, writeFileSync, createWriteStream, statSync, existsSync} from 'node:fs';
import path from 'node:path';
import {pipeline} from 'node:stream/promises';
import {pathToFileURL} from 'node:url';
import JSZip from 'jszip';

// Separate from conversion: adding downloads never requires rendering sprites again.
export async function packageMaps(catalog='public/data/manifest.json') {
  const manifest=JSON.parse(readFileSync(catalog)),parent=path.dirname(path.resolve(catalog));
  const root=path.resolve(parent,manifest.dataPath||'.');
  if(root!==parent&&!root.startsWith(parent+path.sep))throw new Error('Unsafe dataset path');
  for(const map of manifest.maps){
    if(!/^[a-z0-9_-]+$/i.test(map.id))throw new Error('Unsafe map ID');
    const archive=`${map.id}.zip`,file=path.join(root,archive),version=map.assetVersion||manifest.buildId||manifest.commit;
    if(map.archive?.version===version&&map.archive.path===archive&&existsSync(file)&&statSync(file).size===map.archive.bytes)continue;
    const zip=new JSZip(),folder=path.join(root,map.id);
    const assets=JSON.parse(readFileSync(path.join(root,map.assets)));
    for(const item of [...assets,{path:'assets.json'}]){
      const source=path.resolve(folder,item.path);
      if(!source.startsWith(folder+path.sep))throw new Error('Unsafe asset path');
      zip.file(item.path,readFileSync(source),{date:new Date('1980-01-01T00:00:00Z'),createFolders:false,compression:item.path.endsWith('.json')?'DEFLATE':'STORE',compressionOptions:{level:6}});
    }
    await pipeline(zip.generateNodeStream({streamFiles:true}),createWriteStream(file));
    map.archive={path:archive,bytes:statSync(file).size,version};
    console.log(`${map.name}: ${(map.archive.bytes/1048576).toFixed(1)} MB ZIP`);
  }
  writeFileSync(catalog,JSON.stringify(manifest,null,2)+'\n');
  return manifest;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)await packageMaps();
