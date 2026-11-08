// Converts a list of stations in this process. The parallel driver
// (export-parallel.mjs) spawns one of these per worker.
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { exportProgress } from '../export-progress.mjs';
import { promote } from '../promote.mjs';
import { expandStructures, randomisePosters, randomiseTrash, smoothAtoms } from './appearance.mjs';
import { unquote } from './dm.mjs';
import { loadTypes } from './dm.mjs';
import { createSpriteReader } from './dmi.mjs';
import { createDoorResolver } from './door-access.mjs';
import { collectDoorControls } from './door-controls.mjs';
import { createExportContext } from './export-context.mjs';
import { copyCredits, listAssets, writeAssetSources, writeBuildReport } from './export-output.mjs';
import { canQuickReuse, completeMap, legacyMatches, mapFingerprint, reuseMap } from './incremental.mjs';
import { buildInfrastructure } from './infrastructure.mjs';
import { renderLevel } from './level-renderer.mjs';
import { SCHEMA, encodeMap, encodeSearch } from './map-format.mjs';
import { buildDefinitions, trackUsage } from './map-metadata.mjs';
import { isStationConfig, loadStationMap, readStationConfig, stationMapFiles } from './map-source.mjs';
import { createObjectVisual } from './object-visual.mjs';
import { createNaturalTerrain } from './runtime-terrain.mjs';
import { buildRooms, buildSearchItems } from './spawn-records.mjs';
import { createTileRenderer } from './tile-renderer.mjs';

/** Per-cell appearances: expanded structures, smoothed neighbors, resolved random posters. */
function buildAppearances(map, db) {
  const { cells, dictionary } = map;
  const expanded = new Map([...dictionary].map(([key, atoms]) => [key, expandStructures(atoms, db)]));
  const spatial = new Map(cells.map((cell) => [`${cell.x},${cell.y},${cell.z}`, expanded.get(cell.key)]));
  const at = (x, y, z) => spatial.get(`${x},${y},${z}`);
  for (const cell of cells)
    cell.appearance = randomiseTrash(
      randomisePosters(
        smoothAtoms(expanded.get(cell.key), cell.x, cell.y, cell.z, at, db),
        cell.x,
        cell.y,
        cell.z,
        db,
      ),
      cell.x,
      cell.y,
      cell.z,
      db,
    );
  return { expanded, at };
}

