import './style.css';
import { detailForZoom, deckScale, selectedTile, viewFragment, optionBits,encodeOptions,decodeOptions } from './view-state.js';
import { AssetCache } from './asset-cache.js';
import { indexDoorTiles, doorMarkersForRoles, roleSuggestions, groupDoorAccess } from './door-highlights.js';
import { UTILITIES, slotIndex, slotCount, hasChannel, stripName, decodeMap, decodeLevel } from '../scripts/lib/map-format.mjs';
import { createGlRenderer, create2dRenderer } from './gl-renderer.js';

const $ = id => document.getElementById(id);
if (import.meta.env.VITE_ATLAS_SOURCE_URL) { $('atlas-source').href = import.meta.env.VITE_ATLAS_SOURCE_URL; $('atlas-source').hidden = false; }
// Station imagery renders with WebGL (Canvas 2D fallback); annotations such as
// room boundaries and utility symbols draw on a separate 2D canvas above it.
const canvas = $('map'), renderer = createGlRenderer(canvas) || create2dRenderer(canvas);
const annotations = $('annotations'), ctx = annotations.getContext('2d');
let annotationsPainted = false;
const connectionsCanvas = $('connection-overlay'), connectionsContext = connectionsCanvas.getContext('2d');
let connectionsFrame = 0, lastConnectionsPaint = 0;
const space = $('space'), background = space.getContext('2d', { alpha: false });
const palette = { pipes: '#68c8b2', power: '#e5bd69', fluid:'#a798e5', disposal: '#ce8baf', transit: '#80addb' };
const networkNames = { pipes: 'Atmospherics', power: 'Power cables', fluid:'Fluid ducts', disposal: 'Waste disposal', transit: 'Transit tubes' };
const enabled = new Set(['transit']);
const base = new URL('./data/', document.baseURI);
let dataBase = base;
const cacheActivity=$('cache-activity');
cacheActivity.querySelector('small').id='cache-activity-note';
$('cache-activity-note').insertAdjacentHTML('beforebegin',`<p id="cache-activity-status"></p><div class="cache-progress-label"><span>Current step</span><span id="cache-step-percent"></span></div><progress id="cache-step-progress" max="100" aria-label="Current cache step"></progress><div class="cache-progress-label"><span>Overall</span><span id="cache-overall-percent"></span></div><progress id="cache-overall-progress" max="100" aria-label="Overall cache preparation"></progress><p id="cache-remaining"></p>`);
function updateCacheStatus(message,info){
  $('cache-status').textContent=$('cache-activity-status').textContent=message;
  for(const [kind,value]of [['step',info?.stepPercent],['overall',info?.overallPercent]]){const bar=$('cache-'+kind+'-progress');if(Number.isFinite(value)){bar.value=value;$('cache-'+kind+'-percent').textContent=value+'%';}else{bar.removeAttribute('value');$('cache-'+kind+'-percent').textContent='';}}
  if(info){const count=info.remainingMaps+' '+(info.remainingMaps===1?'map':'maps')+' left',remaining=(100-info.overallPercent)+'% remaining';let time='Estimating time remaining';if(Number.isFinite(info.remainingSeconds)){const seconds=Math.ceil(info.remainingSeconds),minutes=Math.floor(seconds/60);time='About '+(minutes?minutes+'m ':'')+(seconds%60)+'s remaining';}$('cache-remaining').textContent=remaining+' · '+count+' · '+time;}
  else $('cache-remaining').textContent='Calculating overall progress...';
}
const assetCache=new AssetCache(base.href,updateCacheStatus,(active,info)=>{cacheActivity.hidden=!active;if(active){cacheActivity.querySelector('strong').textContent=info?.currentReady?'Current map is ready':'Preparing offline cache';$('cache-activity-note').textContent=info?.currentReady?'Other maps are still being downloaded and prepared in the background.':'The map may be slower while saving. Unready chunks may look blurry or pixelated.';}});
$('storage-mode').value=assetCache.mode||'all';
$('cache-status').textContent=assetCache.enabled?'Preparing offline maps…':'Offline saving is off.';
const state = { manifest: null, map: null, levels: new Map(), z: 1, zoom: 1, x: 0, y: 0, w: 0, h: 0, dpr: 1, generation: 0, markers: [], selected: null, motion: true, cutaway: true, regions: false, hover: null, searchReady: false };
let worker, searchSeq = 0, timer, frame = 0, shareTimer, activeRequests = 0;
let finding = null, findingPage = 0, findingIndex = 0, locationSeq = 0, pulseStart = -Infinity;
let locationTarget = null;
let utilityPaths=new Map(),sidebarWidth=320,sheetHeight=innerHeight*.48;
let inspectorDetailHTML='';
let doorTiles=[],doorMarkers=[];
let suggestedRoles=[],suggestedRoleIndex=0;
let panelTransitionUntil=0;
const FINDINGS_PER_PAGE = 30;
const images = new Map(), queue = [], failures = new Set();
const CACHE_BYTES = 128 * 1024 * 1024, MAX_REQUESTS = 12;
let warmImages=new Set(),loadingStation=false,inspectedResult=null,tileSeq=0,tileCandidates=[],imageBytes=0,scaleText='';
let frameImages = new Set(), spaceFrame = 0, spaceTime = 0, lastSpaceTime = null, lastSpacePaint = 0;
const panDirection = { x: 0, y: 0 }, lastCamera = { x: NaN, y: NaN, zoom: NaN };
let prefetchImages = new Set();
const regionChunks=new Map(),areaColors=new Map();
const redraw = () => { if (!frame) frame = requestAnimationFrame(render); };
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const reduced = matchMedia('(prefers-reduced-motion: reduce)');
$('motion').checked = state.motion = !reduced.matches;
reduced.addEventListener('change', event => { state.motion = $('motion').checked = !event.matches; updateSpaceAnimation(); redraw(); });

function sidebarInset() { if(innerWidth<=650)return 0;const rect=$('sidebar').getBoundingClientRect();return Math.max(0,Math.min(rect.width,rect.right)); }
function screenCenterX() { return (state.w + sidebarInset()) / 2; }
function portraitPanel(){return matchMedia('(max-width:650px) and (orientation:portrait)').matches;}
function bottomSidebarInset(){if(!portraitPanel())return 0;const rect=$('sidebar').getBoundingClientRect();return Math.max(0,Math.min(rect.height,innerHeight-rect.top));}
function screenCenterY(){return (state.h-bottomSidebarInset())*.5;}
function sidebar(collapsed, persist = true) {
  const changed=document.body.classList.contains('sidebar-collapsed')!==collapsed;
  document.body.classList.toggle('sidebar-collapsed', collapsed);
  $('sidebar').inert = collapsed;
  $('sidebar-toggle').setAttribute('aria-expanded', String(!collapsed));
  $('sidebar-toggle').setAttribute('aria-label', collapsed ? 'Expand sidebar' : 'Collapse sidebar');
  $('sidebar-toggle').title = collapsed ? 'Expand sidebar' : 'Collapse sidebar';
  $('sidebar-toggle').textContent = portraitPanel()?(collapsed?'↑':'↓'):(collapsed?'›':'‹');
  if (persist) { if(changed&&!reduced.matches)panelTransitionUntil=performance.now()+260;redraw(); try { localStorage.setItem('atlas-sidebar-collapsed', String(collapsed)); } catch {} }
}
let initiallyCollapsed = matchMedia('(max-width:650px)').matches;
try { const saved = localStorage.getItem('atlas-sidebar-collapsed'); if (saved !== null) initiallyCollapsed = saved === 'true'; } catch {}
sidebar(initiallyCollapsed, false);
function sidebarView(view) {
  view=view===true?'inspect':view===false?'explore':view;
  for(const name of ['explore','search','inspect']){
    $(name==='inspect'?'selection-panel':`${name}-panel`).hidden=name!==view;
    $(`${name}-tab`).setAttribute('aria-pressed',String(name===view));
  }
  document.querySelector('.sidebar-scroll').scrollTop = 0;
}
function clearSelection() {
  state.result = null; state.finding = null; locationTarget = null; locationSeq++;
  finding = null; state.markers = []; $('search-findings').hidden = true;
  state.selected = null;state.offsetHighlights=new Set();$('inspect-tab').disabled = true; sidebarView(false); redraw(); share();
}
$('sidebar-toggle').onclick = () => sidebar(!document.body.classList.contains('sidebar-collapsed'));
$('explore-tab').onclick = () => sidebarView(false);
$('search-tab').onclick = () => sidebarView('search');
$('inspect-tab').onclick = () => { if (state.selected) sidebarView(true); };
try{sidebarWidth=Number(localStorage.getItem('atlas-sidebar-width'))||320;}catch{}
try{sheetHeight=Number(localStorage.getItem('atlas-sheet-height'))||sheetHeight;}catch{}
function applySidebarWidth(value,persist=false){const width=Math.round(Math.max(260,Math.min(value,720,innerWidth-40)));document.documentElement.style.setProperty('--sidebar-width',`${width}px`);$('sidebar-resize').setAttribute('aria-valuenow',width);if(persist){redraw();sidebarWidth=width;try{localStorage.setItem('atlas-sidebar-width',width);}catch{}}}
function applySheetHeight(value,persist=false){const height=Math.round(Math.max(220,Math.min(value,innerHeight-100)));document.documentElement.style.setProperty('--sheet-height',`${height}px`);if(portraitPanel())$('sidebar-resize').setAttribute('aria-valuenow',height);if(persist){sheetHeight=height;try{localStorage.setItem('atlas-sheet-height',height);}catch{}redraw();}}
function sizeSidebar(){applySidebarWidth(sidebarWidth);applySheetHeight(sheetHeight);$('sidebar-resize').setAttribute('aria-orientation',portraitPanel()?'horizontal':'vertical');$('sidebar-resize').setAttribute('aria-label',portraitPanel()?'Resize bottom panel':'Resize sidebar');sidebar(document.body.classList.contains('sidebar-collapsed'),false);redraw();}
sizeSidebar();window.addEventListener('resize',sizeSidebar);
$('sidebar-resize').onpointerdown=event=>{$('sidebar-resize').setPointerCapture(event.pointerId);document.body.classList.add('resizing');};
$('sidebar-resize').onpointermove=event=>{if($('sidebar-resize').hasPointerCapture(event.pointerId)){if(portraitPanel())applySheetHeight(innerHeight-event.clientY,true);else applySidebarWidth(event.clientX,true);}};
$('sidebar-resize').onpointerup=event=>{$('sidebar-resize').releasePointerCapture(event.pointerId);document.body.classList.remove('resizing');};
$('sidebar-resize').onpointercancel=()=>document.body.classList.remove('resizing');
$('sidebar-resize').onkeydown=event=>{const keys=portraitPanel()?['ArrowDown','ArrowUp']:['ArrowLeft','ArrowRight'];if(keys.includes(event.key)){event.preventDefault();event.stopPropagation();if(portraitPanel())applySheetHeight(sheetHeight+(event.key==='ArrowUp'?20:-20),true);else applySidebarWidth(sidebarWidth+(event.key==='ArrowRight'?20:-20),true);}};
$('sidebar-resize').ondblclick=()=>{if(portraitPanel())applySheetHeight(innerHeight*.48,true);else applySidebarWidth(320,true);};
$('storage-mode').onchange=event=>{assetCache.setMode(event.target.value);warmStorage();};
async function warmStorage(){
  if(!state.manifest)return;
  if(assetCache.enabled)await assetCache.write(`${assetCache.scope}:catalog`,new Blob([JSON.stringify(state.manifest)],{type:'application/json'}));
  if(assetCache.enabled&&!state.map){$('cache-status').textContent='Choose a map to start preparing offline maps.';return;}
  await assetCache.warm(state.manifest,dataBase);
}
function storageSize(bytes){return (bytes/1048576).toFixed(1)+' MB';}
function updateStorageSizes(){
  const maps=state.manifest.maps,current=maps.find(map=>map.id===assetCache.currentMap);
  const describe=(label,size)=>{
    const sizes=maps.map(size),range=storageSize(Math.min(...sizes))+' to '+storageSize(Math.max(...sizes));
    return{all:label+': '+storageSize(sizes.reduce((a,b)=>a+b,0)),current:label+': '+(current?storageSize(size(current))+' for '+current.name+'; ':'')+range+' depending on the map'};
  };
  const downloadSize=describe('Download size',map=>map.archive?.bytes||map.bytes||0),extractedSize=describe('Extracted size',map=>map.bytes||0);
  $('storage-all-size').textContent=downloadSize.all+' · '+extractedSize.all+' for all '+maps.length+' maps';
  $('storage-current-size').textContent=downloadSize.current+' · '+extractedSize.current;
  $('storage-size').textContent='All maps - '+downloadSize.all+'; '+extractedSize.all+'. Current map only - '+downloadSize.current+'; '+extractedSize.current+'. ZIPs are deleted after extraction. Allow temporary space for one ZIP and a small browser storage overhead.';
  const download=$('download-map');download.hidden=!current?.archive;if(current?.archive){download.href=new URL(current.archive.path,dataBase);download.download=current.id+'.zip';download.textContent='Download '+current.name+' ZIP ('+storageSize(current.archive.bytes)+')';}
}
async function chooseStorage(){
  updateStorageSizes();if(assetCache.mode)return;
  const dialog=$('storage-dialog');dialog.addEventListener('cancel',event=>event.preventDefault());
  await new Promise(resolve=>{for(const button of dialog.querySelectorAll('[data-storage-mode]'))button.onclick=()=>{assetCache.setMode(button.dataset.storageMode);$('storage-mode').value=assetCache.mode;dialog.close();resolve();};dialog.showModal();});
}

