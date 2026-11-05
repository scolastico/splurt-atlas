import test from 'node:test';
import assert from 'node:assert/strict';
import { needsRebuild } from '../scripts/check-upstream.mjs';

test('monthly builds skip only an already-deployed upstream commit',async()=>{
 const commit='a'.repeat(40),url='https://example.test/atlas';
 const matching=async resource=>{assert.equal(resource.pathname,'/atlas/data/manifest.json');return new Response(JSON.stringify({commit}));};
 assert.equal(await needsRebuild('schedule',commit,url,matching),false);
 assert.equal(await needsRebuild('schedule','b'.repeat(40),url,matching),true);
 assert.equal(await needsRebuild('push',commit,url,()=>{throw new Error('Must not fetch');}),true);
 assert.equal(await needsRebuild('workflow_dispatch',commit,url,matching),true);
 assert.equal(await needsRebuild('schedule',commit,'',matching),true);
 assert.equal(await needsRebuild('schedule',commit,url,async()=>new Response('',{status:404})),true);
 assert.equal(await needsRebuild('schedule',commit,url,async()=>{throw new Error('offline');}),true);
});
