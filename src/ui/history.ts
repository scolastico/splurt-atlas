// Selection jumps are native same-document history entries. Camera and option
// changes replace the current entry; popstate restores the view without reloading.
import { $ } from '../core/dom.ts';
import { redraw } from '../core/frame.ts';
import { state } from '../core/state.ts';
import type { AreaSelection, TileRef } from '../model/view-state.ts';
import { validTelecomHighlights } from '../model/telecomms.ts';
import { clearSelection, inspect, inspectArea, paintInspector } from './inspector.ts';
import { showFinding, restoreSearchQuery } from './search.ts';
import { loadStation, setDeck } from './station.ts';
import { loadDoorRoles } from './door-roles.ts';
import { cancelShare, currentViewFragment, restoreOptions, share } from './url-state.ts';

interface ViewEntry {
  x: number;
  y: number;
  zoom: number;
  z: number;
  selected: TileRef | null;
  selectedArea: AreaSelection | null;
  highlights: number[];
  telecomHighlights: number[];
  result: string | null;
  finding: number | null;
}

interface BrowserEntry {
  version: 1;
  session: string;
  position: number;
  map: string;
  view: ViewEntry;
}

const session = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const furthest = new Map<string, number>();
let current: BrowserEntry | null = null;
let restoring = false;
let browserRestoring = false;
let navigation = 0;
let handledPopUrl: string | null = null;

function capture(): ViewEntry {
  return {
    x: state.x,
    y: state.y,
    zoom: state.zoom,
    z: state.z,
    selected: state.selected ? { ...state.selected } : null,
    selectedArea: state.selectedArea ? { ...state.selectedArea } : null,
    highlights: [...state.offsetHighlights],
    telecomHighlights: [...state.telecomHighlights],
    result: state.result,
    finding: state.finding,
  };
}

function readEntry(value: unknown): BrowserEntry | null {
  const entry = (value as { atlasSelection?: BrowserEntry } | null)?.atlasSelection;
  return entry?.version === 1 &&
    typeof entry.session === 'string' &&
    typeof entry.map === 'string' &&
    Number.isSafeInteger(entry.position) &&
    entry.position >= 0 &&
    entry.view &&
    [entry.view.x, entry.view.y, entry.view.zoom, entry.view.z].every(Number.isFinite)
    ? entry
    : null;
}

function sameJump(a: ViewEntry, b: ViewEntry): boolean {
  return (
    a.z === b.z &&
    a.result === b.result &&
    a.finding === b.finding &&
    a.selected?.x === b.selected?.x &&
    a.selected?.y === b.selected?.y &&
    a.selected?.z === b.selected?.z &&
    JSON.stringify(a.selectedArea) === JSON.stringify(b.selectedArea)
  );
}

function write(entry: BrowserEntry, url: string, push: boolean): void {
  const data = { ...history.state, atlasSelection: entry };
  if (push) history.pushState(data, '', url);
  else history.replaceState(data, '', url);
  current = entry;
  if (push) furthest.set(entry.session, entry.position);
  else furthest.set(entry.session, Math.max(furthest.get(entry.session) || 0, entry.position));
  updateButtons();
}

function updateButtons(): void {
  $<HTMLButtonElement>('history-back').disabled = !canGoBack();
  $<HTMLButtonElement>('history-forward').disabled = !canGoForward();
}

export function canGoBack(): boolean {
  return !!current && current.position > 0;
}
export function canGoForward(): boolean {
  return !!current && current.position < (furthest.get(current.session) || 0);
}

/** Camera/options only refresh the current browser entry and its saved view. */
export function replaceHistoryView(url: string): void {
  if (browserRestoring) return;
  const entry = readEntry(history.state);
  if (entry && state.map?.id === entry.map) write({ ...entry, view: capture() }, url, false);
  else {
    const data = { ...history.state };
    delete data.atlasSelection;
    history.replaceState(data, '', url);
    current = null;
    updateButtons();
  }
}

