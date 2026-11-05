import { readFileSync, writeFileSync, mkdirSync, readdirSync, copyFileSync, existsSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import sharp from 'sharp';
import { parseDmm } from './lib/dmm.mjs';
import { loadTypes, unquote, pretty, classify, aperture } from './lib/dm.mjs';
import { createSpriteReader } from './lib/dmi.mjs';
import { expandStructures, smoothAtoms } from './lib/appearance.mjs';
import { promote } from './promote.mjs';
import { writeMipmaps } from './lib/image-pyramid.mjs';
import { buildInfrastructure } from './lib/infrastructure.mjs';
import { createDoorResolver } from './lib/door-access.mjs';
import { bakeRuntimeTerrain } from './lib/runtime-terrain.mjs';

sharp.cache({ memory: 128, files: 20, items: 100 });
const config = JSON.parse(readFileSync('atlas.config.json'));
const root = path.resolve('.source/S.P.L.U.R.T-tg'), cacheRoot = path.resolve('.cache');
const output = path.join(cacheRoot, `export-${randomUUID()}`);
if (!existsSync(root)) throw new Error('Run pnpm source first.');
const provenance = JSON.parse(readFileSync('.source/provenance.json'));
if (provenance.commit !== config.ref) throw new Error('Source pin changed: run pnpm source first.');
const args = process.argv.slice(2).filter(v => v !== '--');
const available = readdirSync(`${root}/_maps`).filter(v => v.endsWith('.json'));
const selected = (args.includes('--all') || (!args.length&&config.maps==='all') ? available.map(v => v.slice(0, -5)) : (args.length ? args : config.maps)).filter(id=>!(config.excludeMaps||[]).includes(id));
mkdirSync(output, { recursive: true });
console.log('Indexing DM declarations in include order…');
const db = loadTypes(root), sprites = createSpriteReader(root);
db.hasIconState = sprites.hasState;
console.log(`${db.types.size} types from ${db.fileCount} DM files`);
const manifest = { schema: 2, buildId:randomUUID(), ...provenance, tilePixels: config.tilePixels, chunkTiles: config.chunkTiles, maps: [] };
const S = config.tilePixels, C = config.chunkTiles, P = S * C;
const imageCache = new Map();
const numeric = (v, fallback) => Number.isFinite(Number(v)) ? Number(v) : fallback;

function candidates(type, vars, seen = new Set()) {
  if (seen.has(type) || seen.size > 12) return [];
  seen.add(type);
  let paths = vars.loot?.match(/\/(?:obj|mob)\/[\w/]+/g) || [];
  if (type.includes('/spawner/random/maintenance')) paths = [...paths, ...db.pool(vars.loot_table?.includes('DUMPSTER') ? 'dumpster_loot' : 'maintenance_loot')];
  return [...new Set(paths.flatMap(p => p.includes('/spawner/') ? candidates(p, db.resolve(p), new Set(seen)) : [p]))];
}

async function tileImage(atoms, channel) {
  const selected = atoms.filter(a => (classify(a.path) || 'base') === channel && !a.path.startsWith('/area/') && !/\/landmark|\/spawner\//.test(a.path));
  const key = JSON.stringify(selected);
  if (imageCache.has(key)) return imageCache.get(key);
  const job = (async () => {
    const layers = [];
    for (const atom of selected) {
      const vars = { ...db.resolve(atom.path), ...atom.vars };
      if (/\/space(?:\/|$)|\/openspace(?:\/|$)/.test(atom.path)) continue;
      const icon = unquote(vars.icon), state = unquote(vars.icon_state);
      if (!icon || !icon.endsWith('.dmi')) continue;
      const opacity = Math.min(numeric(vars.alpha, 255), atom.path.startsWith('/turf/') && aperture(atom.path) ? 255 - aperture(atom.path) : 255);
      const sprite = await sprites.sprite(icon, state, numeric(vars.dir, 2), unquote(vars.color), opacity);
      if (!sprite) continue;
      // Tiles use a one-cell gutter, preserving pixel offsets and up to 96px icons.
      const translation = vars.transform?.match(/^TRANSLATE_MATRIX\(\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\)/);
      const left = Math.round(S + numeric(vars.pixel_x, 0) + numeric(translation?.[1], 0));
      const top = Math.round(S + S - sprite.height - numeric(vars.pixel_y, 0) - numeric(translation?.[2], 0));
      if (left < 0 || top < 0 || left + sprite.width > S * 3 || top + sprite.height > S * 3) continue;
      const defaultLayer = atom.path.startsWith('/turf/') ? 1 : atom.path.includes('turf_decal') ? 2 : atom.path.startsWith('/mob/') ? 5 : 3;
      layers.push({ input: sprite.input, left, top, layer: numeric(vars.layer, defaultLayer) });
    }
    if (!layers.length) return null;
    layers.sort((a, b) => a.layer - b.layer);
    return sharp({ create: { width: S * 3, height: S * 3, channels: 4, background: '#00000000' } }).composite(layers.map(({ layer, ...rest }) => rest)).png().toBuffer();
  })();
  imageCache.set(key, job); return job;
}

for (const id of selected) {
  imageCache.clear();
  if (!/^[\w-]+$/.test(id)) throw new Error(`Invalid map id ${id}`);
  const meta = JSON.parse(readFileSync(`${root}/_maps/${id}.json`));
  const doorAccess=createDoorResolver(db,meta.job_changes||{});
  if (!meta.map_path || !meta.map_file) { console.log(`Skipping non-station config ${id}`); continue; }
  const files = Array.isArray(meta.map_file) ? meta.map_file : [meta.map_file];
  const dir = `${output}/${id}`;
  // Only remove generated output for this map, never source or arbitrary paths.
  if (existsSync(dir)) rmSync(dir, { recursive: true });
  mkdirSync(dir, { recursive: true });
  const merged = { dictionary: new Map(), cells: [], levels: [], width: 0, height: 0 };
  let offset = 0;
  for (const [fileIndex, file] of files.entries()) {
    const map = parseDmm(readFileSync(`${root}/_maps/${meta.map_path}/${file}`, 'utf8'));
    for (const [key, atoms] of map.dictionary) merged.dictionary.set(`${fileIndex}:${key}`, atoms);
    for (const cell of map.cells) merged.cells.push({ ...cell, key: `${fileIndex}:${cell.key}`, z: cell.z + offset });
    merged.levels.push(...map.levels.map(z => z + offset));
    offset += Math.max(...map.levels);
    merged.width = Math.max(merged.width, map.width); merged.height = Math.max(merged.height, map.height);
  }
  const { width, height, cells, dictionary, levels } = merged;
  const expanded = new Map([...dictionary].map(([key, atoms]) => [key, expandStructures(atoms, db)]));
  const spatial = new Map(cells.map(cell => [`${cell.x},${cell.y},${cell.z}`, expanded.get(cell.key)]));
  const at = (x, y, z) => spatial.get(`${x},${y},${z}`);
  for (const cell of cells) cell.appearance = smoothAtoms(expanded.get(cell.key), cell.x, cell.y, cell.z, at, db);
  const infrastructure=buildInfrastructure(cells,at,db,levels);
  const defs = [], keyIds = new Map(), areaMap = new Map(), areas = [], items = [], unresolved = [];
  const getArea = type => {
    if (!areaMap.has(type)) {
      const vars = db.resolve(type);
      areaMap.set(type, areas.length);
      areas.push({ path: type, name: unquote(vars.name) || pretty(type), region: type.split('/')[3] || 'other', gravity: vars.has_gravity ?? null, source: db.types.get(type)?.file ?? null });
    }
    return areaMap.get(type);
  };
  const keyLoot = new Map();
  for (const [key, atoms] of dictionary) {
    const area = atoms.find(a => a.path.startsWith('/area'))?.path || '/area/space';
    const turf = atoms.find(a => a.path.startsWith('/turf'))?.path || '/turf/open/space';
    const definition = { area: getArea(area), turf, aperture: aperture(turf), atoms: atoms.filter(a => !a.path.startsWith('/area')).map(a => {
      const v = { ...db.resolve(a.path), ...a.vars };
      return { path: a.path, name: unquote(v.name) || pretty(a.path), description:unquote(v.desc), doorAccess:a.path.startsWith('/obj/machinery/door/')?doorAccess(atoms,a):undefined, network: classify(a.path), vars: a.vars, source: db.types.get(a.path)?.file ?? null };
    }) };
    const loot = [];
    for (const atom of atoms) {
      const vars = { ...db.resolve(atom.path), ...atom.vars };
      if (atom.path.startsWith('/obj/item/')) loot.push({ path: atom.path, name: unquote(vars.name) || pretty(atom.path), kind: 'placed' });
      if (atom.path.includes('/spawner/') || atom.path.includes('/random')) {
        const possible = candidates(atom.path, vars);
        if (!possible.length) unresolved.push(atom.path);
        for (const candidate of possible) loot.push({ path: candidate, name: unquote(db.resolve(candidate).name) || pretty(candidate), kind: 'possible', spawner: atom.path });
      }
    }
    keyIds.set(key, defs.length); defs.push(definition); keyLoot.set(key, loot);
  }
  // Shared spawn records avoid duplicating large maintenance pools for every tile.
  const itemDefs = [], itemLookup = new Map(), locations = new Map();
  for (const cell of cells) for (const item of keyLoot.get(cell.key)) {
    const ik = JSON.stringify(item);
    if (!itemLookup.has(ik)) { itemLookup.set(ik, itemDefs.length); itemDefs.push(item); }
    const itemId = itemLookup.get(ik);
    if (!locations.has(itemId)) locations.set(itemId, []);
    locations.get(itemId).push(cell.x, cell.y, cell.z);
  }
  for (const [itemId, points] of locations) items.push({ ...itemDefs[itemId], points });
  writeFileSync(`${dir}/search.json`, JSON.stringify(items));
  const roomCells = new Map();
  for (const cell of cells) {
    const area = defs[keyIds.get(cell.key)].area, key = `${area}:${cell.z}`;
    if (!roomCells.has(key)) roomCells.set(key, []);
    roomCells.get(key).push(cell);
  }
  const rooms = areas.map((area, areaId) => {
    const points = [];
    for (const z of levels) {
      const group = roomCells.get(`${areaId}:${z}`); if (!group?.length) continue;
      const cx = group.reduce((v, c) => v + c.x, 0) / group.length, cy = group.reduce((v, c) => v + c.y, 0) / group.length;
      const nearest = group.reduce((best, cell) => Math.hypot(cell.x - cx, cell.y - cy) < Math.hypot(best.x - cx, best.y - cy) ? cell : best);
      points.push(nearest.x, nearest.y, z);
    }
    return { ...area, points };
  }).filter(room => room.points.length);
  const mapMeta = { id, name: meta.map_name, width, height, levels, areas, rooms, jobRoles:doorAccess.roles, infrastructure, definitions: defs, files: files.map(file => `_maps/${meta.map_path}/${file}`), traits: meta.traits || [], unresolvedSpawners: [...new Set(unresolved)] };
  writeFileSync(`${dir}/map.json`, JSON.stringify(mapMeta));
  for (const z of levels) {
    console.log(`${meta.map_name} · Z${z}: rendering ${width} × ${height}`);
    const levelCells = cells.filter(c => c.z === z), grid = new Int32Array(width * height).fill(-1), holes = Buffer.alloc(width * height * 4), chunks = new Map();
    for (const cell of levelCells) {
      const index = (height - cell.y) * width + cell.x - 1;
      const def = keyIds.get(cell.key); grid[index] = def;
      holes[index * 4 + 3] = defs[def].aperture;
      // Add tile to neighboring chunks too, retaining sprites crossing boundaries.
      const px = (cell.x - 1) * S, py = (height - cell.y) * S;
      for (let cy = Math.max(0, Math.floor((py - S) / P)); cy <= Math.min(Math.ceil(height / C) - 1, Math.floor((py + S * 2 - 1) / P)); cy++) {
        for (let cx = Math.max(0, Math.floor((px - S) / P)); cx <= Math.min(Math.ceil(width / C) - 1, Math.floor((px + S * 2 - 1) / P)); cx++) {
          const ck = `${cx},${cy}`;
          if (!chunks.has(ck)) chunks.set(ck, []);
          chunks.get(ck).push({ cell, px, py, cx, cy });
        }
      }
    }
    const levelDir = `${dir}/${z}`; mkdirSync(levelDir, { recursive: true });
    await sharp(holes, { raw: { width, height, channels: 4 } }).png().toFile(`${levelDir}/aperture.png`);
    const chunkIndex = { base: [], pipes: [], power: [], disposal: [], transit: [] };
    const overviews = [];
    for (const [channel] of Object.entries(chunkIndex)) {
      for (const [ck, entries] of chunks) {
        const composite = [];
        for (const { cell, px, py, cx, cy } of entries) {
          const input = await tileImage(cell.appearance, channel);
          if (input) composite.push({ input, left: px - cx * P + S, top: py - cy * P + S });
        }
        if (!composite.length) continue;
        // Two-tile gutter provides a fixed nonnegative composite origin.
        const [cx, cy] = ck.split(',').map(Number);
        const file = `${channel}-${cx}-${cy}.webp`;
        await sharp({ create: { width: P + S * 4, height: P + S * 4, channels: 4, background: '#00000000' } })
          .composite(composite).png().toBuffer()
          .then(buffer => sharp(buffer).extract({ left: S * 2, top: S * 2, width: P, height: P }).webp({ lossless: true }).toFile(`${levelDir}/${file}`));
        await writeMipmaps(`${levelDir}/${file}`, P);
        chunkIndex[channel].push([cx, cy]);
      }
      if (chunkIndex[channel].length) {
        const overviewParts = [];
        for (const [cx, cy] of chunkIndex[channel]) overviewParts.push({ input: await sharp(`${levelDir}/${channel}-${cx}-${cy}.webp`).resize(C * 4, C * 4, { kernel: 'nearest' }).png().toBuffer(), left: cx * C * 4, top: cy * C * 4 });
        const overviewSize = Math.ceil(Math.max(width, height) / C) * C * 4;
        await sharp({ create: { width: overviewSize, height: overviewSize, channels: 4, background: '#00000000' } }).composite(overviewParts).png().toBuffer()
          .then(buffer => sharp(buffer).extract({ left: 0, top: 0, width: width * 4, height: height * 4 }).webp({ lossless: true }).toFile(`${levelDir}/${channel}-overview.webp`));
        overviews.push(channel);
      }
    }
    writeFileSync(`${dir}/${z}.json`, JSON.stringify({ z, grid: Array.from(grid), chunks: chunkIndex, overviews, mips: [1, 2] }));
    console.log(`  ${Object.values(chunkIndex).reduce((n, c) => n + c.length, 0)} image chunks`);
  }
  await bakeRuntimeTerrain(dir,mapMeta,db,sprites,S,C);
  writeFileSync(`${dir}/report.json`, JSON.stringify({ unresolvedSpawners: mapMeta.unresolvedSpawners, sprites: sprites.report, note: 'Static declarations only; no DM runtime. See README for fidelity limits.' }, null, 2));
  const assets=[];function listAssets(folder,prefix=''){for(const entry of readdirSync(folder,{withFileTypes:true})){const name=prefix+entry.name;if(entry.isDirectory())listAssets(`${folder}/${entry.name}`,name+'/');else assets.push({path:name,bytes:readFileSync(`${folder}/${entry.name}`).length});}}
  listAssets(dir);writeFileSync(`${dir}/assets.json`,JSON.stringify(assets));
  manifest.maps.push({ id, name: meta.map_name, width, height, levels, items: items.length,assets:`${id}/assets.json`,bytes:assets.reduce((n,a)=>n+a.bytes,0),preview:existsSync(`${dir}/${levels.at(-1)}/base-overview.webp`)?`${id}/${levels.at(-1)}/base-overview.webp`:null });
  if(existsSync(`${dir}/${levels.at(-1)}/natural-overview.webp`))manifest.maps.at(-1).naturalPreview=`${id}/${levels.at(-1)}/natural-overview.webp`;
}
copyFileSync(`${root}/LICENSE`, `${output}/UPSTREAM-LICENSE.txt`);
copyFileSync(`${root}/README.md`, `${output}/UPSTREAM-README.md`);
copyFileSync('NOTICE', `${output}/ATLAS-NOTICE.txt`);
writeFileSync(`${output}/asset-sources.json`, JSON.stringify({ ...provenance, icons: [...sprites.icons].sort() }, null, 2));
writeFileSync(`${output}/manifest.json`, JSON.stringify(manifest, null, 2));
promote(output);
console.log(`Exported ${manifest.maps.length} stations. Sprite report:`, sprites.report);
