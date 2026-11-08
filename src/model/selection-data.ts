import type { Definition } from '../core/types.ts';
import type { AreaSelection, TileRef } from './view-state.ts';

export function selectionTiles(area: AreaSelection): TileRef[] {
  const tiles: TileRef[] = [];
  for (let y = area.y1; y <= area.y2; y++)
    for (let x = area.x1; x <= area.x2; x++) tiles.push({ x, y, z: area.z });
  return tiles;
}

/** Group identical tile definitions without losing counts or their coordinates. */
export function selectionDefinitions(
  area: AreaSelection,
  at: (x: number, y: number, z: number) => Definition | undefined,
) {
  const groups = new Map<Definition, { definition: Definition; tiles: TileRef[] }>();
  for (const tile of selectionTiles(area)) {
    const definition = at(tile.x, tile.y, tile.z);
    if (!definition) continue;
    if (!groups.has(definition)) groups.set(definition, { definition, tiles: [] });
    groups.get(definition)!.tiles.push(tile);
  }
  return [...groups.values()];
}
