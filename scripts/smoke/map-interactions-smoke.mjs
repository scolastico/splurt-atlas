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
  let documentLoads = 0;
  page.on('pageerror', (error) => {
    errors.push(error.message);
    console.error(error.message);
  });
  page.setDefaultTimeout(10000);
  await page.route('http://atlas.test/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/') {
      documentLoads++;
      const html = readFileSync('index.html', 'utf8').replace(
        '<script type="module" src="/src/main.ts"></script>',
        `<link rel="stylesheet" href="/src/style.css"><script type="importmap">{"imports":{"fuse.js":"/node_modules/fuse.js/dist/fuse.mjs"}}</script><script type="module">
        import {state} from '/src/core/state.ts';
        import {initNetworkControls} from '/src/ui/infrastructure-controls.ts';
        import {initLayout} from '/src/ui/layout.ts';
        import {initCameraControls} from '/src/ui/camera.ts';
        import {consumeHistoryHashChange,initHistory,recordJump,resetHistory} from '/src/ui/history.ts';
        import {inspect,inspectArea,initInspector} from '/src/ui/inspector.ts';
        import {initMapContextMenu} from '/src/ui/map-context-menu.ts';
        import {selectedArea} from '/src/model/view-state.ts';
        import {paintMapStatistics} from '/src/ui/map-statistics.ts';
        import {tileCenterX,tileCenterY,worldToScreenX,worldToScreenY} from '/src/rendering/projection.ts';
        const definition = {area:0,turf:'/turf/open/floor',aperture:0,atoms:[{name:'Fixture chair',path:'/obj/structure/chair',description:'A chair.',vars:{},network:null,source:null}]};
        state.manifest = {repository:'https://example.test/upstream',commit:'fixture-commit',chunkTiles:16};
        state.map = {id:'fixture',name:'Fixture Station',width:10,height:10,levels:[1],areas:[{name:'Fixture Room',path:'/area/fixture',region:'Test'}],definitions:[definition],files:['_maps/fixture.dmm'],infrastructure:{powerNetworks:0,nodes:[],transitions:[]}};
        state.levels.set(1,{grid:new Uint32Array(100)});
        state.w=1200;state.h=900;state.x=160;state.y=160;state.zoom=1;state.ready=true;
        document.querySelector('#loading').hidden=true;
        Object.defineProperty(navigator,'clipboard',{value:{writeText:async value=>{window.copied=value;}}});
        initNetworkControls();initLayout(()=>{});initCameraControls();initHistory();initInspector();initMapContextMenu();paintMapStatistics();recordJump();
        window.fixture={state,inspect,inspectArea,resetHistory,recordJump,selectedArea};
        window.unhandledHistoryHashes=0;
        window.addEventListener('hashchange',()=>{if(!consumeHistoryHashChange())window.unhandledHistoryHashes++;});
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
  assert.equal(await page.locator('#map-statistics-list > div').count(), 17);
  assert.equal(
    await page
      .locator('#map-statistics')
      .textContent()
      .then((text) => text.includes('pre-round snapshot')),
    false,
  );
  const statisticFonts = await page
    .locator('#map-statistics-list dt, #map-statistics-list dd')
    .evaluateAll((nodes) => [...new Set(nodes.map((node) => getComputedStyle(node).fontSize))]);
  assert.equal(statisticFonts.length, 1, 'every statistic uses the same font size');
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
    const saved = { ...window.fixture.state.selectedArea };
    window.fixture.inspectArea({ x1: 4, y1: 5, x2: 6, y2: 7, z: 1 });
    window.fixture.inspectArea(saved);
  });
  await page.goBack();
  await page.waitForFunction(() => window.fixture.state.selectedArea?.x1 === 4);
  await page.goForward();
  await page.waitForFunction(() => window.fixture.state.selectedArea?.x1 === 5);
  const previousLength = await page.evaluate(() => history.length);
  await page.evaluate(() => {
    const { inspect } = window.fixture;
    inspect(2, 2);
    inspect(3, 3);
  });
  assert.equal(await page.evaluate(() => history.length), previousLength + 2);
  const afterPan = await page.evaluate(async () => {
    const { panBy, zoomBy } = await import('/src/ui/camera.ts');
    const { share } = await import('/src/ui/url-state.ts');
    for (let i = 0; i < 12; i++) {
      panBy(1, 1);
      zoomBy(1.01);
    }
    share(true);
    return {
      length: history.length,
      x: window.fixture.state.x,
      y: window.fixture.state.y,
      zoom: window.fixture.state.zoom,
    };
  });
  assert.equal(afterPan.length, previousLength + 2, 'camera movement never adds entries');
  await page.goBack();
  await page.waitForFunction(() => window.fixture.state.selected?.x === 2);
  await page.goForward();
  await page.waitForFunction(() => window.fixture.state.selected?.x === 3);
  assert.deepEqual(
    await page.evaluate(() => ({
      x: window.fixture.state.x,
      y: window.fixture.state.y,
      zoom: window.fixture.state.zoom,
    })),
    { x: afterPan.x, y: afterPan.y, zoom: afterPan.zoom },
  );
  const prevented = await page.evaluate(() =>
    [3, 4].flatMap((button) =>
      ['mousedown', 'mouseup', 'auxclick'].map((type) => {
        const event = new MouseEvent(type, { button, bubbles: true, cancelable: true });
        document.dispatchEvent(event);
        return event.defaultPrevented;
      }),
    ),
  );
  assert.ok(
    prevented.every((value) => !value),
    'native mouse back/forward is never cancelled',
  );
  await page.evaluate(() => {
    const { state, inspect } = window.fixture;
    const machine = (id, x, machineId) => ({
      id,
      x,
      y: 4,
      z: 1,
      atomIndex: 0,
      path: '/obj/machinery/telecomms/' + (id ? 'server' : 'hub'),
      name: id ? 'telecommunication server' : 'telecommunication hub',
      machineId,
      network: 'tcommsat',
      autolinkers: ['common'],
      frequencyMode: id ? 'filtered' : 'all',
      frequencies: id ? [{ value: 1459, name: 'Common' }] : [],
      longRange: !id,
      enabled: true,
      unresolved: [],
      links: [id ? 0 : 1],
    });
    state.map.telecomms = [machine(0, 4, 'Hub'), machine(1, 6, 'Common Server')];
    for (const device of state.map.telecomms) {
      const definition = {
        area: 0,
        turf: '/turf/open/floor',
        aperture: 0,
        atoms: [
          {
            path: device.path,
            name: device.name,
            vars: {},
            description: 'Fixture telecomms',
            network: null,
            source: null,
          },
        ],
      };
      state.map.definitions.push(definition);
      state.levels.get(1).grid[(10 - device.y) * 10 + device.x - 1] = state.map.definitions.length - 1;
    }
    inspect(4, 4);
  });
  assert.match(await page.locator('.telecomms-settings').textContent(), /tcommsat/);
  assert.match(await page.locator('.telecomms-settings').textContent(), /All frequencies/);
  await page.getByRole('checkbox', { name: 'Highlight Common Server', exact: true }).check();
  assert.deepEqual(await page.evaluate(() => [...window.fixture.state.telecomHighlights]), [1]);
  await page.waitForFunction(() => new URLSearchParams(location.hash.slice(1)).get('c') === '1');
  await page.locator('.telecomms-link').click();
  assert.deepEqual(await page.evaluate(() => window.fixture.state.selected), { x: 6, y: 4, z: 1 });
  assert.match(await page.locator('.telecomms-settings').textContent(), /145\.9 \(Common\)/);
  await page.locator('#history-back').click();
  await page.waitForFunction(() => window.fixture.state.selected?.x === 4);
  assert.deepEqual(await page.evaluate(() => [...window.fixture.state.telecomHighlights]), [1]);
  await page.locator('#detailed-view').check();
  assert.match(await page.locator('.telecomms-settings').textContent(), /tcommsat/);
  await page.locator('#detailed-view').uncheck();
  const roomText = await page.evaluate(async () => {
    const { drawAnnotations } = await import('/src/rendering/annotations.ts');
    const { state } = window.fixture;
    state.regions = true;
    state.selected = null;
    state.selectedArea = null;
    state.x = 160;
    state.y = 160;
    const calls = [];
    const context = {
      setTransform(a) {
        this.scale = a;
      },
      fill() {},
      stroke() {},
      save() {},
      restore() {},
      fillRect() {},
      strokeRect() {},
      strokeText() {},
      fillText(text, x, y) {
        calls.push({
          text,
          x,
          y,
          screenFont: parseFloat(this.font) * this.scale,
          align: this.textAlign,
          baseline: this.textBaseline,
        });
      },
    };
    for (const zoom of [1, 3]) {
      state.zoom = zoom;
      drawAnnotations(context);
    }
    return calls;
  });
  assert.equal(roomText.length, 2);
  assert.deepEqual(
    roomText.map((label) => [label.x, label.y]),
    [
      [160, 160],
      [160, 160],
    ],
  );
  assert.equal(roomText[1].screenFont, roomText[0].screenFont * 3);
  assert.ok(roomText.every((label) => label.align === 'center' && label.baseline === 'middle'));
  const bounded = await page.evaluate(async () => {
    const { panBy, zoomBy } = await import('/src/ui/camera.ts');
    const { state } = window.fixture;
    state.zoom = 1;
    panBy(1e9, -1e9);
    const edge = { x: state.x, y: state.y };
    zoomBy(0.0001);
    return { edge, x: state.x, y: state.y, zoom: state.zoom };
  });
  assert.deepEqual(bounded.edge, { x: 384, y: -64 });
  assert.equal(bounded.zoom, 0.04);
  assert.ok(bounded.x <= 320 + 64 / 0.04 && bounded.y >= -64 / 0.04);
  await page.evaluate(async () => {
    const { startSearchWorker, showFinding } = await import('/src/ui/search.ts');
    const { state } = window.fixture;
    const record = {
      id: 'mixed',
      kind: 'placed',
      kinds: ['placed', 'possible'],
      name: 'Fixture wrench',
      path: '/obj/item/wrench',
      spawners: [],
      placedPoints: [2, 2, 1],
      points: [2, 2, 1, 3, 3, 1],
      count: 2,
    };
    const OriginalWorker = window.Worker;
    window.Worker = class {
      terminate() {}
      postMessage(request) {
        const response =
          request.type === 'init'
            ? { type: 'ready' }
            : request.type === 'locations'
              ? { type: 'locations', seq: request.seq, result: record }
              : request.type === 'tile'
                ? { type: 'tile', seq: request.seq, possible: [] }
                : null;
        if (response) queueMicrotask(() => this.onmessage({ data: response }));
      }
    };
    try {
      const { indexReady } = startSearchWorker(state.generation, state.map, new ArrayBuffer(0), null);
      await indexReady;
      showFinding('mixed', 0, null);
      await new Promise(requestAnimationFrame);
    } finally {
      window.Worker = OriginalWorker;
    }
  });
  assert.equal(await page.locator('.finding-location[data-kind="placed"]').count(), 1);
  assert.equal(await page.locator('.finding-location[data-kind="possible"]').count(), 1);
  assert.match(await page.locator('.finding-location[data-kind="placed"]').textContent(), /PLACED/);
  assert.match(await page.locator('.finding-location[data-kind="possible"]').textContent(), /POSSIBLE/);
  const markerColors = await page.evaluate(async () => {
    const { state } = window.fixture;
    const { highlightContext } = await import('/src/rendering/canvases.ts');
    const { updateHighlightOverlay } = await import('/src/rendering/highlight-overlay.ts');
    const { clearFinding } = await import('/src/ui/search.ts');
    document.querySelector('#connections').checked = false;
    document.querySelector('#connection-labels').checked = false;
    state.x = 160;
    state.y = 160;
    state.zoom = 1;
    const colors = [],
      stroke = highlightContext.stroke;
    highlightContext.stroke = function (...args) {
      colors.push(this.strokeStyle.replaceAll(' ', ''));
      return stroke.apply(this, args);
    };
    updateHighlightOverlay();
    highlightContext.stroke = stroke;
    clearFinding();
    updateHighlightOverlay();
    if (state.placedMarkers.size) throw new Error('Placed marker state was not cleared');
    return colors;
  });
  assert.ok(markerColors.some((color) => color.startsWith('rgba(90,226,144,')));
  assert.ok(markerColors.some((color) => color.startsWith('rgba(255,207,114,')));
  const beforeSearchNavigation = await page.evaluate(() => history.length);
  const nextTile = await point(4, 5);
  await page.mouse.click(nextTile.x, nextTile.y);
  assert.equal(await page.evaluate(() => history.length), beforeSearchNavigation + 1);
  await page.goBack();
  await page.waitForFunction(
    () => window.fixture.state.result === 'mixed' && window.fixture.state.markers.length === 6,
  );
  assert.deepEqual(await page.evaluate(() => window.fixture.state.selected), { x: 2, y: 2, z: 1 });
  assert.equal(
    await page.evaluate(() => history.length),
    beforeSearchNavigation + 1,
    'restoring an async search finding must not push another entry',
  );
  await page.goForward();
  await page.waitForFunction(
    () => window.fixture.state.selected?.x === 4 && window.fixture.state.result === null,
  );
  await page.goBack();
  await page.waitForFunction(() => window.fixture.state.result === 'mixed');
  const branchTile = await point(5, 5);
  await page.mouse.click(branchTile.x, branchTile.y);
  assert.equal(
    await page.locator('#history-forward').isDisabled(),
    true,
    'a new selection replaces the forward branch',
  );
  assert.equal(await page.evaluate(() => history.length), beforeSearchNavigation + 1);
  await page.evaluate(async () => {
    const { state, inspect } = window.fixture;
    const { setDeck } = await import('/src/ui/station.ts');
    state.map.levels.push(2);
    state.levels.set(2, { ...state.levels.get(1), z: 2 });
    setDeck(2);
    inspect(2, 2, 2);
  });
  await page.goBack();
  await page.waitForFunction(() => window.fixture.state.z === 1 && window.fixture.state.selected?.x === 5);
  await page.goForward();
  await page.waitForFunction(() => window.fixture.state.z === 2 && window.fixture.state.selected?.z === 2);
  await page.evaluate(() => history.go(-history.state.atlasSelection.position));
  await page.waitForFunction(
    () => history.state.atlasSelection.position === 0 && window.fixture.state.selected === null,
  );
  assert.equal(await page.locator('#history-back').isDisabled(), true);
  assert.deepEqual(errors, []);
  assert.equal(documentLoads, 1, 'browser history never reloads the document');
  assert.equal(
    await page.evaluate(() => window.unhandledHistoryHashes),
    0,
    'managed Back/Forward must not trigger the map hash loader',
  );
  console.log(
    'Passed context actions, area sharing, native browser history for tiles/search/decks, camera replacements, highlights and marker colors without reloads.',
  );
} finally {
  await browser.close();
}
