// Rebuild utility appearances and derived metadata without re-rendering terrain.
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import sharp from 'sharp';
import {loadTypes,unquote,classify} from './lib/dm.mjs';
import {createSpriteReader} from './lib/dmi.mjs';
import {buildInfrastructure} from './lib/infrastructure.mjs';
import {createDoorResolver} from './lib/door-access.mjs';
import {writeMipmaps} from './lib/image-pyramid.mjs';
const catalog=JSON.parse(readFileSync('public/data/manifest.json')),output=`public/data/${catalog.dataPath||''}`,source='.source/S.P.L.U.R.T-tg';
const config=JSON.parse(readFileSync('atlas.config.json'));catalog.maps=catalog.maps.filter(map=>!(config.excludeMaps||[]).includes(map.id));
const db=loadTypes(source),reader=createSpriteReader(source);db.hasIconState=reader.hasState;
const S=catalog.tilePixels,C=catalog.chunkTiles,P=S*C,num=(v,f)=>Number.isFinite(+v)?+v:f;
for(const summary of catalog.maps){
  const dir=`${output}/${summary.id}`,meta=JSON.parse(readFileSync(`${dir}/map.json`)),mapConfig=JSON.parse(readFileSync(`${source}/_maps/${summary.id}.json`)),doorAccess=createDoorResolver(db,mapConfig.job_changes||{});
  meta.jobRoles=doorAccess.roles;
  for(const def of meta.definitions)for(const atom of def.atoms){const v={...db.resolve(atom.path),...atom.vars};atom.description=unquote(v.desc);if(atom.path.startsWith('/obj/machinery/door/'))atom.doorAccess=doorAccess(def.atoms,atom);}
  const levels=new Map(),cells=[],spatial=new Map();
  for(const z of meta.levels){const level=JSON.parse(readFileSync(`${dir}/${z}.json`));levels.set(z,level);for(let index=0;index<level.grid.length;index++){const def=meta.definitions[level.grid[index]];if(!def)continue;const cell={x:index%meta.width+1,y:meta.height-Math.floor(index/meta.width),z,appearance:def.atoms.map(a=>({path:a.path,vars:{...a.vars}}))};cells.push(cell);spatial.set(`${cell.x},${cell.y},${z}`,[...cell.appearance,{path:meta.areas[def.area].path,vars:{}}]);}}
  meta.infrastructure=buildInfrastructure(cells,(x,y,z)=>spatial.get(`${x},${y},${z}`),db,meta.levels);
  const cache=new Map();
  async function tile(atoms,channel){
    const selected=atoms.filter(a=>classify(a.path)===channel),key=JSON.stringify(selected);if(cache.has(key))return cache.get(key);
    const parts=[];
    for(const atom of selected){const v={...db.resolve(atom.path),...atom.vars},icon=unquote(v.icon);if(!icon.endsWith('.dmi'))continue;const sprite=await reader.sprite(icon,unquote(v.icon_state),num(v.dir,2),unquote(v.color),num(v.alpha,255));if(!sprite)continue;const left=Math.round(S+num(v.pixel_x,0)),top=Math.round(S*2-sprite.height-num(v.pixel_y,0));if(left<0||top<0||left+sprite.width>S*3||top+sprite.height>S*3)continue;parts.push({input:sprite.input,left,top});}
    const result=parts.length?await sharp({create:{width:S*3,height:S*3,channels:4,background:'#00000000'}}).composite(parts).png().toBuffer():null;cache.set(key,result);return result;
  }
  for(const [z,level]of levels){
    const folder=`${dir}/${z}`;mkdirSync(folder,{recursive:true});
    for(const channel of process.argv.includes('--pipes-only')?['pipes']:['power','pipes']){
      const chunks=new Map();
      for(const cell of cells){if(cell.z!==z||!cell.appearance.some(a=>classify(a.path)===channel))continue;const px=(cell.x-1)*S,py=(meta.height-cell.y)*S;
        for(let cy=Math.max(0,Math.floor((py-S)/P));cy<=Math.min(Math.ceil(meta.height/C)-1,Math.floor((py+S*2-1)/P));cy++)for(let cx=Math.max(0,Math.floor((px-S)/P));cx<=Math.min(Math.ceil(meta.width/C)-1,Math.floor((px+S*2-1)/P));cx++){const key=`${cx},${cy}`;if(!chunks.has(key))chunks.set(key,[]);chunks.get(key).push({cell,px,py,cx,cy});}
      }
      const indices=[];
      for(const [key,entries]of chunks){const parts=[];for(const {cell,px,py,cx,cy}of entries){const input=await tile(cell.appearance,channel);if(input)parts.push({input,left:px-cx*P+S,top:py-cy*P+S});}if(!parts.length)continue;const [cx,cy]=key.split(',').map(Number),file=`${folder}/${channel}-${cx}-${cy}.webp`;const full=await sharp({create:{width:P+S*4,height:P+S*4,channels:4,background:'#00000000'}}).composite(parts).png().toBuffer();await sharp(full).extract({left:S*2,top:S*2,width:P,height:P}).webp({lossless:true}).toFile(file);await writeMipmaps(file,P);indices.push([cx,cy]);}
      level.chunks[channel]=indices;
      if(indices.length){const parts=[];for(const [cx,cy]of indices)parts.push({input:await sharp(`${folder}/${channel}-${cx}-${cy}.webp`).resize(C*4,C*4,{kernel:'nearest'}).png().toBuffer(),left:cx*C*4,top:cy*C*4});const side=Math.ceil(Math.max(meta.width,meta.height)/C)*C*4;const full=await sharp({create:{width:side,height:side,channels:4,background:'#00000000'}}).composite(parts).png().toBuffer();await sharp(full).extract({left:0,top:0,width:meta.width*4,height:meta.height*4}).webp({lossless:true}).toFile(`${folder}/${channel}-overview.webp`);if(!level.overviews.includes(channel))level.overviews.push(channel);}
    }
    writeFileSync(`${dir}/${z}.json`,JSON.stringify(level));
  }
  writeFileSync(`${dir}/map.json`,JSON.stringify(meta));console.log(`${meta.name}: utility sprites, ${meta.infrastructure.powerNetworks} networks, ${meta.infrastructure.transitions.length} deck connections, door access updated`);
}
const inventory=JSON.parse(readFileSync(`${output}/asset-sources.json`));inventory.icons=[...new Set([...inventory.icons,...reader.icons])].sort();writeFileSync(`${output}/asset-sources.json`,JSON.stringify(inventory,null,2));
