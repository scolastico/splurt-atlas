// Pure helpers for the camera and the shareable URL fragment. They have no DOM
// access so the unit tests can exercise them directly.
import type { MapMeta } from '../core/types.ts';

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

/** The `t=x,y,z` parameter of a link, validated against the map. */
export function selectedTile(params: URLSearchParams, map: MapMeta): TileRef | null {
  const raw = params.get('t');
  if (!raw || !/^\d+,\d+,\d+$/.test(raw)) return null;
  const [x, y, z] = raw.split(',').map(Number) as [number, number, number];
  const inside = x >= 1 && x <= map.width && y >= 1 && y <= map.height && map.levels.includes(z);
  return inside ? { x, y, z } : null;
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
  query?: string;
  result?: string | null;
  finding?: number | null;
  optionMask?: number;
  doorRoles?: string[];
  offsetHighlights?: Set<number>;
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
  if (view.selected) params.set('t', `${view.selected.x},${view.selected.y},${view.selected.z}`);
  if (view.query) params.set('q', view.query);
  if (view.result) {
    params.set('r', view.result);
    params.set('f', String((view.finding || 0) + 1));
  }
  if (view.optionMask !== undefined) params.set('o', String(view.optionMask));
  if (view.doorRoles?.length) params.set('j', view.doorRoles.join(','));
  if (view.offsetHighlights?.size)
    params.set('h', [...view.offsetHighlights].sort((a, b) => a - b).join(','));
  return `#${params}`;
}
