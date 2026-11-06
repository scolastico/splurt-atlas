// Camera movement: fitting the station, zooming, and the pointer, wheel and
// keyboard controls on the map canvas.
import { goBack, goForward } from './history.ts';
import { mapCanvas } from '../rendering/canvases.ts';
import { $ } from '../core/dom.ts';
import { redraw } from '../core/frame.ts';
import { clearSelection, inspect } from './inspector.ts';
import {
  bottomSidebarInset,
  isPortraitPanel,
  setSidebarCollapsed,
  showSidebarView,
  sidebarInset,
} from './layout.ts';
import { screenCenterX, screenCenterY, tileAtScreen } from '../rendering/projection.ts';
import { state, TILE } from '../core/state.ts';
import { share } from './url-state.ts';

const MIN_ZOOM = 0.04;
const MAX_ZOOM = 5;
/** Keyboard panning distance in screen pixels. */
const KEY_PAN_PIXELS = 90;

/** Centers the station's non-space area and zooms to fit it beside the sidebar. */
export function fit(): void {
  const map = state.map;
  if (!map) return;
  const [minX, minY, maxX, maxY] = state.levels.get(state.z)?.bounds || [0, 0, map.width, map.height];
  state.x = ((minX + maxX) * TILE) / 2;
  state.y = ((minY + maxY) * TILE) / 2;
  const availableWidth = state.w - sidebarInset() - 130;
  const availableHeight = state.h - bottomSidebarInset() - (isPortraitPanel() ? 90 : 180);
  state.zoom = Math.max(
    0.05,
    Math.min(availableWidth / ((maxX - minX) * TILE), availableHeight / ((maxY - minY) * TILE), 1),
  );
  redraw();
  share();
}

/** Zooms by a factor around a screen point (the camera center by default). */
export function zoomBy(factor: number, screenX = screenCenterX(), screenY = screenCenterY()): void {
  const before = state.zoom;
  const after = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, before * factor));
  state.x += (screenX - screenCenterX()) * (1 / before - 1 / after);
  state.y += (screenY - screenCenterY()) * (1 / before - 1 / after);
  state.zoom = after;
  redraw();
  share();
}

export function panBy(worldX: number, worldY: number): void {
  state.x += worldX;
  state.y += worldY;
  redraw();
  share();
}

