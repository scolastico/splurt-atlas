import { mapCanvas } from '../rendering/canvases.ts';
import { definitionAt, infrastructureOrder, state, TILE } from '../core/state.ts';
import { redraw } from '../core/frame.ts';
import { tileAtScreen, tileCenterX, tileCenterY } from '../rendering/projection.ts';
import { selectionBounds, viewFragment, type AreaSelection, type TileRef } from '../model/view-state.ts';
import { selectionDefinitions } from '../model/selection-data.ts';
import { currentOptionMask } from './url-state.ts';
import { inspect, inspectArea } from './inspector.ts';

let anchor: TileRef | null = null;
let generation = 0;
let selectingPointer: number | null = null;
let swallowClick = false;

function cancelArea(): void {
  anchor = null;
  selectingPointer = null;
  state.selectionDraft = null;
  mapCanvas.classList.remove('selecting-area');
  redraw();
}

function tileFromEvent(event: MouseEvent): TileRef {
  const rect = mapCanvas.getBoundingClientRect();
  const tile = tileAtScreen(event.clientX - rect.left, event.clientY - rect.top);
  return {
    x: Math.max(1, Math.min(state.map!.width, tile.x)),
    y: Math.max(1, Math.min(state.map!.height, tile.y)),
    z: state.z,
  };
}

function contains(area: AreaSelection, tile: TileRef): boolean {
  return (
    tile.z === area.z && tile.x >= area.x1 && tile.x <= area.x2 && tile.y >= area.y1 && tile.y <= area.y2
  );
}

/** Centered links preserve display options and either the chosen tile or its selected rectangle. */
export function contextShareUrl(tile: TileRef, area: AreaSelection | null): string {
  const x = area ? (area.x1 + area.x2) / 2 : tile.x;
  const y = area ? (area.y1 + area.y2) / 2 : tile.y;
  const url = new URL(location.href);
  url.hash = viewFragment({
    ...state,
    map: state.map!,
    z: tile.z,
    x: tileCenterX(x),
    y: tileCenterY(y),
    selected: area ? { x: area.x1, y: area.y1, z: area.z } : tile,
    selectedArea: area,
    result: null,
    finding: null,
    query: '',
    offsetHighlights: new Set(),
    optionMask: currentOptionMask(),
    infrastructureOrder,
  });
  if (!area) {
    const params = new URLSearchParams(url.hash.slice(1));
    for (const key of ['x', 'y', 'z']) params.delete(key);
    url.hash = params.toString();
  }
  return url.href;
}

export function contextDebugInfo(tile: TileRef, area: AreaSelection | null): object {
  const map = state.map!;
  const bounds = area || { x1: tile.x, y1: tile.y, x2: tile.x, y2: tile.y, z: tile.z };
  return {
    atlas: {
      url: contextShareUrl(tile, area),
      options: currentOptionMask(),
      infrastructureOrder: [...infrastructureOrder],
    },
    upstream: {
      repository: state.manifest?.repository,
      commit: state.manifest?.commit,
      buildId: state.manifest?.buildId,
    },
    map: {
      id: map.id,
      name: map.name,
      width: map.width,
      height: map.height,
      levels: map.levels,
      files: map.files,
    },
    selection: area || tile,
    tiles: selectionDefinitions(bounds, definitionAt).map(({ definition, tiles }) => ({
      positions: tiles,
      area: map.areas[definition.area],
      definition,
    })),
    infrastructure: {
      nodes: (map.infrastructure?.nodes || []).filter((node) => contains(bounds, node)),
      transitions: (map.infrastructure?.transitions || []).filter((link) => contains(bounds, link)),
      telecomms: (map.telecomms || []).filter((machine) => contains(bounds, machine)),
    },
    camera: { x: state.x, y: state.y, z: state.z, zoom: state.zoom, tilePixels: TILE },
  };
}

async function copyText(value: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    const input = document.createElement('textarea');
    input.value = value;
    input.style.position = 'fixed';
    input.style.opacity = '0';
    document.body.append(input);
    input.select();
    const copied = document.execCommand('copy');
    input.remove();
    if (!copied) throw new Error('Clipboard unavailable');
  }
}

