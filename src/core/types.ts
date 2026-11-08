// Shapes of the exported station data the viewer consumes. The exporter
// (scripts/export.mjs) writes these files; scripts/lib/map-format.mjs decodes
// the compact on-disk form into the objects described here.

/** Utility networks that can be toggled in the sidebar. */
export type Network = 'pipes' | 'power' | 'fluid' | 'disposal' | 'transit' | 'navigation';

/** data/manifest.json: the catalog of exported stations. */
export interface Manifest {
  schema: number;
  buildId?: string;
  commit: string;
  repository: string;
  /** Folder (relative to data/) holding the current snapshot, if any. */
  dataPath?: string;
  tilePixels: number;
  chunkTiles: number;
  maps: ManifestMap[];
}

export interface ManifestMap {
  id: string;
  name: string;
  width: number;
  height: number;
  levels: number[];
  /** Relative path of the preview image, or null when no preview exists. */
  preview?: string | null;
  naturalPreview?: string;
  /** Packaged ZIP for offline use. */
  archive?: { path: string; bytes: number };
  /** Relative path of the map's asset inventory (assets.json). */
  assets: string;
  /** Extracted size of the map in bytes. */
  bytes?: number;
  assetVersion?: string;
}

/** Pixel bounds of an object drawn outside its own tile, relative to the tile. */
export interface VisualBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DoorAccessDeclaration {
  type: string;
  property: string;
  value: string;
  file: string;
  mapped?: boolean;
}

export interface DoorAccessHelper {
  mappedType: string;
  type: string;
  method: string;
  access: string[];
  file: string;
}

export interface DoorAccess {
  kind: 'public' | 'remote' | 'unknown' | 'restricted';
  /** Roles whose normal starting ID opens the door. */
  roles: string[];
  expandedRoles?: string[];
  all?: string[];
  any?: string[];
  sources?: { requirements?: DoorAccessDeclaration[]; helpers?: DoorAccessHelper[] };
}

export interface ControlKey {
  kind: string;
  id: string;
}

/** One mapped object, turf or mob on a tile. */
export interface Atom {
  path: string;
  name: string;
  description: string | null;
  network: Network | null;
  /** Mapped variable overrides, as DM literals. */
  vars: Record<string, string>;
  /** Repository path of the DM declaration, when known. */
  source: string | null;
  visual?: VisualBounds;
  doorAccess?: DoorAccess;
  controlKeys?: ControlKey[];
  random?: { kind: 'vending' | 'poster' | 'trash' | 'plant' | 'gibs' | 'spawn'; guaranteed?: boolean };
}

export interface RuntimeTerrain {
  type: string;
  name: string;
  description?: string;
  approximate: boolean;
}

/** A distinct tile content; the level grid references definitions by index. */
export interface Definition {
  area: number;
  turf: string;
  /** 0-255 opacity of the turf as seen from the deck above. */
  aperture: number;
  atoms: Atom[];
  runtimeTerrain?: RuntimeTerrain;
}

export interface Area {
  path: string;
  name: string;
  region: string;
}

export interface InfrastructureNode {
  id: number;
  channel: Network;
  x: number;
  y: number;
  z: number;
  layer: number;
  /** Bitmask of connected directions (NORTH 1, SOUTH 2, EAST 4, WEST 8). */
  links: number;
  network: number;
  exposed: boolean;
  simpleEligible?: boolean;
  color: string;
}

export interface TransitionTarget {
  z: number;
  room: string;
}

/** A stair, ladder or similar deck connection. */
export interface Transition {
  x: number;
  y: number;
  z: number;
  kind: string;
  targets: TransitionTarget[];
}

export interface DoorControl {
  kind: string;
  id: string;
  name: string;
  x: number;
  y: number;
  z: number;
  range?: number;
  atomIndex: number;
}

export interface JobRoleSource {
  type: string;
  declarations: DoorAccessDeclaration[];
  mapChanges?: Record<string, unknown>;
}

export interface Room {
  path: string;
  name: string;
  region: string;
  /** Flat x, y, z triples. */
  points: number[];
}

/** <map>/map.json after decoding. */
export interface MapMeta {
  id: string;
  name: string;
  width: number;
  height: number;
  levels: number[];
  areas: Area[];
  definitions: Definition[];
  infrastructure?: {
    nodes: InfrastructureNode[];
    transitions: Transition[];
    powerNetworks: number;
  };
  rooms?: Room[];
  jobRoles?: string[];
  jobRoleSources?: Record<string, JobRoleSource>;
  doorControls?: DoorControl[];
  /** Repository paths of the map files this station was exported from. */
  files: string[];
}

/** [x, y, channel mask] of one strip in a zoom level. */
export type TileEntry = [number, number, number];

/** <map>/<z>.json after decoding. */
export interface LevelData {
  schema: number;
  z: number;
  cells: number;
  /** Definition index per tile, row-major from the top-left. */
  grid: Int32Array;
  /** [minX, minY, maxX, maxY] in tiles of the non-space area, or null. */
  bounds: [number, number, number, number] | null;
  /** Strips per level of detail: chunks first, then each coarser level. */
  pyramid: TileEntry[][];
  overview: number;
  overviewUtilities: number;
}

/** One record of <map>/search.json after decoding. */
export interface SearchItem {
  path: string;
  name: string;
  kind: 'placed' | 'possible';
  spawner?: string;
  points: number[];
}

/** A search index entry grouped by kind and type path. */
export interface SearchRecord {
  id: string;
  name: string;
  path: string;
  kind: 'room' | 'placed' | 'possible';
  kinds?: ('placed' | 'possible')[];
  placedPoints?: number[];
  region?: string;
  points: number[];
  spawners: string[];
  count: number;
}

/** A search hit as listed in the sidebar (points stripped). */
export type SearchHit = Omit<SearchRecord, 'points' | 'spawners' | 'placedPoints'>;

export interface TileCandidate {
  name: string;
  path: string;
}
