import test from 'node:test';
import assert from 'node:assert/strict';
import {workerCount,distributeMaps} from '../scripts/export-parallel.mjs';
test('conversion worker count respects CPU, RAM, station count and explicit overrides',()=>{
 const gb=1024**3;
 assert.equal(workerCount(16,16,16*gb,undefined),4);
 assert.equal(workerCount(16,2,16*gb,8),2);
 assert.equal(workerCount(16,16,3*gb,8),1);
 assert.equal(workerCount(2,16,32*gb,8),2);
 assert.equal(workerCount(16,16,32*gb,8),8);
 assert.equal(workerCount(16,16,32*gb,1),1);
 assert.throws(()=>workerCount(16,16,32*gb,0),/positive integer/);
});
test('map batches balance estimated work and assign each station exactly once',()=>{
 const maps=['small','large','medium','tiny'],baseline={manifest:{maps:[{id:'large',bytes:100},{id:'medium',bytes:60},{id:'small',bytes:30},{id:'tiny',bytes:10}]}};
 const groups=distributeMaps(maps,2,baseline);
 assert.deepEqual(groups.map(group=>group.weight),[100,100]);
 assert.deepEqual(groups.flatMap(group=>group.maps).sort(),[...maps].sort());
});
