// In-app back and forward navigation between jumps: tile selections, search
// findings and door control links. Panning and zooming are not recorded, and
// the browser history is never touched, so the back button of the browser
// still leaves the page as expected.
import { $ } from '../core/dom.ts';
import { redraw } from '../core/frame.ts';
import { state } from '../core/state.ts';
import type { AreaSelection, TileRef } from '../model/view-state.ts';
import { clearSelection, inspect, inspectArea } from './inspector.ts';
import { showFinding } from './search.ts';
import { setDeck } from './station.ts';
import { share } from './url-state.ts';

const MAX_DEPTH = 50;

interface ViewEntry {
  x: number;
  y: number;
  zoom: number;
  z: number;
  selected: TileRef | null;
  selectedArea: AreaSelection | null;
  highlights: number[];
  result: string | null;
  finding: number | null;
}

const entries: ViewEntry[] = [];
let index = -1;
let restoring = false;

function capture(): ViewEntry {
  return {
    x: state.x,
    y: state.y,
    zoom: state.zoom,
    z: state.z,
    selected: state.selected ? { ...state.selected } : null,
    selectedArea: state.selectedArea ? { ...state.selectedArea } : null,
    highlights: [...state.offsetHighlights],
    result: state.result,
    finding: state.finding,
  };
}

/** Two entries are the same jump when they select the same thing on the same deck. */
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

function updateButtons(): void {
  $<HTMLButtonElement>('history-back').disabled = !canGoBack();
  $<HTMLButtonElement>('history-forward').disabled = !canGoForward();
  syncMouseHistory();
}

let mouseHistoryInstalled = false;
let heldButton: number | null = null;
let mouseNavigated = false;
let releaseTimer: ReturnType<typeof setTimeout> | undefined;

function mouseHistory(event: MouseEvent): void {
  if (event.button !== 3 && event.button !== 4) return;
  const available = event.button === 3 ? canGoBack() : canGoForward();
  if (event.type === 'mousedown') {
    heldButton = available ? event.button : null;
    mouseNavigated = false;
  }
  if (heldButton !== event.button && !available) return;
  event.preventDefault();
  if (event.type !== 'mousedown' && !mouseNavigated) {
    mouseNavigated = true;
    heldButton = event.button;
    if (event.button === 3) goBack();
    else goForward();
  }
  clearTimeout(releaseTimer);
  const release = () => {
    heldButton = null;
    mouseNavigated = false;
    syncMouseHistory();
  };
  if (event.type === 'auxclick') release();
  else releaseTimer = setTimeout(release, 1000);
}

/** No cancellation at a history boundary: the browser's own navigation takes over. */
function syncMouseHistory(): void {
  const needed = canGoBack() || canGoForward() || heldButton !== null;
  if (needed === mouseHistoryInstalled) return;
  mouseHistoryInstalled = needed;
  for (const type of ['mousedown', 'mouseup', 'auxclick'] as const) {
    if (needed) document.addEventListener(type, mouseHistory, true);
    else document.removeEventListener(type, mouseHistory, true);
  }
}

export function canGoBack(): boolean {
  return index > 0;
}

export function canGoForward(): boolean {
  return index >= 0 && index < entries.length - 1;
}

/** Records the current view as a jump target. Re-recording the same jump only refreshes its camera. */
export function recordJump(): void {
  if (restoring || !state.map) return;
  const entry = capture();
  if (index >= 0 && sameJump(entries[index], entry)) {
    entries[index] = entry;
    updateButtons();
    return;
  }
  entries.splice(index + 1);
  entries.push(entry);
  if (entries.length > MAX_DEPTH) entries.shift();
  index = entries.length - 1;
  updateButtons();
}

export function resetHistory(): void {
  heldButton = null;
  clearTimeout(releaseTimer);
  entries.length = 0;
  index = -1;
  updateButtons();
}

/** Runs `action` without recording the jumps it performs, such as restoring a link. */
export function withoutHistory<T>(action: () => T): T {
  const previous = restoring;
  restoring = true;
  try {
    return action();
  } finally {
    restoring = previous;
  }
}

function apply(entry: ViewEntry): void {
  withoutHistory(() => {
    state.x = entry.x;
    state.y = entry.y;
    state.zoom = entry.zoom;
    if (state.z !== entry.z) setDeck(entry.z);
    if (entry.selectedArea) inspectArea(entry.selectedArea);
    else if (entry.result && entry.finding !== null) {
      const tile = entry.selected ? `${entry.selected.x},${entry.selected.y},${entry.selected.z}` : null;
      showFinding(entry.result, entry.finding, tile);
    } else if (entry.selected)
      inspect(entry.selected.x, entry.selected.y, entry.selected.z, null, entry.highlights);
    else if (state.selected) clearSelection();
  });
  redraw();
  share();
  updateButtons();
}

export function goBack(): boolean {
  if (!canGoBack()) return false;
  index--;
  apply(entries[index]);
  return true;
}

export function goForward(): boolean {
  if (!canGoForward()) return false;
  index++;
  apply(entries[index]);
  return true;
}

export function initHistory(): void {
  $('history-back').onclick = () => goBack();
  $('history-forward').onclick = () => goForward();
  updateButtons();
}
