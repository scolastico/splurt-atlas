import {chromium} from '@playwright/test';import assert from 'node:assert/strict';import {mkdirSync,writeFileSync,existsSync} from 'node:fs';import path from 'node:path';
const url=process.env.ATLAS_URL||'http://127.0.0.1:5173/',manifest=await fetch(new URL('data/manifest.json',url)).then(r=>r.json());
const revision=manifest.buildId||manifest.commit;if(!/^[\da-f-]+$/.test(revision))throw new Error('Invalid cache-test revision');
const profile=path.resolve('.cache/qa',`offline-profile-${revision}`),freshProfile=!existsSync(profile),errors=[];let context,page;
async function open(){context=await chromium.launchPersistentContext(profile,{headless:false,viewport:{width:1440,height:1000}});page=context.pages()[0]||await context.newPage();page.on('pageerror',e=>errors.push(e.message));}
try{
 await open();const started=Date.now();await page.goto(url);if(!await page.evaluate(()=>localStorage.getItem('atlas-storage-mode')))await page.locator('[data-storage-mode=all]').click();await page.locator('#map-picker').waitFor({state:'visible'});assert.equal(await page.locator('#storage-mode').inputValue(),'all');assert.equal(await page.locator('.map-card').count(),16);
 const logger=setInterval(async()=>{try{console.log(await page.locator('#cache-status').textContent());}catch{}},15000);
 try{await page.waitForFunction(()=>document.querySelector('#cache-status').textContent.startsWith('All 16 maps saved'),{},{timeout:1800000});}finally{clearInterval(logger);}
 const cacheMs=Date.now()-started,blocked=[];
 const stored=await page.evaluate(()=>new Promise(resolve=>{const r=indexedDB.open('splurt-atlas-assets-v1');r.onsuccess=()=>{const q=r.result.transaction('assets').objectStore('assets').count();q.onsuccess=()=>resolve(q.result);};}));
 await context.close();await open();
 await page.route('**/data/**',route=>{if(new URL(route.request().url()).pathname.endsWith('/manifest.json'))route.continue();else{blocked.push(route.request().url());route.abort();}});
 await page.goto(url);await page.locator('#map-picker').waitFor({state:'visible'});await page.locator('.map-card').filter({hasText:'Tramstation'}).click();await page.locator('#loading').waitFor({state:'hidden',timeout:120000});
 await page.locator('#station').selectOption('northstar');await page.locator('#loading').waitFor({state:'hidden',timeout:120000});
 assert.equal(await page.locator('#map-title').textContent(),'NorthStar');assert.deepEqual(blocked,[],'Previously unselected maps must load entirely from IndexedDB after browser restart');assert.deepEqual(errors,[]);
 mkdirSync('.cache/qa',{recursive:true});const report={passed:true,maps:16,storedResources:stored,freshProfile,cacheMs,reopenedBrowser:true,networkMapOrSpriteRequestsOnReopen:blocked.length,errors};writeFileSync('.cache/qa/cache-report.json',JSON.stringify(report,null,2));console.log(report);
}finally{await context?.close();}