export async function runExportWorker() {
  const progress = exportProgress();
  sharp.concurrency(Number(process.env.ATLAS_SHARP_THREADS) || 1);
  sharp.cache({ memory: 128, files: 20, items: 100 });
  const context = createExportContext();
  const { config, root, output, provenance, args, baseline, converter, changed, selected } = context;
  mkdirSync(output, { recursive: true });
  console.log('Indexing DM declarations in include order…');
  progress.update('Indexing DM declarations');
  const db = loadTypes(root);
  const sprites = createSpriteReader(root);
  const usage = trackUsage(db, sprites);
  console.log(`${db.types.size} types from ${db.fileCount} DM files`);
  const manifest = {
    schema: SCHEMA,
    buildId: randomUUID(),
    converter,
    ...provenance,
    tilePixels: config.tilePixels,
    chunkTiles: config.chunkTiles,
    maps: [],
  };
  /** Writes the manifest so far, so an interrupted run can resume from completed maps. */
  function checkpoint() {
    if (process.env.ATLAS_CHECKPOINT !== '1') return;
    const temporary = path.join(output, 'manifest.checkpoint.json');
    writeFileSync(temporary, JSON.stringify({ ...manifest, complete: false }, null, 2));
    renameSync(temporary, path.join(output, 'manifest.json'));
  }
  const rebuilt = [];
  const reused = [];
  const iconHashes = new Map();
  const tilePixels = config.tilePixels;
  const chunkTiles = config.chunkTiles;
  const tiles = createTileRenderer({ db, sprites, tilePixels });
  const objectVisual = createObjectVisual(db, sprites, tilePixels);
  const recordAtomIcon = (atom) => usage.recordIcon(unquote({ ...db.resolve(atom.path), ...atom.vars }.icon));

  for (const [mapIndex, id] of selected.entries()) {
    const mapProgress = (fraction) => (100 * (mapIndex + fraction)) / selected.length;
    progress.update(`Preparing ${id} (${mapIndex + 1}/${selected.length})`, mapProgress(0));
    tiles.clear();
    usage.reset();
    const previous = baseline?.manifest.maps.find((map) => map.id === id);
    const dir = `${output}/${id}`;
    if (
      canQuickReuse(baseline, previous, converter, changed, config) &&
      completeMap(baseline.root, previous)
    ) {
      manifest.maps.push(reuseMap(baseline, previous, dir));
      reused.push(id);
      console.log(`${id}: reused (no relevant file changes)`);
      checkpoint();
      continue;
    }
    const station = readStationConfig(root, id);
    const doorAccess = createDoorResolver(db, station.job_changes || {});
    if (!isStationConfig(station)) {
      console.log(`Skipping non-station config ${id}`);
      continue;
    }
    const files = stationMapFiles(station).map((file) => `_maps/${station.map_path}/${file}`);
    // Only remove generated output for this map, never source or arbitrary paths.
    if (existsSync(dir)) rmSync(dir, { recursive: true });
    mkdirSync(dir, { recursive: true });
    const map = loadStationMap(root, station);
    const { width, height, cells, dictionary, levels } = map;
    const { expanded, at } = buildAppearances(map, db);
    const infrastructure = buildInfrastructure(cells, at, db, levels);
    const { definitions, definitionIds, areas, lootByKey, unresolved } = await buildDefinitions(dictionary, {
      db,
      objectVisual,
      doorAccess,
    });
    const items = buildSearchItems(cells, lootByKey);
    writeFileSync(`${dir}/search.json`, JSON.stringify(encodeSearch(items)));
    const rooms = buildRooms(areas, cells, (cell) => definitions[definitionIds.get(cell.key)].area, levels);
    const metadata = {
      id,
      name: station.map_name,
      width,
      height,
      levels,
      areas,
      rooms,
      jobRoles: doorAccess.roles,
      jobRoleSources: doorAccess.roleSources,
      doorControls: collectDoorControls(cells, dictionary, db),
      infrastructure,
      definitions,
      files,
      traits: station.traits || [],
      unresolvedSpawners: unresolved,
    };
    // The fingerprint covers every declaration, sprite and appearance the
    // rendering depends on; an unchanged fingerprint reuses the baseline.
    for (const atoms of expanded.values()) for (const atom of atoms) recordAtomIcon(atom);
    for (const cell of cells) for (const atom of cell.appearance) if (atom.vars.icon) recordAtomIcon(atom);
    const { types, icons } = usage.inputs(root, iconHashes);
    const fingerprint = mapFingerprint({ converter, config, metadata, items, cells, types, icons });
    const inputs = [`_maps/${id}.json`, ...files, ...icons.map(([icon]) => icon)];
    const unchanged =
      previous &&
      (previous.fingerprint === fingerprint ||
        (args.adoptBaseline && legacyMatches(baseline, previous, provenance.commit, metadata, items)));
    if (unchanged && completeMap(baseline.root, previous)) {
      manifest.maps.push({ ...reuseMap(baseline, previous, dir), fingerprint, inputs });
      reused.push(id);
      console.log(`${id}: reused (rendering inputs unchanged)`);
      checkpoint();
      continue;
    }
    rebuilt.push(id);
    writeFileSync(`${dir}/map.json`, JSON.stringify(encodeMap(metadata)));
    const natural = createNaturalTerrain(metadata, db, sprites, tilePixels, chunkTiles);
    const geometry = { width, height, tilePixels, chunkTiles };
    for (const [levelIndex, z] of levels.entries()) {
      console.log(`${station.map_name} · Z${z}: rendering ${width} × ${height}`);
      const result = await renderLevel({
        z,
        cells,
        definitions,
        definitionIds,
        dir,
        geometry,
        tiles,
        natural,
        isTopDeck: z === levels.at(-1),
        onChunk: (rendered, total) =>
          progress.update(
            `${station.map_name}: deck ${z}, chunk ${rendered}/${total}`,
            mapProgress((levelIndex + rendered / total) / levels.length),
          ),
        onPyramid: () =>
          progress.update(
            `${station.map_name}: deck ${z}, zoom levels`,
            mapProgress((levelIndex + 1) / levels.length),
          ),
      });
      const terrainNote = result.terrainChunks
        ? `, ${result.terrainChunks} chunks with generated terrain`
        : '';
      console.log(`  ${result.stripCounts.join(' + ')} strips${terrainNote}`);
    }
    const assets = listAssets(dir);
    writeFileSync(`${dir}/assets.json`, JSON.stringify(assets));
    const entry = {
      id,
      name: station.map_name,
      width,
      height,
      levels,
      items: items.length,
      fingerprint,
      inputs,
      assetVersion: fingerprint,
      assets: `${id}/assets.json`,
      bytes: assets.reduce((sum, asset) => sum + asset.bytes, 0),
      preview: existsSync(`${dir}/preview.webp`) ? `${id}/preview.webp` : null,
    };
    if (existsSync(`${dir}/preview-natural.webp`)) entry.naturalPreview = `${id}/preview-natural.webp`;
    manifest.maps.push(entry);
    checkpoint();
  }
  copyCredits(root, output);
  writeAssetSources(output, provenance, manifest.maps);
  writeBuildReport(output, {
    commit: provenance.commit,
    baseline: baseline?.manifest.commit || null,
    changedFiles: changed,
    rebuilt,
    reused,
    forced: args.full,
  });
  writeFileSync(`${output}/manifest.json`, JSON.stringify(manifest, null, 2));
  // Release libvips file handles before the atomic directory swap on Windows.
  sharp.cache(false);
  if (process.env.ATLAS_STAGE_ONLY !== '1') promote(output);
  progress.finish();
  console.log(`Exported ${manifest.maps.length} stations. Sprite report:`, sprites.report);
}
