// Pure helpers for the camera and the shareable URL fragment. They have no DOM
// access so the unit tests can exercise them directly.
import type { MapMeta } from '../core/types.ts';
import { infrastructureOrderParam, type Infrastructure } from './infrastructure-order.ts';

/** Zoom-level selector: 'overview' or the pyramid level to draw (0 = full chunks). */
export type Detail = 'overview' | 0 | 1 | 2;

/** Image resolution depends solely on zoom, never on visible content or tile count. */
export function detailForZoom(zoom: number): Detail {
  if (zoom < 0.125) return 'overview';
  if (zoom < 0.25) return 2;
  if (zoom < 0.5) return 1;
  return 0;
}

/** Scale of a deck `depth` levels below the viewed one; lower decks recede when motion is on. */
export function deckScale(zoom: number, depth: number, motion: boolean): number {
  return zoom / (motion ? 1 + depth * 0.12 : 1);
}

export interface TileRef {
  x: number;
  y: number;
  z: number;
}

export interface AreaSelection {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  z: number;
}

export function selectionBounds(a: TileRef, b: TileRef): AreaSelection {
  return {
    x1: Math.min(a.x, b.x),
    y1: Math.min(a.y, b.y),
    x2: Math.max(a.x, b.x),
    y2: Math.max(a.y, b.y),
    z: a.z,
  };
}

/** Rectangle coordinates are inclusive, on one deck, and must fit the map. */
export function selectedArea(params: URLSearchParams, map: MapMeta): AreaSelection | null {
  const raw = params.get('a');
  if (!raw || !/^\d+,\d+,\d+,\d+,\d+$/.test(raw)) return null;
  const [x1, y1, x2, y2, z] = raw.split(',').map(Number);
  if (x1 < 1 || y1 < 1 || x2 < x1 || y2 < y1 || x2 > map.width || y2 > map.height || !map.levels.includes(z))
    return null;
  return { x1, y1, x2, y2, z };
}

/** The `t=x,y,z` parameter of a link, validated against the map. */
export function selectedTile(params: URLSearchParams, map: MapMeta): TileRef | null {
  const raw = params.get('t');
  if (!raw || !/^\d+,\d+,\d+$/.test(raw)) return null;
  const [x, y, z] = raw.split(',').map(Number) as [number, number, number];
  const inside = x >= 1 && x <= map.width && y >= 1 && y <= map.height && map.levels.includes(z);
  return inside ? { x, y, z } : null;
}

/** Tile/area-only links supply their own deck and center, with optional zoom. */
export function selectionCamera(params: URLSearchParams, map: MapMeta) {
  if (params.has('x') || params.has('y')) return null;
  const area = selectedArea(params, map);
  const tile = selectedTile(params, map);
  if (!area && !tile) return null;
  const x = area ? (area.x1 + area.x2) / 2 : tile!.x;
  const y = area ? (area.y1 + area.y2) / 2 : tile!.y;
  const zoom =
    params.has('s') && Number.isFinite(Number(params.get('s')))
      ? Math.max(0.04, Math.min(5, Number(params.get('s'))))
      : area
        ? 1
        : 2;
  return { x: (x - 0.5) * 32, y: (map.height - y + 0.5) * 32, z: area?.z ?? tile!.z, zoom };
}

/** Bit of each sidebar option in the `o=` link parameter. Order is part of the link format. */
export const optionBits = {
  pipes: 0,
  power: 1,
  disposal: 2,
  transit: 3,
  regions: 4,
  cutaway: 5,
  motion: 6,
  'power-networks': 7,
  'simple-utilities': 8,
  connections: 9,
  'connection-labels': 10,
  'detailed-view': 11,
  placed: 12,
  possible: 13,
  'runtime-terrain': 14,
  fluid: 15,
  'mapping-helpers': 16,
  'exact-search': 17,
  navigation: 18,
  'random-markers': 19,
  'changed-tiles': 20,
} as const;

export type OptionKey = keyof typeof optionBits;
export type OptionFlags = Record<OptionKey, boolean>;

export function encodeOptions(options: Partial<Record<OptionKey, boolean>>): number {
  let value = 0;
  for (const [key, bit] of Object.entries(optionBits) as [OptionKey, number][])
    if (options[key]) value |= 1 << bit;
  return value;
}

export function decodeOptions(value: string | number): OptionFlags | null {
  if (!/^\d+$/.test(String(value))) return null;
  const mask = Number(value);
  if (!Number.isSafeInteger(mask) || mask > 0x7fffffff) return null;
  const flags = {} as OptionFlags;
  for (const [key, bit] of Object.entries(optionBits) as [OptionKey, number][])
    flags[key] = !!(mask & (1 << bit));
  return flags;
}

/** The parts of the viewer state that a link records. */
export interface ShareableView {
  map: { id: string };
  z: number;
  x: number;
  y: number;
  zoom: number;
  selected?: TileRef | null;
  selectedArea?: AreaSelection | null;
  query?: string;
  result?: string | null;
  finding?: number | null;
  optionMask?: number;
  doorRoles?: string[];
  offsetHighlights?: Set<number>;
  telecomHighlights?: Set<number>;
  infrastructureOrder?: readonly Infrastructure[];
  current?: string;
  old?: string;
}

/** Builds the `#m=…` fragment that restores a view. */
export function viewFragment(view: ShareableView): string {
  const params = new URLSearchParams({
    m: view.map.id,
    z: String(view.z),
    x: String(Math.round(view.x)),
    y: String(Math.round(view.y)),
    s: String(Number(view.zoom.toFixed(3))),
  });
  if (view.current) params.set('current', view.current);
  if (view.old) params.set('old', view.old);
  if (view.selected) params.set('t', `${view.selected.x},${view.selected.y},${view.selected.z}`);
  if (view.selectedArea) {
    const a = view.selectedArea;
    params.set('a', `${a.x1},${a.y1},${a.x2},${a.y2},${a.z}`);
  }
  if (view.query) params.set('q', view.query);
  if (view.result) {
    params.set('r', view.result);
    params.set('f', String((view.finding || 0) + 1));
  }
  if (view.optionMask !== undefined) params.set('o', String(view.optionMask));
  if (view.infrastructureOrder) {
    const order = infrastructureOrderParam(view.infrastructureOrder);
    if (order) params.set('u', order);
  }
  if (view.doorRoles?.length) params.set('j', view.doorRoles.join(','));
  if (view.offsetHighlights?.size)
    params.set('h', [...view.offsetHighlights].sort((a, b) => a - b).join(','));
  if (view.telecomHighlights?.size)
    params.set('c', [...view.telecomHighlights].sort((a, b) => a - b).join(','));
  return `#${params}`;
}
