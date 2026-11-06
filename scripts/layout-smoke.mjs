import {chromium} from '@playwright/test';import assert from 'node:assert/strict';import {mkdirSync,writeFileSync} from 'node:fs';
const url=process.env.ATLAS_URL||'http://127.0.0.1:5173/',browser=await chromium.launch({headless:false}),errors=[],results=[];
try{
 for(const mobile of [false,true]){
  const context=await browser.newContext({viewport:mobile?{width:390,height:844}:{width:1440,height:1000},isMobile:mobile,hasTouch:mobile,deviceScaleFactor:1});const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(()=>{localStorage.setItem('atlas-storage-mode','none');window.__mapTransforms=[];const original=CanvasRenderingContext2D.prototype.setTransform;CanvasRenderingContext2D.prototype.setTransform=function(...args){if((this.canvas.id==='map'||this.canvas.id==='annotations')&&args.length===6&&args[4]!==0)window.__mapTransforms.push([args[4],args[5]]);return original.apply(this,args);};});
  await page.goto(url+'#m=boxstation&z=1&x=3248&y=4560&s=2&t=102,113,1');await page.locator('#loading').waitFor({state:'hidden',timeout:120000});await page.waitForTimeout(450);
  const canvas=await page.locator('#map').boundingBox(),panel=await page.locator('#sidebar').boundingBox();
  if(mobile){assert.equal(panel.x,0);assert.equal(panel.width,390);assert.ok(panel.y>250);assert.equal(await page.locator('#sidebar-resize').getAttribute('aria-orientation'),'horizontal');}
  await page.evaluate(()=>window.__mapTransforms=[]);await page.locator('#sidebar-toggle').click();await page.waitForTimeout(350);
  const frames=await page.evaluate(()=>window.__mapTransforms),positions=new Set(frames.map(frame=>Math.round(frame[mobile?1:0])));assert.ok(positions.size>=3,'The map must move through intermediate positions with the panel');assert.deepEqual(await page.locator('#map').boundingBox(),canvas,'Panel animation must preserve canvas size');
  await page.locator('#sidebar-toggle').click();await page.waitForTimeout(350);
  if(mobile){const handle=await page.locator('#sidebar-resize').boundingBox();await page.mouse.move(195,handle.y+4);await page.mouse.down();await page.mouse.move(195,handle.y-65,{steps:8});await page.mouse.up();await page.waitForTimeout(250);assert.ok((await page.locator('#sidebar').boundingBox()).height>panel.height+50);const controls=await page.locator('.map-tools').boundingBox(),sheet=await page.locator('#sidebar').boundingBox();assert.ok(controls.y+controls.height<sheet.y);}
  mkdirSync('.cache/qa',{recursive:true});await page.screenshot({path:`.cache/qa/${mobile?'mobile-bottom-panel':'desktop-panel'}.png`});results.push({mobile,animatedMapPositions:positions.size,canvasPreserved:true});await context.close();
 }
 assert.deepEqual(errors,[]);writeFileSync('.cache/qa/layout-report.json',JSON.stringify({passed:true,results,errors},null,2));console.log({passed:true,results,errors});
}finally{await browser.close();}
