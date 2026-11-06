// The search sidebar: queries run in a worker; a result expands into its list
// of findings (locations), which are drawn as rings on the map.
import { $, escapeHtml } from '../core/dom.ts';
import { redraw } from '../core/frame.ts';
import { inspect, receiveTileCandidates } from './inspector.ts';
import { showSidebarView } from './layout.ts';
import { tileCenterX, tileCenterY } from '../rendering/projection.ts';
import { definitionAt, state } from '../core/state.ts';
import { setDeck } from './station.ts';
import type { MapMeta, SearchHit, SearchRecord, TileCandidate } from '../core/types.ts';
import { share } from './url-state.ts';

const FINDINGS_PER_PAGE = 30;
const SEARCH_DEBOUNCE_MS = 130;
const READY_STATUS = 'Search rooms, mapped items & loot candidates';

/** A finding named by a link (`r=`, `f=`, `t=`), restored once the index is ready. */
export interface RestoreTarget {
  id: string;
  index: number;
  tile: string | null;
}

type WorkerMessage =
  | { type: 'ready' }
  | { type: 'error'; message: string }
  | { type: 'results'; seq: number; total: number; results: SearchHit[] }
  | { type: 'locations'; seq: number; result: SearchRecord | undefined }
  | { type: 'tile'; seq: number; possible: TileCandidate[] };

let worker: Worker | null = null;
let searchSeq = 0;
/** Increments whenever the shown finding changes, so stale location replies are ignored. */
let locationSeq = 0;
let tileSeq = 0;
let debounceTimer: ReturnType<typeof setTimeout> | undefined;
let finding: SearchRecord | null = null;
let findingPage = 0;
let findingIndex = 0;
let locationTarget: RestoreTarget | null = null;

export function updateSearchReset(): void {
  $('reset-search').hidden = !$<HTMLInputElement>('search').value.length;
}

function searchInput(): HTMLInputElement {
  return $<HTMLInputElement>('search');
}

export function runSearch(): void {
  updateSearchReset();
  searchSeq++;
  state.query = searchInput().value;
  state.placed = $<HTMLInputElement>('placed').checked;
  state.possible = $<HTMLInputElement>('possible').checked;
  share();
  if (!state.searchReady) return;
  const query = searchInput().value.trim();
  if (!query) {
    $('results').replaceChildren();
    $('search-status').textContent = READY_STATUS;
    return;
  }
  worker?.postMessage({
    type: 'query',
    seq: searchSeq,
    query,
    placed: state.placed,
    possible: state.possible,
  });
}

function showResults(data: { total: number; results: SearchHit[] }): void {
  $('results').replaceChildren();
  $('search-status').textContent = `${data.total} matches${data.total > 70 ? ' · showing first 70' : ''}`;
  for (const result of data.results) {
    const button = document.createElement('button');
    button.className = 'result';
    button.disabled = state.loadingStation;
    const unit = result.kind === 'room' ? 'decks' : 'locations';
    button.innerHTML = `${escapeHtml(result.name)}<small>${escapeHtml(result.kind.toUpperCase())} · ${result.count} ${unit}</small>`;
    button.onclick = () => {
      locationTarget = null;
      worker?.postMessage({ type: 'locations', id: result.id, seq: ++locationSeq });
    };
    $('results').append(button);
  }
}

/** Shows one location of the current finding group, optionally moving the camera to it. */
export function selectFinding(index: number, { focus = true } = {}): void {
  if (!finding || index < 0 || index >= finding.count) return;
  // setDeck can clear a previous tile selection; retain the finding group.
  const result = finding;
  const [x, y, z] = result.points.slice(index * 3, index * 3 + 3);
  setDeck(z);
  finding = result;
  state.markers = result.points;
  findingIndex = index;
  findingPage = Math.floor(index / FINDINGS_PER_PAGE);
  state.result = result.id;
  state.finding = index;
  if (focus) {
    state.x = tileCenterX(x);
    state.y = tileCenterY(y);
    state.zoom = Math.max(state.zoom, 1);
  }
  inspect(x, y, z, result);
  showFindings();
  redraw();
  share();
}

function showFindings(): void {
  const panel = $('search-findings');
  if (!finding) {
    panel.hidden = true;
    return;
  }
  const start = findingPage * FINDINGS_PER_PAGE;
  const end = Math.min(finding.count, start + FINDINGS_PER_PAGE);
  panel.innerHTML = `<button class="back-to-search">← Search results</button>
<h2>${escapeHtml(finding.name)}</h2>
<p>${escapeHtml(finding.kind.toUpperCase())} · ${finding.count} findings</p>
<div class="finding-list"></div>
<div class="finding-pages">
<button class="previous" ${start === 0 ? 'disabled' : ''} aria-label="Previous findings">←</button>
<span>${start + 1}–${end} / ${finding.count}</span>
<button class="next" ${end >= finding.count ? 'disabled' : ''} aria-label="Next findings">→</button>
</div>`;
  const list = panel.querySelector('.finding-list')!;
  for (let index = start; index < end; index++) {
    const [x, y, z] = finding.points.slice(index * 3, index * 3 + 3);
    const definition = definitionAt(x, y, z);
    const button = document.createElement('button');
    button.className = 'finding-location';
    button.dataset.index = String(index);
    button.setAttribute('aria-pressed', String(index === findingIndex));
    const area = definition ? state.map!.areas[definition.area].name : 'Unknown area';
    button.innerHTML = `<span>${index + 1}. ${escapeHtml(area)}</span><small>Z${z} · X ${x} / Y ${y}</small>`;
    button.onclick = () => selectFinding(index);
    list.append(button);
  }
  panel.querySelector<HTMLButtonElement>('.back-to-search')!.onclick = () => showSidebarView('search');
  panel.querySelector<HTMLButtonElement>('.previous')!.onclick = () => {
    findingPage--;
    showFindings();
  };
  panel.querySelector<HTMLButtonElement>('.next')!.onclick = () => {
    findingPage++;
    showFindings();
  };
  panel.hidden = false;
}

