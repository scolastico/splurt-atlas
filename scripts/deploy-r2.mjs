import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function deploymentTarget(env) {
  if(!env.R2_ENDPOINT)throw new Error('R2_ENDPOINT is required.');
  const endpoint=new URL(env.R2_ENDPOINT);
  if(endpoint.protocol!=='https:'||endpoint.username||endpoint.password||endpoint.search||endpoint.hash)throw new Error('Use an HTTPS R2 S3 endpoint without credentials, query or fragment.');
  const parts=endpoint.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  const bucket=env.R2_BUCKET||parts[0];
  if(!bucket)throw new Error('Set repository variable R2_BUCKET, or include the bucket in R2_ENDPOINT.');
  if(!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket))throw new Error('Invalid R2 bucket name.');
  if(parts.length&&parts[0]!==bucket)throw new Error('R2_BUCKET does not match the endpoint bucket.');
  const prefix=(env.R2_PREFIX||parts.slice(1).join('/')).replace(/^\/+|\/+$/g,'');
  if(prefix&&(prefix.split('/').some(part=>!part||part==='.'||part==='..')||/[\\\x00-\x1f:]/.test(prefix)))throw new Error('Invalid R2_PREFIX.');
  return {endpoint:endpoint.origin,bucket,prefix,remote:`r2:${bucket}/${prefix?prefix+'/':''}`};
}

// Stations are split into balanced groups so several CI jobs can upload at
// once; each group only touches its own map folders and ZIPs.
export function shardMaps(maps,count){
  const shards=Array.from({length:Math.max(1,count)},()=>({maps:[],bytes:0}));
  for(const map of [...maps].sort((a,b)=>(b.bytes||0)+(b.archive?.bytes||0)-(a.bytes||0)-(a.archive?.bytes||0))){
    const shard=shards.reduce((a,b)=>a.bytes<=b.bytes?a:b);shard.maps.push(map.id);shard.bytes+=(map.bytes||0)+(map.archive?.bytes||0);
  }
  return shards.map(shard=>shard.maps);
}
export function validMapId(id){return /^[a-z0-9_-]+$/i.test(id);}

const common=['--checksum','--fast-list','--transfers','32','--checkers','64','--s3-no-head','--stats','30s','--stats-one-line','--retries','1','--low-level-retries','2'];
const mutable=['--header-upload','Cache-Control: no-cache, no-transform'];
// Map folders and hashed bundles are requested with version-stamped URLs, so
// browsers and the Cloudflare edge may keep them for a year.
const immutable=['--header-upload','Cache-Control: public, max-age=31536000, immutable, no-transform'];

export function mapCommands(directory,remote,ids){
  for(const id of ids)if(!validMapId(id))throw new Error(`Unsafe map ID ${id}`);
  return ids.flatMap(id=>[
    ['sync',path.join(directory,'data',id),`${remote}data/${id}`,...common,...immutable,'--delete-after'],
    ...(existsSync(path.join(directory,'data',`${id}.zip`))?[['copyto',path.join(directory,'data',`${id}.zip`),`${remote}data/${id}.zip`,...common,...mutable]]:[]),
  ]);
}
export function siteCommands(directory,remote,ids){
  for(const id of ids)if(!validMapId(id))throw new Error(`Unsafe map ID ${id}`);
  return [
    // An actual benign PUT catches protocol/configuration errors before bulk sync.
    ['copyto',path.join(directory,'data/ATLAS-NOTICE.txt'),remote+'data/ATLAS-NOTICE.txt','--ignore-times','--retries','1','--low-level-retries','1',...mutable],
    ['sync',directory,remote,...common,...mutable,'--delete-after','--exclude','/index.html','--exclude','/data/manifest.json','--exclude','/assets/**',...ids.flatMap(id=>['--exclude',`/data/${id}/**`,'--exclude',`/data/${id}.zip`])],
    ...(existsSync(path.join(directory,'assets'))?[['sync',path.join(directory,'assets'),remote+'assets',...common,...immutable,'--delete-after']]:[]),
    ['copyto',path.join(directory,'data/manifest.json'),remote+'data/manifest.json',...common,...mutable],
    ['copyto',path.join(directory,'index.html'),remote+'index.html',...common,...mutable],
  ];
}
// Map folders are excluded from the site sync, so stations that left the
// catalog are removed explicitly from a listing of the data directory.
export function obsoleteCommands(listing,remote,ids){
  const keep=new Set(ids),commands=[];
  for(const entry of listing){
    const name=String(entry.Name||'');
    if(entry.IsDir){if(validMapId(name)&&!keep.has(name))commands.push(['purge',`${remote}data/${name}`,'--retries','1']);}
    else if(name.endsWith('.zip')&&validMapId(name.slice(0,-4))&&!keep.has(name.slice(0,-4)))commands.push(['deletefile',`${remote}data/${name}`,'--retries','1']);
  }
  return commands;
}
export function deploymentCommands(directory,remote,ids=[]){return [...mapCommands(directory,remote,ids),...siteCommands(directory,remote,ids)];}
export function deploymentStage(env){
  if(!env.R2_STAGE)return {stage:'all'};
  if(env.R2_STAGE==='site')return {stage:'site'};
  if(env.R2_STAGE!=='maps')throw new Error('R2_STAGE must be maps, site or unset.');
  const shard=Number(env.R2_SHARD),count=Number(env.R2_SHARDS);
  if(!Number.isInteger(count)||count<1||!Number.isInteger(shard)||shard<0||shard>=count)throw new Error('R2_SHARD must be a shard index below R2_SHARDS.');
  return {stage:'maps',shard,count};
}

