// Loading a station: decoding its metadata and decks, restoring the view from
// the link, and the station picker shown when no station is selected.
import { resetAnnotationCaches } from './annotations.ts';
import { mapCanvas } from './canvases.ts';
import { fit } from './camera.ts';
import { assetCache, fetchBytes, fetchJson, resolvePath } from './data.ts';
import { prepareView } from './deck-tiles.ts';
import { loadDoorRoles } from './door-roles.ts';
import { $, escapeHtml, isChecked } from './dom.ts';
import { redraw } from './frame.ts';
import { clearImages, setWarmImages } from './images.ts';
import { invalidateUtilityPaths } from './infrastructure-overlay.ts';
import { clearSelection, inspect } from './inspector.ts';
import { showSidebarView } from './layout.ts';
import { clearLoadingError, setLoading, showLoadingError } from './loading.ts';
import {
  disableSearch,
  enableSearch,
  prepareSearchForStation,
  startSearchWorker,
  type RestoreTarget,
} from './search.ts';
import { state, TILE, type DeckLevel } from './state.ts';
import { updateStorageSizes, warmStorage } from './storage-settings.ts';
import type { LevelData, MapMeta } from './types.ts';
import { currentHashParams, restoreOptions, share, shareOptionsOnly } from './url-state.ts';
import { selectedTile } from './view-state.ts';
import { decodeLevel, decodeMap } from '../scripts/lib/map-format.mjs';

let loadAbort: AbortController | null = null;

/** Switches the viewed deck, dropping a selection that belonged to another deck. */
export function setDeck(z: number): void {
  state.z = z;
  if (state.selected && state.selected.z !== z) clearSelection();
  for (const button of $('decks').children as HTMLCollectionOf<HTMLButtonElement>) {
    const active = Number(button.dataset.z) === z;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  }
  $('coords').textContent = `DECK ${z} / DRAG TO EXPLORE`;
  redraw();
  share();
}

function renderDeckButtons(map: MapMeta): void {
  $('decks').replaceChildren();
  for (const z of [...map.levels].reverse()) {
    const button = document.createElement('button');
    button.textContent = `Z${String(z).padStart(2, '0')}`;
    button.onclick = () => setDeck(z);
    button.dataset.z = String(z);
    button.setAttribute('aria-label', `Deck ${z}`);
    $('decks').append(button);
  }
}

function describeStation(map: MapMeta): void {
  const decks = map.levels.length;
  $('map-title').textContent = map.name;
  $('map-subtitle').textContent =
    `${decks} ${decks === 1 ? 'deck' : 'decks'} · ${map.areas.length} mapped areas · pre-round snapshot`;
  $('station-meta').textContent =
    `${map.width} × ${map.height} GRID / ${decks} Z-LEVEL${decks === 1 ? '' : 'S'}`;
  $('network-summary').textContent = map.infrastructure
    ? `${map.infrastructure.powerNetworks} separate mapped power networks. Colors describe wired connectivity before a round starts.`
    : '';
}

/** Applies the camera and selection a link describes, after the station is fitted. */
function restoreView(map: MapMeta, params: URLSearchParams): void {
  const hasView = ['x', 'y', 's'].every((key) => params.has(key) && Number.isFinite(Number(params.get(key))));
  if (hasView) {
    state.x = Math.max(0, Math.min(map.width * TILE, Number(params.get('x'))));
    state.y = Math.max(0, Math.min(map.height * TILE, Number(params.get('y'))));
    state.zoom = Math.max(0.04, Math.min(5, Number(params.get('s'))));
    redraw();
  }
  const tile = selectedTile(params, map);
  if (!tile) return;
  // A link that names a tile but no view (as the in-game "View in Browser"
  // link does) opens centered on that tile.
  if (!['x', 'y', 's'].some((key) => params.has(key))) {
    state.x = (tile.x - 1) * TILE + TILE / 2;
    state.y = (map.height - tile.y) * TILE + TILE / 2;
    state.zoom = 1;
    redraw();
  }
  if (state.z !== tile.z) setDeck(tile.z);
  const highlights = (params.get('h') || '')
    .split(',')
    .filter((value) => /^\d+$/.test(value))
    .map(Number);
  inspect(tile.x, tile.y, tile.z, null, highlights);
}

function withTileMasks(level: LevelData): DeckLevel {
  return {
    ...level,
    tileMasks: level.pyramid.map((tiles) => new Map(tiles.map(([x, y, mask]) => [`${x},${y}`, mask]))),
  };
}

