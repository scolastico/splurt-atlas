// Conversions between map tiles, world pixels and the screen. World space has
// 32 pixels per tile with y growing downwards from the top of the map, while
// the game counts tile y upwards from the bottom.
import { bottomSidebarInset, sidebarInset } from './layout.ts';
import { TILE, state } from './state.ts';
import { deckScale } from './view-state.ts';

/** Screen position of the camera center, which avoids the area under the sidebar. */
export function screenCenterX(): number {
  return (state.w + sidebarInset()) / 2;
}

export function screenCenterY(): number {
  return (state.h - bottomSidebarInset()) * 0.5;
}

/** World x of a tile's center. */
export function tileCenterX(tileX: number): number {
  return (tileX - 0.5) * TILE;
}

/** World y of a tile's center on the current map. */
export function tileCenterY(tileY: number): number {
  return (state.map!.height - tileY + 0.5) * TILE;
}

/** World y of a tile's top edge on the current map. */
export function tileTopY(tileY: number): number {
  return (state.map!.height - tileY) * TILE;
}

export function worldToScreenX(worldX: number): number {
  return (worldX - state.x) * state.zoom + screenCenterX();
}

export function worldToScreenY(worldY: number): number {
  return (worldY - state.y) * state.zoom + screenCenterY();
}

/** The game tile under a screen position relative to the map canvas. */
export function tileAtScreen(screenX: number, screenY: number): { x: number; y: number } {
  const x = Math.floor((state.x + (screenX - screenCenterX()) / state.zoom) / TILE) + 1;
  const y = state.map!.height - Math.floor((state.y + (screenY - screenCenterY()) / state.zoom) / TILE);
  return { x, y };
}

/** Tile range covering the viewport: [left, top) in grid rows/columns from the top-left. */
export function visibleTileRange(): { left: number; top: number; right: number; bottom: number } {
  const map = state.map!;
  return {
    left: Math.max(0, Math.floor((state.x - screenCenterX() / state.zoom) / TILE)),
    top: Math.max(0, Math.floor((state.y - screenCenterY() / state.zoom) / TILE)),
    right: Math.min(map.width, Math.ceil((state.x + (state.w - screenCenterX()) / state.zoom) / TILE)),
    bottom: Math.min(map.height, Math.ceil((state.y + (state.h - screenCenterY()) / state.zoom) / TILE)),
  };
}

/**
 * Sets a 2D context's transform so world pixels map to the screen. Each deck
 * is projected from the same camera at a different distance: lower decks
 * recede and pan at their own rate.
 */
export function applyWorldTransform(target: CanvasRenderingContext2D, depth = 0): void {
  const scale = deckScale(state.zoom, depth, state.motion);
  target.setTransform(
    state.dpr * scale,
    0,
    0,
    state.dpr * scale,
    state.dpr * (screenCenterX() - state.x * scale),
    state.dpr * (screenCenterY() - state.y * scale),
  );
}
