import test from 'node:test';
import assert from 'node:assert/strict';
import { indexedDB } from 'fake-indexeddb';
import JSZip from 'jszip';
import { AssetCache } from '../src/data/asset-cache.ts';
globalThis.indexedDB = indexedDB;
const preferences = new Map();
globalThis.localStorage = {
  getItem: (key) => preferences.get(key) ?? null,
  setItem: (key, value) => preferences.set(key, String(value)),
};
test('IndexedDB persists blobs across cache instances and disabling caching bypasses it', async () => {
  preferences.clear();
  preferences.set('atlas-storage-mode', 'all');
  let requests = 0;
  globalThis.fetch = async () => {
    requests++;
    return new Response(new Blob(['sprite-bytes'], { type: 'image/webp' }));
  };
  const first = new AssetCache('test-persistence');
  first.version = 'revision-1';
  assert.equal(first.enabled, true);
  await first.get('https://example.test/sprite.webp', 'sprite.webp');
  const reopened = new AssetCache('test-persistence');
  reopened.version = first.version;
  await reopened.get('https://example.test/sprite.webp', 'sprite.webp');
  assert.equal(requests, 1);
  reopened.setMode('none');
  await reopened.get('https://example.test/sprite.webp', 'sprite.webp');
  assert.equal(requests, 2);
  reopened.setMode('all');
  reopened.version = 'revision-2';
  await reopened.get('https://example.test/sprite.webp', 'sprite.webp');
  assert.equal(requests, 3);
});
test('catalog fallback restores the last known manifest when the network is unavailable', async () => {
  preferences.clear();
  preferences.set('atlas-storage-mode', 'all');
  const manifest = { maps: [{ id: 'one' }] };
  globalThis.fetch = async () => new Response(JSON.stringify(manifest));
  const cache = new AssetCache('test-catalog');
  await cache.catalog('https://example.test/manifest.json');
  globalThis.fetch = async () => {
    throw new Error('offline');
  };
  assert.deepEqual(await cache.catalog('https://example.test/manifest.json'), manifest);
});
async function zipFixture() {
  const zip = new JSZip();
  zip.file(
    'assets.json',
    JSON.stringify([
      { path: 'map.json', bytes: 2 },
      { path: '1/base.webp', bytes: 6 },
    ]),
  );
  zip.file('map.json', '{}');
  zip.file('1/base.webp', 'sprite');
  const blob = new Blob([await zip.generateAsync({ type: 'uint8array' })], { type: 'application/zip' });
  const maps = ['first', 'second'].map((id) => ({
    id,
    name: id,
    assets: `${id}/assets.json`,
    assetVersion: 'map-1',
    archive: { path: `${id}.zip`, bytes: blob.size },
  }));
  return { blob, manifest: { buildId: 'build-1', maps }, base: new URL('https://example.test/data/') };
}
test('offline warming saves whole ZIPs for maps that were never selected and never fetches single files', async () => {
  preferences.clear();
  preferences.set('atlas-storage-mode', 'all');
  const { blob, manifest, base } = await zipFixture(),
    requests = [];
  globalThis.fetch = async (url) => {
    requests.push(String(url));
    return new Response(blob);
  };
  let status = '';
  const cache = new AssetCache('test-all-maps', (value) => (status = value));
  cache.setManifest(manifest);
  await cache.warm(manifest, base);
  assert.deepEqual(
    requests.map((url) => new URL(url).pathname),
    ['/data/first.zip', '/data/second.zip'],
  );
  assert.ok(requests.every((url) => new URL(url).searchParams.get('v') === 'map-1'));
  assert.ok(status.startsWith('All 2 maps saved'));
  const stored = await cache.read('test-all-maps:map-1:second/1/base.webp');
  assert.equal(await stored.text(), 'sprite');
  await cache.warm(manifest, base);
  assert.equal(requests.length, 2);
  const unpackaged = { buildId: 'build-1', maps: [{ id: 'loose', assets: 'loose/assets.json' }] };
  cache.setManifest(unpackaged);
  await cache.warm(unpackaged, base);
  assert.equal(requests.length, 2, 'Maps without a ZIP are never downloaded file by file');
  assert.match(status, /no packaged map downloads/);
});
test('versioned URLs stamp map files but leave catalog files untouched', () => {
  const cache = new AssetCache('test-versions');
  cache.setManifest({ buildId: 'build-9', maps: [{ id: 'one', assetVersion: 'one-3' }] });
  assert.equal(
    cache.versioned(new URL('https://example.test/data/one/1/c-0-0.webp'), 'one/1/c-0-0.webp').href,
    'https://example.test/data/one/1/c-0-0.webp?v=one-3',
  );
  assert.equal(
    cache.versioned(new URL('https://example.test/data/manifest.json'), 'manifest.json').href,
    'https://example.test/data/manifest.json',
  );
});