/** Loads a station; with `restore`, the view and selection come from the link. */
export async function loadStation(id: string, restore = false): Promise<void> {
  const generation = ++state.generation;
  assetCache.setCurrentMap(id);
  updateStorageSizes();
  state.ready = false;
  state.loadingStation = true;
  assetCache.foregroundBusy = true;
  assetCache.activeView = true;
  invalidateUtilityPaths();
  setWarmImages([]);
  mapCanvas.style.pointerEvents = 'none';
  $('map-picker').hidden = true;
  document.querySelector<HTMLElement>('.floating-decks')!.hidden = false;
  document.querySelector<HTMLElement>('.map-tools')!.hidden = false;
  const params = currentHashParams();
  if (restore) restoreOptions(params);
  const restoreTarget: RestoreTarget | null =
    restore && params.get('r')
      ? {
          id: params.get('r')!,
          index: Math.max(0, (Number(params.get('f')) || 1) - 1),
          tile: params.get('t'),
        }
      : null;
  prepareSearchForStation(restore ? params.get('q') || '' : $<HTMLInputElement>('search').value);
  loadAbort?.abort();
  loadAbort = new AbortController();
  const { signal } = loadAbort;
  state.map = null;
  state.levels.clear();
  state.markers = [];
  state.selected = null;
  clearImages();
  resetAnnotationCaches();
  $<HTMLButtonElement>('inspect-tab').disabled = true;
  showSidebarView('explore');
  clearLoadingError();
  setLoading('Reading station archive…');
  try {
    const map = decodeMap(await fetchJson(`${id}/map.json`, signal)) as MapMeta;
    const levels = await Promise.all(map.levels.map((z) => fetchJson<LevelData>(`${id}/${z}.json`, signal)));
    if (generation !== state.generation) return;
    state.map = map;
    state.levels = new Map(levels.map((level) => [level.z, withTileMasks(decodeLevel(level) as LevelData)]));
    loadDoorRoles(map, restore ? (params.get('j') || '').split(',') : state.doorRoles);
    const requestedZ = restore ? Number(params.get('z')) : map.levels.at(-1)!;
    state.z = map.levels.includes(requestedZ) ? requestedZ : map.levels.at(-1)!;
    describeStation(map);
    renderDeckButtons(map);
    setDeck(state.z);
    fit();
    if (restore) restoreView(map, params);
    // The loading overlay stays until a finding from the URL is restored, so
    // a visible station always has a complete, consistent state and URL.
    const searchBytes = await fetchBytes(`${id}/search.json`);
    if (generation !== state.generation) return;
    const { indexReady, restoreReady } = startSearchWorker(generation, map, searchBytes, restoreTarget);
    await Promise.all([prepareView(generation), indexReady, restoreReady]);
    if (generation !== state.generation) return;
    state.ready = true;
    state.loadingStation = false;
    assetCache.foregroundBusy = false;
    mapCanvas.style.pointerEvents = '';
    setLoading('', false);
    $('source-status').textContent = 'ARCHIVE READY';
    redraw();
    share(true);
    enableSearch();
    void warmStorage();
  } catch (error) {
    if ((error as Error).name === 'AbortError') return;
    state.loadingStation = false;
    assetCache.foregroundBusy = false;
    showLoadingError(
      `Could not load station: ${(error as Error).message}. Run pnpm source && pnpm export, then reload.`,
    );
  }
}

function previewPath(map: { id: string; preview?: string | null; naturalPreview?: string }): string {
  return (isChecked('runtime-terrain') && map.naturalPreview) || map.preview || `${map.id}/preview.webp`;
}

/** Shows the station cards and clears the current station. */
export function showMapPicker(): void {
  const manifest = state.manifest!;
  assetCache.activeView = false;
  disableSearch('Choose a station to search its rooms and items.');
  $<HTMLButtonElement>('inspect-tab').disabled = true;
  state.selected = null;
  showSidebarView('explore');
  state.generation++;
  loadAbort?.abort();
  state.map = null;
  state.ready = false;
  state.loadingStation = false;
  assetCache.foregroundBusy = false;
  mapCanvas.style.pointerEvents = '';
  setLoading('', false);
  $('map-picker').hidden = false;
  $<HTMLSelectElement>('station').value = '';
  $('map-title').textContent = 'Choose a station';
  $('map-subtitle').textContent = `${manifest.maps.length} map configurations available`;
  $('station-meta').textContent = '';
  $('source-status').textContent = 'ARCHIVE READY';
  document.querySelector<HTMLElement>('.floating-decks')!.hidden = true;
  document.querySelector<HTMLElement>('.map-tools')!.hidden = true;
  shareOptionsOnly();
  $('map-cards').replaceChildren();
  for (const map of manifest.maps) {
    const button = document.createElement('button');
    button.className = 'map-card';
    const decks = map.levels.length;
    button.innerHTML = `${map.preview === null ? '<div class="map-preview-empty">Preview unavailable</div>' : '<img alt="" loading="lazy">'}<strong>${escapeHtml(map.name)}</strong><small>${decks} ${decks === 1 ? 'deck' : 'decks'} · ${map.width} × ${map.height} tiles</small>`;
    button.onclick = () => {
      $<HTMLSelectElement>('station').value = map.id;
      void loadStation(map.id);
    };
    const card = document.createElement('div');
    card.className = 'map-card-entry';
    card.append(button);
    $('map-cards').append(card);
    if (map.preview === null) continue;
    const path = previewPath(map);
    assetCache
      .get(resolvePath(path), path)
      .then((blob) => {
        const url = URL.createObjectURL(blob);
        const img = button.querySelector('img')!;
        img.onload = () => URL.revokeObjectURL(url);
        img.src = url;
      })
      .catch(() => {});
  }
  redraw();
}
