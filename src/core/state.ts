// The viewer's shared state: the loaded catalog and station, the camera and
// the selection. Modules read and update it directly; `redraw()` in frame.ts
// schedules the next paint after a change.
import type { LevelData, Manifest, MapMeta, Network } from './types.ts';
import type { AreaSelection, TileRef } from '../model/view-state.ts';
import { DEFAULT_INFRASTRUCTURE_ORDER } from '../model/infrastructure-order.ts';

/** A decoded deck plus a lookup of strip masks per zoom level, keyed "x,y". */
export interface DeckLevel extends LevelData {
  tileMasks: Map<string, number>[];
}

export interface ViewerState {
  current?: string;
  old?: string;
  /** Union of both revisions, expressed from the current map's world origin. */
  comparisonBounds?: { width: number; height: number; offsetY: number };
  manifest: Manifest | null;
  map: MapMeta | null;
  levels: Map<number, DeckLevel>;
  /** Viewed deck. */
  z: number;
  zoom: number;
  /** Camera center in world pixels (32 per tile, y growing downwards). */
  x: number;
  y: number;
  /** Canvas size in CSS pixels and the device pixel ratio in use. */
  w: number;
  h: number;
  dpr: number;
  /** Increments on every station load; async work compares it to detect staleness. */
  generation: number;
  /** The station is decoded and may be drawn. */
  ready: boolean;
  loadingStation: boolean;
  /** Flat x, y, z triples of the current search finding, drawn as rings. */
  markers: number[];
  changedTiles: { x: number; y: number; z: number; kind: string }[];
  placedMarkers: Set<string>;
  selected: TileRef | null;
  selectedArea: AreaSelection | null;
  selectionDraft: AreaSelection | null;
  /** Indices of offset-drawn objects on the selected tile that are highlighted. */
  offsetHighlights: Set<number>;
  telecomHighlights: Set<number>;
  /** When the selection pulse animation started. */
  selectionPulseStart: number;
  motion: boolean;
  cutaway: boolean;
  regions: boolean;
  searchReady: boolean;
  query: string;
  placed: boolean;
  possible: boolean;
  /** Search record id and finding index currently shown. */
  result: string | null;
  finding: number | null;
  doorRoles: string[];
  optionMask?: number;
}

export const state: ViewerState = {
  manifest: null,
  map: null,
  levels: new Map(),
  z: 1,
  zoom: 1,
  x: 0,
  y: 0,
  w: 0,
  h: 0,
  dpr: 1,
  generation: 0,
  ready: false,
  loadingStation: false,
  markers: [],
  changedTiles: [],
  placedMarkers: new Set(),
  selected: null,
  selectedArea: null,
  selectionDraft: null,
  offsetHighlights: new Set(),
  telecomHighlights: new Set(),
  selectionPulseStart: -Infinity,
  motion: true,
  cutaway: true,
  regions: false,
  searchReady: false,
  query: '',
  placed: true,
  possible: true,
  result: null,
  finding: null,
  doorRoles: [],
};

/** Side length of a tile in world pixels. */
export const TILE = 32;

export const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

export const palette: Record<Network, string> = {
  pipes: '#68c8b2',
  power: '#e5bd69',
  fluid: '#a798e5',
  disposal: '#ce8baf',
  transit: '#80addb',
  navigation: '#a6d88d',
};

export const networkNames: Record<Network, string> = {
  pipes: 'Atmospherics',
  power: 'Power cables',
  fluid: 'Fluid ducts',
  disposal: 'Waste disposal',
  transit: 'Transit tubes',
  navigation: 'Navigation beacons',
};

/** Utility networks whose hidden components are currently shown. */
export const enabledNetworks = new Set<Network>(['transit']);
/** Sidebar order, topmost infrastructure first. Stored locally by the controls. */
export const infrastructureOrder = [...DEFAULT_INFRASTRUCTURE_ORDER];

/** The definition under a tile, if the deck is loaded and the tile is inside the map. */
export function definitionAt(x: number, y: number, z: number) {
  const map = state.map;
  if (!map || x < 1 || y < 1 || x > map.width || y > map.height) return undefined;
  const level = state.levels.get(z);
  if (!level) return undefined;
  return map.definitions[level.grid[(map.height - y) * map.width + x - 1]];
}
