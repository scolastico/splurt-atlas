import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, cpSync, writeFileSync, readFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import sharp from 'sharp';

test('incremental exporter reuses unchanged maps and invalidates map, sprite, inherited-code and missing-asset changes',async()=>{
 const workspace=mkdtempSync(path.join(tmpdir(),'splurt-incremental-'));
 const source=path.join(workspace,'.source/S.P.L.U.R.T-tg');
 const put=(file,text)=>{mkdirSync(path.dirname(path.join(workspace,file)),{recursive:true});writeFileSync(path.join(workspace,file),text);};
 const git=args=>execFileSync('git',args,{cwd:source,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
 const config={repository:'https://example.test/upstream.git',ref:'',maps:'all',excludeMaps:[],chunkTiles:16,tilePixels:32};
 const commit=()=>{git(['add','.']);git(['-c','user.name=Atlas test','-c','user.email=atlas@example.test','commit','--allow-empty','-m','fixture']);config.ref=git(['rev-parse','HEAD']);put('atlas.config.json',JSON.stringify(config));put('.source/provenance.json',JSON.stringify({repository:config.repository,commit:config.ref}));};
 const baseline=()=>cpSync(path.join(workspace,'public/data'),path.join(workspace,'.cache/baseline/data'),{recursive:true});
 const run=(...args)=>{execFileSync(process.execPath,['scripts/export.mjs',...args],{cwd:workspace,encoding:'utf8',timeout:120000});return JSON.parse(readFileSync(path.join(workspace,'public/data/build-report.json')));};
 const pixels=id=>readFileSync(path.join(workspace,`public/data/${id}/1/base-0-0.webp`));
 try{
  cpSync('scripts',path.join(workspace,'scripts'),{recursive:true});cpSync('package.json',path.join(workspace,'package.json'));cpSync('pnpm-lock.yaml',path.join(workspace,'pnpm-lock.yaml'));cpSync('NOTICE',path.join(workspace,'NOTICE'));
  symlinkSync(path.resolve('node_modules'),path.join(workspace,'node_modules'),process.platform==='win32'?'junction':'dir');
  put('.source/S.P.L.U.R.T-tg/tgstation.dme','#include "code/main.dm"');
  let code='/turf/open/floor\n    color = "#ffffff"\n/turf/open/floor/one\n    name = "First floor"\n    icon = \'icons/one.dmi\'\n/turf/open/floor/two\n    name = "Second floor"\n    icon = \'icons/two.dmi\'\n/area/test\n    name = "Test room"\n';
  put('.source/S.P.L.U.R.T-tg/code/main.dm',code);put('.source/S.P.L.U.R.T-tg/LICENSE','Fixture license');put('.source/S.P.L.U.R.T-tg/README.md','Fixture');
  for(const id of ['one','two']){
   put(`.source/S.P.L.U.R.T-tg/_maps/${id}.json`,JSON.stringify({map_name:id,map_path:id,map_file:'station.dmm'}));
   put(`.source/S.P.L.U.R.T-tg/_maps/${id}/station.dmm`,`"a" = (/turf/open/floor/${id},/area/test)\n(1,1,1) = {"\na\n"}`);
   mkdirSync(path.join(source,'icons'),{recursive:true});await sharp({create:{width:32,height:32,channels:4,background:'#ff6600'}}).png().toFile(path.join(source,`icons/${id}.dmi`));
  }
  git(['init','-b','main']);commit();assert.deepEqual(run('--full').rebuilt,['one','two']);baseline();const original=pixels('one');
  put('.source/S.P.L.U.R.T-tg/README.md','Only documentation changed');commit();let report=run('--incremental');assert.deepEqual(report.rebuilt,[]);assert.deepEqual(report.reused,['one','two']);assert.ok(report.changedFiles.includes('README.md'));assert.deepEqual(pixels('one'),original);baseline();
  code+='\n/obj/unrelated\n    name = "Unused type"\n';put('.source/S.P.L.U.R.T-tg/code/main.dm',code);commit();report=run('--incremental');assert.deepEqual(report.rebuilt,[],'Unrelated code does not rerender stations');baseline();
  put('.source/S.P.L.U.R.T-tg/_maps/one/station.dmm','"a" = (/obj/item/test,/turf/open/floor/one,/area/test)\n(1,1,1) = {"\na\n"}');commit();report=run('--incremental');assert.deepEqual(report.rebuilt,['one']);assert.deepEqual(report.reused,['two']);baseline();
  await sharp({create:{width:32,height:32,channels:4,background:'#3366ff'}}).png().toFile(path.join(source,'icons/one.dmi'));commit();report=run('--incremental');assert.deepEqual(report.rebuilt,['one']);assert.deepEqual(report.reused,['two']);assert.notDeepEqual(pixels('one'),original);baseline();
  code=code.replace('#ffffff','#aaffaa');put('.source/S.P.L.U.R.T-tg/code/main.dm',code);commit();report=run('--incremental');assert.deepEqual(report.rebuilt,['one','two'],'Shared parent changes invalidate both maps');baseline();
  const file=path.join(workspace,'.cache/baseline/data/manifest.json'),legacy=JSON.parse(readFileSync(file));delete legacy.converter;for(const map of legacy.maps){delete map.fingerprint;delete map.inputs;}writeFileSync(file,JSON.stringify(legacy));
  report=run('--incremental','--adopt-baseline');assert.deepEqual(report.rebuilt,[],'Same-revision legacy output is adopted after metadata verification');baseline();
  rmSync(path.join(workspace,'.cache/baseline/data/one/1/base-0-0.webp'));report=run('--incremental');assert.deepEqual(report.rebuilt,['one'],'Missing cached assets require conversion');baseline();
  report=run('--incremental','--full');assert.deepEqual(report.rebuilt,['one','two']);
 }finally{
  const resolved=path.resolve(workspace);if(path.dirname(resolved)!==path.resolve(tmpdir())||!path.basename(resolved).startsWith('splurt-incremental-'))throw new Error('Unsafe test workspace');
  rmSync(resolved,{recursive:true,force:true});
 }
});