// Map-scoped resources carry their export version in the query string, so
// hosts can mark them immutable while the file names stay stable.
const resolve=path=>assetCache.versioned(new URL(path,dataBase),path);
async function json(url, signal) {
  if(url==='manifest.json')return assetCache.catalog(new URL(url,base));
  const blob=await assetCache.get(resolve(url),url);
  if(signal?.aborted)throw new DOMException('Map changed','AbortError');
  return JSON.parse(await blob.text());
}

function setLoading(message,show=true,progress=null){$('loading').hidden=!show;$('loading-message').textContent=message;if(progress===null)$('loading-progress').removeAttribute('value');else{$('loading-progress').max=1;$('loading-progress').value=progress;}}
function requestReadyRedraw(path){if(loadingStation)return;if(frameImages.has(path))redraw();}
// Decode off the main thread where possible; drawing a freshly loaded
// HTMLImageElement would otherwise decode synchronously inside the frame.
// Premultiplied bitmaps draw about twice as fast in Chromium; their only cost
// is a rounding error of one unit at translucent sprite edges.
function decodeImage(blob){
  if(typeof createImageBitmap==='function')return createImageBitmap(blob);
  return new Promise((resolve,reject)=>{const url=URL.createObjectURL(blob),img=new Image();img.onload=()=>{URL.revokeObjectURL(url);resolve(img);};img.onerror=()=>{URL.revokeObjectURL(url);reject(new Error('Image decode failed'));};img.src=url;});
}
function ensureImage(path,urgent=false,mask=0){
  if(images.has(path))return images.get(path);
  const entry={path,mask,ready:false,image:null,bytes:0,generation:state.generation,urgent,used:performance.now()};entry.promise=new Promise(resolve=>entry.resolve=resolve);
  images.set(path,entry);urgent?queue.unshift(entry):queue.push(entry);drain();return entry;
}
function image(path,mask) {
  frameImages.add(path);
  if (failures.has(path)) return null;
  const cached = images.get(path);
  if (cached) {
    images.delete(path); images.set(path, cached); cached.used = performance.now();
    // A strip that became visible jumps ahead of background warm-up loads.
    if (!cached.ready && !cached.urgent) { cached.urgent = true; const index = queue.indexOf(cached); if (index > 0) { queue.splice(index, 1); queue.unshift(cached); } }
    return cached.ready ? cached.image : null;
  }
  ensureImage(path,true,mask);
  return null;
}
function drain() {
  while (activeRequests < MAX_REQUESTS && queue.length) {
    const entry = queue.shift(), { path } = entry;
    if (entry.generation !== state.generation) { if(images.get(path)===entry)images.delete(path);entry.resolve(null);continue; }
    activeRequests++;
    assetCache.get(resolve(path),path,entry.urgent?'high':'auto').then(decodeImage).then(bitmap=>renderer.prepare(bitmap,Math.max(1,slotCount(entry.mask)))).then(handle=>{
      activeRequests--;
      if(images.get(path)!==entry){renderer.release(handle);entry.resolve(null);}
      else{entry.image=handle;entry.bytes=handle.bytes;imageBytes+=entry.bytes;entry.ready=true;entry.resolve(handle);}
      drain();requestReadyRedraw(path);
    }).catch(()=>{
      activeRequests--; failures.add(path); if(images.get(path)===entry)images.delete(path); drain();
      entry.resolve(null);$('coords').textContent = 'Some image chunks failed · reload to retry';requestReadyRedraw(path);
    });
  }
}
function dropImage(path,entry){images.delete(path);if(entry.ready){imageBytes-=entry.bytes;renderer.release(entry.image);}}
function clearImages(){for(const [path,entry]of images)dropImage(path,entry);for(const pending of queue)pending.resolve(null);queue.length=0;failures.clear();imageBytes=0;}
function trimImages() {
  if (imageBytes <= CACHE_BYTES) return;
  // Protect this viewport's images and the tiles prefetched for it, and grow
  // the budget when a large viewport needs more than the target itself:
  // evicting what the next frame draws only causes churn and re-downloads.
  let needed = 0; for (const key of new Set([...frameImages, ...prefetchImages])) needed += images.get(key)?.bytes || 0;
  const budget = Math.max(CACHE_BYTES, needed * 1.5), now = performance.now();
  for (const [key, entry] of images) {
    if (imageBytes <= budget) break;
    // Tiles used within the last two seconds stay: a drag that changes
    // direction would otherwise evict and re-download its own prefetches.
    if (entry.ready && now - entry.used > 2000 && !frameImages.has(key)&&!prefetchImages.has(key)&&!warmImages.has(key)&&!key.endsWith('/overview.webp')) dropImage(key,entry);
  }
}

for (const [key, color] of Object.entries(palette)) {
  const label = document.createElement('label'); label.className = 'toggle-row';
  label.innerHTML = `<span>${networkNames[key]}</span><input type="checkbox" aria-label="${networkNames[key]}">`;
  label.querySelector('input').onchange = event => { event.target.checked ? enabled.add(key) : enabled.delete(key); redraw(); };
  label.querySelector('input').checked=enabled.has(key);
  label.querySelector('input').id=key;
  $('network-controls').append(label);
}

const backgroundPlanes = [0, 1, 2].map(plane => {
  const tile = document.createElement('canvas'); tile.width = tile.height = 1024;
  const c = tile.getContext('2d');
  let seed = 4129 + plane * 923;
  const rand = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  for (let i = 0; i < 180 - plane * 40; i++) {
    const x = rand() * 1024, y = rand() * 1024, r = rand() > .96 ? 1.6 : .4 + rand() * .5;
    c.fillStyle = `rgba(${plane === 2 ? '222,189,140' : '150,189,212'},${.15 + rand() * .6})`;
    c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.fill();
  }
  return tile;
});

function drawBackground() {
  const ctx = background;
  ctx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);
  ctx.fillStyle = '#081522'; ctx.fillRect(0, 0, state.w, state.h);
  const offset = state.motion ? 1 : 0;
  const gx = state.w * (.6 + Math.sin(spaceTime / 95) * .15) - state.x * .018 * offset;
  const gy = state.h * (.45 + Math.cos(spaceTime / 120) * .15) - state.y * .018 * offset;
  const nebula = ctx.createRadialGradient(gx, gy, 0, gx, gy, Math.max(state.w, state.h));
  nebula.addColorStop(0, '#163340'); nebula.addColorStop(.4, '#102434'); nebula.addColorStop(1, '#09101e');
  ctx.fillStyle = nebula; ctx.fillRect(0, 0, state.w, state.h);
  for (let p = 0; p < 3; p++) {
    const dx = ((-state.x * (.025 + p * .03) * offset + spaceTime * (3 + p * 4)) % 1024 + 1024) % 1024;
    const dy = ((-state.y * (.025 + p * .03) * offset + spaceTime * (1 + p * 1.4)) % 1024 + 1024) % 1024;
    for (let x = dx - 1024; x < state.w; x += 1024) for (let y = dy - 1024; y < state.h; y += 1024) ctx.drawImage(backgroundPlanes[p], x, y);
  }
}
function animateSpace(timestamp) {
  spaceFrame = 0;
  if (!state.motion || document.hidden) { lastSpaceTime = null; return; }
  if (lastSpaceTime !== null) spaceTime += Math.min(.1, (timestamp - lastSpaceTime) / 1000);
  lastSpaceTime = timestamp;
  if (timestamp - lastSpacePaint >= 1000 / 30) { drawBackground(); lastSpacePaint = timestamp; }
  spaceFrame = requestAnimationFrame(animateSpace);
}
function updateSpaceAnimation() {
  if (spaceFrame) cancelAnimationFrame(spaceFrame);
  spaceFrame = 0; lastSpaceTime = null;
  drawBackground();
  if (state.motion && !document.hidden) spaceFrame = requestAnimationFrame(animateSpace);
}
document.addEventListener('visibilitychange', () => { updateSpaceAnimation(); updateConnectionHighlights(); });

