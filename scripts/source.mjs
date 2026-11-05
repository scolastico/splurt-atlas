import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const config = JSON.parse(readFileSync('atlas.config.json'));
const root = path.resolve('.source/S.P.L.U.R.T-tg');
const args = process.argv.slice(2);
const from = args.includes('--from') ? path.resolve(args[args.indexOf('--from') + 1]) : null;
const git = (args, cwd) => execFileSync('git', args, { cwd, stdio: 'inherit' });
mkdirSync('.source', { recursive: true });
if (!existsSync(path.join(root, '.git'))) {
  // A local clone owns its working files; Git can reuse the existing object store.
  // No source checkout outside this project is ever changed.
  if (from) git(['clone', '--local', '--no-checkout', from, root]);
  else git(['clone', '--filter=blob:none', '--depth=1', '--no-checkout', config.repository, root]);
}
try { execFileSync('git', ['cat-file', '-e', `${config.ref}^{commit}`], { cwd: root, stdio: 'ignore' }); }
catch { git(['fetch', '--depth=1', 'origin', config.ref], root); }
git(['checkout', '--detach', config.ref], root);
git(['remote', 'set-url', 'origin', config.repository], root);
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
writeFileSync('.source/provenance.json', JSON.stringify({ repository: config.repository, commit }, null, 2));
console.log(`Source ready at ${root}\nPinned commit: ${commit}`);