export function deploy(env=process.env,run=execFileSync) {
  const target=deploymentTarget(env),directory=path.resolve('dist'),stage=deploymentStage(env);
  if(!env.R2_ACCESS_KEY||!env.R2_ACCESS_KEY_ID)throw new Error('R2_ACCESS_KEY and R2_ACCESS_KEY_ID secrets are required.');
  if(!existsSync(path.join(directory,'index.html')))throw new Error('Missing dist/index.html; refusing to synchronize an incomplete build.');
  if(!existsSync(path.join(directory,'data/ATLAS-NOTICE.txt')))throw new Error('Missing deployment notice; refusing to synchronize an incomplete build.');
  const manifest=JSON.parse(readFileSync(path.join(directory,'data/manifest.json')));
  if(!manifest.maps?.length)throw new Error('Missing map catalog; refusing to synchronize an empty site.');
  const ids=manifest.maps.map(map=>map.id);
  const runtime={...env,RCLONE_CONFIG_R2_TYPE:'s3',RCLONE_CONFIG_R2_PROVIDER:'Cloudflare',RCLONE_CONFIG_R2_ACCESS_KEY_ID:env.R2_ACCESS_KEY_ID,RCLONE_CONFIG_R2_SECRET_ACCESS_KEY:env.R2_ACCESS_KEY,RCLONE_CONFIG_R2_ENDPOINT:target.endpoint,RCLONE_CONFIG_R2_REGION:'auto',RCLONE_CONFIG_R2_NO_CHECK_BUCKET:'true'};
  // Credentials exist only in the child environment, never arguments or config files.
  const rclone=args=>run('rclone',args,{env:runtime,stdio:'inherit'});
  if(stage.stage==='maps'){
    const group=shardMaps(manifest.maps,stage.count)[stage.shard];
    console.log(`Uploading ${group.length} of ${ids.length} stations (shard ${stage.shard+1}/${stage.count}) to ${target.remote}.`);
    for(const args of mapCommands(directory,target.remote,group))rclone(args);
    console.log('Station files uploaded.');
    return;
  }
  if(stage.stage==='all'){console.log(`Mirroring ${ids.length} stations to ${target.remote}.`);for(const args of mapCommands(directory,target.remote,ids))rclone(args);}
  let listing=[];
  try{listing=JSON.parse(run('rclone',['lsjson',`${target.remote}data`,'--retries','1'],{env:runtime,stdio:['ignore','pipe','inherit'],encoding:'utf8',maxBuffer:64*1024*1024}));}
  catch(error){console.log(`Could not list the remote data directory; obsolete stations are kept: ${error.message}`);}
  for(const args of [...siteCommands(directory,target.remote,ids),...obsoleteCommands(listing,target.remote,ids)])rclone(args);
  console.log('R2 mirror updated; obsolete objects removed and entry points published last.');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)deploy();