/** Every distinct selection pushes once. Re-selecting it or changing highlights replaces it. */
export function recordJump(): void {
  if (restoring || browserRestoring || !state.map) return;
  cancelShare();
  const url = currentViewFragment(),
    view = capture();
  const previous = readEntry(history.state);
  const push =
    !!previous &&
    (previous.map !== state.map.id || (!state.loadingStation && !sameJump(previous.view, view)));
  const entry: BrowserEntry = {
    version: 1,
    session: previous?.session || session,
    position: previous ? previous.position + (push ? 1 : 0) : 0,
    map: state.map.id,
    view,
  };
  write(entry, url, push);
}

/** Map loading resets the active UI, while native history retains earlier maps and selections. */
export function resetHistory(): void {
  current = readEntry(history.state);
  if (current) furthest.set(current.session, Math.max(furthest.get(current.session) || 0, current.position));
  updateButtons();
}

export function withoutHistory<T>(action: () => T): T {
  const previous = restoring;
  restoring = true;
  try {
    return action();
  } finally {
    restoring = previous;
  }
}

async function apply(entry: ViewEntry, token: number): Promise<void> {
  state.x = entry.x;
  state.y = entry.y;
  state.zoom = entry.zoom;
  if (state.z !== entry.z) setDeck(entry.z);
  if (entry.selectedArea) inspectArea(entry.selectedArea, entry.telecomHighlights);
  else if (entry.result && entry.finding !== null && state.searchReady) {
    const tile = entry.selected ? `${entry.selected.x},${entry.selected.y},${entry.selected.z}` : null;
    await showFinding(entry.result, entry.finding, tile);
    if (token !== navigation) return;
    state.offsetHighlights = new Set(entry.highlights);
    state.telecomHighlights = validTelecomHighlights(
      state.map!,
      state.selected,
      state.selectedArea,
      entry.telecomHighlights,
    );
    paintInspector();
  } else if (entry.selected)
    inspect(
      entry.selected.x,
      entry.selected.y,
      entry.selected.z,
      null,
      entry.highlights,
      entry.telecomHighlights,
    );
  else clearSelection();
  redraw();
}

/** Popstate also emits hashchange; the normal hash loader must not load the map again. */
export function consumeHistoryHashChange(): boolean {
  const handled = handledPopUrl === location.href;
  handledPopUrl = null;
  return handled;
}

async function onPopState(event: PopStateEvent): Promise<void> {
  const token = ++navigation;
  cancelShare();
  current = readEntry(event.state);
  if (!current) {
    browserRestoring = false;
    updateButtons();
    return;
  }
  const target = current;
  furthest.set(target.session, Math.max(furthest.get(target.session) || 0, target.position));
  browserRestoring = true;
  handledPopUrl = location.href;
  updateButtons();
  try {
    if (state.map?.id === target.map && state.ready && !state.loadingStation) {
      const params = new URLSearchParams(location.hash.slice(1));
      restoreOptions(params);
      loadDoorRoles(state.map, (params.get('j') || '').split(','));
      restoreSearchQuery(params.get('q') || '');
      await apply(target.view, token);
    } else {
      $<HTMLSelectElement>('station').value = target.map;
      await loadStation(target.map, true);
    }
  } finally {
    if (token === navigation) {
      browserRestoring = false;
      if (state.map?.id === target.map && state.ready) share(true);
      updateButtons();
    }
  }
}

export function goBack(): boolean {
  if (!canGoBack()) return false;
  cancelShare();
  history.back();
  return true;
}

export function goForward(): boolean {
  if (!canGoForward()) return false;
  cancelShare();
  history.forward();
  return true;
}

export function initHistory(): void {
  history.scrollRestoration = 'manual';
  resetHistory();
  $('history-back').onclick = () => goBack();
  $('history-forward').onclick = () => goForward();
  // Mouse side buttons use native history, including browsers that cannot cancel them.
  window.addEventListener('popstate', (event) => {
    void onPopState(event);
  });
}
