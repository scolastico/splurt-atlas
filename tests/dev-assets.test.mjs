import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'vite';
import { devAssets, validateDataset } from '../scripts/dev-assets.mjs';

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'atlas-dev-'));
  const data = path.join(root, 'public/data'),
    folder = path.join(data, 'snapshots/current/station');
  await mkdir(folder, { recursive: true });
  await mkdir(path.join(root, '.cache'), { recursive: true });
  await writeFile(path.join(root, 'index.html'), '<html><head></head><body>VIEWER</body></html>');
  await writeFile(path.join(folder, 'map.json'), '{}');
  await writeFile(path.join(folder, 'assets.json'), JSON.stringify([{ path: 'map.json', bytes: 2 }]));
  const catalog = {
    dataPath: 'snapshots/current',
    maps: [{ id: 'station', name: 'Station', assets: 'station/assets.json' }],
  };
  await writeFile(path.join(data, 'manifest.json'), JSON.stringify(catalog));
  // Broken old snapshots must have no effect on validation or startup.
  await mkdir(path.join(data, 'snapshots/retired'), { recursive: true });
  await writeFile(path.join(data, 'snapshots/retired/manifest.json'), 'INVALID');
  return { root, data, folder, catalog };
}
async function until(url, phase) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const state = await (await fetch(url + '/__atlas_dev/status')).json();
    if (state.phase === phase) return state;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Never reached ${phase}`);
}

test('dev validation checks the selected snapshot and rejects incomplete or escaping files', async () => {
  const f = await fixture();
  try {
    let progress;
    await validateDataset(f.root, (message, percent) => {
      progress = percent;
    });
    assert.equal(progress, 100);
    await writeFile(path.join(f.folder, 'map.json'), 'TRUNCATED');
    await assert.rejects(validateDataset(f.root), /Incomplete asset/);
    await writeFile(
      path.join(f.folder, 'assets.json'),
      JSON.stringify([{ path: '../../outside', bytes: 0 }]),
    );
    await assert.rejects(validateDataset(f.root), /Invalid asset path/);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('dev requests show progress during export and recover without serving HTML as data', async () => {
  const f = await fixture();
  let server;
  try {
    const progress = path.join(f.root, '.cache/export-progress.json');
    await writeFile(
      progress,
      JSON.stringify({
        pid: process.pid,
        phase: 'preparing',
        percent: 42,
        message: 'Station: deck 1, pipes, chunk 7/20',
      }),
    );
    server = await createServer({
      root: f.root,
      configFile: false,
      publicDir: false,
      plugins: [devAssets({ generationFactory: () => null })],
      server: { host: '127.0.0.1', port: 0, watch: null },
      optimizeDeps: { noDiscovery: true, include: [] },
      logLevel: 'silent',
    });
    await server.listen();
    const url = `http://127.0.0.1:${server.httpServer.address().port}`;
    assert.equal((await until(url, 'preparing')).percent, 42);
    assert.match(await (await fetch(url)).text(), /Preparing Station Atlas/);
    const unavailable = await fetch(url + '/data/manifest.json');
    assert.equal(unavailable.status, 503);
    assert.match(unavailable.headers.get('content-type'), /json/);
    assert.equal((await unavailable.json()).percent, 42);
    await writeFile(progress, JSON.stringify({ pid: process.pid, phase: 'ready' }));
    await until(url, 'ready');
    const html = await (await fetch(url)).text();
    assert.match(html, /VIEWER/);
    assert.match(html, /__atlas_dev\/status/);
    const asset = await fetch(url + '/data/snapshots/current/station/map.json');
    assert.equal(await asset.text(), '{}');
    const cached = await fetch(url + '/data/snapshots/current/station/map.json', {
      headers: { 'If-None-Match': asset.headers.get('etag') },
    });
    assert.equal(cached.status, 304);
    const missing = await fetch(url + '/data/missing.json');
    assert.equal(missing.status, 404);
    assert.match(missing.headers.get('content-type'), /json/);
    // A real catalog change must revalidate, show an error, then recover.
    f.catalog.maps[0].assets = 'station/missing.json';
    await writeFile(path.join(f.data, 'manifest.json'), JSON.stringify(f.catalog));
    await until(url, 'error');
    assert.match(await (await fetch(url)).text(), /Preparing Station Atlas/);
    f.catalog.maps[0].assets = 'station/assets.json';
    await writeFile(path.join(f.data, 'manifest.json'), JSON.stringify(f.catalog));
    await until(url, 'ready');
  } finally {
    await server?.close();
    await rm(f.root, { recursive: true, force: true });
  }
});
test('a missing known asset triggers repair while an unknown URL remains a plain 404', async () => {
  const f = await fixture();
  let server,
    repairs = 0;
  const generator = {
    status: null,
    tick: async () => {},
    close: async () => {},
    invalidate() {
      repairs++;
      this.status = { phase: 'preparing', percent: 0, message: 'Repairing missing assets' };
    },
  };
  try {
    server = await createServer({
      root: f.root,
      configFile: false,
      publicDir: false,
      plugins: [devAssets({ generationFactory: () => generator })],
      server: { host: '127.0.0.1', port: 0, watch: null },
      optimizeDeps: { noDiscovery: true, include: [] },
      logLevel: 'silent',
    });
    await server.listen();
    const url = `http://127.0.0.1:${server.httpServer.address().port}`;
    await until(url, 'ready');
    assert.equal((await fetch(url + '/data/unknown.json')).status, 404);
    assert.equal(repairs, 0);
    await rm(path.join(f.folder, 'map.json'));
    const missing = await fetch(url + '/data/snapshots/current/station/map.json');
    assert.equal(missing.status, 503);
    assert.equal((await missing.json()).phase, 'preparing');
    assert.equal(repairs, 1);
    assert.match(await (await fetch(url)).text(), /Preparing Station Atlas/);
  } finally {
    await server?.close();
    await rm(f.root, { recursive: true, force: true });
  }
});
