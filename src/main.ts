// Entry point: wires the sidebar, map controls and rendering together, then
// loads the catalog and the station named in the link.
import './style.css';
import { initCameraControls } from './camera.ts';
import { assetCache, catalogBase, fetchManifest, setDataBase } from './data.ts';
import { initDoorRoles } from './door-roles.ts';
import { $, checkbox } from './dom.ts';
import { redraw } from './frame.ts';
import { initNetworkControls } from './infrastructure-overlay.ts';
import { clearInspectedResult, initInspector, paintInspector } from './inspector.ts';
import { initLayout, showSidebarView } from './layout.ts';
import { showLoadingError } from './loading.ts';
import { initRender } from './render.ts';
import { initSearch } from './search.ts';
import { updateSpaceAnimation } from './space-background.ts';
import { reducedMotion, state } from './state.ts';
import { loadStation, showMapPicker } from './station.ts';
import { chooseStorage, initStorageSettings, warmStorage } from './storage-settings.ts';
import { currentHashParams, initOptionSharing, restoreOptions } from './url-state.ts';

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
    $('commit-link').textContent = `${manifest.commit.slice(0, 12)} ↗`;
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
initDoorRoles();
initSearch(() => {
  clearInspectedResult();
  paintInspector();
});
initInspector();
initCameraControls();
initRender();
initOptionSharing();
initDisplayToggles();
initStationSelection();
restoreOptions(currentHashParams());
void boot();
