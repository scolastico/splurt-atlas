import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { localGenerator } from './dev-generation.mjs';

const types = { '.json': 'application/json', '.webp': 'image/webp', '.png': 'image/png', '.zip': 'application/zip', '.svg': 'image/svg+xml', '.txt': 'text/plain', '.ico': 'image/x-icon' };
const inside = (parent, child) => child === parent || child.startsWith(parent + path.sep);
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

export function loadingPage() {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Preparing Station Atlas</title>
<style>:root{color-scheme:dark;font-family:system-ui;font-size:100%;background:#0b1420;color:#e3eef7}body{margin:0;min-height:100vh;display:grid;place-items:center}main{width:min(34rem,85vw)}small{color:#7ddfc6}h1{font-size:1.75rem}p{font-size:1rem;line-height:1.6;color:#b6c8da}progress{width:100%;accent-color:#7ddfc6;height:1rem}#detail{min-height:3rem}code{color:#7ddfc6}</style>
<main><small>LOCAL DEVELOPMENT</small><h1>Preparing Station Atlas</h1><p id="detail" role="status">Checking the exported map assets...</p><progress aria-label="Asset preparation" max="100"></progress><p id="count"></p><p>The viewer will open automatically when the assets are ready. Generator hashes and the local upstream commit are checked automatically. Unchanged exports are reused; UI edits do not regenerate maps.</p><button id="retry" hidden>Retry preparation</button></main>
<script type="module">const detail=document.querySelector('#detail'),bar=document.querySelector('progress'),count=document.querySelector('#count'),retry=document.querySelector('#retry');retry.onclick=async()=>{retry.hidden=true;await fetch('/__atlas_dev/retry',{method:'POST'})};async function poll(){try{const r=await fetch('/__atlas_dev/status',{cache:'no-store'});if(!r.ok)throw Error('Status unavailable');const s=await r.json();if(s.phase==='ready'){location.reload();return}detail.textContent=s.message;bar.value=s.percent||0;retry.hidden=s.phase!=='error';count.textContent=s.phase==='error'?'Fix the error or retry preparation. Input changes are detected automatically.':Math.floor(s.percent||0)+'%';}catch{detail.textContent='Waiting for the development server to reconnect...'}setTimeout(poll,700)}poll();</script></html>`;
}

// Check only the catalog's selected snapshot, never old snapshots or scratch dirs.
export async function validateDataset(root, report = () => {}) {
  const data = path.join(root, 'public/data');
  const files = new Set([path.join(data,'manifest.json')]);
  const manifest = JSON.parse(await readFile(path.join(data, 'manifest.json'), 'utf8'));
  const selected = path.resolve(data, manifest.dataPath || '.');
  if (!inside(data, selected) || !manifest.maps?.length) throw new Error('Invalid or empty map catalog');
  let complete = 0;
  for (const map of manifest.maps) {
    if (!/^[a-z0-9_-]+$/i.test(map.id)) throw new Error('Invalid map ID');
    const folder = path.join(selected, map.id), inventory = path.resolve(selected, map.assets);
    if (!inside(folder, inventory)) throw new Error('Invalid asset inventory path');
    files.add(inventory);
    const assets = JSON.parse(await readFile(inventory, 'utf8'));
    if (!assets.length) throw new Error(`Empty asset inventory for ${map.name}`);
    let cursor = 0, checked = 0;
    await Promise.all(Array.from({ length: Math.min(32, assets.length) }, async () => {
      while (cursor < assets.length) {
        const asset = assets[cursor++], file = path.resolve(folder, asset.path);
        if (!inside(folder, file)) throw new Error('Invalid asset path');
        const info = await stat(file);
        if (!info.isFile() || info.size !== asset.bytes) throw new Error(`Incomplete asset: ${map.id}/${asset.path}`);
        files.add(file);
        checked++;
        if (checked % 256 === 0) report(`Checking ${map.name}: ${checked} / ${assets.length} files`, 100 * (complete + checked / assets.length) / manifest.maps.length);
      }
    }));
    if (map.archive) {
      const archive = path.resolve(selected, map.archive.path);
      if (!inside(selected, archive) || (await stat(archive)).size !== map.archive.bytes) throw new Error(`Incomplete ZIP for ${map.name}. Run pnpm package:maps.`);
      files.add(archive);
    }
    complete++;
    report(`Checked ${map.name} (${complete}/${manifest.maps.length})`, 100 * complete / manifest.maps.length);
  }
  return files;
}

export function devAssets({ generationFactory = localGenerator } = {}) {
  let generation;
  return {
    name: 'atlas-dev-assets', apply: 'serve',
    configureServer(server) {
      const root = server.config.root, publicRoot = path.join(root, 'public');
      generation = generationFactory(root);
      let expectedFiles=new Set();
      let state = { phase: 'checking', percent: 0, message: 'Checking exported map assets' }, signature, checking = false, activeExport = false, retryAfter = 0;
      const refresh = async () => {
        if (checking) return;
        checking = true;
        try {
          let progress;
          try { progress = JSON.parse(await readFile(path.join(root, '.cache/export-progress.json'), 'utf8')); } catch {}
          if (progress?.phase === 'preparing' && alive(progress.pid) && !generation?.active) { activeExport = true; state = progress; return; }
          await generation?.tick();
          if (generation?.status) { state = generation.status; return; }
          const info = await stat(path.join(publicRoot, 'data/manifest.json'));
          const next = `${info.mtimeMs}:${info.size}`;
          if (signature === next && state.phase === 'error' && Date.now() < retryAfter && !activeExport) return;
          if (signature === next && state.phase === 'ready' && !activeExport) return;
          signature = next;
          activeExport = false;
          state = { phase: 'checking', percent: 0, message: 'Checking exported map assets' };
          expectedFiles=await validateDataset(root, (message, percent) => { state = { phase: 'checking', message, percent }; });
          signature = next;
          state = { phase: 'ready', percent: 100, message: 'Assets ready' };
        } catch (error) {
          // Retry incomplete files without continuously rescanning a large map.
          retryAfter = Date.now() + 10000;
          generation?.invalidate();
          state = { phase: generation ? 'preparing' : 'error', percent: 0, message: `Map assets are not ready: ${error.message}. ${generation ? 'Preparing a fresh export automatically...' : 'Check the exported dataset.'}` };
        } finally { checking = false; }
      };
      void refresh();
      const timer = setInterval(refresh, 1000); timer.unref();
      server.httpServer?.once('close', () => { clearInterval(timer); void generation?.close(); });
      server.middlewares.use(async (req, res, next) => {
        let pathname, versioned;
        try { const url = new URL(req.url, 'http://localhost'); pathname = decodeURIComponent(url.pathname); versioned = url.searchParams.has('v'); } catch { res.writeHead(400).end(); return; }
        if (pathname === '/__atlas_dev/retry') {
          if (req.method !== 'POST') { res.writeHead(405).end(); return; }
          generation?.invalidate(); res.writeHead(204).end(); void refresh(); return;
        }
        if (pathname === '/__atlas_dev/status') { res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(state)); return; }
        const document = pathname === '/' || pathname === '/index.html';
        if (document && state.phase !== 'ready') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(loadingPage()); return; }
        const dataRequest = pathname.startsWith('/data/');
        if (dataRequest && state.phase !== 'ready') {
          res.writeHead(503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Retry-After': '1' }); res.end(JSON.stringify(state)); return;
        }
        const file = path.resolve(publicRoot, '.' + pathname);
        if (!inside(publicRoot, file)) { res.writeHead(403).end(); return; }
        try {
          const info = await stat(file);
          if (!info.isFile()) { if (dataRequest) { res.writeHead(404).end(); return; } next(); return; }
          const etag = `W/"${info.size}-${info.mtimeMs}"`;
          res.setHeader('Content-Type', types[path.extname(file)] || 'application/octet-stream');
          // Version-stamped map files never change under the same query string.
          res.setHeader('Cache-Control', dataRequest && versioned ? 'public, max-age=31536000, immutable' : 'no-cache'); res.setHeader('ETag', etag);
          if (req.headers['if-none-match'] === etag) { res.writeHead(304).end(); return; }
          res.setHeader('Content-Length', info.size);
          if (req.method === 'HEAD') { res.end(); return; }
          const stream = createReadStream(file);
          stream.on('error', () => res.destroy()); res.on('close', () => stream.destroy()); stream.pipe(res);
        } catch {
          if (dataRequest) {
            const repair=!!generation&&expectedFiles.has(file);
            if(repair){generation.invalidate();signature=undefined;state={phase:'preparing',percent:0,message:'A generated asset is missing. Repairing the export...'};void refresh();}
            res.writeHead(repair?503:404, { 'Content-Type': 'application/json','Cache-Control':'no-store' });res.end(JSON.stringify(repair?state:{ error: 'Map asset not found', path: pathname }));
          }
          else next();
        }
      });
    },
    async closeBundle() { await generation?.close(); },
    transformIndexHtml: {
      order: 'pre',
      handler() {
        return [{ tag: 'script', injectTo: 'head-prepend', children: `setInterval(async()=>{try{const r=await fetch('/__atlas_dev/status',{cache:'no-store'});if(r.ok&&(await r.json()).phase!=='ready')location.reload()}catch{}},1500);` }];
      }
    }
  };
}
