import {chromium} from '@playwright/test';
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
import path from 'node:path';

const url=process.env.ATLAS_URL||'http://127.0.0.1:4173/',errors=[],requests=[];
const profile=path.resolve('.cache/qa',`zip-profile-${Date.now()}`);
let context,page;
async function open(){context=await chromium.launchPersistentContext(profile,{headless:false,viewport:{width:1440,height:1000}});page=context.pages()[0]||await context.newPage();page.on('pageerror',error=>errors.push(error.message));}
try{
  await open();page.on('request',request=>{if(request.url().includes('/data/'))requests.push(request.url());});
  const start=Date.now();await page.goto(url);await page.locator('[data-storage-mode=all]').click();await page.locator('#map-picker').waitFor();
  assert.equal(await page.locator('.map-card').count(),16);assert.equal(await page.locator('.map-card-entry .map-download').count(),0);
  assert.equal(requests.filter(url=>new URL(url).pathname.endsWith('.zip')).length,0,'Background ZIP downloads wait for a selected map');
  await page.locator('.map-card').filter({hasText:'Tramstation'}).click();await page.locator('#loading').waitFor({state:'hidden',timeout:120000});
  await page.locator('#cache-activity').waitFor({state:'visible'});assert.match(await page.locator('#cache-activity strong').textContent(),/Preparing offline cache|Current map is ready/);
  const indicator=await page.locator('#cache-activity').boundingBox(),controls=await page.locator('.map-tools').boundingBox();assert.ok(indicator.x+indicator.width<=controls.x,'The background indicator sits beside the zoom controls');
  const logger=setInterval(async()=>{try{console.log(await page.locator('#cache-status').textContent());}catch{}},15000);
  try{await page.waitForFunction(()=>!document.querySelector('#cache-activity').hidden&&document.querySelector('#cache-activity strong').textContent==='Current map is ready',{},{timeout:120000});assert.match(await page.locator('#cache-activity small').textContent(),/Other maps are still/);await page.screenshot({path:'.cache/qa/background-cache-ready.png'});await page.waitForFunction(()=>document.querySelector('#cache-status').textContent.startsWith('All 16 maps saved'),{},{timeout:600000});}finally{clearInterval(logger);}
  assert.equal(await page.locator('#cache-activity').isVisible(),false);
  const archives=requests.map(url=>new URL(url).pathname).filter(pathname=>pathname.endsWith('.zip'));assert.equal(archives.length,16);assert.equal(new Set(archives).size,16);
  assert.ok(archives[0].endsWith('/tramstation.zip'),'The selected map downloads before other maps');
  assert.equal(requests.filter(url=>new URL(url).pathname.endsWith('/assets.json')).length,0);
  const stored=await page.evaluate(()=>new Promise(resolve=>{const open=indexedDB.open('splurt-atlas-assets-v1');open.onsuccess=()=>{const db=open.result,tx=db.transaction(['assets','archives']),assets=tx.objectStore('assets').count(),archives=tx.objectStore('archives').count();tx.oncomplete=()=>{resolve({assets:assets.result,archives:archives.result});db.close();};};}));
  assert.equal(stored.archives,0,'Successfully extracted ZIPs are deleted');
  const manifest=await fetch(new URL('data/manifest.json',url)).then(response=>response.json()),expected=(await Promise.all(manifest.maps.map(map=>fetch(new URL('data/'+(manifest.dataPath||'')+map.assets,url)).then(response=>response.json())))).reduce((count,list)=>count+list.length+1,0);
  assert.ok(stored.assets>=expected&&stored.assets<=expected+1,`Every indexed asset is saved (${stored.assets} of ${expected})`);
  const cacheMs=Date.now()-start;await context.close();await open();const blocked=[];
  await page.route('**/data/**',route=>{if(new URL(route.request().url()).pathname.endsWith('/manifest.json'))route.continue();else{blocked.push(route.request().url());route.abort();}});
  await page.goto(url);await page.locator('#map-picker').waitFor();await page.locator('.map-card').filter({hasText:'Tramstation'}).click();await page.locator('#loading').waitFor({state:'hidden',timeout:120000});
  await page.locator('#station').selectOption('northstar');await page.locator('#loading').waitFor({state:'hidden',timeout:120000});
  assert.deepEqual(blocked,[]);assert.deepEqual(errors,[]);
  mkdirSync('.cache/qa',{recursive:true});await page.screenshot({path:'.cache/qa/archive-cache.png'});
  const report={passed:true,cacheMs,zipRequests:archives.length,stored,networkRequestsOnReopen:blocked.length,errors};writeFileSync('.cache/qa/archive-report.json',JSON.stringify(report,null,2));console.log(report);
}finally{await context?.close();}
