import test from 'node:test';import assert from 'node:assert/strict';import {indexedDB} from 'fake-indexeddb';import {AssetCache} from '../src/asset-cache.js';
globalThis.indexedDB=indexedDB;const preferences=new Map();globalThis.localStorage={getItem:key=>preferences.get(key)??null,setItem:(key,value)=>preferences.set(key,String(value))};
test('IndexedDB persists blobs across cache instances and disabling caching bypasses it',async()=>{
 preferences.clear();preferences.set('atlas-storage-mode','all');let requests=0;globalThis.fetch=async()=>{requests++;return new Response(new Blob(['sprite-bytes'],{type:'image/webp'}));};
 const first=new AssetCache('test-persistence');first.version='revision-1';assert.equal(first.enabled,true);await first.get('https://example.test/sprite.webp','sprite.webp');
 const reopened=new AssetCache('test-persistence');reopened.version=first.version;await reopened.get('https://example.test/sprite.webp','sprite.webp');assert.equal(requests,1);
 reopened.setMode('none');await reopened.get('https://example.test/sprite.webp','sprite.webp');assert.equal(requests,2);
 reopened.setMode('all');reopened.version='revision-2';await reopened.get('https://example.test/sprite.webp','sprite.webp');assert.equal(requests,3);
});
test('catalog fallback restores the last known manifest when the network is unavailable',async()=>{
 preferences.clear();preferences.set('atlas-storage-mode','all');const manifest={maps:[{id:'one'}]};globalThis.fetch=async()=>new Response(JSON.stringify(manifest));const cache=new AssetCache('test-catalog');await cache.catalog('https://example.test/manifest.json');
 globalThis.fetch=async()=>{throw new Error('offline');};assert.deepEqual(await cache.catalog('https://example.test/manifest.json'),manifest);
});
test('offline warming includes sprites and metadata of maps that were never selected',async()=>{
 preferences.clear();preferences.set('atlas-storage-mode','all');let requests=0;globalThis.fetch=async url=>{requests++;return new Response(String(url).endsWith('assets.json')?JSON.stringify([{path:'map.json',bytes:10},{path:'1/base.webp',bytes:20}]):'cached-resource');};
 let status='';const cache=new AssetCache('test-all-maps',value=>status=value);cache.version='revision';const manifest={maps:[{id:'first',assets:'first/assets.json'},{id:'unselected',assets:'unselected/assets.json'}]};
 await cache.warm(manifest,new URL('https://example.test/data/'));assert.equal(requests,6);assert.ok(status.startsWith('All 2 maps saved'));
 const blob=await cache.read('test-all-maps:revision:unselected/1/base.webp');assert.equal(await blob.text(),'cached-resource');await cache.warm(manifest,new URL('https://example.test/data/'));assert.equal(requests,6);
});

test('first visit waits for a local choice and current-map mode replaces the old saved map',async()=>{
 preferences.clear();const requests=[];globalThis.fetch=async url=>{requests.push(String(url));return new Response(String(url).endsWith('assets.json')?JSON.stringify([{path:'map.json',bytes:10},{path:'1/base.webp',bytes:20}]):'sprite');};
 const cache=new AssetCache('test-current-only');cache.version='revision';assert.equal(cache.mode,null);assert.equal(cache.enabled,false);
 const manifest={maps:[{id:'first',assets:'first/assets.json'},{id:'second',assets:'second/assets.json'}]},base=new URL('https://example.test/data/');
 await cache.warm(manifest,base);assert.deepEqual(requests,[]);
 cache.setMode('current');cache.setCurrentMap('first');await cache.warm(manifest,base);
 assert.equal(requests.length,3);assert.ok(requests.every(url=>url.includes('/first/')));
 const firstKey='test-current-only:revision:first/1/base.webp';assert.ok(await cache.read(firstKey));
 const reopened=new AssetCache('test-current-only');assert.equal(reopened.mode,'current');assert.equal(reopened.currentMap,'first');
 cache.setCurrentMap('second');await cache.warm(manifest,base);assert.equal(await cache.read(firstKey),null);assert.ok(await cache.read('test-current-only:revision:second/1/base.webp'));
 cache.setMode('none');await cache.warm(manifest,base);assert.equal(await cache.read('test-current-only:revision:second/1/base.webp'),null);
});

test('switching all-map mode to current-only prunes other maps and old export revisions',async()=>{
 preferences.clear();const cache=new AssetCache('test-prune');cache.setMode('all');cache.version='old';
 globalThis.fetch=async()=>new Response('sprite');await cache.get('https://example.test/old','first/old.webp');
 cache.version='new';await cache.get('https://example.test/first','first/base.webp');await cache.get('https://example.test/second','second/base.webp');
 cache.setMode('current');cache.setCurrentMap('second');await cache.prune();
 assert.equal(await cache.read('test-prune:old:first/old.webp'),null);assert.equal(await cache.read('test-prune:new:first/base.webp'),null);assert.ok(await cache.read('test-prune:new:second/base.webp'));
});

test('switching storage modes discards both in-flight downloads and buffered writes from other maps',async()=>{
 preferences.clear();const cache=new AssetCache('test-storage-race');cache.setMode('all');cache.version='revision';
 let finish;globalThis.fetch=()=>new Promise(resolve=>finish=resolve);
 const pending=cache.get('https://example.test/first','first/late.webp','low');
 while(!finish)await new Promise(resolve=>setTimeout(resolve,0));
 cache.setMode('current');cache.setCurrentMap('second');finish(new Response('sprite'));await pending;await cache.flushWrites();
 assert.equal(await cache.read('test-storage-race:revision:first/late.webp'),null);
 cache.setMode('all');globalThis.fetch=async()=>new Response('buffered sprite');await cache.get('https://example.test/buffered','first/buffered.webp','low');
 cache.setMode('none');await cache.prune();await cache.flushWrites();assert.equal(await cache.read('test-storage-race:revision:first/buffered.webp'),null);
});
test('an incremental release retains cached images for maps that were reused',async()=>{
 preferences.clear();const cache=new AssetCache('test-map-versions');cache.setMode('all');let requests=0;
 globalThis.fetch=async()=>{requests++;return new Response('sprite');};
 cache.setManifest({buildId:'build-1',maps:[{id:'one',assetVersion:'one-1'},{id:'two',assetVersion:'two-1'}]});
 await cache.get('https://example.test/one','one/base.webp');await cache.get('https://example.test/two','two/base.webp');
 cache.setManifest({buildId:'build-2',maps:[{id:'one',assetVersion:'one-2'},{id:'two',assetVersion:'two-1'}]});await cache.prune();
 await cache.get('https://example.test/two','two/base.webp');assert.equal(requests,2);
 await cache.get('https://example.test/one','one/base.webp');assert.equal(requests,3);
 assert.equal(await cache.read('test-map-versions:one-1:one/base.webp'),null);
});