/** Drops the current finding group and its markers. */
export function clearFinding(): void {
  finding = null;
  locationTarget = null;
  locationSeq++;
  state.markers = [];
  state.result = null;
  state.finding = null;
  $('search-findings').hidden = true;
}

/** Shows a finding of a search record again, as the in-app history does. */
export function showFinding(id: string, index: number, tile: string | null): void {
  if (!state.searchReady) return;
  locationTarget = { id, index, tile };
  worker?.postMessage({ type: 'locations', id, seq: ++locationSeq });
}

/** Asks the worker which random spawns are recorded on a tile; the inspector shows the reply. */
export function requestTileCandidates(x: number, y: number, z: number): void {
  if (state.searchReady) worker?.postMessage({ type: 'tile', tile: `${x},${y},${z}`, seq: ++tileSeq });
}

/** Resets the search panel while a station loads, keeping or restoring the query. */
export function prepareSearchForStation(query: string): void {
  clearFinding();
  searchInput().value = state.query = query;
  updateSearchReset();
  state.placed = $<HTMLInputElement>('placed').checked;
  state.possible = $<HTMLInputElement>('possible').checked;
  $('results').replaceChildren();
  state.searchReady = false;
  $('search-status').textContent = 'Preparing search index…';
  searchInput().disabled = true;
}

export function enableSearch(): void {
  searchInput().disabled = false;
  for (const button of $('results').children) (button as HTMLButtonElement).disabled = false;
}

export function disableSearch(message: string): void {
  searchInput().disabled = true;
  $('search-status').textContent = message;
  $('results').replaceChildren();
  finding = null;
}

/** Finds the index of a point triple within a finding's points, or -1. */
function indexOfPoint(record: SearchRecord, tile: string): number {
  for (let p = 0; p < record.points.length; p += 3)
    if (record.points.slice(p, p + 3).join(',') === tile) return p / 3;
  return -1;
}

/** The first finding on the viewed deck, or the first finding overall. */
function defaultFindingIndex(record: SearchRecord): number {
  for (let p = 0; p < record.points.length; p += 3) if (record.points[p + 2] === state.z) return p / 3;
  return 0;
}

/**
 * Starts a search worker for a station. Resolves `indexReady` once searching
 * works and `restoreReady` once a finding named by the link is shown (or
 * immediately when the link names none), so the loading overlay can wait.
 */
export function startSearchWorker(
  generation: number,
  map: MapMeta,
  searchBytes: ArrayBuffer,
  restoreTarget: RestoreTarget | null,
): { indexReady: Promise<void>; restoreReady: Promise<void> } {
  const restoreVersion = locationSeq;
  let resolveIndex!: () => void;
  const indexReady = new Promise<void>((resolve) => (resolveIndex = resolve));
  let resolveRestore!: () => void;
  const restoreReady = new Promise<void>((resolve) => (resolveRestore = resolve));
  if (!restoreTarget) resolveRestore();
  worker?.terminate();
  worker = new Worker(new URL('../workers/search.worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = ({ data }: MessageEvent<WorkerMessage>) => {
    if (generation !== state.generation) return;
    switch (data.type) {
      case 'ready':
        state.searchReady = true;
        $('search-status').textContent = READY_STATUS;
        runSearch();
        resolveIndex();
        if (state.selected) requestTileCandidates(state.selected.x, state.selected.y, state.selected.z);
        if (restoreTarget && restoreVersion === locationSeq) {
          locationTarget = restoreTarget;
          worker?.postMessage({ type: 'locations', id: restoreTarget.id, seq: ++locationSeq });
        } else resolveRestore();
        break;
      case 'error':
        $('search-status').textContent = data.message;
        resolveIndex();
        resolveRestore();
        break;
      case 'tile':
        if (data.seq === tileSeq) receiveTileCandidates(data.possible);
        break;
      case 'results':
        if (data.seq === searchSeq) showResults(data);
        break;
      case 'locations':
        if (data.seq !== locationSeq) break;
        if (!data.result) {
          resolveRestore();
          break;
        }
        {
          const restoring = !!locationTarget;
          finding = data.result;
          let index = defaultFindingIndex(finding);
          if (locationTarget) {
            index = Math.min(finding.count - 1, Math.floor(locationTarget.index));
            const named = locationTarget.tile ? indexOfPoint(finding, locationTarget.tile) : -1;
            if (named >= 0) index = named;
            locationTarget = null;
          }
          selectFinding(index, { focus: !restoring });
          resolveRestore();
        }
        break;
    }
  };
  // The worker parses and decodes the search records itself; transferring the
  // bytes avoids cloning a large object graph through the main thread.
  worker.postMessage({ type: 'init', buffer: searchBytes, generation, rooms: map.rooms || [] }, [
    searchBytes,
  ]);
  return { indexReady, restoreReady };
}

export function initSearch(onReset: () => void): void {
  searchInput().oninput = () => {
    updateSearchReset();
    clearTimeout(debounceTimer);
    searchSeq++;
    state.query = searchInput().value;
    share();
    debounceTimer = setTimeout(runSearch, SEARCH_DEBOUNCE_MS);
  };
  $('reset-search').onclick = () => {
    clearTimeout(debounceTimer);
    searchInput().value = '';
    searchSeq++;
    clearFinding();
    $('results').replaceChildren();
    runSearch();
    onReset();
    redraw();
    searchInput().focus();
  };
  for (const key of ['placed', 'possible']) $(key).onchange = runSearch;
}
