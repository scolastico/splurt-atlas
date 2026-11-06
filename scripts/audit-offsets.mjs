import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { loadTypes } from './lib/dm.mjs';
import { objectOffsets } from './lib/object-offsets.mjs';

const db = loadTypes('.source/S.P.L.U.R.T-tg');
const manifest = JSON.parse(readFileSync('public/data/manifest.json'));
const root = path.resolve('public/data', manifest.dataPath || '.');
const mapped = new Map(), unresolved = [], declarations = [], runtime = [];
let mappedAtoms = 0;
for (const map of manifest.maps) {
  const meta = JSON.parse(readFileSync(path.join(root, map.id, 'map.json')));
  for (const definition of meta.definitions) for (const atom of definition.atoms) {
    if (!/^\/(obj|mob)\//.test(atom.path)) continue;
    mappedAtoms++;
    const vars = objectOffsets(atom.path, { ...db.resolve(atom.path), ...atom.vars }, db);
    for (const key of ['pixel_x', 'pixel_y', 'pixel_w', 'pixel_z']) if (vars[key] !== undefined && !Number.isFinite(Number(vars[key]))) unresolved.push({ map: map.id, type: atom.path, key, value: vars[key], mappedOverrides: atom.vars });
    let type = atom.path;
    while (type.startsWith('/obj/') || type.startsWith('/mob/')) {
      if (!mapped.has(type)) mapped.set(type, new Set());
      mapped.get(type).add(map.id);
      type = type.slice(0, type.lastIndexOf('/'));
    }
  }
}
for (const [type, record] of db.types) {
  for (const key of ['pixel_x', 'pixel_y', 'pixel_w', 'pixel_z']) if (record.vars[key] !== undefined) {
    const resolved = db.literal(record.vars[key]);
    declarations.push({ type, key, raw: record.vars[key], resolved, source: db.sourceFor(type, key)?.file, maps: [...(mapped.get(type) || [])] });
  }
}
// Record runtime assignments for review instead of treating procedure bodies as
// static defaults. Random item scatter must not become a wall-mount offset.
for (const [file, text] of db.files) for (const block of text.split(/(?=^\/[\w/]+)/m)) {
  const head = block.match(/^(\/[\w/]+)\/(Initialize|LateInitialize|update_icon_state|update_appearance|update_overlays|setDir|set_dir)\(/);
  if (!head || !mapped.has(head[1])) continue;
  const assignments = block.split('\n').filter(line => /^\s+pixel_[xyzw]\s*[-+]?=/.test(line)).map(line => line.trim());
  if (assignments.length) runtime.push({ type: head[1], method: head[2], source: path.relative(db.root, file).replaceAll('\\', '/'), assignments, maps: [...mapped.get(head[1])] });
}
mkdirSync('.cache', { recursive: true });
writeFileSync('.cache/offset-audit.json', JSON.stringify({ commit: manifest.commit, maps: manifest.maps.length, mappedAtoms, declarations, unresolved, runtime }, null, 2));
console.log(`Audited ${declarations.length} offset declarations and ${mappedAtoms} mapped definition objects across ${manifest.maps.length} maps.`);
console.log(`${unresolved.length} unresolved mapped offsets. ${runtime.length} runtime placement procedures recorded for review.`);
console.log('Report: .cache/offset-audit.json');
if (unresolved.length) process.exitCode = 1;
