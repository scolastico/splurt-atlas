// Files written next to the station folders: asset inventories, the credits
// copied from upstream, the icon source list and the build report.
import { copyFileSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** Every file below a map folder with its size, for offline caching. */
export function listAssets(folder, prefix = '') {
  const assets = [];
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    const name = prefix + entry.name;
    if (entry.isDirectory()) assets.push(...listAssets(`${folder}/${entry.name}`, `${name}/`));
    else assets.push({ path: name, bytes: readFileSync(`${folder}/${entry.name}`).length });
  }
  return assets;
}

/** Copies the upstream license and README and the atlas notice into the output. */
export function copyCredits(root, output) {
  copyFileSync(`${root}/LICENSE`, `${output}/UPSTREAM-LICENSE.txt`);
  copyFileSync(`${root}/README.md`, `${output}/UPSTREAM-README.md`);
  copyFileSync('NOTICE', `${output}/ATLAS-NOTICE.txt`);
}

/** Lists every DMI file any exported map depends on, with the source revision. */
export function writeAssetSources(output, provenance, maps) {
  const icons = [
    ...new Set(maps.flatMap((map) => (map.inputs || []).filter((file) => file.endsWith('.dmi')))),
  ].sort();
  writeFileSync(path.join(output, 'asset-sources.json'), JSON.stringify({ ...provenance, icons }, null, 2));
}

export function writeBuildReport(output, report) {
  writeFileSync(path.join(output, 'build-report.json'), JSON.stringify(report, null, 2));
}