function worldTransform(target, depth = 0) {
  // Project each deck from the same camera at a different distance. Lower
  // decks recede and pan at their own rate, while parent aperture masks stay
  // attached to their own deck. No saturated screen-offset approximation.
  const scale = deckScale(state.zoom, depth, state.motion);
  target.setTransform(state.dpr * scale, 0, 0, state.dpr * scale, state.dpr * (screenCenterX() - state.x * scale), state.dpr * (screenCenterY() - state.y * scale));
}

// Every tile is one strip image containing all of its channels, so a deck
// view costs one request per tile and its channels always arrive together.
function deckImages(z,zoom=state.zoom,viewZoom=zoom,margin=null) {
  const data = state.levels.get(z); if (!data) return null;
  const S = state.manifest.tilePixels, chunkSize = S * state.manifest.chunkTiles, detail = detailForZoom(zoom), path = `${state.map.id}/${z}`;
  if (detail === 'overview') {
    // Lower decks only need the terrain strip; utilities show on the viewed deck.
    const items=[];
    for(const [file,mask]of [['overview',data.overview],['overview-utilities',z===state.z?data.overviewUtilities:0]])if(mask)items.push({path:`${path}/${file}.webp`,mask,lod:'overview',x:0,y:0,w:state.map.width*S,h:state.map.height*S,sw:state.map.width*4,sh:state.map.height*4});
    return {detail,lod:'overview',items};
  }
  const scale = deckScale(viewZoom,state.z-z,state.motion);
  const left = state.x - screenCenterX() / scale - S - (margin?.left || 0), top = state.y - screenCenterY() / scale - S - (margin?.top || 0);
  const right = state.x + (state.w - screenCenterX()) / scale + S + (margin?.right || 0), bottom = state.y + (state.h - screenCenterY()) / scale + S + (margin?.bottom || 0);
  // Coarser levels pack 2×2 finer tiles per strip, so the image count per
  // frame stays similar at every zoom.
  const lod=Math.min(detail,data.pyramid.length-1), span=chunkSize<<lod, items=[];
  for(const [tx,ty,mask]of data.pyramid[lod])if(!((tx + 1) * span < left || tx * span > right || (ty + 1) * span < top || ty * span > bottom))items.push({path:`${path}/${stripName(tx,ty,lod)}`,mask,lod,tx,ty,x:tx*span,y:ty*span,w:span,h:span,sw:chunkSize,sh:chunkSize});
  return {detail,lod,items};
}
// A tile that is not decoded yet borrows the matching part of its nearest
// decoded coarser level (or the overview), so only that tile looks soft while
// it loads instead of the whole deck dropping a resolution.
function tileSources(z,item){
  if(item.image)return [{handle:item.image,mask:item.mask,sx:0,sy:0,sw:item.sw,sh:item.sh}];
  if(item.lod==='overview')return [];
  const data=state.levels.get(z),S=state.manifest.tilePixels,chunkSize=S*state.manifest.chunkTiles;
  for(let lod=item.lod+1;lod<data.pyramid.length;lod++){
    const k=lod-item.lod,tx=item.tx>>k,ty=item.ty>>k,mask=data.tileMasks[lod].get(`${tx},${ty}`);if(mask===undefined)continue;
    const path=`${state.map.id}/${z}/${stripName(tx,ty,lod)}`,entry=images.get(path);if(!entry?.ready)continue;
    frameImages.add(path);const size=chunkSize>>k;
    return [{handle:entry.image,mask,sx:(item.tx&((1<<k)-1))*size,sy:(item.ty&((1<<k)-1))*size,sw:size,sh:size}];
  }
  const sources=[],factor=4/S;
  for(const [file,mask]of [['overview',data.overview],['overview-utilities',z===state.z?data.overviewUtilities:0]]){
    if(!mask)continue;const path=`${state.map.id}/${z}/${file}.webp`,entry=images.get(path);if(!entry?.ready)continue;
    frameImages.add(path);sources.push({handle:entry.image,mask,sx:item.x*factor,sy:item.y*factor,sw:item.w*factor,sh:item.h*factor});
  }
  return sources;
}
function deckChannels(z){
  const channels=['base'];
  if(z===state.z){const simple=$('simple-utilities').checked&&state.map.infrastructure?.nodes?.length;for(const channel of UTILITIES){if(simple&&['power','pipes'].includes(channel))continue;channels.push(channel+'-surface');if(enabled.has(channel))channels.push(channel);}}
  channels.push('foreground');return channels;
}
function drawDeckTiles(z,shade){
  const set=deckImages(z);if(!set)return;
  const chunkSize=state.manifest.tilePixels*state.manifest.chunkTiles,scale=deckScale(state.zoom,state.z-z,state.motion),centerX=screenCenterX(),centerY=screenCenterY(),dpr=state.dpr,natural=$('runtime-terrain').checked;
  for(const item of set.items){item.image=image(item.path,item.mask);assetCache.priorityPaths?.add(item.path);}
  // Prefetch one tile beyond the edges the camera is moving toward, at low
  // priority, so dragging rarely reaches tiles that are still loading.
  if(set.lod!=='overview'&&(panDirection.x||panDirection.y)){const span=chunkSize<<set.lod,margin={left:panDirection.x<0?span:0,right:panDirection.x>0?span:0,top:panDirection.y<0?span:0,bottom:panDirection.y>0?span:0};for(const item of deckImages(z,state.zoom,state.zoom,margin)?.items||[]){prefetchImages.add(item.path);const entry=images.get(item.path);if(entry)entry.used=performance.now();else ensureImage(item.path,false,item.mask);}}
  const sources=set.items.map(item=>tileSources(z,item));
  renderer.beginDeck(shade);
  for(const channel of deckChannels(z))for(const [index,item]of set.items.entries())for(const source of sources[index]){
    const slot=slotIndex(source.mask,channel==='base'&&natural&&hasChannel(source.mask,'natural')?'natural':channel);if(slot<0)continue;
    renderer.draw(source.handle,slot,source.sx,source.sy,source.sw,source.sh,((item.x-state.x)*scale+centerX)*dpr,((item.y-state.y)*scale+centerY)*dpr,item.w*scale*dpr,item.h*scale*dpr);
    break;
  }
  renderer.endDeck();
}
// Block only on what the first frame draws; zoom neighbors load afterwards so
// the first zoom step needs no new requests without delaying the station.
async function prepareView(generation){
  const first=new Map(),warm=new Map();
  const levels=state.map.levels.filter(z=>z<=state.z&&(state.cutaway||z===state.z));
  for(const z of state.map.levels){const data=state.levels.get(z);if(data?.overview)(z<=state.z?first:warm).set(`${state.map.id}/${z}/overview.webp`,data.overview);}
  for(const z of levels){
    for(const item of deckImages(z).items)first.set(item.path,item.mask);
    for(const zoom of [state.zoom/1.5,state.zoom/2,state.zoom*1.5])for(const item of deckImages(z,zoom)?.items||[])if(!first.has(item.path))warm.set(item.path,item.mask);
  }
  warmImages=new Set([...first.keys(),...warm.keys()]);assetCache.priorityPaths=new Set([`${state.map.id}/map.json`,`${state.map.id}/search.json`,`${state.map.id}/${state.z}.json`,...first.keys(),...warm.keys()]);let count=0;
  for(const [path,mask]of first)ensureImage(path,true,mask);
  for(const [path,mask]of warm)ensureImage(path,false,mask);
  await Promise.all([...first.keys()].map(async path=>{await images.get(path)?.promise;if(generation===state.generation)setLoading(`Decoding the current view · ${++count} / ${first.size} images`,true,count/first.size);}));
}

function render() {
  frame = 0;
  if(performance.now()<panelTransitionUntil)redraw();
  const detail=String(detailForZoom(state.zoom));if(canvas.dataset.detail!==detail)canvas.dataset.detail=detail;
  frameImages = new Set(); prefetchImages = new Set();
  if(state.map)assetCache.priorityPaths=new Set([`${state.map.id}/map.json`,`${state.map.id}/search.json`,`${state.map.id}/${state.z}.json`]);
  // The space background lives on its own canvas: the animation loop repaints
  // it while motion is on, and it is static otherwise.
  updateConnectionHighlights();
  const drawable = !!(state.map && state.ready);
  // Camera motion between frames steers the prefetch; zooming resets it.
  panDirection.x = state.zoom === lastCamera.zoom ? Math.sign(state.x - lastCamera.x) : 0; panDirection.y = state.zoom === lastCamera.zoom ? Math.sign(state.y - lastCamera.y) : 0;
  lastCamera.x = state.x; lastCamera.y = state.y; lastCamera.zoom = state.zoom;
  renderer.begin();
  if (drawable) {
    // Deeper decks are shaded without changing their opacity, so an opaque
    // middle floor still occludes deeper floors and transparent sprite edges
    // stay see-through. Decks composite bottom-up.
    if (state.cutaway) for (const z of state.map.levels) if (z < state.z) drawDeckTiles(z, Math.min(.45, (state.z - z) * .14));
    drawDeckTiles(state.z, 0);
  }
  renderer.end();
  const wantAnnotations = drawable && (state.regions || $('simple-utilities').checked || $('power-networks').checked || state.selected?.z === state.z);
  if (wantAnnotations || annotationsPainted) { ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, annotations.width, annotations.height); annotationsPainted = false; }
  if (wantAnnotations) { drawInfrastructure(); drawAnnotations(); annotationsPainted = true; }
  if (!drawable) return;
  trimImages();
  const tileWidth = 32 * state.zoom, scale = `${Math.max(1, Math.round(70 / tileWidth))} tiles / ${Math.round(state.zoom * 100)}%`;
  if (scale !== scaleText) $('scale').textContent = scaleText = scale;
  if (!reduced.matches && performance.now() - pulseStart < 1400) redraw();
}
function drawInfrastructure(){
  const data=state.map.infrastructure;if(!data)return;
  worldTransform(ctx);const simple=$('simple-utilities').checked,colored=$('power-networks').checked;
  if(simple||colored){
    const key=`${state.z}:${simple}:${colored}:${[...enabled].sort()}`;
    if(!utilityPaths.has(key)){
      const paths=new Map();
      for(const node of data.nodes){if(!['power','pipes'].includes(node.channel)||node.z!==state.z||(!enabled.has(node.channel)&&!node.exposed)||(simple&&node.simpleEligible===false&&!(colored&&node.channel==='power'))||(!simple&&!(colored&&node.channel==='power')))continue;
        const color=colored&&node.channel==='power'?`hsl(${node.network*137.508%360} 85% 70%)`:node.color;
        if(!paths.has(color))paths.set(color,new Path2D());const path=paths.get(color),x=(node.x-.5)*32,y=(state.map.height-node.y+.5)*32;
        const ports=simple?15:node.links;
        for(const [dir,dx,dy]of[[1,0,-1],[2,0,1],[4,1,0],[8,-1,0]])if(ports&dir){path.moveTo(x,y);path.lineTo(x+dx*16,y+dy*16);}
        if(!ports){path.moveTo(x-3,y);path.lineTo(x+3,y);}
      }
      utilityPaths.set(key,paths);
    }
    ctx.lineCap='round';for(const [color,path]of utilityPaths.get(key)){ctx.strokeStyle='#0c1729';ctx.lineWidth=5;ctx.stroke(path);ctx.strokeStyle=color;ctx.lineWidth=2.5;ctx.stroke(path);}ctx.lineCap='butt';
  }
}

