// Browser interactions against intercepted synthetic data; no dev server or map generation.
import { chromium } from '@playwright/test';
import { transformWithEsbuild } from 'vite';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import path from 'node:path';

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  const errors = [];
  page.on('pageerror', (error) => {
    errors.push(error.message);
    console.error(error.message);
  });
  page.setDefaultTimeout(10000);
  await page.route('http://atlas.test/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/') {
      const html = readFileSync('index.html', 'utf8').replace(
        '<script type="module" src="/src/main.ts"></script>',
        `<link rel="stylesheet" href="/src/style.css"><script type="importmap">{"imports":{"fuse.js":"/node_modules/fuse.js/dist/fuse.mjs"}}</script><script type="module">
        import {state} from '/src/core/state.ts';
        import {initNetworkControls} from '/src/ui/infrastructure-controls.ts';
        import {initLayout} from '/src/ui/layout.ts';
        import {initCameraControls} from '/src/ui/camera.ts';
        import {initHistory,recordJump,resetHistory} from '/src/ui/history.ts';
        import {inspect,inspectArea} from '/src/ui/inspector.ts';
        import {initMapContextMenu} from '/src/ui/map-context-menu.ts';
        import {selectedArea} from '/src/model/view-state.ts';
        import {tileCenterX,tileCenterY,worldToScreenX,worldToScreenY} from '/src/rendering/projection.ts';
        const definition = {area:0,turf:'/turf/open/floor',aperture:0,atoms:[{name:'Fixture chair',path:'/obj/structure/chair',description:'A chair.',vars:{},network:null,source:null}]};
        state.manifest = {repository:'https://example.test/upstream',commit:'fixture-commit'};
        state.map = {id:'fixture',name:'Fixture Station',width:10,height:10,levels:[1],areas:[{name:'Fixture Room',path:'/area/fixture',region:'Test'}],definitions:[definition],files:['_maps/fixture.dmm'],infrastructure:{nodes:[],transitions:[]}};
        state.levels.set(1,{grid:new Uint32Array(100)});
        state.w=1200;state.h=900;state.x=160;state.y=160;state.zoom=1;state.ready=true;
        document.querySelector('#loading').hidden=true;
        Object.defineProperty(navigator,'clipboard',{value:{writeText:async value=>{window.copied=value;}}});
        initNetworkControls();initLayout(()=>{});initCameraControls();initHistory();initMapContextMenu();recordJump();
        window.fixture={state,inspect,inspectArea,resetHistory,recordJump,selectedArea};
        window.screenFor=(x,y)=>({x:worldToScreenX(tileCenterX(x)),y:worldToScreenY(tileCenterY(y))});
        window.fixtureReady=true;
      </script>`,
      );
      return route.fulfill({ contentType: 'text/html', body: html });
    }
    if (
      !pathname.startsWith('/src/') &&
      !pathname.startsWith('/scripts/lib/') &&
      pathname !== '/node_modules/fuse.js/dist/fuse.mjs'
    )
      return route.fulfill({ status: 404 });
    const file = path.resolve('.' + pathname);
    if (!file.startsWith(process.cwd() + path.sep)) return route.abort();
    const source = readFileSync(file, 'utf8');
    const body = pathname.endsWith('.ts')
      ? (await transformWithEsbuild(source, file, { loader: 'ts', target: 'es2022' })).code
      : source;
    await route.fulfill({
      contentType: pathname.endsWith('.css') ? 'text/css' : 'application/javascript',
      body,
    });
  });
  await page.goto('http://atlas.test/');
  await page.waitForFunction(() => window.fixtureReady);
  const point = (x, y) => page.evaluate(([x, y]) => window.screenFor(x, y), [x, y]);
  const open = async (x, y) => {
    const p = await point(x, y);
    await page.mouse.click(p.x, p.y, { button: 'right' });
    await page.locator('#map-context-menu').waitFor({ state: 'visible' });
  };
  await open(4, 5);
  const menuStyle = await page
    .locator('#map-context-menu button')
    .first()
    .evaluate((node) => ({
      outline: getComputedStyle(node).outlineStyle,
      background: getComputedStyle(node).backgroundColor,
    }));
  assert.equal(menuStyle.outline, 'none');
  await page.getByRole('menuitem', { name: 'Copy share URL', exact: true }).click();
  await page.waitForFunction(() => window.copied?.includes('#m='));
  const shared = new URL(await page.evaluate(() => window.copied));
  const params = new URLSearchParams(shared.hash.slice(1));
  assert.equal(params.get('t'), '4,5,1');
  for (const key of ['x', 'y', 'z']) assert.equal(params.has(key), false);
  for (const key of ['m', 't', 's', 'o']) assert.ok(params.has(key));
  assert.deepEqual(
    await page.evaluate(() => window.fixture.state.selected),
    { x: 4, y: 5, z: 1 },
    'right click selects the tile before showing its actions',
  );
  await open(4, 5);
  await page.getByRole('menuitem', { name: 'Copy XY coordinates' }).click();
  await page.waitForFunction(() => window.copied === '4, 5');
  await open(4, 5);
  await page.getByRole('menuitem', { name: 'Start area selection' }).click();
  const end = await point(6, 7);
  await page.mouse.click(end.x, end.y);
  assert.deepEqual(await page.evaluate(() => window.fixture.state.selectedArea), {
    x1: 4,
    y1: 5,
    x2: 6,
    y2: 7,
    z: 1,
  });
  assert.match(await page.locator('#inspector').textContent(), /9 selected tiles/);
  assert.match(await page.locator('#inspector').textContent(), /Fixture chair.*9/);
  await open(5, 6);
  await page.getByRole('menuitem', { name: 'Copy area share URL' }).click();
  await page.waitForFunction(() => window.copied?.includes('a=4'));
  assert.deepEqual(
    await page.evaluate(() =>
      window.fixture.selectedArea(
        new URLSearchParams(new URL(window.copied).hash.slice(1)),
        window.fixture.state.map,
      ),
    ),
    { x1: 4, y1: 5, x2: 6, y2: 7, z: 1 },
  );
  await open(5, 6);
  await page.getByRole('menuitem', { name: 'Copy debug info' }).click();
  await page.waitForFunction(() => window.copied?.startsWith('{'));
  const debug = JSON.parse(await page.evaluate(() => window.copied));
  assert.equal(debug.map.id, 'fixture');
  assert.equal(debug.upstream.commit, 'fixture-commit');
  assert.equal(debug.tiles[0].positions.length, 9);
  assert.equal(debug.tiles[0].definition.atoms[0].path, '/obj/structure/chair');
  await open(2, 2);
  await page.getByRole('menuitem', { name: 'Start area selection' }).click();
  await page.keyboard.press('Escape');
  assert.equal(await page.evaluate(() => window.fixture.state.selectionDraft), null);
  await open(7, 7);
  await page.getByRole('menuitem', { name: 'Start area selection' }).click();
  const startDrag = await point(7, 7),
    endDrag = await point(5, 6);
  await page.mouse.move(startDrag.x, startDrag.y);
  await page.mouse.down();
  await page.mouse.move(endDrag.x, endDrag.y, { steps: 4 });
  await page.mouse.up();
  assert.deepEqual(await page.evaluate(() => window.fixture.state.selectedArea), {
    x1: 5,
    y1: 6,
    x2: 7,
    y2: 7,
    z: 1,
  });
  await page.evaluate(async () => {
    const { goBack, goForward } = await import('/src/ui/history.ts');
    const saved = { ...window.fixture.state.selectedArea };
    window.fixture.inspectArea({ x1: 4, y1: 5, x2: 6, y2: 7, z: 1 });
    window.fixture.inspectArea(saved);
    goBack();
    if (window.fixture.state.selectedArea?.x1 !== 4) throw new Error('Area history was not restored');
    goForward();
    if (window.fixture.state.selectedArea?.x1 !== 5) throw new Error('Area forward history was not restored');
  });
  // A full down/up/auxclick gesture is consumed exactly once, and boundaries pass through.
  const result = await page.evaluate(() => {
    const { state, inspect, resetHistory, recordJump } = window.fixture;
    resetHistory();
    state.selected = null;
    state.selectedArea = null;
    recordJump();
    inspect(2, 2);
    inspect(3, 3);
    const gesture = (button) =>
      ['mousedown', 'mouseup', 'auxclick'].map((type) => {
        const event = new MouseEvent(type, { button, bubbles: true, cancelable: true });
        document.dispatchEvent(event);
        return event.defaultPrevented;
      });
    const back = gesture(3),
      afterBack = { ...state.selected };
    gesture(3);
    const boundaryBack = gesture(3);
    const forward = gesture(4),
      afterForward = { ...state.selected };
    gesture(4);
    const boundaryForward = gesture(4);
    return { back, afterBack, boundaryBack, forward, afterForward, boundaryForward };
  });
  assert.deepEqual(result.afterBack, { x: 2, y: 2, z: 1 });
  assert.deepEqual(result.back, [true, true, true]);
  assert.deepEqual(result.boundaryBack, [false, false, false]);
  assert.deepEqual(result.afterForward, { x: 2, y: 2, z: 1 });
  assert.deepEqual(result.forward, [true, true, true]);
  assert.deepEqual(result.boundaryForward, [false, false, false]);
  assert.deepEqual(errors, []);
  console.log(
    'Passed context clipboard actions, centered tile URLs, area selection/sharing/debug JSON, cancellation and mouse history boundaries.',
  );
} finally {
  await browser.close();
}
