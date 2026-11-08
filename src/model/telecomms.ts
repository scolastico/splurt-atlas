import type { MapMeta, TelecommsMachine } from '../core/types.ts';
import type { AreaSelection, TileRef } from './view-state.ts';

export function selectedTelecomms(
  map: MapMeta,
  tile: TileRef | null,
  area: AreaSelection | null = null,
): TelecommsMachine[] {
  if (!tile) return [];
  return (map.telecomms || []).filter((machine) =>
    area
      ? machine.z === area.z &&
        machine.x >= area.x1 &&
        machine.x <= area.x2 &&
        machine.y >= area.y1 &&
        machine.y <= area.y2
      : machine.x === tile.x && machine.y === tile.y && machine.z === tile.z,
  );
}

export function validTelecomHighlights(
  map: MapMeta,
  tile: TileRef | null,
  area: AreaSelection | null,
  ids: Iterable<number>,
): Set<number> {
  const allowed = new Set(selectedTelecomms(map, tile, area).flatMap((machine) => machine.links));
  return new Set([...ids].filter((id) => allowed.has(id)));
}

export function frequencyLabel(frequency: { value: number; name?: string }): string {
  const value = (frequency.value / 10).toFixed(1);
  return frequency.name ? `${value} (${frequency.name})` : value;
}
