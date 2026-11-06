import {readFileSync, writeFileSync, createWriteStream, statSync, existsSync,renameSync,rmSync} from 'node:fs';
import path from 'node:path';
import {pipeline} from 'node:stream/promises';
import {pathToFileURL} from 'node:url';
import JSZip from 'jszip';
import {exportProgress} from './export-progress.mjs';

// Separate from conversion: adding downloads never requires rendering sprites again.
export async function packageMaps(catalog='public/data/manifest.json',report=()=>{}) {
  const manifest=JSON.parse(readFileSync(catalog)),parent=path.dirname(path.resolve(catalog));
  const root=path.resolve(parent,manifest.dataPath||'.');
  if(root!==parent&&!root.startsWith(parent+path.sep))throw new Error('Unsafe dataset path');
  for(const map of manifest.maps){
    report(`Preparing ${map.name} download (${manifest.maps.indexOf(map)+1}/${manifest.maps.length})`,100*manifest.maps.indexOf(map)/manifest.maps.length);
    if(!/^[a-z0-9_-]+$/i.test(map.id))throw new Error('Unsafe map ID');
    const archive=`${map.id}.zip`,file=path.join(root,archive),version=map.assetVersion||manifest.buildId||manifest.commit;
    if(process.env.ATLAS_REPACKAGE!=='1'&&map.archive?.version===version&&map.archive.path===archive&&existsSync(file)&&statSync(file).size===map.archive.bytes)continue;
    const zip=new JSZip(),folder=path.join(root,map.id);
    const assets=JSON.parse(readFileSync(path.join(root,map.assets)));
    for(const item of [...assets,{path:'assets.json'}]){
      const source=path.resolve(folder,item.path);
      if(!source.startsWith(folder+path.sep))throw new Error('Unsafe asset path');
      zip.file(item.path,readFileSync(source),{date:new Date('1980-01-01T00:00:00Z'),createFolders:false,compression:item.path.endsWith('.json')?'DEFLATE':'STORE',compressionOptions:{level:6}});
    }
    // Never truncate an existing archive: reused dev snapshots may hard-link it.
    const temporary=`${file}.${process.pid}.tmp`;
    try{await pipeline(zip.generateNodeStream({streamFiles:true}),createWriteStream(temporary));renameSync(temporary,file);}finally{rmSync(temporary,{force:true});}
    map.archive={path:archive,bytes:statSync(file).size,version};
    console.log(`${map.name}: ${(map.archive.bytes/1048576).toFixed(1)} MB ZIP`);
  }
  const temporaryCatalog=`${catalog}.${process.pid}.tmp`;
  writeFileSync(temporaryCatalog,JSON.stringify(manifest,null,2)+'\n');renameSync(temporaryCatalog,catalog);
  return manifest;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){const progress=exportProgress();await packageMaps(process.argv[2],progress.update);progress.finish();}