test('first visit waits for a local choice and current-map mode replaces the old saved map', async () => {
  preferences.clear();
  const { blob, manifest, base } = await zipFixture(),
    requests = [];
  globalThis.fetch = async (url) => {
    requests.push(String(url));
    return new Response(blob);
  };
  const cache = new AssetCache('test-current-only');
  cache.setManifest(manifest);
  assert.equal(cache.mode, null);
  assert.equal(cache.enabled, false);
  await cache.warm(manifest, base);
  assert.deepEqual(requests, []);
  cache.setMode('current');
  cache.setCurrentMap('first');
  await cache.warm(manifest, base);
  assert.equal(requests.length, 1);
  assert.ok(requests.every((url) => url.includes('/first.zip')));
  const firstKey = 'test-current-only:map-1:first/1/base.webp';
  assert.ok(await cache.read(firstKey));
  const reopened = new AssetCache('test-current-only');
  assert.equal(reopened.mode, 'current');
  assert.equal(reopened.currentMap, 'first');
  cache.setCurrentMap('second');
  await cache.warm(manifest, base);
  assert.equal(await cache.read(firstKey), null);
  assert.ok(await cache.read('test-current-only:map-1:second/1/base.webp'));
  cache.setMode('none');
  await cache.warm(manifest, base);
  assert.equal(await cache.read('test-current-only:map-1:second/1/base.webp'), null);
});

test('switching all-map mode to current-only prunes other maps and old export revisions', async () => {
  preferences.clear();
  const cache = new AssetCache('test-prune');
  cache.setMode('all');
  cache.version = 'old';
  globalThis.fetch = async () => new Response('sprite');
  await cache.get('https://example.test/old', 'first/old.webp');
  cache.version = 'new';
  await cache.get('https://example.test/first', 'first/base.webp');
  await cache.get('https://example.test/second', 'second/base.webp');
  cache.setMode('current');
  cache.setCurrentMap('second');
  await cache.prune();
  assert.equal(await cache.read('test-prune:old:first/old.webp'), null);
  assert.equal(await cache.read('test-prune:new:first/base.webp'), null);
  assert.ok(await cache.read('test-prune:new:second/base.webp'));
});

