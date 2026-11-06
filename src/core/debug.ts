// A read-only view of the viewer for the development tools panel, exposed as
// window.__atlasDev in development builds only.
import { assetCache } from '../data/source.ts';
import { renderer } from '../rendering/canvases.ts';
import { imageStats } from '../rendering/images.ts';
import { tileAtScreen, screenCenterX, screenCenterY } from '../rendering/projection.ts';
import { frameStats } from '../rendering/render.ts';
import { detailForZoom } from '../model/view-state.ts';
import { state } from './state.ts';

function snapshot() {
  return {
    map: state.map?.id || null,
    ready: state.ready,
    z: state.z,
    x: state.x,
    y: state.y,
    zoom: state.zoom,
    detail: String(detailForZoom(state.zoom)),
    centerTile: state.map ? tileAtScreen(screenCenterX(), screenCenterY()) : null,
    selected: state.selected,
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
