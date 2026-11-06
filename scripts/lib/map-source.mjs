// Reading a station's configuration and its map files from the source checkout.
import { readFileSync } from 'node:fs';
import { parseDmm } from './dmm.mjs';

/** The upstream _maps/<id>.json configuration. */
export function readStationConfig(root, id) {
  return JSON.parse(readFileSync(`${root}/_maps/${id}.json`));
}

/** Whether a configuration describes a station map (and not, say, an away mission). */
export function isStationConfig(config) {
  return !!(config.map_path && config.map_file);
}

/** The map files of a station, relative to its map_path. */
export function stationMapFiles(config) {
  return Array.isArray(config.map_file) ? config.map_file : [config.map_file];
}

/**
 * Parses every map file of a station into one map. Files are stacked along
 * z in order, and dictionary keys are prefixed with the file index so the
 * files never collide.
 */
export function loadStationMap(root, config) {
  const merged = { dictionary: new Map(), cells: [], levels: [], width: 0, height: 0 };
  let zOffset = 0;
  for (const [fileIndex, file] of stationMapFiles(config).entries()) {
    const map = parseDmm(readFileSync(`${root}/_maps/${config.map_path}/${file}`, 'utf8'));
    for (const [key, atoms] of map.dictionary) merged.dictionary.set(`${fileIndex}:${key}`, atoms);
    for (const cell of map.cells)
      merged.cells.push({ ...cell, key: `${fileIndex}:${cell.key}`, z: cell.z + zOffset });
    merged.levels.push(...map.levels.map((z) => z + zOffset));
    zOffset += Math.max(...map.levels);
    merged.width = Math.max(merged.width, map.width);
    merged.height = Math.max(merged.height, map.height);
  }
  return merged;
}
