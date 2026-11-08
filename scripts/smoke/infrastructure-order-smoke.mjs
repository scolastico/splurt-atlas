// Isolated browser checks: intercepted local source files, no server or map export.
import { chromium } from '@playwright/test';
import { transformWithEsbuild } from 'vite';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import path from 'node:path';

const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const errors = [];
const defaultOrder = ['navigation', 'fluid', 'pipes', 'power', 'disposal'];
const order = (page) =>
  page
    .locator('#network-controls .network-row')
    .evaluateAll((rows) => rows.map((row) => row.dataset.network));
async function openPage(context, url = 'http://atlas.test/') {
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('http://atlas.test/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/') {
      const html = readFileSync('index.html', 'utf8').replace(
        '<script type="module" src="/src/main.ts"></script>',
        `<link rel="stylesheet" href="/src/style.css"><script type="module">
        import { initNetworkControls, updateNetworkSummary } from '/src/ui/infrastructure-controls.ts';
        import { initOptionSharing, restoreOptions } from '/src/ui/url-state.ts';
        import { state } from '/src/core/state.ts';
        import { initInfoPopovers } from '/src/ui/info-popovers.ts';
        import { initStorageSettings } from '/src/ui/storage-settings.ts';
        document.querySelector('#loading').hidden = true;
        state.map = {id:'fixture', infrastructure:{powerNetworks:12,nodes:[]}};
        initNetworkControls(); initOptionSharing(); initInfoPopovers(); initStorageSettings();
        restoreOptions(new URLSearchParams(location.hash.slice(1))); updateNetworkSummary();
        window.fixtureReady = true;
      </script>`,
      );
      return route.fulfill({ contentType: 'text/html', body: html });
    }
    if (!pathname.startsWith('/src/') && !pathname.startsWith('/scripts/lib/'))
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
  await page.goto(url);
  await page.waitForFunction(() => window.fixtureReady);
  return page;
}
try {
  const context = await browser.newContext({ viewport: { width: 1200, height: 1000 } });
  const page = await openPage(context);
  assert.deepEqual(await order(page), defaultOrder);
  assert.equal(await page.locator('.station-controls .eyebrow, #source-status').count(), 0);
  assert.equal(
    await page.locator('.station-controls #station-meta, .station-controls #map-subtitle').count(),
    0,
  );
  assert.equal(await page.locator('#map-statistics #station-meta, #map-statistics #map-subtitle').count(), 2);
  assert.equal(
    await page.locator('#source-link').evaluate((node) => node.nextElementSibling?.id),
    'commit-link',
  );
  assert.match(await page.locator('#commit-link').textContent(), /^Upstream commit /);
  assert.equal(await page.locator('#atlas-source').isVisible(), true);
  assert.equal(
    await page.locator('#atlas-source').getAttribute('href'),
    'https://github.com/scolastico/splurt-atlas',
  );
  assert.ok(
    !(await page.locator('.sidebar-bottom').textContent()).includes(
      'Mapped positions, before the round begins.',
    ),
  );
  assert.equal(
    await page.locator('#cache-status').count(),
    1,
    'offline status must not have a stale duplicate',
  );
  assert.equal(await page.locator('#offline-storage-info #cache-status').count(), 1);
  assert.equal(await page.locator('#cache-status').isHidden(), true);
  await page.evaluate(async () => {
    const { assetCache } = await import('/src/data/source.ts');
    assetCache.setMode('none');
  });
  assert.equal(await page.locator('#cache-status').textContent(), 'Offline storage is off.');
  await page.locator('[popovertarget="offline-storage-info"]').hover();
  await page.locator('#offline-storage-info').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#cache-status').isVisible(), true);
  await page.mouse.move(700, 100);
  await page.locator('#offline-storage-info').waitFor({ state: 'hidden' });
  await page.locator('#random-markers').check();
  await page.waitForFunction(
    () => !!(Number(new URLSearchParams(location.hash.slice(1)).get('o')) & (1 << 19)),
  );
  assert.equal(await page.locator('#network-controls #transit').count(), 0);
  assert.equal(await page.locator('#transit').isVisible(), true);
  assert.equal(await page.locator('#reset-infrastructure-order').isDisabled(), true);
  assert.equal(await page.locator('#reset-infrastructure-order').isHidden(), true);
  assert.equal(
    await page.locator('#map-statistics #network-summary').textContent(),
    '12 separate mapped power networks.',
  );
  await page.locator('[popovertarget="infrastructure-info"]').hover();
  assert.equal(await page.locator('#infrastructure-info').isVisible(), true);
  assert.equal(await page.locator('#power-network-color-hint').isVisible(), false);
  await page.locator('#power-networks').check();
  assert.equal(await page.locator('#power-network-color-hint').evaluate((node) => node.hidden), false);
  await page.locator('#power-networks').uncheck();
  assert.equal(await page.locator('#power-network-color-hint').evaluate((node) => node.hidden), true);
  await page.mouse.move(700, 100);
  await page.locator('#infrastructure-info').waitFor({ state: 'hidden' });
  const disposal = await page.locator('[data-network="disposal"] button').boundingBox();
  const navigation = await page.locator('[data-network="navigation"]').boundingBox();
  await page.mouse.move(disposal.x + 10, disposal.y + 16);
  await page.mouse.down();
  await page.mouse.move(disposal.x + 10, navigation.y + 2, { steps: 12 });
  await page.mouse.up();
  const custom = ['disposal', 'navigation', 'fluid', 'pipes', 'power'];
  assert.deepEqual(await order(page), custom);
  assert.equal(await page.locator('#disposal').isChecked(), false, 'dragging does not toggle the network');
  await page.waitForFunction(() =>
    new URLSearchParams(location.hash.slice(1)).get('u')?.startsWith('disposal,'),
  );
  const shared = page.url();
  await page.reload();
  await page.waitForFunction(() => window.fixtureReady);
  assert.equal(await page.locator('#random-markers').isChecked(), true);
  assert.deepEqual(await order(page), custom);
  const handle = page.locator('[data-network="disposal"] button');
  await handle.focus();
  await page.keyboard.press('ArrowDown');
  assert.deepEqual((await order(page)).slice(0, 2), ['navigation', 'disposal']);
  await page.locator('#reset-infrastructure-order').click();
  assert.deepEqual(await order(page), defaultOrder);
  await page.waitForFunction(() => !new URLSearchParams(location.hash.slice(1)).has('u'));
  assert.equal(await page.locator('#reset-infrastructure-order').isDisabled(), true);
  assert.equal(await page.locator('#reset-infrastructure-order').isHidden(), true);
  const mobile = await browser.newContext({ viewport: { width: 1000, height: 1000 }, hasTouch: true });
  const touchPage = await openPage(mobile, shared);
  assert.deepEqual(await order(touchPage), custom, 'URL restores order on another device');
  await touchPage.locator('#reset-infrastructure-order').click();
  const source = await touchPage.locator('[data-network="disposal"] button').boundingBox();
  const target = await touchPage.locator('[data-network="navigation"]').boundingBox();
  const session = await mobile.newCDPSession(touchPage);
  await session.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: source.x + 10, y: source.y + 16 }],
  });
  // No long-press wait: dragging a handle works immediately on touch.
  await session.send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: [{ x: source.x + 10, y: target.y + 2 }],
  });
  await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  assert.deepEqual(await order(touchPage), custom);
  assert.equal(await touchPage.locator('#disposal').isChecked(), false);
  const beforeCancel = await order(touchPage);
  const start = await touchPage.locator('[data-network="disposal"] button').boundingBox();
  const end = await touchPage.locator('[data-network="power"]').boundingBox();
  await session.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: start.x + 10, y: start.y + 16 }],
  });
  await session.send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: [{ x: start.x + 10, y: end.y + end.height - 1 }],
  });
  await session.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
  assert.deepEqual(await order(touchPage), beforeCancel);
  await touchPage.locator('[popovertarget="infrastructure-info"]').tap();
  assert.equal(
    await touchPage.locator('#infrastructure-info').isVisible(),
    true,
    'touch opens hints without hover',
  );
  await touchPage.keyboard.press('Escape');
  await touchPage.evaluate(async () => {
    localStorage.setItem('atlas-test-reset', 'remove');
    localStorage.setItem('other-app-test', 'keep');
    sessionStorage.setItem('atlas-test-session', 'remove');
    const { assetCache } = await import('/src/data/source.ts');
    assetCache.mode = 'all';
    assetCache.version = 'v1';
    await assetCache.write(`${assetCache.scope}:v1:test.bin`, new Blob(['offline fixture']));
  });
  touchPage.once('dialog', (dialog) => dialog.dismiss());
  await touchPage.locator('#reset-app').click();
  assert.equal(await touchPage.evaluate(() => localStorage.getItem('atlas-test-reset')), 'remove');
  touchPage.once('dialog', (dialog) => dialog.accept());
  await Promise.all([touchPage.waitForEvent('load'), touchPage.locator('#reset-app').click()]);
  await touchPage.waitForFunction(() => window.fixtureReady);
  assert.equal(await touchPage.evaluate(() => localStorage.getItem('atlas-test-reset')), null);
  assert.equal(await touchPage.evaluate(() => sessionStorage.getItem('atlas-test-session')), null);
  assert.equal(await touchPage.evaluate(() => localStorage.getItem('other-app-test')), 'keep');
  assert.equal(new URL(touchPage.url()).hash, '');
  // Exercise the actual WebGL/Canvas renderer with synthetic tiles only.
  // This does not read, regenerate or publish station imagery.
  const pixels = await touchPage.evaluate(async () => {
    const { renderer, mapCanvas } = await import('/src/rendering/canvases.ts');
    const { drawUtilitySymbols } = await import('/src/rendering/infrastructure-overlay.ts');
    const { state } = await import('/src/core/state.ts');
    const { channelsForDeck } = await import('/src/model/deck-channels.ts');
    const { normalizeInfrastructureOrder } = await import('/src/model/infrastructure-order.ts');
    mapCanvas.width = mapCanvas.height = 128;
    renderer.resize(128, 128);
    state.w = state.h = 128;
    state.x = state.y = 0;
    state.dpr = 1;
    state.z = 1;
    document.querySelector('#simple-utilities').checked = true;
    document.querySelector('#power-networks').checked = false;
    const bitmap = async (color) => {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 32;
      const context = canvas.getContext('2d');
      context.fillStyle = color;
      context.fillRect(0, 0, 32, 32);
      return renderer.prepare(await createImageBitmap(canvas), 1);
    };
    const disposal = await bitmap('#0000ff'),
      windowTile = await bitmap('#00ff00');
    const read = (x, y) => {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 128;
      const context = canvas.getContext('2d');
      context.drawImage(mapCanvas, 0, 0);
      return [...context.getImageData(x, y, 1, 1).data];
    };
    state.map = {
      height: 3,
      infrastructure: {
        nodes: [
          {
            id: 0,
            channel: 'power',
            x: 2,
            y: 2,
            z: 1,
            layer: 2,
            links: 15,
            network: 1,
            exposed: true,
            simpleEligible: true,
            color: '#ff0000',
          },
        ],
      },
    };
    const paint = async (order, enabled) => {
      for (let i = 0; i < 5; i++) {
        renderer.begin();
        renderer.beginDeck(0);
        for (const channel of channelsForDeck(
          true,
          new Set(enabled),
          true,
          false,
          normalizeInfrastructureOrder(order),
        )) {
          if (channel.includes('-symbols')) drawUtilitySymbols(channel, 1, 0, 0);
          else if (channel === 'disposal-surface') renderer.draw(disposal, 0, 0, 0, 32, 32, 32, 32, 32, 32);
          else if (channel === 'foreground') renderer.draw(windowTile, 0, 0, 0, 32, 32, 32, 32, 32, 32);
        }
        renderer.endDeck();
        renderer.end();
        await new Promise(requestAnimationFrame);
      }
      return read(48, 48);
    };
    const disposalOnTop = await paint(['disposal', 'power'], ['disposal', 'power']);
    const powerOnTop = await paint(['power', 'disposal'], ['disposal', 'power']);
    const ordinaryUnderWindow = await paint(['power', 'disposal'], []);
    state.map.infrastructure.nodes = [1, 2, 3, 4, 5].map((layer) => ({
      id: layer,
      channel: 'pipes',
      x: 2,
      y: 2,
      z: 1,
      layer,
      links: 15,
      network: 0,
      exposed: true,
      simpleEligible: true,
      color: ['#ff0000', '#00ff00', '#ffff00', '#ff00ff', '#0000ff'][layer - 1],
    }));
    for (let i = 0; i < 5; i++) {
      renderer.begin();
      renderer.beginDeck(0);
      drawUtilitySymbols('pipes-symbols-surface', 1, 0, 0);
      renderer.endDeck();
      renderer.end();
      await new Promise(requestAnimationFrame);
    }
    const shiftedFirst = read(23, 58),
      shiftedFifth = read(73, 38);
    renderer.release(disposal);
    renderer.release(windowTile);
    return { disposalOnTop, powerOnTop, ordinaryUnderWindow, shiftedFirst, shiftedFifth };
  });
  assert.deepEqual(pixels.disposalOnTop, [0, 0, 255, 255]);
  assert.deepEqual(pixels.powerOnTop, [255, 0, 0, 255]);
  assert.deepEqual(pixels.ordinaryUnderWindow, [0, 255, 0, 255]);
  assert.deepEqual(pixels.shiftedFirst, [255, 0, 0, 255]);
  assert.deepEqual(pixels.shiftedFifth, [0, 0, 255, 255]);
  assert.deepEqual(errors, []);
  console.log(
    'Passed mouse/touch/keyboard reordering, cancellation, reset, URL restoration, transit placement, hover/touch hints, statistics and confirmed local-data reset.',
  );
} finally {
  await browser.close();
}
