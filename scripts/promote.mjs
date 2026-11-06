import { existsSync, readFileSync, renameSync, rmSync, mkdirSync, cpSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

export function promote(output) {
  const cacheRoot = path.resolve('.cache');
  output = path.resolve(output);
  if (path.dirname(output) !== cacheRoot || !/^export-[\da-f-]+$/.test(path.basename(output))) throw new Error('Promotion only accepts this project’s .cache/export-<uuid> directories.');
  const manifest = JSON.parse(readFileSync(path.join(output, 'manifest.json')));
  if(manifest.complete===false)throw new Error('Cannot publish an incomplete generation checkpoint.');
  const config = JSON.parse(readFileSync('atlas.config.json'));
  if (manifest.commit !== config.ref || !manifest.maps?.length) throw new Error('Staged export does not match the configured source revision.');
  const destination = path.resolve('public/data'), previous = path.join(cacheRoot, `previous-${randomUUID()}`);
  mkdirSync(path.dirname(destination), { recursive: true });
  try {
    if (existsSync(destination)) renameSync(destination, previous);
    try { renameSync(output, destination); }
    catch (error) { if (existsSync(previous)) renameSync(previous, destination); throw error; }
  } catch (error) {
    if (['EPERM','EACCES','EBUSY'].includes(error.code) && existsSync(destination) && !existsSync(previous)) {
      // Windows watchers can lock the directory itself. Publish immutable
      // files, then switch only the manifest; already-open views keep their
      // complete old snapshot. Production builds copy only the chosen data.
      const relative = `snapshots/${path.basename(output).slice(7)}/`;
      const snapshot = path.join(destination, relative);
      mkdirSync(snapshot, { recursive: true });
      cpSync(output, snapshot, { recursive: true });
      for (const name of ['UPSTREAM-LICENSE.txt','UPSTREAM-README.md','ATLAS-NOTICE.txt']) cpSync(path.join(output,name),path.join(destination,name));
      const temporary = path.join(destination,'manifest.next.json');
      writeFileSync(temporary,JSON.stringify({...manifest,dataPath:relative},null,2));
      renameSync(temporary,path.join(destination,'manifest.json'));
      console.log('Published immutable data snapshot while the preview is running.');
      return;
    }
    throw new Error(`Could not promote completed export (${error.code}). On Windows, stop the Vite dev/preview servers first. Previous data is preserved. Resume without converting again: node scripts/promote.mjs ${path.relative(process.cwd(), output).replaceAll('\\', '/')}`, { cause: error });
  }
  // Verify the absolute backup target before recursively deleting generated data.
  if (existsSync(previous)) {
    if (!path.resolve(previous).startsWith(cacheRoot + path.sep)) throw new Error('Unsafe generated backup path');
    rmSync(previous, { recursive: true });
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error('Usage: node scripts/promote.mjs .cache/export-<uuid>');
  promote(process.argv[2]);
  console.log('Completed export promoted to public/data.');
}
