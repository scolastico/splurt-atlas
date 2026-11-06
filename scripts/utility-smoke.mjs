import {chromium} from '@playwright/test';import assert from 'node:assert/strict';import {mkdirSync} from 'node:fs';
const browser=await chromium.launch({headless:false}),page=await browser.newPage({viewport:{width:1440,height:1000}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
await page.addInitScript(()=>localStorage.setItem('atlas-storage-mode','none'));
try{
  await page.goto(`${process.env.ATLAS_URL||'http://127.0.0.1:5173/'}#m=tramstation&z=2&x=2704&y=2736&s=1`);
  await page.locator('#loading').waitFor({state:'hidden',timeout:120000});
  await page.locator('#explore-tab').click();await page.locator('#motion').uncheck();
  await page.waitForLoadState('networkidle');const extra=[];const request=r=>{if(r.url().includes('/data/'))extra.push(r.url());};page.on('request',request);const box=await page.locator('#map').boundingBox();await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.wheel(0,120);await page.waitForTimeout(400);page.off('request',request);assert.deepEqual(extra,[],'The first zoom out must use images decoded during the loading phase');
  // Station imagery is WebGL; simple utility symbols draw on the annotation canvas.
  const pixels=()=>page.evaluate(()=>['#map','#annotations'].map(id=>document.querySelector(id).toDataURL()).join());
  for(const simple of [false,true]){
    await page.locator('#simple-utilities').setChecked(simple);
    for(const label of ['Power cables','Atmospherics']){
      const control=page.getByLabel(label,{exact:true});await control.uncheck();await page.waitForTimeout(150);const before=await pixels();
      await control.check();await page.waitForLoadState('networkidle');await page.waitForTimeout(150);
      assert.notEqual(await pixels(),before,`${label} must visibly change the map (simple=${simple})`);
      await control.uncheck();await page.waitForTimeout(150);
    }
  }
  assert.deepEqual(errors,[]);mkdirSync('.cache/qa',{recursive:true});await page.screenshot({path:'.cache/qa/utilities.png'});console.log('Power and atmospherics visibly toggle in both connected and simple modes.');
}finally{await browser.close();}
