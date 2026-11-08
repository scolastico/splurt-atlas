// The frame: station decks on the WebGL canvas, then the annotation layer.
import { drawAnnotations, selectionPulsing } from './annotations.ts';
import { annotationCanvas, annotationContext, highlightCanvas, mapCanvas, renderer } from './canvases.ts';
import { assetCache } from '../data/source.ts';
import { drawDeck, trackCameraMotion } from './deck-tiles.ts';
import { $, isChecked } from '../core/dom.ts';
import { paintNow, redraw, setFramePainter } from '../core/frame.ts';
import { updateHighlightOverlay } from './highlight-overlay.ts';
import { beginFrame, trimImages } from './images.ts';
import { isSidebarAnimating } from '../ui/layout.ts';
import { resizeBackground, updateSpaceAnimation } from './space-background.ts';
import { state, TILE } from '../core/state.ts';
import { detailForZoom } from '../model/view-state.ts';
import { constrainCamera } from './projection.ts';

/** Shade of a deck `depth` levels below the viewed one. */
function deckShade(depth: number): number {
  return 1 - Math.pow(0.65, Math.max(0, depth));
}

let annotationsPainted = false;
let scaleText = '';
const frameTiming = { last: 0, total: 0, count: 0 };

/** CPU time of the last frame and the running average, for the development tools. */
export function frameStats(): { last: number; average: number; count: number } {
  return {
    last: frameTiming.last,
    average: frameTiming.count ? frameTiming.total / frameTiming.count : 0,
    count: frameTiming.count,
  };
}

function updateScaleText(): void {
  const tileWidth = TILE * state.zoom;
  const text = `${Math.max(1, Math.round(70 / tileWidth))} tiles / ${Math.round(state.zoom * 100)}%`;
  if (text !== scaleText) $('scale').textContent = scaleText = text;
}

function render(): void {
  const started = performance.now();
  try {
    paintFrame();
  } finally {
    frameTiming.last = performance.now() - started;
    frameTiming.total += frameTiming.last;
    frameTiming.count++;
  }
}

function paintFrame(): void {
  constrainCamera();
  if (isSidebarAnimating()) redraw();
  const detail = String(detailForZoom(state.zoom));
  if (mapCanvas.dataset.detail !== detail) mapCanvas.dataset.detail = detail;
  beginFrame();
  if (state.map)
    assetCache.priorityPaths = new Set([
      `${state.map.id}/map.json`,
      `${state.map.id}/search.json`,
      `${state.map.id}/${state.z}.json`,
    ]);
  // The space background lives on its own canvas: the animation loop repaints
  // it while motion is on, and it is static otherwise.
  updateHighlightOverlay();
  const drawable = !!(state.map && state.ready);
  trackCameraMotion();
  renderer.begin();
  if (drawable) {
    // Deeper decks are shaded without changing their opacity, so an opaque
    // middle floor still occludes deeper floors and transparent sprite edges
    // stay see-through. Decks composite bottom-up.
    if (state.cutaway)
      for (const z of state.map!.levels) if (z < state.z) drawDeck(z, deckShade(state.z - z));
    drawDeck(state.z, 0);
  }
  renderer.end();
  const wantAnnotations = drawable && (state.regions || state.selected?.z === state.z);
  if (wantAnnotations || annotationsPainted) {
    annotationContext.setTransform(1, 0, 0, 1, 0, 0);
    annotationContext.clearRect(0, 0, annotationCanvas.width, annotationCanvas.height);
    annotationsPainted = false;
  }
  if (wantAnnotations) {
    drawAnnotations(annotationContext);
    annotationsPainted = true;
  }
  if (!drawable) return;
  trimImages();
  updateScaleText();
  if (selectionPulsing()) redraw();
}

/** Matches every canvas to the viewport size and repaints synchronously. */
function resize(): void {
  const rect = mapCanvas.getBoundingClientRect();
  state.w = rect.width;
  state.h = rect.height;
  state.dpr = Math.min(devicePixelRatio || 1, 2);
  const width = Math.round(state.w * state.dpr);
  const height = Math.round(state.h * state.dpr);
  mapCanvas.width = annotationCanvas.width = highlightCanvas.width = width;
  mapCanvas.height = annotationCanvas.height = highlightCanvas.height = height;
  resizeBackground(width, height);
  renderer.resize(width, height);
  // ResizeObserver runs before paint. Repaint synchronously so resizing never
  // presents a freshly cleared canvas for one frame.
  updateSpaceAnimation();
  paintNow();
}

export function initRender(): void {
  setFramePainter(render);
  new ResizeObserver(resize).observe(mapCanvas);
  document.addEventListener('visibilitychange', () => {
    updateSpaceAnimation();
    updateHighlightOverlay();
  });
}
