// Conversions between map tiles, world pixels and the screen. World space has
// 32 pixels per tile with y growing downwards from the top of the map, while
// the game counts tile y upwards from the bottom.
import { bottomSidebarInset, sidebarInset } from '../ui/layout.ts';
import { TILE, state as mainState, type ViewerState } from '../core/state.ts';
import { deckScale } from '../model/view-state.ts';
import { boundedCamera } from '../model/camera-bounds.ts';

export function createProjection(
  state: ViewerState,
  leftInset = sidebarInset,
  bottomInset = bottomSidebarInset,
) {
  function constrainCamera(): void {
    if (!state.map) return;
    const bounds = state.comparisonBounds;
    const point = boundedCamera(
      state.x,
      state.y + (bounds?.offsetY || 0),
      state.zoom,
      bounds?.width || state.map.width,
      bounds?.height || state.map.height,
      state.w - leftInset(),
      state.h - bottomInset(),
    );
    state.x = point.x;
    state.y = point.y - (bounds?.offsetY || 0);
  }

  /** Screen position of the camera center, which avoids the area under the sidebar. */
  function screenCenterX(): number {
    return (state.w + leftInset()) / 2;
  }

  function screenCenterY(): number {
    return (state.h - bottomInset()) * 0.5;
  }

  /** World x of a tile's center. */
  function tileCenterX(tileX: number): number {
    return (tileX - 0.5) * TILE;
  }

  /** World y of a tile's center on the current map. */
  function tileCenterY(tileY: number): number {
    return (state.map!.height - tileY + 0.5) * TILE;
  }

  /** World y of a tile's top edge on the current map. */
  function tileTopY(tileY: number): number {
    return (state.map!.height - tileY) * TILE;
  }

  function worldToScreenX(worldX: number): number {
    return (worldX - state.x) * state.zoom + screenCenterX();
  }

  function worldToScreenY(worldY: number): number {
    return (worldY - state.y) * state.zoom + screenCenterY();
  }

  /** The game tile under a screen position relative to the map canvas. */
  function tileAtScreen(screenX: number, screenY: number): { x: number; y: number } {
    const x = Math.floor((state.x + (screenX - screenCenterX()) / state.zoom) / TILE) + 1;
    const y = state.map!.height - Math.floor((state.y + (screenY - screenCenterY()) / state.zoom) / TILE);
    return { x, y };
  }

  /** Tile range covering the viewport: [left, top) in grid rows/columns from the top-left. */
  function visibleTileRange(): { left: number; top: number; right: number; bottom: number } {
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
  function applyWorldTransform(target: CanvasRenderingContext2D, depth = 0): void {
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

  return {
    constrainCamera,
    screenCenterX,
    screenCenterY,
    tileCenterX,
    tileCenterY,
    tileTopY,
    worldToScreenX,
    worldToScreenY,
    tileAtScreen,
    visibleTileRange,
    applyWorldTransform,
  };
}
export const {
  constrainCamera,
  screenCenterX,
  screenCenterY,
  tileCenterX,
  tileCenterY,
  tileTopY,
  worldToScreenX,
  worldToScreenY,
  tileAtScreen,
  visibleTileRange,
  applyWorldTransform,
} = createProjection(mainState);