test('switching storage modes discards both in-flight downloads and buffered writes from other maps', async () => {
  preferences.clear();
  const cache = new AssetCache('test-storage-race');
  cache.setMode('all');
  cache.version = 'revision';
  let finish;
  globalThis.fetch = () => new Promise((resolve) => (finish = resolve));
  const pending = cache.get('https://example.test/first', 'first/late.webp', 'low');
  while (!finish) await new Promise((resolve) => setTimeout(resolve, 0));
  cache.setMode('current');
  cache.setCurrentMap('second');
  finish(new Response('sprite'));
  await pending;
  await cache.flushWrites();
  assert.equal(await cache.read('test-storage-race:revision:first/late.webp'), null);
  cache.setMode('all');
  globalThis.fetch = async () => new Response('buffered sprite');
  await cache.get('https://example.test/buffered', 'first/buffered.webp', 'low');
  cache.setMode('none');
  await cache.prune();
  await cache.flushWrites();
  assert.equal(await cache.read('test-storage-race:revision:first/buffered.webp'), null);
});
test('an incremental release retains cached images for maps that were reused', async () => {
  preferences.clear();
  const cache = new AssetCache('test-map-versions');
  cache.setMode('all');
  let requests = 0;
  globalThis.fetch = async () => {
    requests++;
    return new Response('sprite');
  };
  cache.setManifest({
    buildId: 'build-1',
    maps: [
      { id: 'one', assetVersion: 'one-1' },
      { id: 'two', assetVersion: 'two-1' },
    ],
  });
  await cache.get('https://example.test/one', 'one/base.webp');
  await cache.get('https://example.test/two', 'two/base.webp');
  cache.setManifest({
    buildId: 'build-2',
    maps: [
      { id: 'one', assetVersion: 'one-2' },
      { id: 'two', assetVersion: 'two-1' },
    ],
  });
  await cache.prune();
  await cache.get('https://example.test/two', 'two/base.webp');
  assert.equal(requests, 2);
  await cache.get('https://example.test/one', 'one/base.webp');
  assert.equal(requests, 3);
  assert.equal(await cache.read('test-map-versions:one-1:one/base.webp'), null);
});

