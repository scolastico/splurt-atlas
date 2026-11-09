// A second instance of the atlas renderer. Only the dataset and canvas differ;
// the camera, selection and display controls are shared with the current view.
import { datasets } from '../data/source.ts';
import { oldAssetUrl, oldView } from '../data/comparison.ts';
import { state, TILE } from '../core/state.ts';
import { $ } from '../core/dom.ts';
import { sidebarInset, bottomSidebarInset } from '../ui/layout.ts';
import { create2dRenderer, createGlRenderer } from './gl-renderer.ts';
import { createImageCache } from './images.ts';
import { createDeckPainter } from './deck-tiles.ts';
import { createProjection } from './projection.ts';
import { createAnnotationPainter } from './annotations.ts';
import { createHighlightPainter } from './highlight-overlay.ts';
import { indexDoorTiles, doorMarkersForRoles } from '../model/door-highlights.ts';

export const oldCanvas = $<HTMLCanvasElement>('old-map');
const annotations = $<HTMLCanvasElement>('old-annotations');
const highlights = $<HTMLCanvasElement>('old-highlights');
const context = annotations.getContext('2d')!;
const projection = createProjection(oldView, () => 0, bottomSidebarInset);
let painter: ReturnType<typeof createDeckPainter> | undefined;
let images: ReturnType<typeof createImageCache>;
let renderer: ReturnType<typeof create2dRenderer>;
const annotationPainter = createAnnotationPainter(oldView, projection);
let doorMap = oldView.map;
let doorRoles = '';
let doorTiles: ReturnType<typeof indexDoorTiles> = [];
let doorMarkers: ReturnType<typeof doorMarkersForRoles> = [];
function oldDoorMarkers() {
  if (doorMap !== oldView.map) {
    doorMap = oldView.map;
    doorTiles = doorMap ? indexDoorTiles(doorMap, oldView.levels) : [];
    doorRoles = '';
    doorMarkers = [];
  }
  const roles = JSON.stringify(state.doorRoles);
  if (roles !== doorRoles) {
    doorRoles = roles;
    doorMarkers = doorMarkersForRoles(doorTiles, state.doorRoles);
  }
  return doorMarkers;
}
const highlightPainter = createHighlightPainter(
  oldView,
  highlights,
  highlights.getContext('2d')!,
  projection,
  oldDoorMarkers,
);
let generation = -1;
let inset = -1;

export function comparisonInset(): void {
  if (!datasets.comparing) return;
  const width = sidebarInset();
  if (width === inset) return;
  inset = width;
  $('viewport').style.setProperty('--comparison-inset', `${width}px`);
}

export function initComparisonRendering(): void {
  if (!datasets.comparing) return;
  document.body.classList.add('comparing');
  $('old-view').hidden = false;
  $('current-revision').hidden = false;
  $('changed-tiles-option').hidden = false;
  $('comparison-summary').hidden = false;
  comparisonInset();
  renderer = createGlRenderer(oldCanvas) || create2dRenderer(oldCanvas);
  images = createImageCache(renderer, async (path) => {
    const response = await fetch(oldAssetUrl(path));
    if (!response.ok) throw new Error(`Old dataset image unavailable: ${path}`);
    return response.blob();
  });
  painter = createDeckPainter(oldView, renderer, images, projection);
}

/** Maps a pointer in the old pane into the current pane's camera coordinates. */
export function oldPointerOffset(): [number, number] {
  return [(state.w + sidebarInset()) / 2 - oldCanvas.clientWidth / 2, 0];
}

export function paintComparison(): void {
  if (!painter) return;
  const { map, levels, manifest } = oldView;
  Object.assign(oldView, state, {
    map,
    levels,
    manifest,
    y: state.y + ((map?.height || state.map?.height || 0) - (state.map?.height || 0)) * TILE,
    w: oldCanvas.clientWidth,
    h: oldCanvas.clientHeight,
  });
  const width = Math.round(oldView.w * state.dpr),
    height = Math.round(oldView.h * state.dpr);
  if (oldCanvas.width !== width || oldCanvas.height !== height) {
    oldCanvas.width = annotations.width = highlights.width = width;
    oldCanvas.height = annotations.height = highlights.height = height;
    renderer.resize(width, height);
  }
  if (generation !== state.generation) {
    generation = state.generation;
    images.clearImages();
    annotationPainter.resetAnnotationCaches();
  }
  oldCanvas.style.pointerEvents = state.ready ? '' : 'none';
  oldCanvas.dataset.detail = document.getElementById('map')!.dataset.detail;
  images.beginFrame();
  painter.trackCameraMotion();
  renderer.begin();
  if (state.ready && map) {
    if (state.cutaway)
      for (const z of map.levels) if (z < state.z) painter.drawDeck(z, 1 - Math.pow(0.65, state.z - z));
    painter.drawDeck(state.z, 0);
  }
  renderer.end();
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, width, height);
  if (state.ready) annotationPainter.drawAnnotations(context);
  highlightPainter.updateHighlightOverlay();
  images.trimImages();
}
