// The annotation layer above the station imagery: room boundaries with their
// names, and the selected tile.
import { applyWorldTransform, visibleTileRange } from './projection.ts';
import { reducedMotion, state, TILE } from './state.ts';

interface AreaPaths {
  fill: Path2D;
  edge: Path2D;
}

/** Fill and boundary paths per area, cached per chunk ("z:cx,cy"). */
const regionChunks = new Map<string, Map<number, AreaPaths>>();
const areaColors = new Map<number, string>();

/** The selection pulse lasts this long after a tile is selected. */
const SELECTION_PULSE_MS = 1400;

export function resetAnnotationCaches(): void {
  regionChunks.clear();
  areaColors.clear();
}

function hashColor(text: string): string {
  let hash = 0;
  for (const char of text) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return `hsl(${Math.abs(hash) % 360} 48% 64%)`;
}

function areaColor(index: number): string {
  let color = areaColors.get(index);
  if (!color) areaColors.set(index, (color = hashColor(state.map!.areas[index].path)));
  return color;
}

/**
 * Fills and boundaries are cached per chunk as one path per area, so a frame
 * strokes a few paths per chunk instead of every visible tile.
 */
function regionChunk(z: number, cx: number, cy: number): Map<number, AreaPaths> {
  const key = `${z}:${cx},${cy}`;
  const cached = regionChunks.get(key);
  if (cached) return cached;
  const map = state.map!;
  const data = state.levels.get(z)!;
  const chunkTiles = state.manifest!.chunkTiles;
  const byArea = new Map<number, AreaPaths>();
  const definitionAtCell = (x: number, y: number) =>
    x < map.width && y < map.height ? map.definitions[data.grid[y * map.width + x]] : undefined;
  for (let y = cy * chunkTiles; y < Math.min(map.height, (cy + 1) * chunkTiles); y++)
    for (let x = cx * chunkTiles; x < Math.min(map.width, (cx + 1) * chunkTiles); x++) {
      const definition = definitionAtCell(x, y);
      if (!definition || definition.turf.includes('/space')) continue;
      let paths = byArea.get(definition.area);
      if (!paths) byArea.set(definition.area, (paths = { fill: new Path2D(), edge: new Path2D() }));
      paths.fill.rect(x * TILE, y * TILE, TILE, TILE);
      // An edge is drawn where the right or bottom neighbor belongs to another area.
      for (const [dx, dy] of [
        [1, 0],
        [0, 1],
      ]) {
        if (definitionAtCell(x + dx, y + dy)?.area !== definition.area) {
          paths.edge.moveTo((x + dx) * TILE, (y + dy) * TILE);
          paths.edge.lineTo((x + 1) * TILE, (y + 1) * TILE);
        }
      }
    }
  regionChunks.set(key, byArea);
  return byArea;
}

function drawRegions(context: CanvasRenderingContext2D): void {
  const map = state.map!;
  const data = state.levels.get(state.z)!;
  const { left, top, right, bottom } = visibleTileRange();
  const chunkTiles = state.manifest!.chunkTiles;
  for (let cy = Math.floor(top / chunkTiles); cy * chunkTiles < bottom; cy++)
    for (let cx = Math.floor(left / chunkTiles); cx * chunkTiles < right; cx++)
      for (const [area, paths] of regionChunk(state.z, cx, cy)) {
        const color = areaColor(area);
        context.globalAlpha = 0.14;
        context.fillStyle = color;
        context.fill(paths.fill);
        context.globalAlpha = 0.8;
        context.strokeStyle = color;
        context.stroke(paths.edge);
      }
  context.globalAlpha = 1;
  if (state.zoom <= 0.55) return;
  // One label per visible area, at the first of its tiles in reading order.
  const labels = new Map<number, [number, number]>();
  for (let y = top; y < bottom; y++)
    for (let x = left; x < right; x++) {
      const definition = map.definitions[data.grid[y * map.width + x]];
      if (definition && !labels.has(definition.area) && !definition.turf.includes('/space'))
        labels.set(definition.area, [x, y]);
    }
  for (const [area, [x, y]] of labels) {
    context.font = `${10 / state.zoom}px 'IBM Plex Mono',monospace`;
    context.fillStyle = '#eff4ee';
    context.strokeStyle = '#0c1824';
    context.lineWidth = 3 / state.zoom;
    const label = map.areas[area].name;
    context.strokeText(label, x * TILE + 8, y * TILE + 18);
    context.fillText(label, x * TILE + 8, y * TILE + 18);
  }
}

/** Whether the selection pulse is still running and needs more frames. */
export function selectionPulsing(): boolean {
  return !reducedMotion.matches && performance.now() - state.selectionPulseStart < SELECTION_PULSE_MS;
}

export function drawAnnotations(context: CanvasRenderingContext2D): void {
  const map = state.map;
  if (!map || !state.levels.has(state.z)) return;
  applyWorldTransform(context);
  context.lineWidth = 1 / state.zoom;
  if (state.regions) drawRegions(context);
  context.globalAlpha = 1;
  context.lineWidth = 2 / state.zoom;
  if (state.selected?.z === state.z) {
    const elapsed = performance.now() - state.selectionPulseStart;
    const pulse = selectionPulsing() ? 0.5 + Math.sin(elapsed / 75) * 0.5 : 0;
    const x = (state.selected.x - 1) * TILE;
    const y = (map.height - state.selected.y) * TILE;
    context.fillStyle = `rgba(255,210,115,${pulse * 0.3})`;
    context.fillRect(x, y, TILE, TILE);
    context.strokeStyle = '#fff4d8';
    context.strokeRect(x, y, TILE, TILE);
  }
}
