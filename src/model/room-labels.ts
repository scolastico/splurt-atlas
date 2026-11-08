import type { LevelData, MapMeta } from '../core/types.ts';

export interface RoomLabel {
  area: number;
  x: number;
  y: number;
}

export function isRegionTurf(turf: string): boolean {
  return !/\/(space|openspace)(?:\/|$)/.test(turf);
}

/** Stable centers for each connected room, moved onto an interior tile for concave rooms. */
export function roomLabels(map: MapMeta, level: LevelData): RoomLabel[] {
  const labels: RoomLabel[] = [];
  const visited = new Uint8Array(level.grid.length);
  const queue = new Int32Array(level.grid.length);
  const definitionAt = (index: number) => map.definitions[level.grid[index]];
  for (let start = 0; start < level.grid.length; start++) {
    if (visited[start]) continue;
    visited[start] = 1;
    const definition = definitionAt(start);
    if (!definition || !isRegionTurf(definition.turf)) continue;
    let head = 0,
      tail = 1,
      sumX = 0,
      sumY = 0;
    queue[0] = start;
    while (head < tail) {
      const index = queue[head++],
        x = index % map.width,
        y = Math.floor(index / map.width);
      sumX += x + 0.5;
      sumY += y + 0.5;
      const neighbors = [
        x > 0 ? index - 1 : -1,
        x + 1 < map.width ? index + 1 : -1,
        y > 0 ? index - map.width : -1,
        y + 1 < map.height ? index + map.width : -1,
      ];
      for (const next of neighbors) {
        if (next < 0 || visited[next]) continue;
        const candidate = definitionAt(next);
        if (!candidate || candidate.area !== definition.area || !isRegionTurf(candidate.turf)) continue;
        visited[next] = 1;
        queue[tail++] = next;
      }
    }
    const centerX = sumX / tail,
      centerY = sumY / tail;
    let closest = start,
      best = Infinity,
      hasFloor = false;
    for (let i = 0; i < tail; i++) {
      const index = queue[i],
        floor = !definitionAt(index).turf.startsWith('/turf/closed/');
      if (hasFloor && !floor) continue;
      if (floor && !hasFloor) {
        hasFloor = true;
        best = Infinity;
      }
      const dx = (index % map.width) + 0.5 - centerX,
        dy = Math.floor(index / map.width) + 0.5 - centerY;
      const distance = dx * dx + dy * dy;
      if (distance < best) {
        best = distance;
        closest = index;
      }
    }
    // Keep an exact geometric center when it lies on one of this room's usable tiles.
    const centerIndex = Math.floor(centerY) * map.width + Math.floor(centerX);
    let inside = false;
    for (let i = 0; i < tail; i++)
      if (queue[i] === centerIndex) {
        inside = true;
        break;
      }
    const centerDefinition = inside ? definitionAt(centerIndex) : null;
    const exact = inside && (!hasFloor || !centerDefinition!.turf.startsWith('/turf/closed/'));
    labels.push({
      area: definition.area,
      x: exact ? centerX : (closest % map.width) + 0.5,
      y: exact ? centerY : Math.floor(closest / map.width) + 0.5,
    });
  }
  return labels;
}
