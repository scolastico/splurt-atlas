import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, existsSync, statSync, mkdirSync, linkSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import { encodeMap, encodeSearch } from './map-format.mjs';

export const digest = (value) => createHash('sha256').update(value).digest('hex');
export function converterDigest(root = '.') {
  const files = ['scripts/export.mjs', 'scripts/export-parallel.mjs', 'pnpm-lock.yaml', 'package.json'];
  for (const item of readdirSync(path.join(root, 'scripts/lib')))
    if (item.endsWith('.mjs')) files.push(`scripts/lib/${item}`);
  return digest(
    files
      .sort()
      .map((file) => file + '\0' + readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n'))
      .join('\0'),
  );
}
export function loadBaseline(folder) {
  try {
    const manifest = JSON.parse(readFileSync(path.join(folder, 'manifest.json')));
    const root = path.resolve(folder, manifest.dataPath || '.');
    if (root !== path.resolve(folder) && !root.startsWith(path.resolve(folder) + path.sep))
      throw new Error('Unsafe baseline path');
    return { manifest, root };
  } catch {
    return null;
  }
}
export function completeMap(root, map) {
  try {
    const assets = JSON.parse(readFileSync(path.join(root, map.assets)));
    return (
      assets.length > 0 &&
      assets.every((asset) => {
        const file = path.resolve(root, map.id, asset.path),
          parent = path.resolve(root, map.id);
        return file.startsWith(parent + path.sep) && existsSync(file) && statSync(file).size === asset.bytes;
      })
    );
  } catch {
    return false;
  }
}
export function reuseMap(baseline, map, destination, { links = process.env.ATLAS_REUSE_LINKS === '1' } = {}) {
  // Reused map outputs are immutable: hard links avoid copying hundreds of MB
  // during local generations. Fall back to copying across filesystems.
  const reuseFile = (source, target) => {
    if (links) {
      try {
        linkSync(source, target);
        return;
      } catch {}
    }
    copyFileSync(source, target);
  };
  const reuseTree = (source, target) => {
    mkdirSync(target, { recursive: true });
    for (const item of readdirSync(source, { withFileTypes: true })) {
      const from = path.join(source, item.name),
        to = path.join(target, item.name);
      if (item.isDirectory()) reuseTree(from, to);
      else reuseFile(from, to);
    }
  };
  reuseTree(path.join(baseline.root, map.id), destination);
  if (map.archive?.version === (map.assetVersion || baseline.manifest.buildId || baseline.manifest.commit)) {
    const source = path.resolve(baseline.root, map.archive.path),
      target = path.resolve(path.dirname(destination), map.archive.path);
    if (
      source.startsWith(path.resolve(baseline.root) + path.sep) &&
      target.startsWith(path.resolve(path.dirname(destination)) + path.sep) &&
      existsSync(source) &&
      statSync(source).size === map.archive.bytes
    ) {
      mkdirSync(path.dirname(target), { recursive: true });
      reuseFile(source, target);
    }
  }
  return { ...map, assetVersion: map.assetVersion || baseline.manifest.buildId || baseline.manifest.commit };
}
export function canQuickReuse(baseline, map, converter, changed, renderConfig) {
  return !!(
    baseline &&
    map?.fingerprint &&
    map.inputs?.length &&
    baseline.manifest.converter === converter &&
    baseline.manifest.tilePixels === renderConfig.tilePixels &&
    baseline.manifest.chunkTiles === renderConfig.chunkTiles &&
    changed &&
    !changed.some((file) => /\.(dm|dme)$/i.test(file) || map.inputs.includes(file))
  );
}
export function mapFingerprint({ converter, config, metadata, items, cells, types, icons }) {
  const hash = createHash('sha256');
  hash.update(
    JSON.stringify([converter, config.tilePixels, config.chunkTiles, metadata, items, types, icons]),
  );
  // Stream cells instead of allocating a second station-sized JSON string.
  for (const cell of cells) hash.update(JSON.stringify([cell.x, cell.y, cell.z, cell.appearance]));
  return hash.digest('hex');
}
export function legacyMatches(baseline, map, commit, metadata, items) {
  if (!baseline || !map || map.fingerprint || baseline.manifest.commit !== commit) return false;
  try {
    // Encoding is deterministic, so identical metadata produces identical files.
    return (
      readFileSync(path.join(baseline.root, map.id, 'map.json'), 'utf8') ===
        JSON.stringify(encodeMap(metadata)) &&
      readFileSync(path.join(baseline.root, map.id, 'search.json'), 'utf8') ===
        JSON.stringify(encodeSearch(items))
    );
  } catch {
    return false;
  }
}