test('ZIP warming downloads once per map, removes completed ZIPs and reopens without asset requests', async () => {
  preferences.clear();
  preferences.set('atlas-storage-mode', 'all');
  const { blob, manifest, base } = await zipFixture(),
    requests = [];
  globalThis.fetch = async (url) => {
    requests.push(String(url));
    return new Response(blob);
  };
  const cache = new AssetCache('test-zip-all');
  cache.setManifest(manifest);
  await cache.warm(manifest, base);
  assert.deepEqual(
    requests.map((url) => new URL(url).pathname),
    ['/data/first.zip', '/data/second.zip'],
  );
  assert.equal(await cache.archiveRecord('test-zip-all:map-1:first/archive.zip'), undefined);
  const reopened = new AssetCache('test-zip-all');
  reopened.setManifest(manifest);
  await reopened.warm(manifest, base);
  assert.equal(requests.length, 2);
  assert.equal(
    await (await reopened.get(new URL('second/1/base.webp', base), 'second/1/base.webp')).text(),
    'sprite',
  );
  assert.equal(requests.length, 2);
  // An evicted extracted asset downloads the map ZIP again, then removes it.
  const db = await reopened.database;
  await new Promise((resolve) => {
    const tx = db.transaction('assets', 'readwrite');
    tx.objectStore('assets').delete('test-zip-all:map-1:second/1/base.webp');
    tx.oncomplete = resolve;
  });
  reopened.keys.delete('test-zip-all:map-1:second/1/base.webp');
  await reopened.warm(manifest, base);
  assert.ok(await reopened.read('test-zip-all:map-1:second/1/base.webp'));
  assert.equal(requests.length, 3);
  assert.equal(await reopened.archiveRecord('test-zip-all:map-1:second/archive.zip'), undefined);
  reopened.setMode('current');
  reopened.setCurrentMap('second');
  await reopened.warm(manifest, base);
  assert.equal(await reopened.archiveRecord('test-zip-all:map-1:first/archive.zip'), undefined);
  assert.equal(await reopened.read('test-zip-all:map-1:first/map.json'), null);
  reopened.setMode('none');
  await reopened.warm(manifest, base);
  assert.equal(await reopened.archiveRecord('test-zip-all:map-1:second/archive.zip'), undefined);
});
test('interrupted ZIP extraction resumes from IndexedDB and a cancelled download cannot save an unwanted map', async () => {
  preferences.clear();
  preferences.set('atlas-storage-mode', 'current');
  const { blob, manifest, base } = await zipFixture();
  let requests = 0;
  globalThis.fetch = async () => {
    requests++;
    return new Response(blob);
  };
  const cache = new AssetCache('test-zip-resume');
  cache.setManifest(manifest);
  cache.setCurrentMap('first');
  const unpack = cache.unpack;
  cache.unpack = async () => {
    throw new DOMException('Interrupted', 'AbortError');
  };
  await cache.warm(manifest, base);
  assert.equal((await cache.archiveRecord('test-zip-resume:map-1:first/archive.zip')).complete, false);
  cache.unpack = unpack;
  await cache.warm(manifest, base);
  assert.equal(requests, 1);
  assert.equal(await cache.archiveRecord('test-zip-resume:map-1:first/archive.zip'), undefined);
  let finish;
  globalThis.fetch = () => new Promise((resolve) => (finish = resolve));
  cache.setCurrentMap('second');
  const pending = cache.warm(manifest, base);
  while (!finish) await new Promise((resolve) => setTimeout(resolve, 0));
  cache.setMode('none');
  finish(new Response(blob));
  await pending;
  await cache.warm(manifest, base);
  assert.equal(await cache.archiveRecord('test-zip-resume:map-1:second/archive.zip'), undefined);
  assert.equal(await cache.read('test-zip-resume:map-1:second/map.json'), null);
});
test('the current map is downloaded and fully extracted before another map ZIP starts', async () => {
  preferences.clear();
  preferences.set('atlas-storage-mode', 'all');
  const { blob, manifest, base } = await zipFixture(),
    events = [],
    activity = [];
  const cache = new AssetCache(
    'test-zip-priority',
    () => {},
    (active, info) => activity.push({ active, ready: !!info?.currentReady }),
  );
  cache.setManifest(manifest);
  cache.setCurrentMap('second');
  globalThis.fetch = async (url) => {
    events.push(String(url));
    if (String(url).endsWith('first.zip')) {
      assert.ok(await cache.read('test-zip-priority:map-1:second/1/base.webp'));
      assert.equal(await cache.archiveRecord('test-zip-priority:map-1:second/archive.zip'), undefined);
    }
    return new Response(blob);
  };
  await cache.warm(manifest, base);
  assert.deepEqual(
    events.map((url) => new URL(url).pathname),
    ['/data/second.zip', '/data/first.zip'],
  );
  assert.equal(activity[0].active, true);
  assert.equal(activity.at(-1).active, false);
  assert.ok(activity.slice(0, -1).every((state) => state.active));
  assert.ok(
    activity.some((state) => state.active && state.ready),
    'Current-ready status keeps the indicator visible while other maps are prepared',
  );
});
test('cache status reports each activity, step progress and monotonic overall remaining work', async () => {
  preferences.clear();
  preferences.set('atlas-storage-mode', 'all');
  const { blob, manifest, base } = await zipFixture(),
    progress = [];
  const cache = new AssetCache('test-cache-progress', (message, info) => {
    if (info) progress.push({ message, ...info });
  });
  cache.setManifest(manifest);
  cache.setCurrentMap('first');
  globalThis.fetch = async () => new Response(blob);
  await cache.warm(manifest, base);
  assert.ok(progress.some((step) => step.activity === 'download' && step.stepPercent === 0));
  assert.ok(progress.some((step) => step.activity === 'extract' && step.stepPercent === 100));
  assert.ok(
    progress.some(
      (step) => step.activity === 'download' && step.completedMaps === 1 && step.remainingMaps === 1,
    ),
  );
  assert.ok(
    progress.every(
      (step, index) =>
        step.stepPercent >= 0 &&
        step.stepPercent <= 100 &&
        step.overallPercent >= 0 &&
        step.overallPercent <= 100 &&
        (!index || step.overallPercent >= progress[index - 1].overallPercent),
    ),
  );
  assert.equal(progress.at(-1).overallPercent, 100);
  assert.equal(progress.at(-1).remainingMaps, 0);
  assert.equal(progress.at(-1).remainingSeconds, 0);
  const reopened = [];
  cache.onStatus = (message, info) => {
    if (info) reopened.push(info);
  };
  globalThis.fetch = async () => {
    throw Error('Saved maps must not download again');
  };
  await cache.warm(manifest, base);
  assert.ok(reopened.every((step) => step.activity === 'check' || step.activity === 'complete'));
  assert.equal(reopened.at(-1).remainingMaps, 0);
  assert.equal(reopened.at(-1).overallPercent, 100);
});
