// A read-only view of the viewer for the development tools panel, exposed as
// window.__atlasDev in development builds only.
import { assetCache } from '../data/source.ts';
import { renderer } from '../rendering/canvases.ts';
import { imageStats } from '../rendering/images.ts';
import { tileAtScreen, screenCenterX, screenCenterY } from '../rendering/projection.ts';
import { frameStats } from '../rendering/render.ts';
import { detailForZoom } from '../model/view-state.ts';
import { state } from './state.ts';
import { oldView } from '../data/comparison.ts';

function snapshot() {
  return {
    dataset: state.manifest
      ? {
          buildId: state.manifest.buildId,
          commit: state.manifest.commit,
          dataPath: state.manifest.dataPath || '',
        }
      : null,
    map: state.map?.id || null,
    ready: state.ready,
    z: state.z,
    x: state.x,
    y: state.y,
    zoom: state.zoom,
    detail: String(detailForZoom(state.zoom)),
    centerTile: state.map ? tileAtScreen(screenCenterX(), screenCenterY()) : null,
    selected: state.selected,
    comparison: oldView.map
      ? {
          commit: oldView.manifest?.commit,
          x: oldView.x,
          y: oldView.y,
          zoom: oldView.zoom,
          z: oldView.z,
          changedTiles: state.changedTiles.length,
          centerTile: {
            x: Math.floor(oldView.x / 32) + 1,
            y: oldView.map.height - Math.floor(oldView.y / 32),
          },
        }
      : null,
    images: imageStats(),
    frame: frameStats(),
    width: Math.round(state.w),
    height: Math.round(state.h),
    dpr: state.dpr,
    renderer: renderer.kind,
    storageMode: assetCache.mode,
  };
}

/** Removes every stored map file and the device's storage choice. */
async function clearStorage(): Promise<void> {
  assetCache.stopWarm();
  await new Promise<void>((resolve) => {
    const request = indexedDB.deleteDatabase('splurt-atlas-assets-v1');
    request.onsuccess = request.onerror = request.onblocked = () => resolve();
  });
  for (const key of ['atlas-storage-mode', 'atlas-storage-map']) localStorage.removeItem(key);
}

export function installDebugHook(): void {
  (window as unknown as { __atlasDev: unknown }).__atlasDev = { snapshot, clearStorage };
}
