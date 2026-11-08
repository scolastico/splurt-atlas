import test from 'node:test';
import assert from 'node:assert/strict';
import { indexedDB } from 'fake-indexeddb';
import { AssetCache } from '../src/data/asset-cache.ts';
import { clearAtlasPreferences } from '../src/model/local-data.ts';

globalThis.indexedDB = indexedDB;

test('reset removes app settings while preserving unrelated storage keys', () => {
  const entries = new Map([
    ['atlas-storage-mode', 'all'],
    ['atlas-infrastructure-order', '[]'],
    ['atlas-sidebar-width', '400'],
    ['other-app', 'keep'],
  ]);
  const storage = {
    get length() {
      return entries.size;
    },
    key: (index) => [...entries.keys()][index],
    removeItem: (key) => entries.delete(key),
  };
  clearAtlasPreferences(storage);
  assert.deepEqual([...entries], [['other-app', 'keep']]);
});

test('reset cancels buffered writes and deletes both assets and archived ZIPs', async () => {
  const cache = new AssetCache('reset-test');
  cache.mode = 'all';
  cache.version = 'v1';
  await cache.write('reset-test:v1:one.webp', new Blob(['map']));
  const db = await cache.database;
  await new Promise((resolve, reject) => {
    const transaction = db.transaction('archives', 'readwrite');
    transaction
      .objectStore('archives')
      .put({ key: 'reset-test:v1:one.zip', blob: new Blob(['zip']), complete: true });
    transaction.oncomplete = resolve;
    transaction.onerror = reject;
  });
  cache.queueWrite('reset-test:v1:buffered.webp', new Blob(['pending']));
  await cache.deleteAll();
  assert.equal(cache.enabled, false);
  assert.equal(cache.buffer.size, 0);
  assert.equal(cache.writeTimer, 0);
  const reopened = new AssetCache('reset-test');
  const empty = await reopened.database;
  for (const store of ['assets', 'archives']) {
    const count = await new Promise((resolve) => {
      const request = empty.transaction(store).objectStore(store).count();
      request.onsuccess = () => resolve(request.result);
    });
    assert.equal(count, 0);
  }
  empty.close();
});
