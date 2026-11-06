import { defineConfig } from 'vite';
import path from 'node:path';
import { copyPublic } from './scripts/lib/copy-public.mjs';
import { devAssets } from './scripts/dev/dev-assets.mjs';
let output;
export default defineConfig({
  base: './',
  publicDir: false,
  // Do not index/watch thousands of generated files and old map snapshots.
  server: { watch: { ignored: ['**/public/data/**', '**/.cache/**', '**/.source/**', '**/dist/**'] } },
  optimizeDeps: { entries: ['index.html'] },
  build: { target: 'es2022' },
  plugins: [
    devAssets(),
    {
      name: 'copy-current-dataset',
      apply: 'build',
      configResolved(config) {
        output = path.resolve(config.root, config.build.outDir);
      },
      closeBundle() {
        copyPublic(output);
      },
    },
  ],
});
