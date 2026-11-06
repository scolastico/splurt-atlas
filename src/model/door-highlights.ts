// Door access highlighting: which doors a set of job roles can open.
import Fuse from 'fuse.js';
import type { Atom, DoorAccess, LevelData, MapMeta } from '../core/types.ts';

export interface DoorTile {
  x: number;
  y: number;
  z: number;
  access: DoorAccess[];
}

export type DoorStatus = 'allowed' | 'partial' | 'denied';

export interface DoorMarker extends DoorTile {
  status: DoorStatus;
}

/** Every tile with at least one door, with the access rules of its doors. */
export function indexDoorTiles(map: MapMeta, levels: Map<number, Pick<LevelData, 'grid'>>): DoorTile[] {
  const accessByDefinition = new Map<number, DoorAccess[]>();
  map.definitions.forEach((definition, index) => {
    const access = definition.atoms.flatMap((atom) => (atom.doorAccess ? [atom.doorAccess] : []));
    if (access.length) accessByDefinition.set(index, access);
  });
  const tiles: DoorTile[] = [];
  for (const [z, level] of levels)
    for (let index = 0; index < level.grid.length; index++) {
      const access = accessByDefinition.get(level.grid[index]);
      if (access)
        tiles.push({ x: (index % map.width) + 1, y: map.height - Math.floor(index / map.width), z, access });
    }
  return tiles;
}

type RoleDecision = 'normal' | 'expanded' | 'denied' | 'unknown';

/** How one rule treats one role. */
function decideRule(rule: DoorAccess, role: string): RoleDecision {
  if (rule.kind === 'public') return 'normal';
  if (rule.kind === 'remote') return 'denied';
  if (rule.kind !== 'restricted') return 'unknown';
  if ((rule.roles || []).includes(role)) return 'normal';
  if ((rule.expandedRoles || []).includes(role)) return 'expanded';
  return 'denied';
}

/** The worst outcome across all doors on a tile, for one role. */
function decideTile(tile: DoorTile, role: string): RoleDecision {
  const decisions = tile.access.map((rule) => decideRule(rule, role));
  if (decisions.includes('denied')) return 'denied';
  if (decisions.includes('unknown')) return 'unknown';
  if (decisions.includes('expanded')) return 'expanded';
  return 'normal';
}

/** Marker colors for the selected roles; tiles with unknown access get no marker. */
export function doorMarkersForRoles(tiles: DoorTile[], roles: string[]): DoorMarker[] {
  if (!roles.length) return [];
  return tiles.flatMap((tile) => {
    const decisions = roles.map((role) => decideTile(tile, role));
    let status: DoorStatus | null;
    if (decisions.every((value) => value === 'normal')) status = 'allowed';
    else if (decisions.some((value) => value === 'normal' || value === 'expanded')) status = 'partial';
    else if (decisions.includes('unknown')) status = null;
    else status = 'denied';
    return status ? [{ ...tile, status }] : [];
  });
}

/** Up to eight role names matching the query, excluding roles already selected. */
export function roleSuggestions(roles: string[], query: string, selected: string[] = []): string[] {
  const available = roles.filter((role) => !selected.includes(role));
  const trimmed = query.trim();
  if (!trimmed) return available.slice(0, 8);
  return new Fuse(available, { threshold: 0.45, ignoreLocation: true })
    .search(trimmed)
    .slice(0, 8)
    .map((result) => result.item);
}

type DoorAtom = Atom & { doorAccess: DoorAccess };

/** Merges doors with identical access rules into one entry with a combined name. */
export function groupDoorAccess(doors: DoorAtom[]): DoorAtom[] {
  const groups = new Map<string, DoorAtom[]>();
  for (const door of doors) {
    const access = door.doorAccess;
    const key = JSON.stringify([
      access.kind,
      [...(access.roles || [])].sort(),
      [...(access.expandedRoles || [])].sort(),
    ]);
    const group = groups.get(key);
    if (group) group.push(door);
    else groups.set(key, [door]);
  }
  return [...groups.values()].map((group) => {
    const names = [...new Set(group.map((door) => door.name))];
    return {
      ...group[0],
      controlKeys: group.flatMap((door) => door.controlKeys || []),
      name: names.length > 1 ? `${names.slice(0, -1).join(', ')} & ${names.at(-1)}` : names[0],
    };
  });
}
