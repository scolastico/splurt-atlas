// The Vite development plugin: serves the exported map data, generates it on a
// cold start, keeps serving the published snapshot while a background
// regeneration runs, and hosts the dev tools panel and its small API.
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_DEV_MAPS,
  checkUpstream,
  pullUpstream,
  readUpstreamCheck,
  upstreamStations,
  deleteSnapshot,
  devMaps,
  listSnapshots,
  localGenerator,
  readDevSettings,
  readStamp,
  writeDevSettings,
} from './dev-generation.mjs';

const types = {
  '.json': 'application/json',
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.zip': 'application/zip',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain',
  '.ico': 'image/x-icon',
};
const inside = (parent, child) => child === parent || child.startsWith(parent + path.sep);
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const DEVTOOLS_CLIENT = fileURLToPath(new URL('./devtools-client.js', import.meta.url));
/** The station list is re-read from the checkout at most this often. */
const STATIONS_CACHE_MS = 10000;
/** The upstream repository is checked for new commits about once a day. */
const UPSTREAM_CHECK_MS = 24 * 60 * 60 * 1000;

/** The page shown while no usable dataset exists yet (cold start or a broken export). */
export function loadingPage() {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Preparing Station Atlas</title>
<style>:root{color-scheme:dark;font-family:system-ui;font-size:100%;background:#0b1420;color:#e3eef7}body{margin:0;min-height:100vh;display:grid;place-items:center}main{width:min(34rem,85vw)}small{color:#7ddfc6}h1{font-size:1.75rem}p{font-size:1rem;line-height:1.6;color:#b6c8da}progress{width:100%;accent-color:#7ddfc6;height:1rem}#detail{min-height:3rem}code{color:#7ddfc6}button{font:inherit;padding:.5rem 1rem;border-radius:.4rem;border:1px solid #4f5e6b;background:#16222f;color:inherit;cursor:pointer}</style>
<main><small>LOCAL DEVELOPMENT</small><h1>Preparing Station Atlas</h1><p id="detail" role="status">Checking the exported map assets...</p><progress aria-label="Asset preparation" max="100"></progress><p id="count"></p><p>The viewer opens automatically when the assets are ready. Later changes to the generator or the upstream checkout are only reported in the dev tools; regeneration then runs in the background while the viewer stays usable.</p><button id="retry" hidden>Retry preparation</button></main>
<script type="module">const detail=document.querySelector('#detail'),bar=document.querySelector('progress'),count=document.querySelector('#count'),retry=document.querySelector('#retry');retry.onclick=async()=>{retry.hidden=true;await fetch('/__atlas_dev/retry',{method:'POST'})};async function poll(){try{const r=await fetch('/__atlas_dev/status',{cache:'no-store'});if(!r.ok)throw Error('Status unavailable');const s=await r.json();if(s.phase==='ready'){location.reload();return}detail.textContent=s.message;bar.value=s.percent||0;retry.hidden=s.phase!=='error';count.textContent=s.phase==='error'?'Fix the error or retry preparation.':Math.floor(s.percent||0)+'%';}catch{detail.textContent='Waiting for the development server to reconnect...'}setTimeout(poll,700)}poll();</script></html>`;
}

// Check only the catalog's selected snapshot, never old snapshots or scratch dirs.
export async function validateDataset(root, report = () => {}) {
  const data = path.join(root, 'public/data');
  const files = new Set([path.join(data, 'manifest.json')]);
  const manifest = JSON.parse(await readFile(path.join(data, 'manifest.json'), 'utf8'));
  const selected = path.resolve(data, manifest.dataPath || '.');
  if (!inside(data, selected) || !manifest.maps?.length) throw new Error('Invalid or empty map catalog');
  let complete = 0;
  for (const map of manifest.maps) {
    if (!/^[a-z0-9_-]+$/i.test(map.id)) throw new Error('Invalid map ID');
    const folder = path.join(selected, map.id),
      inventory = path.resolve(selected, map.assets);
    if (!inside(folder, inventory)) throw new Error('Invalid asset inventory path');
    files.add(inventory);
    const assets = JSON.parse(await readFile(inventory, 'utf8'));
    if (!assets.length) throw new Error(`Empty asset inventory for ${map.name}`);
    let cursor = 0,
      checked = 0;
    await Promise.all(
      Array.from({ length: Math.min(32, assets.length) }, async () => {
        while (cursor < assets.length) {
          const asset = assets[cursor++],
            file = path.resolve(folder, asset.path);
          if (!inside(folder, file)) throw new Error('Invalid asset path');
          const info = await stat(file);
          if (!info.isFile() || info.size !== asset.bytes)
            throw new Error(`Incomplete asset: ${map.id}/${asset.path}`);
          files.add(file);
          checked++;
          if (checked % 256 === 0)
            report(
              `Checking ${map.name}: ${checked} / ${assets.length} files`,
              (100 * (complete + checked / assets.length)) / manifest.maps.length,
            );
        }
      }),
    );
    if (map.archive) {
      const archive = path.resolve(selected, map.archive.path);
      if (!inside(selected, archive) || (await stat(archive)).size !== map.archive.bytes)
        throw new Error(`Incomplete ZIP for ${map.name}. Run pnpm package:maps.`);
      files.add(archive);
    }
    complete++;
    report(
      `Checked ${map.name} (${complete}/${manifest.maps.length})`,
      (100 * complete) / manifest.maps.length,
    );
  }
  return files;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 65536) reject(new Error('Request too large'));
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}

export function devAssets({ generationFactory = localGenerator } = {}) {
  let generation;
  return {
    name: 'atlas-dev-assets',
    apply: 'serve',
    configureServer(server) {
      const root = server.config.root,
        publicRoot = path.join(root, 'public');
      generation = generationFactory(root);
      let expectedFiles = new Set();
      /** True once a complete dataset was validated; it keeps being served during regeneration. */
      let serving = false;
      let state = { phase: 'checking', percent: 0, message: 'Checking exported map assets' },
        signature,
        checking = false,
        externalExport = null,
        retryAfter = 0;
      let stationsCache = { time: 0, stations: { stations: [], omitted: [] } };
      let upstream = null;
      let upstreamBusy = null;
      const refreshUpstream = async (force = false) => {
        if (upstreamBusy) return upstreamBusy;
        if (!upstream) upstream = await readUpstreamCheck(root);
        if (!force && upstream && Date.now() - upstream.checked < UPSTREAM_CHECK_MS) return upstream;
        upstreamBusy = checkUpstream(root)
          .then((result) => (upstream = result))
          .finally(() => (upstreamBusy = null));
        return upstreamBusy;
      };
      void refreshUpstream();
      const upstreamTimer = setInterval(() => void refreshUpstream(), 60 * 60 * 1000);
      upstreamTimer.unref();

      const refresh = async () => {
        if (checking) return;
        checking = true;
        try {
          // An export started outside this server (pnpm export) is reported but not interfered with.
          let progress;
          try {
            progress = JSON.parse(await readFile(path.join(root, '.cache/export-progress.json'), 'utf8'));
          } catch {}
          externalExport =
            progress?.phase === 'preparing' && alive(progress.pid) && !generation?.active ? progress : null;
          if (externalExport && !serving) {
            state = progress;
            return;
          }
          await generation?.tick();
          if (generation?.status) {
            state = generation.status;
            if (!serving) return;
          }
          const info = await stat(path.join(publicRoot, 'data/manifest.json'));
          const next = `${info.mtimeMs}:${info.size}`;
          if (signature === next && state.phase === 'error' && Date.now() < retryAfter) return;
          if (signature === next && (serving || state.phase === 'ready')) return;
          signature = next;
          if (!serving) state = { phase: 'checking', percent: 0, message: 'Checking exported map assets' };
          expectedFiles = await validateDataset(root, (message, percent) => {
            if (!serving) state = { phase: 'checking', message, percent };
          });
          signature = next;
          serving = true;
          state = { phase: 'ready', percent: 100, message: 'Assets ready' };
        } catch (error) {
          // Retry incomplete files without continuously rescanning a large map.
          retryAfter = Date.now() + 10000;
          serving = false;
          generation?.invalidate();
          state = {
            phase: generation ? 'preparing' : 'error',
            percent: 0,
            message: `Map assets are not ready: ${error.message}. ${generation ? 'Preparing a fresh export automatically...' : 'Check the exported dataset.'}`,
          };
        } finally {
          checking = false;
        }
      };
      void refresh();
      const timer = setInterval(refresh, 1000);
      timer.unref();
      server.httpServer?.once('close', () => {
        clearInterval(timer);
        clearInterval(upstreamTimer);
        void generation?.close?.();
      });

      const stations = async () => {
        if (Date.now() - stationsCache.time > STATIONS_CACHE_MS)
          stationsCache = { time: Date.now(), stations: await upstreamStations(root) };
        return stationsCache.stations;
      };

      /** Everything the dev tools panel shows, in one poll. */
      const devStatus = async () => {
        let manifest = null;
        try {
          manifest = JSON.parse(await readFile(path.join(publicRoot, 'data/manifest.json'), 'utf8'));
        } catch {}
        const stamp = await readStamp(root);
        const settings = await readDevSettings(root);
        let selected = null;
        try {
          selected = devMaps(process.env, settings);
        } catch {}
        return {
          ...(serving ? { phase: 'ready', percent: 100, message: 'Assets ready' } : state),
          serving,
          dataset: manifest
            ? {
                buildId: manifest.buildId,
                commit: manifest.commit,
                snapshot: manifest.dataPath?.replace(/^snapshots\/|\/$/g, '') || null,
                maps: (manifest.maps || []).map((map) => ({ id: map.id, name: map.name })),
                generated: stamp?.generated || null,
              }
            : null,
          generation: generation
            ? {
                mode: generation.mode,
                active: !!generation.active,
                stale: generation.stale,
                job: generation.job,
                log: generation.log,
              }
            : null,
          external: externalExport
            ? { message: externalExport.message, percent: externalExport.percent }
            : null,
          maps: {
            selected,
            saved: settings.maps !== undefined,
            environment: process.env.ATLAS_DEV_MAPS ?? null,
            defaults: DEFAULT_DEV_MAPS,
            available: (await stations()).stations,
            omitted: (await stations()).omitted,
          },
          upstream,
        };
      };

      const routes = {
        'GET /__atlas_dev/status': async (req, res) => sendJson(res, 200, await devStatus()),
        'POST /__atlas_dev/retry': async (req, res) => {
          generation?.invalidate();
          res.writeHead(204).end();
          void refresh();
        },
        'POST /__atlas_dev/generate': async (req, res) => {
          const body = await readBody(req);
          const started = (await generation?.request?.({ full: !!body.full })) ?? false;
          sendJson(res, started ? 202 : 409, { started });
        },
        'POST /__atlas_dev/cancel': async (req, res) =>
          sendJson(res, 200, { cancelled: generation?.cancel?.() ?? false }),
        'POST /__atlas_dev/maps': async (req, res) => {
          const body = await readBody(req);
          let maps = null;
          if (body.maps !== null) {
            if (!Array.isArray(body.maps)) throw new Error('maps must be an array or null');
            const known = new Set((await stations()).stations.map((station) => station.id));
            maps = [...new Set(body.maps.map(String))];
            for (const id of maps) if (!known.has(id)) throw new Error(`Unknown map: ${id}`);
          }
          await writeDevSettings(root, { ...(await readDevSettings(root)), maps });
          stationsCache.time = 0;
          sendJson(res, 200, { maps });
        },
        'POST /__atlas_dev/upstream/check': async (req, res) =>
          sendJson(res, 200, await refreshUpstream(true)),
        'POST /__atlas_dev/upstream/pull': async (req, res) => {
          if (upstreamBusy) await upstreamBusy;
          upstream = await pullUpstream(root);
          sendJson(res, 200, upstream);
        },
        'GET /__atlas_dev/snapshots': async (req, res) => sendJson(res, 200, await listSnapshots(root)),
        'POST /__atlas_dev/snapshots/delete': async (req, res) => {
          const body = await readBody(req);
          await deleteSnapshot(root, String(body.id || ''));
          sendJson(res, 200, { deleted: body.id });
        },
        'GET /__atlas_dev/devtools.js': async (req, res) => {
          res.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-store' });
          res.end(await readFile(DEVTOOLS_CLIENT));
        },
      };

      server.middlewares.use(async (req, res, next) => {
        let pathname, versioned;
        try {
          const url = new URL(req.url, 'http://localhost');
          pathname = decodeURIComponent(url.pathname);
          versioned = url.searchParams.has('v');
        } catch {
          res.writeHead(400).end();
          return;
        }
        if (pathname.startsWith('/__atlas_dev/')) {
          const route = routes[`${req.method} ${pathname}`];
          if (!route) {
            res.writeHead(routes[`GET ${pathname}`] || routes[`POST ${pathname}`] ? 405 : 404).end();
            return;
          }
          try {
            await route(req, res);
          } catch (error) {
            sendJson(res, 400, { error: error.message });
          }
          return;
        }
        const document = pathname === '/' || pathname === '/index.html';
        if (document && !serving) {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
          res.end(loadingPage());
          return;
        }
        const dataRequest = pathname.startsWith('/data/');
        if (dataRequest && !serving) {
          res.writeHead(503, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
            'Retry-After': '1',
          });
          res.end(JSON.stringify(state));
          return;
        }
        const file = path.resolve(publicRoot, '.' + pathname);
        if (!inside(publicRoot, file)) {
          res.writeHead(403).end();
          return;
        }
        try {
          const info = await stat(file);
          if (!info.isFile()) {
            if (dataRequest) {
              res.writeHead(404).end();
              return;
            }
            next();
            return;
          }
          const etag = `W/"${info.size}-${info.mtimeMs}"`;
          res.setHeader('Content-Type', types[path.extname(file)] || 'application/octet-stream');
          // Version-stamped map files never change under the same query string.
          res.setHeader(
            'Cache-Control',
            dataRequest && versioned ? 'public, max-age=31536000, immutable' : 'no-cache',
          );
          res.setHeader('ETag', etag);
          if (req.headers['if-none-match'] === etag) {
            res.writeHead(304).end();
            return;
          }
          res.setHeader('Content-Length', info.size);
          if (req.method === 'HEAD') {
            res.end();
            return;
          }
          const stream = createReadStream(file);
          stream.on('error', () => res.destroy());
          res.on('close', () => stream.destroy());
          stream.pipe(res);
        } catch {
          if (dataRequest) {
            const repair = !!generation && expectedFiles.has(file);
            if (repair) {
              generation.invalidate();
              signature = undefined;
              serving = false;
              state = {
                phase: 'preparing',
                percent: 0,
                message: 'A generated asset is missing. Repairing the export...',
              };
              void refresh();
            }
            res.writeHead(repair ? 503 : 404, {
              'Content-Type': 'application/json',
              'Cache-Control': 'no-store',
            });
            res.end(JSON.stringify(repair ? state : { error: 'Map asset not found', path: pathname }));
          } else next();
        }
      });
    },
    async closeBundle() {
      await generation?.close?.();
    },
    // The dev tools panel is injected into the page; it polls the status route.
    transformIndexHtml: {
      order: 'pre',
      handler() {
        return [
          {
            tag: 'script',
            injectTo: 'body',
            attrs: { src: '/__atlas_dev/devtools.js', 'data-status': '/__atlas_dev/status' },
          },
        ];
      },
    },
  };
}