// Animate only this transparent overlay; the station's cached canvas stays idle.
let overlayPainted = false;
function drawConnectionHighlights(time = performance.now()) {
  const target = connectionsContext;
  const ready = state.ready && state.map && !document.hidden;
  const wanted = ready && !!(doorMarkers.length || state.markers.length || (state.selected?.z === state.z && state.offsetHighlights?.size) || ($('connections').checked && state.map.infrastructure?.transitions?.length));
  // Skip the full-screen clear while the overlay is empty and stays empty.
  if (!wanted && !overlayPainted) return false;
  target.setTransform(1, 0, 0, 1, 0, 0);
  target.clearRect(0, 0, connectionsCanvas.width, connectionsCanvas.height);
  overlayPainted = false;
  if (!wanted) return false;
  worldTransform(target);
  const centerX=screenCenterX(),centerY=screenCenterY();
  const pulse = reduced.matches ? .5 : (1 + Math.sin(time * Math.PI * 2 / 1800)) / 2;
  let visible = false;
  const ring=(tileX,tileY,z,color)=>{
    if(z!==state.z)return;
    const x=(tileX-.5)*32,y=(state.map.height-tileY+.5)*32;
    const sx=(x-state.x)*state.zoom+centerX,sy=(y-state.y)*state.zoom+centerY;
    if(sx < -30||sx>state.w+30||sy < -30||sy>state.h+30)return;
    visible=true;target.strokeStyle=`rgba(${color},${.65+pulse*.35})`;target.fillStyle=`rgba(${color},${.08+pulse*.12})`;target.lineWidth=2/state.zoom;
    target.beginPath();target.arc(x,y,Math.max(13,5/state.zoom)+pulse*3/state.zoom,0,Math.PI*2);target.fill();target.stroke();
  };
  for(const marker of doorMarkers)ring(marker.x,marker.y,marker.z,marker.status==='allowed'?'90,226,144':marker.status==='partial'?'255,210,92':'255,105,113');
  for(let index=0;index<state.markers.length;index+=3)ring(state.markers[index],state.markers[index+1],state.markers[index+2],'255,207,114');
  if(state.selected?.z===state.z&&state.offsetHighlights?.size){
    const tile=state.selected,definition=state.map.definitions[state.levels.get(tile.z)?.grid[(state.map.height-tile.y)*state.map.width+tile.x-1]];
    for(const index of state.offsetHighlights){const bounds=definition?.atoms[index]?.visual;if(!bounds)continue;
      const x=(tile.x-1)*32+bounds.x,y=(state.map.height-tile.y)*32+bounds.y,cx=x+bounds.width/2,cy=y+bounds.height/2,sx=(cx-state.x)*state.zoom+centerX,sy=(cy-state.y)*state.zoom+centerY;if(sx< -50||sx>state.w+50||sy< -50||sy>state.h+50)continue;
      visible=true;target.strokeStyle=`rgba(106,224,255,${.65+pulse*.35})`;target.lineWidth=1/state.zoom;target.beginPath();target.moveTo((tile.x-.5)*32,(state.map.height-tile.y+.5)*32);target.lineTo(cx,cy);target.stroke();
      const padding=(2+pulse*2)/state.zoom;target.fillStyle=`rgba(106,224,255,${.08+pulse*.15})`;target.fillRect(x-padding,y-padding,bounds.width+padding*2,bounds.height+padding*2);target.lineWidth=2/state.zoom;target.strokeRect(x-padding,y-padding,bounds.width+padding*2,bounds.height+padding*2);
    }
  }
  for (const link of $('connections').checked ? state.map.infrastructure?.transitions || [] : []) {
    if (link.z !== state.z) continue;
    const x = (link.x - .5) * 32, y = (state.map.height - link.y + .5) * 32;
    const screenX = (x - state.x) * state.zoom + centerX, screenY = (y - state.y) * state.zoom + centerY;
    if (screenX < -400 || screenX > state.w + 30 || screenY < -30 || screenY > state.h + 30) continue;
    visible = true;
    const radius = Math.max(13, 5 / state.zoom) + pulse * 3 / state.zoom;
    target.strokeStyle = `rgba(177,232,255,${.65 + pulse * .35})`;
    target.fillStyle = `rgba(118,201,237,${.12 + pulse * .18})`;
    target.lineWidth = 2 / state.zoom;
    target.beginPath(); target.arc(x, y, radius, 0, Math.PI * 2); target.fill(); target.stroke();
    if ($('connection-labels').checked) {
      const up = link.targets.some(t => t.z > link.z), down = link.targets.some(t => t.z < link.z);
      if (!up && !down) continue;
      const size = Math.min(10, Math.max(3, state.zoom * 10)) / state.zoom;
      const arrow = new Path2D();
      arrow.moveTo(x, y - size); arrow.lineTo(x, y + size);
      if (up) { arrow.moveTo(x - size * .55, y - size * .4); arrow.lineTo(x, y - size); arrow.lineTo(x + size * .55, y - size * .4); }
      if (down) { arrow.moveTo(x - size * .55, y + size * .4); arrow.lineTo(x, y + size); arrow.lineTo(x + size * .55, y + size * .4); }
      target.lineJoin = 'round'; target.lineCap = 'round';
      target.strokeStyle = '#09131f'; target.lineWidth = 5 / state.zoom; target.stroke(arrow);
      target.strokeStyle = '#d2f0ff'; target.lineWidth = 2 / state.zoom; target.stroke(arrow);
      target.lineCap = 'butt'; target.lineJoin = 'miter';
    }
  }
  overlayPainted = visible;
  return visible;
}
function animateConnections(time) {
  connectionsFrame = 0;
  if (time - lastConnectionsPaint >= 1000 / 30) {
    lastConnectionsPaint = time;
    if (!drawConnectionHighlights(time) || reduced.matches) return;
  }
  connectionsFrame = requestAnimationFrame(animateConnections);
}
function updateConnectionHighlights() {
  if (connectionsFrame) cancelAnimationFrame(connectionsFrame);
  connectionsFrame = 0;
  if (drawConnectionHighlights() && !reduced.matches) connectionsFrame = requestAnimationFrame(animateConnections);
}

function regionColor(area) {
  let hash = 0; for (const c of area) hash = (hash * 31 + c.charCodeAt(0)) | 0;
  return `hsl(${Math.abs(hash) % 360} 48% 64%)`;
}
function areaColor(index) {
  let color = areaColors.get(index);
  if (!color) areaColors.set(index, color = regionColor(state.map.areas[index].path));
  return color;
}
function regionChunk(z, cx, cy) {
  const key = `${z}:${cx},${cy}`;
  let byArea = regionChunks.get(key); if (byArea) return byArea;
  const map = state.map, data = state.levels.get(z), C = state.manifest.chunkTiles; byArea = new Map();
  for (let y = cy * C; y < Math.min(map.height, (cy + 1) * C); y++) for (let x = cx * C; x < Math.min(map.width, (cx + 1) * C); x++) {
    const def = map.definitions[data.grid[y * map.width + x]]; if (!def || def.turf.includes('/space')) continue;
    let paths = byArea.get(def.area); if (!paths) byArea.set(def.area, paths = { fill: new Path2D(), edge: new Path2D() });
    paths.fill.rect(x * 32, y * 32, 32, 32);
    for (const [dx, dy] of [[1, 0], [0, 1]]) {
      const neighbor = x + dx < map.width && y + dy < map.height ? map.definitions[data.grid[(y + dy) * map.width + x + dx]] : undefined;
      if (neighbor?.area !== def.area) { paths.edge.moveTo((x + dx) * 32, (y + dy) * 32); paths.edge.lineTo((x + 1) * 32, (y + 1) * 32); }
    }
  }
  regionChunks.set(key, byArea); return byArea;
}