function initPointerControls(): void {
  const pointers = new Map<number, [number, number]>();
  let dragged = false;
  let downAt: [number, number] | null = null;
  let pinchDistance = 0;
  let tapCandidate: { x: number; y: number; generation: number } | null = null;
  const canvasPoint = (event: MouseEvent): [number, number] => {
    const rect = mapCanvas.getBoundingClientRect();
    return [event.clientX - rect.left, event.clientY - rect.top];
  };

  mapCanvas.onpointerdown = (event) => {
    // The mouse back and forward buttons never start a drag.
    if (event.button === 3 || event.button === 4) return;
    tapCandidate = null;
    mapCanvas.focus();
    mapCanvas.setPointerCapture(event.pointerId);
    pointers.set(event.pointerId, [event.clientX, event.clientY]);
    downAt = [event.clientX, event.clientY];
    dragged = false;
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinchDistance = Math.hypot(a[0] - b[0], a[1] - b[1]);
      dragged = true;
    }
  };
  mapCanvas.onpointermove = (event) => {
    const [sx, sy] = canvasPoint(event);
    if (state.map) {
      const { x, y } = tileAtScreen(sx, sy);
      $('coords').textContent = `X ${x} / Y ${y} / Z ${state.z}`;
    }
    const previous = pointers.get(event.pointerId);
    if (!previous) return;
    pointers.set(event.pointerId, [event.clientX, event.clientY]);
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const distance = Math.hypot(a[0] - b[0], a[1] - b[1]);
      const rect = mapCanvas.getBoundingClientRect();
      if (pinchDistance > 0)
        zoomBy(distance / pinchDistance, (a[0] + b[0]) / 2 - rect.left, (a[1] + b[1]) / 2 - rect.top);
      pinchDistance = distance;
      return;
    }
    if (downAt && Math.hypot(event.clientX - downAt[0], event.clientY - downAt[1]) > 4) dragged = true;
    panBy(-(event.clientX - previous[0]) / state.zoom, -(event.clientY - previous[1]) / state.zoom);
  };
  mapCanvas.onpointerup = (event) => {
    pointers.delete(event.pointerId);
    if (!dragged && !pointers.size && state.map) {
      const [sx, sy] = canvasPoint(event);
      tapCandidate = { ...tileAtScreen(sx, sy), generation: state.generation };
    }
    if (!pointers.size) downAt = null;
  };
  // Open the sidebar during the completed click, not pointerup. Touch browsers
  // otherwise deliver the same tap's click to a newly revealed checkbox.
  mapCanvas.onclick = (event) => {
    const tile = tapCandidate;
    tapCandidate = null;
    if (tile && tile.generation === state.generation) {
      event.preventDefault();
      event.stopPropagation();
      inspect(tile.x, tile.y);
    }
  };
  mapCanvas.onpointercancel = (event) => {
    pointers.delete(event.pointerId);
    dragged = true;
    tapCandidate = null;
    if (!pointers.size) downAt = null;
  };
  mapCanvas.addEventListener(
    'wheel',
    (event) => {
      event.preventDefault();
      const [sx, sy] = canvasPoint(event);
      zoomBy(Math.exp(-event.deltaY * 0.0015), sx, sy);
    },
    { passive: false },
  );
  mapCanvas.ondblclick = (event) => {
    const [sx, sy] = canvasPoint(event);
    zoomBy(1.8, sx, sy);
  };
}

/** Arrow keys and WASD pan the map. */
const PAN_KEYS: Record<string, [number, number]> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
  a: [-1, 0],
  d: [1, 0],
  w: [0, -1],
  s: [0, 1],
};

function onKeyDown(event: KeyboardEvent): void {
  const target = event.target as HTMLElement;
  if (/INPUT|SELECT|TEXTAREA/.test(target.tagName)) {
    if (event.key === 'Escape') target.blur();
    return;
  }
  if (event.key === '/') {
    event.preventDefault();
    setSidebarCollapsed(false);
    showSidebarView('search');
    $('search').focus();
  }
  // Alt+arrows step through the in-app history; the browser history is untouched.
  if (event.altKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
    event.preventDefault();
    if (event.key === 'ArrowLeft') goBack();
    else goForward();
    return;
  }
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  if (event.key.toLowerCase() === 'f') fit();
  if (event.key === '+' || event.key === '=') zoomBy(1.4);
  if (event.key === '-') zoomBy(1 / 1.4);
  if (event.key === 'Escape') {
    if (state.selected) clearSelection();
    else setSidebarCollapsed(true);
  }
  const shift = PAN_KEYS[event.key.length === 1 ? event.key.toLowerCase() : event.key];
  if (shift) {
    event.preventDefault();
    panBy((shift[0] * KEY_PAN_PIXELS) / state.zoom, (shift[1] * KEY_PAN_PIXELS) / state.zoom);
  }
}

/** Mouse back and forward buttons step through the in-app history instead of the browser's. */
function initHistoryButtons(): void {
  document.addEventListener('mouseup', (event) => {
    if (event.button === 3 || event.button === 4) event.preventDefault();
  });
  document.addEventListener('auxclick', (event) => {
    if (event.button !== 3 && event.button !== 4) return;
    event.preventDefault();
    if (event.button === 3) goBack();
    else goForward();
  });
}

export function initCameraControls(): void {
  initPointerControls();
  initHistoryButtons();
  $('zoom-in').onclick = () => zoomBy(1.5);
  $('zoom-out').onclick = () => zoomBy(1 / 1.5);
  $('fit').onclick = fit;
  document.onkeydown = onKeyDown;
}
