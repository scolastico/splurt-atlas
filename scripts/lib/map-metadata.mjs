// The station metadata written to map.json: areas, tile definitions with
// their atoms, and the inputs that decide whether a map needs re-rendering.
import { readFileSync } from 'node:fs';
import { aperture, classify, pretty, unquote } from './dm.mjs';
import { doorControlKeys } from './door-controls.mjs';
import { digest } from './incremental.mjs';
import { runtimeReplacement } from './runtime-terrain.mjs';
import { tileLoot } from './spawn-records.mjs';
import { randomSourceInfo, VENDING_PREVIEW_DESCRIPTION } from './random-appearances.mjs';

/** Collects the areas of a map in first-seen order. */
export function createAreaIndex(db) {
  const areas = [];
  const indexByPath = new Map();
  return {
    areas,
    /** The index of an area, adding it on first use. */
    index(type) {
      let index = indexByPath.get(type);
      if (index === undefined) {
        const vars = db.resolve(type);
        index = areas.length;
        indexByPath.set(type, index);
        areas.push({
          path: type,
          name: unquote(vars.name) || pretty(type),
          region: type.split('/')[3] || 'other',
          gravity: vars.has_gravity ?? null,
          source: db.types.get(type)?.file ?? null,
        });
      }
      return index;
    },
  };
}

/** The atom record of one mapped object as the viewer sees it. */
async function describeAtom(atom, atoms, { db, objectVisual, doorAccess }) {
  const vars = { ...db.resolve(atom.path), ...atom.vars };
  const door = atom.path.startsWith('/obj/machinery/door/');
  const random = randomSourceInfo(atom, db);
  return {
    path: atom.path,
    name: unquote(vars.name) || pretty(atom.path),
    description: random?.kind === 'vending' ? VENDING_PREVIEW_DESCRIPTION : unquote(vars.desc),
    random: random || undefined,
    visual: await objectVisual(atom, vars),
    doorAccess: door ? doorAccess(atoms, atom) : undefined,
    controlKeys: door ? doorControlKeys(atom, db) : undefined,
    network: classify(atom.path),
    vars: atom.vars,
    source: db.types.get(atom.path)?.file ?? null,
  };
}

/**
 * Builds one definition per dictionary key: its area, turf, aperture and
 * atoms. Also returns the loot per key and the spawners without candidates.
 */
export async function buildDefinitions(dictionary, context) {
  const { db } = context;
  const areaIndex = createAreaIndex(db);
  const definitions = [];
  const definitionIds = new Map();
  const lootByKey = new Map();
  const unresolved = [];
  for (const [key, atoms] of dictionary) {
    const area = atoms.find((atom) => atom.path.startsWith('/area'))?.path || '/area/space';
    const turf = atoms.find((atom) => atom.path.startsWith('/turf'))?.path || '/turf/open/space';
    const visible = atoms.filter((atom) => !atom.path.startsWith('/area'));
    definitionIds.set(key, definitions.length);
    definitions.push({
      area: areaIndex.index(area),
      turf,
      aperture: aperture(turf),
      atoms: await Promise.all(visible.map((atom) => describeAtom(atom, atoms, context))),
    });
    lootByKey.set(key, tileLoot(db, atoms, unresolved));
  }
  // Resolve generated terrain before comparing metadata and rendering inputs.
  for (const definition of definitions) {
    const replacement = runtimeReplacement(definition, areaIndex.areas[definition.area], db);
    if (replacement) definition.runtimeTerrain = replacement;
  }
  return {
    definitions,
    definitionIds,
    areas: areaIndex.areas,
    lootByKey,
    unresolved: [...new Set(unresolved)],
  };
}

/**
 * Tracks which DM types and icons a map's conversion touched, so the
 * fingerprint covers exactly the declarations and sprites it depends on.
 */
export function trackUsage(db, sprites) {
  let usedTypes = new Set();
  let usedIcons = new Set();
  const resolveType = db.resolve;
  const hasState = sprites.hasState;
  db.resolve = (type, ...rest) => {
    if (type) usedTypes.add(type);
    return resolveType(type, ...rest);
  };
  sprites.hasState = (icon, state) => {
    if (icon) usedIcons.add(icon);
    return hasState(icon, state);
  };
  db.hasIconState = sprites.hasState;
  return {
    resolveType,
    reset() {
      usedTypes = new Set();
      usedIcons = new Set();
    },
    recordIcon(icon) {
      if (icon.endsWith('.dmi')) usedIcons.add(icon);
    },
    /** Sorted [type, resolved vars] pairs and [icon, file hash] pairs of this map. */
    inputs(root, iconHashes) {
      const types = [...usedTypes].sort().map((type) => [type, resolveType(type)]);
      for (const [, vars] of types) this.recordIcon(unquote(vars.icon));
      const icons = [...usedIcons].sort().map((icon) => {
        if (!iconHashes.has(icon)) {
          try {
            iconHashes.set(icon, digest(readFileSync(`${root}/${icon}`)));
          } catch {
            iconHashes.set(icon, null);
          }
        }
        return [icon, iconHashes.get(icon)];
      });
      return { types, icons };
    },
  };
}
