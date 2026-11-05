import { defineConfig } from 'vite';
import path from 'node:path';
import { copyPublic } from './scripts/lib/copy-public.mjs';
let output;
export default defineConfig(({command})=>({ base: './', publicDir:command === 'build' ? false : 'public', build: { target: 'es2022' }, plugins:[{
  name:'copy-current-dataset',apply:'build',
  configResolved(config){output=path.resolve(config.root,config.build.outDir);},
  closeBundle(){copyPublic(output);}
}] }));
