// Entry point: wires the sidebar, map controls and rendering together, then
// loads the catalog and the station named in the link.
import './style.css';
import { installDebugHook } from './core/debug.ts';
import { initCameraControls } from './ui/camera.ts';
import { assetCache, catalogBase, fetchManifest, setDataBase } from './data/source.ts';
import { initDoorRoles } from './ui/door-roles.ts';
import { $, checkbox } from './core/dom.ts';
import { redraw } from './core/frame.ts';
import { initNetworkControls } from './ui/infrastructure-controls.ts';
import { consumeHistoryHashChange, initHistory } from './ui/history.ts';
import { clearInspectedResult, initInspector, paintInspector } from './ui/inspector.ts';
import { initLayout, showSidebarView } from './ui/layout.ts';
import { showLoadingError } from './ui/loading.ts';
import { initRender } from './rendering/render.ts';
import { initSearch } from './ui/search.ts';
import { updateSpaceAnimation } from './rendering/space-background.ts';
import { reducedMotion, state } from './core/state.ts';
import { loadStation, showMapPicker } from './ui/station.ts';
import { chooseStorage, initStorageSettings, warmStorage } from './ui/storage-settings.ts';
import { currentHashParams, initOptionSharing, restoreOptions } from './ui/url-state.ts';
import { initInfoPopovers } from './ui/info-popovers.ts';
import { initMapContextMenu } from './ui/map-context-menu.ts';

function initSourceLink(): void {
  const url = import.meta.env.VITE_ATLAS_SOURCE_URL;
  if (!url) return;
  const link = $<HTMLAnchorElement>('atlas-source');
  link.href = url;
  link.hidden = false;
}

function initDisplayToggles(): void {
  for (const key of ['regions', 'cutaway', 'motion'] as const)
    checkbox(key).onchange = () => {
      state[key] = checkbox(key).checked;
      if (key === 'motion') updateSpaceAnimation();
      redraw();
    };
  checkbox('runtime-terrain').onchange = () => {
    if (!state.map) showMapPicker();
    else {
      paintInspector();
      redraw();
    }
  };
  checkbox('mapping-helpers').onchange = redraw;
  checkbox('random-markers').onchange = () => {
    paintInspector();
    redraw();
  };
  checkbox('motion').checked = state.motion = !reducedMotion.matches;
  reducedMotion.addEventListener('change', (event) => {
    state.motion = checkbox('motion').checked = !event.matches;
    updateSpaceAnimation();
    redraw();
  });
}

function initStationSelection(): void {
  const select = $<HTMLSelectElement>('station');
  select.onchange = () => (select.value ? void loadStation(select.value) : showMapPicker());
  window.addEventListener('hashchange', () => {
    if (consumeHistoryHashChange()) return;
    const id = currentHashParams().get('m');
    if (id && state.manifest?.maps.some((map) => map.id === id)) {
      select.value = id;
      void loadStation(id, true);
    } else if (state.manifest) showMapPicker();
  });
}

function fillStationSelect(): void {
  const select = $<HTMLSelectElement>('station');
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = 'Choose a map…';
  select.append(placeholder);
  for (const map of state.manifest!.maps) {
    const option = document.createElement('option');
    option.value = map.id;
    option.textContent = map.name;
    select.append(option);
  }
}

async function boot(): Promise<void> {
  try {
    const manifest = await fetchManifest();
    state.manifest = manifest;
    setDataBase(new URL(manifest.dataPath || './', catalogBase));
    assetCache.setManifest(manifest);
    const requested = currentHashParams().get('m');
    if (manifest.maps.some((map) => map.id === requested)) assetCache.setCurrentMap(requested);
    await chooseStorage();
    if (assetCache.enabled)
      await assetCache.write(
        `${assetCache.scope}:catalog`,
        new Blob([JSON.stringify(manifest)], { type: 'application/json' }),
      );
    const repository = manifest.repository.replace(/\.git$/, '');
    $<HTMLAnchorElement>('source-link').href = repository;
    $<HTMLAnchorElement>('commit-link').href = `${repository}/commit/${manifest.commit}`;
    $('upstream-commit').textContent = manifest.commit.slice(0, 12);
    fillStationSelect();
    const id = currentHashParams().get('m');
    if (id && manifest.maps.some((map) => map.id === id)) {
      $<HTMLSelectElement>('station').value = id;
      await loadStation(id, true);
    } else showMapPicker();
    if (!state.map) void warmStorage();
  } catch (error) {
    showLoadingError(
      `Archive unavailable: ${(error as Error).message}. Run pnpm source && pnpm export before starting the viewer.`,
    );
  }
}

initSourceLink();
initLayout(() => {
  if (state.selected) showSidebarView('inspect');
});
initStorageSettings();
initNetworkControls();
initInfoPopovers();
initDoorRoles();
initSearch(() => {
  clearInspectedResult();
  paintInspector();
});
initInspector();
initHistory();
initCameraControls();
initMapContextMenu();
initRender();
initOptionSharing();
initDisplayToggles();
initStationSelection();
restoreOptions(currentHashParams());
if (import.meta.env.DEV) installDebugHook();
void boot();