function drawAnnotations() {
  const map = state.map, data = state.levels.get(state.z); if (!data) return;
  worldTransform(ctx); ctx.lineWidth = 1 / state.zoom;
  const left = Math.max(0, Math.floor((state.x - screenCenterX() / state.zoom) / 32));
  const top = Math.max(0, Math.floor((state.y - screenCenterY() / state.zoom) / 32));
  const right = Math.min(map.width, Math.ceil((state.x + (state.w - screenCenterX()) / state.zoom) / 32));
  const bottom = Math.min(map.height, Math.ceil((state.y + (state.h-screenCenterY()) / state.zoom) / 32));
  if (state.regions) {
    // Fills and boundaries are cached per chunk as one path per area, so a
    // frame strokes a few paths per chunk instead of every visible tile.
    const C = state.manifest.chunkTiles;
    for (let cy = Math.floor(top / C); cy * C < bottom; cy++) for (let cx = Math.floor(left / C); cx * C < right; cx++) {
      for (const [area, paths] of regionChunk(state.z, cx, cy)) {
        const color = areaColor(area);
        ctx.globalAlpha = .14; ctx.fillStyle = color; ctx.fill(paths.fill);
        ctx.globalAlpha = .8; ctx.strokeStyle = color; ctx.stroke(paths.edge);
      }
    }
    ctx.globalAlpha = 1;
    const labels = new Map();
    if (state.zoom > .55) for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) {
      const def = map.definitions[data.grid[y * map.width + x]];
      if (def && !labels.has(def.area) && !def.turf.includes('/space')) labels.set(def.area, [x, y]);
    }
    for (const [area, [x, y]] of labels) {
      ctx.font = `${10 / state.zoom}px 'IBM Plex Mono',monospace`; ctx.fillStyle = '#eff4ee'; ctx.strokeStyle = '#0c1824'; ctx.lineWidth = 3 / state.zoom;
      const label = map.areas[area].name; ctx.strokeText(label, x * 32 + 8, y * 32 + 18); ctx.fillText(label, x * 32 + 8, y * 32 + 18);
    }
  }
  ctx.globalAlpha = 1;
  ctx.lineWidth = 2 / state.zoom;
  if (state.selected?.z === state.z) {
    const elapsed = performance.now() - pulseStart;
    const pulse = !reduced.matches && elapsed < 1400 ? .5 + Math.sin(elapsed / 75) * .5 : 0;
    const x = (state.selected.x - 1) * 32, y = (map.height - state.selected.y) * 32;
    ctx.fillStyle = `rgba(255,210,115,${pulse * .3})`; ctx.fillRect(x, y, 32, 32);
    ctx.strokeStyle = '#fff4d8'; ctx.strokeRect(x, y, 32, 32);
  }
}

