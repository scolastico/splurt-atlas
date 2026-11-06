import test from 'node:test';
import assert from 'node:assert/strict';
import { deploymentTarget,deploymentCommands,mapCommands,siteCommands,obsoleteCommands,shardMaps,deploymentStage } from '../scripts/deploy-r2.mjs';

test('R2 destination requires an explicit bucket and confines deletion to its prefix',()=>{
 const endpoint='https://account.r2.cloudflarestorage.com';
 assert.throws(()=>deploymentTarget({R2_ENDPOINT:endpoint}),/R2_BUCKET/);
 assert.equal(deploymentTarget({R2_ENDPOINT:endpoint,R2_BUCKET:'splurt-atlas'}).remote,'r2:splurt-atlas/');
 assert.equal(deploymentTarget({R2_ENDPOINT:endpoint+'/bucket/maps',R2_PREFIX:undefined}).remote,'r2:bucket/maps/');
 assert.throws(()=>deploymentTarget({R2_ENDPOINT:endpoint+'/other',R2_BUCKET:'bucket'}),/does not match/);
 assert.throws(()=>deploymentTarget({R2_ENDPOINT:endpoint,R2_BUCKET:'bucket',R2_PREFIX:'../other'}),/Invalid R2_PREFIX/);
 assert.throws(()=>deploymentTarget({R2_ENDPOINT:'http://example.test',R2_BUCKET:'bucket'}),/HTTPS/);
});
test('R2 mirror checks content, removes obsolete objects after transfers, and publishes entry points last',()=>{
 const commands=deploymentCommands('nowhere','r2:bucket/site/',['tramstation']);
 assert.equal(commands[0][0],'sync');assert.equal(commands[0][2],'r2:bucket/site/data/tramstation');assert.ok(commands[0].includes('--delete-after'));assert.ok(commands[0].some(value=>value.includes('immutable')));
 const site=commands.slice(1);
 assert.equal(site[0][0],'copyto');assert.equal(site[0][2],'r2:bucket/site/data/ATLAS-NOTICE.txt');assert.ok(site[0].includes('--ignore-times'));
 assert.equal(site[1][0],'sync');assert.ok(site[1].includes('--checksum'));assert.ok(site[1].includes('--delete-after'));assert.ok(!site[1].includes('--delete-excluded'));
 assert.ok(site[1].includes('/index.html'));assert.ok(site[1].includes('/data/manifest.json'));assert.ok(site[1].includes('/data/tramstation/**'));assert.ok(site[1].includes('/data/tramstation.zip'));
 assert.equal(site.at(-2)[2],'r2:bucket/site/data/manifest.json');assert.equal(site.at(-1)[2],'r2:bucket/site/index.html');
 assert.ok(site.at(-1).some(value=>value.includes('no-cache')));
 assert.ok(commands.every(command=>!command.some(value=>value.includes('secret'))));
 assert.throws(()=>mapCommands('dist','r2:bucket/',['../escape']),/Unsafe map ID/);
 assert.throws(()=>siteCommands('dist','r2:bucket/',['bad id']),/Unsafe map ID/);
});
test('station uploads shard by size and obsolete stations are purged from a remote listing',()=>{
 const maps=[{id:'large',bytes:100,archive:{bytes:50}},{id:'medium',bytes:60,archive:{bytes:30}},{id:'small',bytes:30},{id:'tiny',bytes:10}];
 const shards=shardMaps(maps,2);
 assert.deepEqual(shards,[['large'],['medium','small','tiny']]);assert.equal(shards.flat().length,4);
 assert.deepEqual(shardMaps(maps,1).flat().sort(),['large','medium','small','tiny']);
 const listing=[{Name:'large',IsDir:true},{Name:'retired',IsDir:true},{Name:'retired.zip',IsDir:false},{Name:'large.zip',IsDir:false},{Name:'manifest.json',IsDir:false},{Name:'../x',IsDir:true}];
 assert.deepEqual(obsoleteCommands(listing,'r2:bucket/',['large']).map(command=>command.slice(0,2)),[['purge','r2:bucket/data/retired'],['deletefile','r2:bucket/data/retired.zip']]);
 assert.deepEqual(deploymentStage({}),{stage:'all'});assert.deepEqual(deploymentStage({R2_STAGE:'site'}),{stage:'site'});
 assert.deepEqual(deploymentStage({R2_STAGE:'maps',R2_SHARD:'3',R2_SHARDS:'4'}),{stage:'maps',shard:3,count:4});
 assert.throws(()=>deploymentStage({R2_STAGE:'maps',R2_SHARD:'4',R2_SHARDS:'4'}),/R2_SHARD/);
 assert.throws(()=>deploymentStage({R2_STAGE:'other'}),/R2_STAGE/);
});
