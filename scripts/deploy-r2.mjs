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

export function deploymentCommands(directory,remote) {
  const common=['--checksum','--fast-list','--transfers','16','--checkers','32','--stats','30s','--stats-one-line','--header-upload','Cache-Control: no-cache, no-transform'];
  return [
    ['sync',directory,remote,...common,'--delete-after','--exclude','/index.html','--exclude','/data/manifest.json'],
    ['copyto',path.join(directory,'data/manifest.json'),remote+'data/manifest.json',...common],
    ['copyto',path.join(directory,'index.html'),remote+'index.html',...common],
  ];
}

export function deploy(env=process.env,run=execFileSync) {
  const target=deploymentTarget(env),directory=path.resolve('dist');
  if(!env.R2_ACCESS_KEY||!env.R2_ACCESS_KEY_ID)throw new Error('R2_ACCESS_KEY and R2_ACCESS_KEY_ID secrets are required.');
  if(!existsSync(path.join(directory,'index.html')))throw new Error('Missing dist/index.html; refusing to synchronize an incomplete build.');
  const manifest=JSON.parse(readFileSync(path.join(directory,'data/manifest.json')));
  if(!manifest.maps?.length)throw new Error('Missing map catalog; refusing to synchronize an empty site.');
  const runtime={...env,RCLONE_CONFIG_R2_TYPE:'s3',RCLONE_CONFIG_R2_PROVIDER:'Cloudflare',RCLONE_CONFIG_R2_ACCESS_KEY_ID:env.R2_ACCESS_KEY_ID,RCLONE_CONFIG_R2_SECRET_ACCESS_KEY:env.R2_ACCESS_KEY,RCLONE_CONFIG_R2_ENDPOINT:target.endpoint,RCLONE_CONFIG_R2_REGION:'auto',RCLONE_CONFIG_R2_NO_CHECK_BUCKET:'true'};
  console.log(`Mirroring ${manifest.maps.length} stations to ${target.remote}.`);
  // Credentials exist only in the child environment, never arguments or config files.
  for(const args of deploymentCommands(directory,target.remote))run('rclone',args,{env:runtime,stdio:'inherit'});
  console.log('R2 mirror updated; obsolete objects removed and entry points published last.');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)deploy();
