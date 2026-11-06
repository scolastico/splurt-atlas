import {readFileSync,writeFileSync} from 'node:fs';
import sharp from 'sharp';
import {unquote,pretty,classify,aperture} from './dm.mjs';
import {expandStructures,smoothAtoms} from './appearance.mjs';
import {writeMipmaps} from './image-pyramid.mjs';
import {bakedChannel} from './utility-visibility.mjs';
export function runtimeReplacement(def,area,db){
  if(!/^\/turf\/open\/genturf(?:\/|$)/.test(def.turf))return null;
  const generator=db.resolve(area.path).map_generator;
  const target=db.resolve(generator||'').weighted_open_turf_types?.match(/\/turf\/[\w/]+/)?.[0];
  if(!target)return null;const vars=db.resolve(target);
  return{type:target,name:unquote(vars.name)||pretty(target),description:unquote(vars.desc),approximate:true};
}
export async function bakeRuntimeTerrain(dir,meta,db,reader,S=32,C=16){
  let generated=0;
  for(const def of meta.definitions){const replacement=runtimeReplacement(def,meta.areas[def.area],db);if(replacement){def.runtimeTerrain=replacement;generated++;}}
  if(!generated)return false;
  const P=S*C,expanded=meta.definitions.map(def=>expandStructures([...def.atoms.map(a=>({path:a.path,vars:a.vars})),{path:meta.areas[def.area].path,vars:{}}],db)),cache=new Map();
  const num=(v,f)=>Number.isFinite(+v)?+v:f;
  async function tile(atoms){
    const visible=atoms.filter(a=>bakedChannel(a,atoms,db)==='base'&&!a.path.startsWith('/area/')&&!/\/landmark|\/spawner\//.test(a.path)),key=JSON.stringify(visible);if(cache.has(key))return cache.get(key);
    const parts=[];
    for(const atom of visible){if(/\/space(?:\/|$)|\/openspace(?:\/|$)/.test(atom.path))continue;const v={...db.resolve(atom.path),...atom.vars},icon=unquote(v.icon);if(!icon.endsWith('.dmi'))continue;
      const alpha=Math.min(num(v.alpha,255),atom.path.startsWith('/turf/')&&aperture(atom.path)?255-aperture(atom.path):255),sprite=await reader.sprite(icon,unquote(v.icon_state),num(v.dir,2),unquote(v.color),alpha);if(!sprite)continue;
      const translation=v.transform?.match(/^TRANSLATE_MATRIX\(\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\)/),left=Math.round(S+num(v.pixel_x,0)+num(translation?.[1],0)),top=Math.round(S*2-sprite.height-num(v.pixel_y,0)-num(translation?.[2],0));if(left<0||top<0||left+sprite.width>S*3||top+sprite.height>S*3)continue;
      parts.push({input:sprite.input,left,top,layer:num(v.layer,atom.path.startsWith('/turf/')?1:atom.path.includes('turf_decal')?2:atom.path.startsWith('/mob/')?5:3)});
    }
    parts.sort((a,b)=>a.layer-b.layer);const result=parts.length?await sharp({create:{width:S*3,height:S*3,channels:4,background:'#00000000'}}).composite(parts.map(({layer,...part})=>part)).png().toBuffer():null;cache.set(key,result);return result;
  }
  for(const z of meta.levels){
    const level=JSON.parse(readFileSync(`${dir}/${z}.json`)),chunks=new Set();
    for(let i=0;i<level.grid.length;i++)if(meta.definitions[level.grid[i]]?.runtimeTerrain)chunks.add(`${Math.floor((i%meta.width)/C)},${Math.floor(Math.floor(i/meta.width)/C)}`);
    if(!chunks.size)continue;
    const at=(x,y,zz)=>zz===z&&x>=1&&x<=meta.width&&y>=1&&y<=meta.height?expanded[level.grid[(meta.height-y)*meta.width+x-1]]:undefined;
    level.chunks.natural=[];
    for(const key of chunks){const [cx,cy]=key.split(',').map(Number),parts=[];
      for(let iy=Math.max(0,cy*C-1);iy<Math.min(meta.height,(cy+1)*C+1);iy++)for(let ix=Math.max(0,cx*C-1);ix<Math.min(meta.width,(cx+1)*C+1);ix++){
        const def=meta.definitions[level.grid[iy*meta.width+ix]];if(!def)continue;let atoms=at(ix+1,meta.height-iy,z);
        if(def.runtimeTerrain){const target=def.runtimeTerrain.type,v=db.resolve(target),icon=unquote(v.icon),base=unquote(v.icon_state),hash=((ix*73856093)^(iy*19349663)^(z*83492791))>>>0;let state=base;
          if(base==='snow'&&db.hasIconState(icon,`snow${hash%13}`))state=`snow${hash%13}`;
          else if(base==='0,0'&&db.hasIconState(icon,`${ix%10},${iy%10}`))state=`${ix%10},${iy%10}`;
          atoms=atoms.map(atom=>atom.path===def.turf?{path:target,vars:{icon_state:JSON.stringify(state)}}:atom);
        }
        atoms=smoothAtoms(atoms,ix+1,meta.height-iy,z,at,db);const input=await tile(atoms);if(input)parts.push({input,left:ix*S-cx*P+S,top:iy*S-cy*P+S});
      }
      const file=`${dir}/${z}/natural-${cx}-${cy}.webp`,full=await sharp({create:{width:P+S*4,height:P+S*4,channels:4,background:'#00000000'}}).composite(parts).png().toBuffer();
      await sharp(full).extract({left:S*2,top:S*2,width:P,height:P}).webp({lossless:true}).toFile(file);await writeMipmaps(file,P);level.chunks.natural.push([cx,cy]);
    }
    const side=Math.ceil(Math.max(meta.width,meta.height)/C)*C*4,parts=[{input:`${dir}/${z}/base-overview.webp`,left:0,top:0}];
    for(const [cx,cy]of level.chunks.natural)parts.push({input:await sharp(`${dir}/${z}/natural-${cx}-${cy}.webp`).resize(C*4,C*4,{kernel:'nearest'}).png().toBuffer(),left:cx*C*4,top:cy*C*4});
    const overview=await sharp({create:{width:side,height:side,channels:4,background:'#00000000'}}).composite(parts).png().toBuffer();await sharp(overview).extract({left:0,top:0,width:meta.width*4,height:meta.height*4}).webp({lossless:true}).toFile(`${dir}/${z}/natural-overview.webp`);
    if(!level.overviews.includes('natural'))level.overviews.push('natural');writeFileSync(`${dir}/${z}.json`,JSON.stringify(level));
    console.log(`${meta.name} Z${z}: replaced generator markers in ${chunks.size} image chunks`);
  }
  writeFileSync(`${dir}/map.json`,JSON.stringify(meta));return true;
}
