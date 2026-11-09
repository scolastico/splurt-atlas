// The animated highlight overlay: pulsing rings around search findings and
// door markers, offset-object callouts on the selected tile, and stair and
// ladder markers. It animates on its own transparent canvas so the station
// imagery stays idle.
import { highlightCanvas as mainCanvas, highlightContext as mainContext } from './canvases.ts';
import { getDoorMarkers as mainDoorMarkers } from '../ui/door-roles.ts';
import { isChecked } from '../core/dom.ts';
import { createProjection } from './projection.ts';
import { reducedMotion, state as mainState, TILE, type ViewerState } from '../core/state.ts';
import { selectedTelecomms } from '../model/telecomms.ts';

const OVERLAY_FPS = 30;
const PULSE_PERIOD_MS = 1800;
const DOOR_COLORS = { allowed: '90,226,144', partial: '255,210,92', denied: '255,105,113' } as const;
const FINDING_COLOR = '255,207,114';
const PLACED_FINDING_COLOR = '90,226,144';

export function createHighlightPainter(
  state: ViewerState,
  highlightCanvas: HTMLCanvasElement,
  highlightContext: CanvasRenderingContext2D,
  projection = createProjection(state),
  getDoorMarkers = mainDoorMarkers,
) {
  const { applyWorldTransform, tileCenterX, tileCenterY, tileTopY, worldToScreenX, worldToScreenY } =
    projection;
  const definitionAt = (x: number, y: number, z: number) =>
    state.map?.definitions[state.levels.get(z)?.grid[(state.map.height - y) * state.map.width + x - 1] ?? -1];
  let animationFrame = 0;
  let lastPaintTime = 0;
  /** Whether the overlay currently shows anything, so an empty overlay skips the full-screen clear. */
  let painted = false;

  function wantsOverlay(): boolean {
    const map = state.map;
    if (!state.ready || !map || document.hidden) return false;
    const transitions =
      (isChecked('connections') || isChecked('connection-labels')) && map.infrastructure?.transitions?.length;
    return !!(
      getDoorMarkers().length ||
      state.markers.length ||
      (isChecked('changed-tiles') && state.changedTiles.length) ||
      (state.selected?.z === state.z && state.offsetHighlights.size) ||
      (state.selected?.z === state.z && state.telecomHighlights.size) ||
      transitions
    );
  }

  function onScreen(screenX: number, screenY: number, slack: number): boolean {
    return screenX >= -slack && screenX <= state.w + slack && screenY >= -slack && screenY <= state.h + slack;
  }

  /** Paints the overlay for a point in time and reports whether anything is visible. */
  function drawHighlights(time = performance.now()): boolean {
    const target = highlightContext;
    const wanted = wantsOverlay();
    if (!wanted && !painted) return false;
    target.setTransform(1, 0, 0, 1, 0, 0);
    target.clearRect(0, 0, highlightCanvas.width, highlightCanvas.height);
    painted = false;
    if (!wanted) return false;
    const map = state.map!;
    applyWorldTransform(target);
    const pulse = reducedMotion.matches ? 0.5 : (1 + Math.sin((time * Math.PI * 2) / PULSE_PERIOD_MS)) / 2;
    const lineWidth = (pixels: number) => pixels / state.zoom;
    let visible = false;

    const ring = (tileX: number, tileY: number, z: number, color: string) => {
      if (z !== state.z) return;
      const x = tileCenterX(tileX);
      const y = tileCenterY(tileY);
      if (!onScreen(worldToScreenX(x), worldToScreenY(y), 30)) return;
      visible = true;
      target.strokeStyle = `rgba(${color},${0.65 + pulse * 0.35})`;
      target.fillStyle = `rgba(${color},${0.08 + pulse * 0.12})`;
      target.lineWidth = lineWidth(2);
      target.beginPath();
      target.arc(x, y, Math.max(13, lineWidth(5)) + lineWidth(pulse * 3), 0, Math.PI * 2);
      target.fill();
      target.stroke();
    };
    if (isChecked('changed-tiles'))
      for (const tile of state.changedTiles)
        ring(
          tile.x,
          tile.y,
          tile.z,
          tile.kind === 'added'
            ? '90,226,144'
            : tile.kind === 'removed'
              ? '255,105,113'
              : tile.kind === 'visual'
                ? '120,183,255'
                : FINDING_COLOR,
        );
    for (const marker of getDoorMarkers()) ring(marker.x, marker.y, marker.z, DOOR_COLORS[marker.status]);
    for (let index = 0; index < state.markers.length; index += 3) {
      const x = state.markers[index],
        y = state.markers[index + 1],
        z = state.markers[index + 2];
      ring(x, y, z, state.placedMarkers.has(`${x},${y},${z}`) ? PLACED_FINDING_COLOR : FINDING_COLOR);
    }

    if (state.selected?.z === state.z && state.telecomHighlights.size) {
      const sources = selectedTelecomms(map, state.selected, state.selectedArea);
      for (const machine of map.telecomms || []) {
        if (machine.z !== state.z || !state.telecomHighlights.has(machine.id)) continue;
        ring(machine.x, machine.y, machine.z, '106,224,255');
        target.strokeStyle = `rgba(106,224,255,${0.5 + pulse * 0.3})`;
        target.lineWidth = lineWidth(2);
        for (const source of sources.filter((source) => source.links.includes(machine.id))) {
          visible = true;
          target.beginPath();
          target.moveTo(tileCenterX(source.x), tileCenterY(source.y));
          target.lineTo(tileCenterX(machine.x), tileCenterY(machine.y));
          target.stroke();
        }
      }
    }

    // Callouts from the selected tile to objects drawn beside it.
    if (state.selected?.z === state.z && state.offsetHighlights.size) {
      const tile = state.selected;
      const definition = definitionAt(tile.x, tile.y, tile.z);
      for (const index of state.offsetHighlights) {
        const bounds = definition?.atoms[index]?.visual;
        if (!bounds) continue;
        const x = (tile.x - 1) * TILE + bounds.x;
        const y = tileTopY(tile.y) + bounds.y;
        const centerX = x + bounds.width / 2;
        const centerY = y + bounds.height / 2;
        if (!onScreen(worldToScreenX(centerX), worldToScreenY(centerY), 50)) continue;
        visible = true;
        target.strokeStyle = `rgba(106,224,255,${0.65 + pulse * 0.35})`;
        target.lineWidth = lineWidth(1);
        target.beginPath();
        target.moveTo(tileCenterX(tile.x), tileCenterY(tile.y));
        target.lineTo(centerX, centerY);
        target.stroke();
        const padding = lineWidth(2 + pulse * 2);
        target.fillStyle = `rgba(106,224,255,${0.08 + pulse * 0.15})`;
        target.fillRect(x - padding, y - padding, bounds.width + padding * 2, bounds.height + padding * 2);
        target.lineWidth = lineWidth(2);
        target.strokeRect(x - padding, y - padding, bounds.width + padding * 2, bounds.height + padding * 2);
      }
    }

    // Highlights and direction arrows are independent toggles; either one draws the transitions.
    const highlight = isChecked('connections');
    const labels = isChecked('connection-labels');
    const transitions = highlight || labels ? map.infrastructure?.transitions || [] : [];
    for (const link of transitions) {
      if (link.z !== state.z) continue;
      const x = tileCenterX(link.x);
      const y = tileCenterY(link.y);
      const screenX = worldToScreenX(x);
      const screenY = worldToScreenY(y);
      if (screenX < -400 || screenX > state.w + 30 || screenY < -30 || screenY > state.h + 30) continue;
      visible = true;
      target.strokeStyle = `rgba(177,232,255,${0.65 + pulse * 0.35})`;
      target.fillStyle = `rgba(118,201,237,${0.12 + pulse * 0.18})`;
      target.lineWidth = lineWidth(2);
      if (highlight) {
        target.beginPath();
        target.arc(x, y, Math.max(13, lineWidth(5)) + lineWidth(pulse * 3), 0, Math.PI * 2);
        target.fill();
        target.stroke();
      }
      if (labels) {
        const up = link.targets.some((t) => t.z > link.z);
        const down = link.targets.some((t) => t.z < link.z);
        if (!up && !down) continue;
        // Follow the tile's scale, retaining a readable minimum when zoomed out.
        const size = Math.max(10, lineWidth(3));
        const arrow = new Path2D();
        arrow.moveTo(x, y - size);
        arrow.lineTo(x, y + size);
        if (up) {
          arrow.moveTo(x - size * 0.55, y - size * 0.4);
          arrow.lineTo(x, y - size);
          arrow.lineTo(x + size * 0.55, y - size * 0.4);
        }
        if (down) {
          arrow.moveTo(x - size * 0.55, y + size * 0.4);
          arrow.lineTo(x, y + size);
          arrow.lineTo(x + size * 0.55, y + size * 0.4);
        }
        target.lineJoin = 'round';
        target.lineCap = 'round';
        target.strokeStyle = '#09131f';
        target.lineWidth = Math.max(5, lineWidth(5));
        target.stroke(arrow);
        target.strokeStyle = '#d2f0ff';
        target.lineWidth = Math.max(2, lineWidth(2));
        target.stroke(arrow);
        target.lineCap = 'butt';
        target.lineJoin = 'miter';
      }
    }
    painted = visible;
    return visible;
  }

  function animate(time: number): void {
    animationFrame = 0;
    if (time - lastPaintTime >= 1000 / OVERLAY_FPS) {
      lastPaintTime = time;
      if (!drawHighlights(time) || reducedMotion.matches) return;
    }
    animationFrame = requestAnimationFrame(animate);
  }

  /** Repaints the overlay now and keeps animating it while it shows something. */
  function updateHighlightOverlay(): void {
    if (animationFrame) cancelAnimationFrame(animationFrame);
    animationFrame = 0;
    if (drawHighlights() && !reducedMotion.matches) animationFrame = requestAnimationFrame(animate);
  }

  return { updateHighlightOverlay };
}
export const { updateHighlightOverlay } = createHighlightPainter(mainState, mainCanvas, mainContext);