export function initMapContextMenu(): void {
  const menu = document.createElement('div');
  menu.id = 'map-context-menu';
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', 'Map actions');
  menu.hidden = true;
  const status = document.createElement('div');
  status.className = 'map-action-status';
  status.setAttribute('role', 'status');
  status.hidden = true;
  document.body.append(menu, status);
  let statusTimer: ReturnType<typeof setTimeout>;
  const message = (text: string) => {
    clearTimeout(statusTimer);
    status.textContent = text;
    status.hidden = false;
    statusTimer = setTimeout(() => {
      status.hidden = true;
    }, 3500);
  };
  const close = () => {
    menu.hidden = true;
  };
  const button = (label: string, action: () => void | Promise<void>) => {
    const item = document.createElement('button');
    item.type = 'button';
    item.setAttribute('role', 'menuitem');
    item.textContent = label;
    item.onclick = () => {
      close();
      void Promise.resolve()
        .then(action)
        .catch(() => message('Could not copy to the clipboard.'));
      mapCanvas.focus();
    };
    menu.append(item);
  };
  mapCanvas.addEventListener('contextmenu', (event) => {
    if (!state.ready || !state.map) return;
    event.preventDefault();
    cancelArea();
    const tile = tileFromEvent(event);
    const area = state.selectedArea && contains(state.selectedArea, tile) ? { ...state.selectedArea } : null;
    if (!area) inspect(tile.x, tile.y, tile.z);
    const openedGeneration = state.generation;
    menu.replaceChildren();
    const valid = () => state.ready && state.map && state.generation === openedGeneration;
    button(area ? 'Copy area share URL' : 'Copy share URL', async () => {
      if (!valid()) return;
      await copyText(contextShareUrl(tile, area));
      message('Share URL copied.');
    });
    button('Copy XY coordinates', async () => {
      await copyText(area ? `${area.x1}, ${area.y1} - ${area.x2}, ${area.y2}` : `${tile.x}, ${tile.y}`);
      message('Coordinates copied.');
    });
    button('Start area selection', () => {
      if (!valid()) return;
      anchor = tile;
      generation = state.generation;
      state.selectionDraft = selectionBounds(tile, tile);
      mapCanvas.classList.add('selecting-area');
      message('Click or drag to the opposite corner. Escape cancels.');
      redraw();
    });
    button('Copy debug info', async () => {
      if (!valid()) return;
      await copyText(JSON.stringify(contextDebugInfo(tile, area), null, 2));
      message('Debug JSON copied.');
    });
    menu.hidden = false;
    menu.style.left = `${Math.max(8, Math.min(event.clientX, window.innerWidth - menu.offsetWidth - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(event.clientY, window.innerHeight - menu.offsetHeight - 8))}px`;
    menu.querySelector('button')!.focus();
  });
  const current = () => {
    if (anchor && (generation !== state.generation || anchor.z !== state.z || !state.ready)) cancelArea();
    return anchor;
  };
  mapCanvas.addEventListener(
    'pointerdown',
    (event) => {
      const start = current();
      if (!start || event.button !== 0) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      selectingPointer = event.pointerId;
      mapCanvas.setPointerCapture(event.pointerId);
      state.selectionDraft = selectionBounds(start, tileFromEvent(event));
      redraw();
    },
    true,
  );
  mapCanvas.addEventListener(
    'pointermove',
    (event) => {
      const start = current();
      if (!start) return;
      event.stopImmediatePropagation();
      state.selectionDraft = selectionBounds(start, tileFromEvent(event));
      redraw();
    },
    true,
  );
  mapCanvas.addEventListener(
    'pointerup',
    (event) => {
      const start = current();
      if (!start || selectingPointer !== event.pointerId) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const area = selectionBounds(start, tileFromEvent(event));
      if (mapCanvas.hasPointerCapture(event.pointerId)) mapCanvas.releasePointerCapture(event.pointerId);
      cancelArea();
      swallowClick = true;
      inspectArea(area);
    },
    true,
  );
  mapCanvas.addEventListener('pointercancel', () => cancelArea(), true);
  mapCanvas.addEventListener(
    'click',
    (event) => {
      if (!swallowClick) return;
      swallowClick = false;
      event.preventDefault();
      event.stopImmediatePropagation();
    },
    true,
  );
  document.addEventListener(
    'pointerdown',
    (event) => {
      if (!menu.contains(event.target as Node)) close();
    },
    true,
  );
  document.addEventListener(
    'keydown',
    (event) => {
      if (event.key === 'Escape' && (!menu.hidden || anchor)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        close();
        cancelArea();
        mapCanvas.focus();
      }
      if (!menu.hidden && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        const items = [...menu.querySelectorAll('button')];
        const index = items.indexOf(document.activeElement as HTMLButtonElement);
        const next =
          event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? items.length - 1
              : (index + (event.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length;
        items[next].focus();
      }
    },
    true,
  );
  window.addEventListener('resize', close);
  window.addEventListener('blur', () => {
    close();
    cancelArea();
  });
}