function resize() {
  const rect = canvas.getBoundingClientRect(); state.w = rect.width; state.h = rect.height; state.dpr = Math.min(devicePixelRatio || 1, 2);
  canvas.width = annotations.width = Math.round(state.w * state.dpr);
  canvas.height = annotations.height = Math.round(state.h * state.dpr);
  space.width = connectionsCanvas.width = canvas.width; space.height = connectionsCanvas.height = canvas.height;
  renderer.resize(canvas.width, canvas.height);
  // ResizeObserver runs before paint. Repaint synchronously so resizing never
  // presents a freshly cleared canvas for one frame.
  updateSpaceAnimation(); if (frame) cancelAnimationFrame(frame); render();
}
new ResizeObserver(resize).observe(canvas);
function fit() {
  if (!state.map) return;
  const map = state.map, [minX, minY, maxX, maxY] = state.levels.get(state.z)?.bounds || [0, 0, map.width, map.height];
  state.x = (minX + maxX) * 16; state.y = (minY + maxY) * 16;
  state.zoom = Math.max(.05, Math.min((state.w - sidebarInset() - 130) / ((maxX - minX) * 32), (state.h - bottomSidebarInset() - (portraitPanel()?90:180)) / ((maxY - minY) * 32), 1));
  redraw(); share();
}
function zoom(factor, sx = screenCenterX(), sy = screenCenterY()) {
  const before = state.zoom, after = Math.min(5, Math.max(.04, before * factor));
  state.x += (sx - screenCenterX()) * (1 / before - 1 / after); state.y += (sy - screenCenterY()) * (1 / before - 1 / after); state.zoom = after;
  redraw(); share();
}
function share(immediate = false) {
  clearTimeout(shareTimer);
  const apply = () => {
    state.optionMask=encodeOptions(Object.fromEntries(Object.keys(optionBits).map(key=>[key,$(key).checked])));
    if(!state.map){history.replaceState(null,'',`#o=${state.optionMask}`);return;}
    history.replaceState(null, '', viewFragment(state));
  };
  if (immediate) apply(); else shareTimer = setTimeout(apply, 150);
}
function restoreOptions(params){
  if(!params.has('o'))return false;const options=decodeOptions(params.get('o'));if(!options)return false;
  for(const [key,value]of Object.entries(options))$(key).checked=value;
  for(const key of Object.keys(palette))options[key]?enabled.add(key):enabled.delete(key);
  for(const key of ['regions','cutaway','motion'])state[key]=options[key];
  updateSpaceAnimation();utilityPaths.clear();return true;
}
let loadAbort;
async function loadStation(id, restore = false) {
  const generation = ++state.generation;
  assetCache.setCurrentMap(id);updateStorageSizes();
  state.ready=false;loadingStation=true;assetCache.foregroundBusy=true;assetCache.activeView=true;warmImages=new Set();utilityPaths.clear();canvas.style.pointerEvents='none';$('map-picker').hidden=true;
  document.querySelector('.floating-decks').hidden=false;document.querySelector('.map-tools').hidden=false;
  finding = null; locationSeq++; $('search-findings').hidden = true;
  const params = new URLSearchParams(location.hash.slice(1));if(restore)restoreOptions(params);
  const restoreTarget = restore && params.get('r') ? { id: params.get('r'), index: Math.max(0, (Number(params.get('f')) || 1) - 1), tile: params.get('t') } : null;
  state.result = null; state.finding = null; locationTarget = null;
  $('search').value = state.query = restore ? params.get('q') || '' : $('search').value;
  updateSearchReset();
  state.placed = $('placed').checked; state.possible = $('possible').checked;
  loadAbort?.abort(); loadAbort = new AbortController();
  state.map = null; state.levels.clear(); state.markers = []; state.selected = null; clearImages();regionChunks.clear();areaColors.clear();
  $('inspect-tab').disabled = true; sidebarView(false);
  $('loading').classList.remove('error');setLoading('Reading station archive…');
  $('results').replaceChildren(); state.searchReady = false; $('search-status').textContent = 'Preparing search index…';
  $('search').disabled=true;
  try {
    const signal = loadAbort.signal, meta = decodeMap(await json(`${id}/map.json`, signal));
    const levelData = (await Promise.all(meta.levels.map(z => json(`${id}/${z}.json`, signal)))).map(decodeLevel);
    if (generation !== state.generation) return;
    state.map = meta; state.levels = new Map(levelData.map(level => [level.z, { ...level, tileMasks: level.pyramid.map(tiles => new Map(tiles.map(([x, y, mask]) => [`${x},${y}`, mask]))) }]));
    doorTiles=indexDoorTiles(meta,state.levels);
    const requestedRoles=restore?(params.get('j')||'').split(','):state.doorRoles||[];
    state.doorRoles=[...new Set(requestedRoles.filter(role=>(meta.jobRoles||[]).includes(role)))];
    $('door-role-input').disabled=!(meta.jobRoles?.length);$('door-role-input').value='';$('door-role-suggestions').hidden=true;
    renderDoorRoles();doorMarkers=doorMarkersForRoles(doorTiles,state.doorRoles);
    $('network-summary').textContent=meta.infrastructure?`${meta.infrastructure.powerNetworks} separate mapped power networks. Colors describe wired connectivity before a round starts.`:'';
    const requestedZ = restore ? +params.get('z') : meta.levels.at(-1);
    state.z = meta.levels.includes(requestedZ) ? requestedZ : meta.levels.at(-1);
    $('map-title').textContent = meta.name;
    $('map-subtitle').textContent = `${meta.levels.length} ${meta.levels.length === 1 ? 'deck' : 'decks'} · ${meta.areas.length} mapped areas · pre-round snapshot`;
    $('station-meta').textContent = `${meta.width} × ${meta.height} GRID / ${meta.levels.length} Z-LEVEL${meta.levels.length === 1 ? '' : 'S'}`;
    $('decks').replaceChildren();
    for (const z of [...meta.levels].reverse()) {
      const button = document.createElement('button'); button.textContent = `Z${String(z).padStart(2, '0')}`; button.onclick = () => setDeck(z); button.dataset.z = z; button.setAttribute('aria-label', `Deck ${z}`); $('decks').append(button);
    }
    setDeck(state.z); fit();
    if (restore && ['x', 'y', 's'].every(k => params.has(k) && Number.isFinite(+params.get(k)))) {
      state.x = Math.max(0, Math.min(meta.width * 32, +params.get('x'))); state.y = Math.max(0, Math.min(meta.height * 32, +params.get('y'))); state.zoom = Math.max(.04, Math.min(5, +params.get('s'))); redraw();
    }
    const tile = restore ? selectedTile(params, meta) : null;
    if (tile) { if (state.z !== tile.z) setDeck(tile.z); inspect(tile.x, tile.y, tile.z,null,(params.get('h')||'').split(',').filter(value=>/^\d+$/.test(value)).map(Number)); }
    const restoreVersion = locationSeq;
    let resolveIndex;const indexReady=new Promise(resolve=>resolveIndex=resolve);
    // The loading overlay stays until a finding from the URL is restored, so
    // a visible station always has a complete, consistent state and URL.
    let resolveRestore;const restoreReady=new Promise(resolve=>resolveRestore=resolve);if(!restoreTarget)resolveRestore();
    worker?.terminate(); worker = new Worker(new URL('./search.worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = ({ data }) => {
      if (generation !== state.generation) return;
      if (data.type === 'ready') {
        state.searchReady = true; $('search-status').textContent = 'Search rooms, mapped items & loot candidates'; runSearch();
        resolveIndex();if(state.selected)worker.postMessage({type:'tile',tile:`${state.selected.x},${state.selected.y},${state.selected.z}`,seq:++tileSeq});
        if (restoreTarget && restoreVersion === locationSeq) { locationTarget = restoreTarget; worker.postMessage({ type: 'locations', id: restoreTarget.id, seq: ++locationSeq }); } else resolveRestore();
      }
      if (data.type === 'error') { $('search-status').textContent = data.message;resolveIndex();resolveRestore(); }
      if(data.type==='tile'&&data.seq===tileSeq){tileCandidates=data.possible;paintInspector();}
      if (data.type === 'results' && data.seq === searchSeq) showResults(data);
      if (data.type === 'locations' && data.seq === locationSeq && data.result) {
        const restoring = !!locationTarget;
        finding = data.result;
        let index = 0;
        for (let p = 0; p < finding.points.length; p += 3) if (finding.points[p + 2] === state.z) { index = p / 3; break; }
        if (locationTarget) {
          index = Math.min(finding.count - 1, Math.floor(locationTarget.index));
          if (locationTarget.tile) for (let p = 0; p < finding.points.length; p += 3) if (finding.points.slice(p, p + 3).join(',') === locationTarget.tile) { index = p / 3; break; }
          locationTarget = null;
        }
        selectFinding(index, { focus: !restoring });
        resolveRestore();
      } else if (data.type === 'locations' && data.seq === locationSeq) resolveRestore();
    };
    // The worker parses and decodes the search records itself; transferring the
    // bytes avoids cloning a large object graph through the main thread.
    const searchBytes=await(await assetCache.get(resolve(`${id}/search.json`),`${id}/search.json`)).arrayBuffer();if(generation!==state.generation)return;
    worker.postMessage({ type: 'init', buffer:searchBytes, generation, rooms: meta.rooms || [] },[searchBytes]);
    await Promise.all([prepareView(generation),indexReady,restoreReady]);if(generation!==state.generation)return;
    state.ready=true;loadingStation=false;assetCache.foregroundBusy=false;canvas.style.pointerEvents='';setLoading('',false);$('source-status').textContent = 'ARCHIVE READY';redraw();share(true);
    $('search').disabled=false;for(const button of $('results').children)button.disabled=false;
    warmStorage();
  } catch (error) {
    if (error.name === 'AbortError') return;
    loadingStation=false;assetCache.foregroundBusy=false;$('loading').classList.add('error');setLoading(`Could not load station: ${error.message}. Run pnpm source && pnpm export, then reload.`);
  }
}
function setDeck(z) {
  state.z = z;
  if (state.selected && state.selected.z !== z) clearSelection();
  for (const button of $('decks').children) { button.classList.toggle('active', +button.dataset.z === z); button.setAttribute('aria-pressed', +button.dataset.z === z); }
  $('coords').textContent = `DECK ${z} / DRAG TO EXPLORE`; redraw(); share();
}

function updateSearchReset(){$('reset-search').hidden=!$('search').value.length;}
function runSearch() {
  updateSearchReset();
  searchSeq++;
  state.query = $('search').value; state.placed = $('placed').checked; state.possible = $('possible').checked; share();
  if (!state.searchReady) return;
  const query = $('search').value.trim();
  if (!query) { $('results').replaceChildren(); $('search-status').textContent = 'Search rooms, mapped items & loot candidates'; return; }
  worker.postMessage({ type: 'query', seq: searchSeq, query, placed: $('placed').checked, possible: $('possible').checked });
}
function showResults(data) {
  $('results').replaceChildren(); $('search-status').textContent = `${data.total} matches${data.total > 70 ? ' · showing first 70' : ''}`;
  for (const result of data.results) {
    const button = document.createElement('button'); button.className = 'result';
    button.disabled=loadingStation;
    button.innerHTML = `${escape(result.name)}<small>${escape(result.kind.toUpperCase())} · ${result.count} ${result.kind === 'room' ? 'decks' : 'locations'}</small>`;
    button.onclick = () => {
      locationTarget = null;
      worker.postMessage({ type: 'locations', id: result.id, seq: ++locationSeq });
    };
    $('results').append(button);
  }
}
function selectFinding(index, { focus = true } = {}) {
  if (!finding || index < 0 || index >= finding.count) return;
  // setDeck can clear a previous tile selection; retain the finding group.
  const result = finding, [x, y, z] = result.points.slice(index * 3, index * 3 + 3);
  setDeck(z); finding = result; state.markers = result.points;
  findingIndex = index; findingPage = Math.floor(index / FINDINGS_PER_PAGE);
  state.result = result.id; state.finding = index;
  if (focus) { state.x = (x - .5) * 32; state.y = (state.map.height - y + .5) * 32; state.zoom = Math.max(state.zoom, 1); }
  inspect(x, y, z, result); showFindings(); redraw(); share();
}
function showFindings() {
  const panel = $('search-findings');
  if (!finding) { panel.hidden = true; return; }
  const start = findingPage * FINDINGS_PER_PAGE, end = Math.min(finding.count, start + FINDINGS_PER_PAGE);
  panel.innerHTML = `<button class="back-to-search">← Search results</button><h2>${escape(finding.name)}</h2><p>${escape(finding.kind.toUpperCase())} · ${finding.count} findings</p><div class="finding-list"></div><div class="finding-pages"><button class="previous" ${start === 0 ? 'disabled' : ''} aria-label="Previous findings">←</button><span>${start + 1}–${end} / ${finding.count}</span><button class="next" ${end >= finding.count ? 'disabled' : ''} aria-label="Next findings">→</button></div>`;
  for (let index = start; index < end; index++) {
    const [x, y, z] = finding.points.slice(index * 3, index * 3 + 3);
    const def = state.map.definitions[state.levels.get(z)?.grid[(state.map.height - y) * state.map.width + x - 1]];
    const button = document.createElement('button'); button.className = 'finding-location'; button.dataset.index = index;
    button.setAttribute('aria-pressed', String(index === findingIndex));
    button.innerHTML = `<span>${index + 1}. ${escape(def ? state.map.areas[def.area].name : 'Unknown area')}</span><small>Z${z} · X ${x} / Y ${y}</small>`;
    button.onclick = () => selectFinding(index); panel.querySelector('.finding-list').append(button);
  }
  panel.querySelector('.back-to-search').onclick = () => sidebarView('search');
  panel.querySelector('.previous').onclick = () => { findingPage--; showFindings(); };
  panel.querySelector('.next').onclick = () => { findingPage++; showFindings(); };
  panel.hidden = false;
}
function inspect(x, y, z = state.z, result = null, highlights = undefined) {
  if (!state.map) return;
  const meta = state.map, def = meta.definitions[state.levels.get(z)?.grid[(meta.height - y) * meta.width + x - 1]];
  if (!def || x < 1 || x > meta.width || y < 1 || y > meta.height) return;
  const same=state.selected?.x===x&&state.selected?.y===y&&state.selected?.z===z;
  if(highlights!==undefined)state.offsetHighlights=new Set(highlights.filter(index=>Number.isInteger(index)&&def.atoms[index]?.visual));else if(!same)state.offsetHighlights=new Set();
  const area = meta.areas[def.area]; state.selected = { x, y, z };
  if (!result) { finding = null; state.markers = []; state.result = null; state.finding = null; locationSeq++; $('search-findings').hidden = true; }
  pulseStart = performance.now();
  const contents = def.atoms.filter(a => !a.path.startsWith('/turf/'));
  if (result?.kind === 'possible') result = { ...result, spawner: contents.find(atom => result.spawners?.includes(atom.path))?.path || result.spawners?.[0] || 'a static loot table' };
  const sourceUrl = path => `${state.manifest.repository.replace(/\.git$/, '')}/blob/${state.manifest.commit}/${path}`;
  $('inspector').innerHTML = `<button class="close" aria-label="Close inspector">×</button><span class="tiny-label">TILE INSPECTOR / Z${z}</span><h3>${escape(area.name)}</h3><p>${escape(area.region.toUpperCase())} · X ${x} / Y ${y}<br>${escape(area.path)}</p>${result ? `<p><strong>${escape(result.name)}</strong><br>${result.kind === 'possible' ? 'Candidate from ' + escape(result.spawner) + '. No probability is inferred.' : escape(result.kind) + ' source location'}</p>` : ''}<p>${def.aperture ? 'Lower-deck visibility: ' + Math.round(def.aperture / 255 * 100) + '% · ' : ''}${escape(def.turf)}</p><details open><summary>${contents.length} mapped objects</summary><ul>${contents.map(a => `<li>${escape(a.name)}${a.network ? ` <span style="color:${palette[a.network]}">[${escape(networkNames[a.network])}]</span>` : ''}<details><summary>Type & overrides</summary><p>${escape(a.path)}<br>${escape(JSON.stringify(a.vars))}${a.source ? `<br><a href="${escape(sourceUrl(a.source))}" target="_blank" rel="noreferrer">DM declaration ↗</a>` : ''}</p></details></li>`).join('')}</ul></details><p>Utility sprites show mapped infrastructure. They do not simulate live connectivity, pressure or power.</p><a href="${escape(sourceUrl(meta.files[0]))}" target="_blank" rel="noreferrer">View map source ↗</a>`;
  $('inspect-tab').disabled = false; sidebar(false); sidebarView(true);
  inspectorDetailHTML=$('inspector').innerHTML;inspectedResult=result;tileCandidates=[];paintInspector();
  if(state.searchReady)worker.postMessage({type:'tile',tile:`${x},${y},${z}`,seq:++tileSeq});
  $('inspector').querySelector('.close').onclick = clearSelection;
  redraw(); share();
}

function paintInspector(){
  if(!state.selected||!state.map)return;
  const {x,y,z}=state.selected,meta=state.map,def=meta.definitions[state.levels.get(z)?.grid[(meta.height-y)*meta.width+x-1]];if(!def)return;
  if($('detailed-view').checked){$('inspector').innerHTML=inspectorDetailHTML;}
  else{
    const area=meta.areas[def.area],turf=def.atoms.find(a=>a.path.startsWith('/turf/'));
    const clean=text=>String(text||'').replace(/<[^>]*>/g,'').replace(/\\[a-z]+\s*/g,'').replace(/\[[^\]]*\]/g,'').trim();
    const here=def.atoms.filter(a=>/^\/(obj|mob)\//.test(a.path)&&!a.path.startsWith('/obj/effect/')&&!a.path.includes('/spawner/'));
    const list=items=>{const counts=new Map();for(const item of items){const name=clean(item.name);if(name)counts.set(name,(counts.get(name)||0)+1);}return [...counts].sort(([a],[b])=>a.localeCompare(b)).map(([name,count])=>`<li>${escape(name)}${count>1?` × ${count}`:''}</li>`).join('');};
    const links=(meta.infrastructure?.transitions||[]).filter(t=>t.x===x&&t.y===y&&t.z===z);
    const cables=(meta.infrastructure?.nodes||[]).filter(n=>n.channel==='power'&&n.x===x&&n.y===y&&n.z===z);
    const shownTurf=$('runtime-terrain').checked&&def.runtimeTerrain?def.runtimeTerrain:turf;
    const random=!!def.runtimeTerrain||def.atoms.some(a=>a.path.includes('/spawner/')||a.path.includes('/random'));
    $('inspector').innerHTML=`<button class="close" aria-label="Close inspector">×</button><span class="tiny-label">DECK ${z} · ${x}, ${y}</span><h3>${escape(area.name)}</h3><p class="friendly-description">${escape(clean(shownTurf?.name)||'Station surface')}${clean(shownTurf?.description)?`. ${escape(clean(shownTurf.description))}`:''}</p>${inspectedResult?`<p class="friendly-description">Selected finding: <strong>${escape(inspectedResult.name)}</strong></p>`:''}<h4 class="info-heading">What’s here</h4>${here.length?`<ul class="friendly-list">${list(here)}</ul>`:'<p class="info-empty">No objects are placed on this tile.</p>'}<h4 class="info-heading">What could appear</h4>${tileCandidates.length?`<p class="friendly-description">One or more of these may be chosen when the round begins.</p><ul class="friendly-list">${list(tileCandidates)}</ul>`:`<p class="info-empty">${random?'Random objects may appear here. Their exact contents are decided when the round starts.':'No random item spawns are recorded here.'}</p>`}${cables.length?`<h4 class="info-heading">Electricity</h4><p class="friendly-description">${[...new Set(cables.map(n=>`Power network ${n.network}`))].join(', ')}. Matching network colors indicate connected wiring.</p>`:''}${links.length?`<h4 class="info-heading">Where this leads</h4>${links.map(link=>`<p class="friendly-description">${escape(link.kind)}: ${link.targets.length?link.targets.map(t=>`Deck ${t.z} - ${escape(t.room)}`).join('; '):'No destination is mapped in this station.'}</p>`).join('')}`:''}`;
  }
  const doors=def.atoms.filter(atom=>atom.doorAccess);
  for(const door of $('detailed-view').checked?doors:groupDoorAccess(doors)){
    const access=door.doorAccess,section=document.createElement('section');
    const denied=(meta.jobRoles||[]).filter(role=>!access.roles.includes(role));
    let allowedText,deniedText;
    if(access.kind==='public'){
      allowedText='Anyone can normally open this door.';deniedText='No standard crew roles are excluded.';
    }else if(access.kind==='remote'){
      allowedText='This door is normally opened using a button or remote controls.';deniedText='A job ID alone does not open this remotely controlled door.';
    }else if(access.kind==='unknown'){
      allowedText='Access is assigned dynamically and could not be determined from the map.';deniedText='Excluded roles could not be determined from the map.';
    }else{
      allowedText=access.roles.length?access.roles.join(', ')+'.':'No standard starting job ID is known to open this door.';
      deniedText=meta.jobRoles?.length?(denied.length?denied.join(', ')+'.':'No standard crew roles are excluded.'):'The complete crew role list is unavailable.';
    }
    section.innerHTML=`<h4 class="info-heading">Who can open ${escape(door.name)}</h4><p class="friendly-description">${escape(allowedText)}</p><h4 class="info-heading">Who can NOT open ${escape(door.name)}</h4><p class="friendly-description">${escape(deniedText)}</p>${access.expandedRoles?.length?`<p class="friendly-description">With expanded departmental access, it can also open for: ${escape(access.expandedRoles.join(', '))}.</p>`:''}${access.kind==='restricted'?'<p class="helper-text">Both lists use normal starting ID access. Access granted or changed during a round can differ.</p>':''}`;
    const controls=(meta.doorControls||[]).filter(control=>(door.controlKeys||[]).some(key=>key.kind===control.kind&&key.id===control.id)&&(!control.range||(control.z===z&&Math.max(Math.abs(control.x-x),Math.abs(control.y-y))<=control.range)));
    if(controls.length){const heading=document.createElement('h4');heading.className='info-heading';heading.textContent='Buttons & controls for '+door.name;section.append(heading);for(const control of controls){const link=document.createElement('a');link.className='door-control-link';link.textContent=`${control.name} - Deck ${control.z} · ${control.x}, ${control.y}`;link.href=viewFragment({...state,z:control.z,x:(control.x-.5)*32,y:(meta.height-control.y+.5)*32,zoom:Math.max(state.zoom,1),selected:control,result:null,finding:null,offsetHighlights:new Set([control.atomIndex])});link.onclick=event=>{if(event.ctrlKey||event.metaKey||event.shiftKey)return;event.preventDefault();setDeck(control.z);state.x=(control.x-.5)*32;state.y=(meta.height-control.y+.5)*32;state.zoom=Math.max(state.zoom,1);inspect(control.x,control.y,control.z,null,[control.atomIndex]);redraw();share();};section.append(link);}}
    else if(access.kind==='remote'){const note=document.createElement('p');note.className='helper-text';note.textContent='No matching button is recorded in this station snapshot.';section.append(note);}
    if($('detailed-view').checked){
      const sourceLink=file=>`<a href="${escape(`${state.manifest.repository.replace(/\.git$/,'')}/blob/${state.manifest.commit}/${file}`)}" target="_blank" rel="noreferrer">${escape(file)} ↗</a>`;
      const declaration=item=>`<li><code>${escape(item.type)}<br>${escape(item.property)} = ${escape(item.value)}</code><br>${item.mapped?'Mapped override: '+meta.files.map(sourceLink).join('<br>'):sourceLink(item.file)}</li>`;
      const sources=access.sources,provenance=document.createElement('details');provenance.className='access-provenance';
      const roles=Object.entries(meta.jobRoleSources||{});
      provenance.innerHTML=`<summary>Access rules &amp; source data</summary><pre>${escape(JSON.stringify({kind:access.kind,all:access.all||[],any:access.any||[],normalRoles:access.roles,expandedRoles:access.expandedRoles},null,2))}</pre><h4>Door requirements</h4>${sources?.requirements?.length?'<ul>'+sources.requirements.map(declaration).join('')+'</ul>':'<p>No static requirement declaration was recorded.</p>'}<h4>Mapped access helpers</h4>${sources?.helpers?.length?'<ul>'+sources.helpers.map(helper=>`<li><code>${escape(helper.mappedType)}<br>${escape(helper.type+'/'+helper.method)}<br>${escape(helper.access.join(', '))}</code><br>${sourceLink(helper.file)}</li>`).join('')+'</ul>':'<p>No mapped access helper was recorded.</p>'}<details><summary>Job ID access definitions (${roles.length})</summary>${roles.map(([role,source])=>`<h4>${escape(role)}</h4><code>${escape(source.type)}</code><ul>${source.declarations.map(declaration).join('')}</ul>${Object.keys(source.mapChanges||{}).length?`<pre>${escape(JSON.stringify(source.mapChanges,null,2))}</pre>${sourceLink('_maps/'+meta.id+'.json')}`:''}`).join('')}</details>`;
      section.append(provenance);
    }
    $('inspector').append(section);
  }
  if(!$('detailed-view').checked&&def.runtimeTerrain&&$('runtime-terrain').checked){const note=document.createElement('p');note.className='helper-text';note.textContent='Representative terrain preview. The exact landscape is generated when each round starts.';$('inspector').append(note);}
  const offsetObjects=def.atoms.map((atom,index)=>({atom,index})).filter(({atom})=>atom.visual);
  if(offsetObjects.length){const section=document.createElement('section');section.className='offset-objects';section.innerHTML='<h4 class="info-heading">Objects drawn beside this tile</h4><p class="helper-text">Highlight the actual position of each wall-mounted or offset object.</p>';
    for(const {atom,index}of offsetObjects){const label=document.createElement('label');label.className='toggle-row';const text=document.createElement('span');text.textContent=atom.name;const input=document.createElement('input');input.type='checkbox';input.dataset.objectIndex=index;input.setAttribute('aria-label','Highlight '+atom.name);input.checked=state.offsetHighlights?.has(index)||false;input.onchange=()=>{state.offsetHighlights||=new Set();input.checked?state.offsetHighlights.add(index):state.offsetHighlights.delete(index);redraw();share();};label.append(text,input);section.append(label);}$('inspector').append(section);
  }
  $('inspector').querySelector('.close').onclick=clearSelection;
}
$('detailed-view').onchange=paintInspector;

const pointers = new Map(); let dragged = false, down = null, pinchDistance = 0, tapCandidate = null;
canvas.onpointerdown = event => {
  tapCandidate=null;
  canvas.focus(); canvas.setPointerCapture(event.pointerId); pointers.set(event.pointerId, [event.clientX, event.clientY]);
  down = [event.clientX, event.clientY]; dragged = false;
  if (pointers.size === 2) { const p = [...pointers.values()]; pinchDistance = Math.hypot(p[0][0] - p[1][0], p[0][1] - p[1][1]); dragged = true; }
};
canvas.onpointermove = event => {
  const rect = canvas.getBoundingClientRect(), sx = event.clientX - rect.left, sy = event.clientY - rect.top;
  if (state.map) {
    const x = Math.floor((state.x + (sx - screenCenterX()) / state.zoom) / 32) + 1;
    const y = state.map.height - Math.floor((state.y + (sy - screenCenterY()) / state.zoom) / 32);
    $('coords').textContent = `X ${x} / Y ${y} / Z ${state.z}`;
  }
  const previous = pointers.get(event.pointerId); if (!previous) return;
  pointers.set(event.pointerId, [event.clientX, event.clientY]);
  if (pointers.size === 2) {
    const p = [...pointers.values()], distance = Math.hypot(p[0][0] - p[1][0], p[0][1] - p[1][1]);
    if (pinchDistance > 0) zoom(distance / pinchDistance, (p[0][0] + p[1][0]) / 2 - rect.left, (p[0][1] + p[1][1]) / 2 - rect.top);
    pinchDistance = distance; return;
  }
  if (down && Math.hypot(event.clientX - down[0], event.clientY - down[1]) > 4) dragged = true;
  state.x -= (event.clientX - previous[0]) / state.zoom; state.y -= (event.clientY - previous[1]) / state.zoom; redraw(); share();
};
canvas.onpointerup = event => {
  pointers.delete(event.pointerId);
  if (!dragged && !pointers.size && state.map) {
    const rect = canvas.getBoundingClientRect();
    const x = Math.floor((state.x + (event.clientX - rect.left - screenCenterX()) / state.zoom) / 32) + 1;
    const y = state.map.height - Math.floor((state.y + (event.clientY - rect.top - screenCenterY()) / state.zoom) / 32);
    tapCandidate={x,y,generation:state.generation};
  }
  if (!pointers.size) down = null;
};
// Open the sidebar during the completed click, not pointerup. Touch browsers
// otherwise deliver the same tap's click to a newly revealed checkbox.
canvas.onclick=event=>{const tile=tapCandidate;tapCandidate=null;if(tile&&tile.generation===state.generation){event.preventDefault();event.stopPropagation();inspect(tile.x,tile.y);}};
canvas.onpointercancel = event => { pointers.delete(event.pointerId); dragged = true;tapCandidate=null;if(!pointers.size)down=null; };
canvas.addEventListener('wheel', event => { event.preventDefault(); const rect = canvas.getBoundingClientRect(); zoom(Math.exp(-event.deltaY * .0015), event.clientX - rect.left, event.clientY - rect.top); }, { passive: false });
canvas.ondblclick = event => { const rect = canvas.getBoundingClientRect(); zoom(1.8, event.clientX - rect.left, event.clientY - rect.top); };
$('zoom-in').onclick = () => zoom(1.5); $('zoom-out').onclick = () => zoom(1 / 1.5); $('fit').onclick = fit;
$('station').onchange = event => event.target.value?loadStation(event.target.value):showMapPicker();
function renderDoorRoles(){
  const list=$('door-role-tags');list.replaceChildren();
  for(const role of state.doorRoles||[]){const tag=document.createElement('button');tag.type='button';tag.className='role-tag';tag.textContent=role+' ×';tag.setAttribute('aria-label','Remove '+role);tag.onclick=()=>changeDoorRoles(state.doorRoles.filter(item=>item!==role));list.append(tag);}
  $('clear-door-roles').hidden=!state.doorRoles?.length;
}
function changeDoorRoles(roles){state.doorRoles=roles;doorMarkers=doorMarkersForRoles(doorTiles,roles);renderDoorRoles();const input=$('door-role-input');input.value='';input.focus();$('door-role-suggestions').hidden=true;input.setAttribute('aria-expanded','false');input.removeAttribute('aria-activedescendant');suggestedRoles=[];suggestedRoleIndex=0;redraw();share();}
function showRoleSuggestions(){
  const input=$('door-role-input'),list=$('door-role-suggestions');suggestedRoles=roleSuggestions(state.map?.jobRoles||[],input.value,state.doorRoles||[]);suggestedRoleIndex=0;list.replaceChildren();
  for(const [index,role]of suggestedRoles.entries()){const button=document.createElement('button');button.type='button';button.id='role-suggestion-'+index;button.setAttribute('role','option');button.setAttribute('aria-selected',String(index===0));button.textContent=role;button.onpointerdown=event=>event.preventDefault();button.onclick=()=>changeDoorRoles([...(state.doorRoles||[]),role]);list.append(button);}
  list.hidden=!suggestedRoles.length;input.setAttribute('aria-expanded',String(!list.hidden));if(suggestedRoles.length)input.setAttribute('aria-activedescendant','role-suggestion-0');else input.removeAttribute('aria-activedescendant');
}
$('door-role-input').oninput=showRoleSuggestions;$('door-role-input').onfocus=showRoleSuggestions;$('door-role-input').onclick=showRoleSuggestions;
$('door-role-input').onblur=()=>{$('door-role-suggestions').hidden=true;$('door-role-input').setAttribute('aria-expanded','false');$('door-role-input').removeAttribute('aria-activedescendant');};
$('door-role-input').onkeydown=event=>{
  if(['ArrowDown','ArrowUp','Enter','Escape'].includes(event.key)){event.preventDefault();event.stopPropagation();
    if(event.key==='Escape'){$('door-role-input').blur();return;}
    if(event.key==='Enter'){if(!$('door-role-suggestions').hidden&&suggestedRoles[suggestedRoleIndex])changeDoorRoles([...(state.doorRoles||[]),suggestedRoles[suggestedRoleIndex]]);return;}
    if(!suggestedRoles.length)return;suggestedRoleIndex=(suggestedRoleIndex+(event.key==='ArrowDown'?1:-1)+suggestedRoles.length)%suggestedRoles.length;
    for(const [index,button]of [...$('door-role-suggestions').children].entries())button.setAttribute('aria-selected',String(index===suggestedRoleIndex));$('door-role-input').setAttribute('aria-activedescendant','role-suggestion-'+suggestedRoleIndex);
  }else if(event.key==='Backspace'&&!$('door-role-input').value&&state.doorRoles?.length){event.preventDefault();changeDoorRoles(state.doorRoles.slice(0,-1));}
};
$('clear-door-roles').onclick=()=>changeDoorRoles([]);
for (const key of ['regions', 'cutaway', 'motion']) $(key).onchange = event => { state[key] = event.target.checked; if (key === 'motion') updateSpaceAnimation(); redraw(); };
$('search').oninput = () => { updateSearchReset();clearTimeout(timer); searchSeq++; state.query = $('search').value; share(); timer = setTimeout(runSearch, 130); };
$('reset-search').onclick = () => {
  clearTimeout(timer); $('search').value = ''; searchSeq++; locationSeq++;
  locationTarget = null; finding = null; state.result = null; state.finding = null;
  state.markers = []; inspectedResult = null; $('search-findings').hidden = true;
  $('results').replaceChildren(); runSearch(); paintInspector(); redraw(); $('search').focus();
};
for (const key of ['placed', 'possible']) $(key).onchange = runSearch;
for(const key of ['power-networks','simple-utilities','connections','connection-labels'])$(key).onchange=()=>{
  if(key==='power-networks'&&$('power-networks').checked){enabled.add('power');document.querySelector('#network-controls input[aria-label="Power cables"]').checked=true;}
  utilityPaths.clear();redraw();
};
$('runtime-terrain').onchange=()=>{if(!state.map)showMapPicker();else{paintInspector();redraw();}};
document.onkeydown = event => {
  if (/INPUT|SELECT|TEXTAREA/.test(event.target.tagName)) { if (event.key === 'Escape') event.target.blur(); return; }
  if (event.key === '/') { event.preventDefault(); sidebar(false); sidebarView('search'); $('search').focus(); }
  if (event.key.toLowerCase() === 'f') fit();
  if (event.key === '+' || event.key === '=') zoom(1.4);
  if (event.key === '-') zoom(1 / 1.4);
  if (event.key === 'Escape') { if (state.selected) clearSelection(); else sidebar(true); }
  const shifts = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
  if (shifts[event.key]) { event.preventDefault(); const [x, y] = shifts[event.key]; state.x += x * 90 / state.zoom; state.y += y * 90 / state.zoom; redraw(); share(); }
};
window.addEventListener('hashchange', () => {
  const params = new URLSearchParams(location.hash.slice(1)), id = params.get('m');
  if (state.manifest?.maps.some(m => m.id === id)) { $('station').value = id; loadStation(id, true); }
  else if(state.manifest)showMapPicker();
});

function showMapPicker(){
  assetCache.activeView=false;
  $('search').disabled=true;$('search-status').textContent='Choose a station to search its rooms and items.';$('results').replaceChildren();$('inspect-tab').disabled=true;state.selected=null;finding=null;sidebarView(false);
  state.generation++;loadAbort?.abort();state.map=null;state.ready=false;loadingStation=false;assetCache.foregroundBusy=false;canvas.style.pointerEvents='';setLoading('',false);$('map-picker').hidden=false;$('station').value='';$('map-title').textContent='Choose a station';$('map-subtitle').textContent=`${state.manifest.maps.length} map configurations available`;$('station-meta').textContent='';$('source-status').textContent='ARCHIVE READY';document.querySelector('.floating-decks').hidden=true;document.querySelector('.map-tools').hidden=true;
  history.replaceState(null,'',location.pathname+location.search+(new URLSearchParams(location.hash.slice(1)).has('o')?'#o='+encodeOptions(Object.fromEntries(Object.keys(optionBits).map(key=>[key,$(key).checked]))):''));$('map-cards').replaceChildren();
  for(const map of state.manifest.maps){
    const button=document.createElement('button');button.className='map-card';button.innerHTML=`${map.preview===null?'<div class="map-preview-empty">Preview unavailable</div>':'<img alt="" loading="lazy">'}<strong>${escape(map.name)}</strong><small>${map.levels.length} ${map.levels.length===1?'deck':'decks'} · ${map.width} × ${map.height} tiles</small>`;
    button.onclick=()=>{$('station').value=map.id;loadStation(map.id);};
    const card=document.createElement('div');card.className='map-card-entry';card.append(button);
    $('map-cards').append(card);
    if(map.preview===null)continue;
    const path=($('runtime-terrain').checked&&map.naturalPreview)||map.preview||`${map.id}/preview.webp`;
    assetCache.get(resolve(path),path).then(blob=>{const url=URL.createObjectURL(blob),img=button.querySelector('img');img.onload=()=>URL.revokeObjectURL(url);img.src=url;}).catch(()=>{});
  }
  redraw();
}

for(const key of Object.keys(optionBits))$(key).addEventListener('change',share);
restoreOptions(new URLSearchParams(location.hash.slice(1)));
try {
  state.manifest = await json('manifest.json');
  dataBase = new URL(state.manifest.dataPath || './',base);
  assetCache.setManifest(state.manifest);
  const requested=new URLSearchParams(location.hash.slice(1)).get('m');
  if(state.manifest.maps.some(map=>map.id===requested))assetCache.setCurrentMap(requested);
  await chooseStorage();
  if(assetCache.enabled)await assetCache.write(`${assetCache.scope}:catalog`,new Blob([JSON.stringify(state.manifest)],{type:'application/json'}));
  const repository = state.manifest.repository.replace(/\.git$/, '');
  $('source-link').href = repository; $('commit-link').href = `${repository}/commit/${state.manifest.commit}`; $('commit-link').textContent = `${state.manifest.commit.slice(0, 12)} ↗`;
  const placeholder=document.createElement('option');placeholder.value='';placeholder.textContent='Choose a map…';$('station').append(placeholder);
  for (const map of state.manifest.maps) { const option = document.createElement('option'); option.value = map.id; option.textContent = map.name; $('station').append(option); }
  const params = new URLSearchParams(location.hash.slice(1)), id = params.get('m');
  if(state.manifest.maps.some(map=>map.id===id)){$('station').value=id;await loadStation(id,true);}else showMapPicker();
  if(!state.map)warmStorage();
} catch (error) { $('loading').classList.add('error');setLoading(`Archive unavailable: ${error.message}. Run pnpm source && pnpm export before starting the viewer.`); }
