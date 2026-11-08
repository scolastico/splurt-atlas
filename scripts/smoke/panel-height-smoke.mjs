// Synthetic UI and intercepted dev status only: no server or generation jobs.
import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const browser = await chromium.launch({ headless: true });
try {
  for (const mobile of [false, true]) {
    const page = await browser.newPage({
      viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
    });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/*', (route) => {
      const url = new URL(route.request().url());
      if (url.hostname !== 'atlas.test') return route.abort();
      if (url.pathname === '/')
        return route.fulfill({
          contentType: 'text/html',
          body: readFileSync('index.html', 'utf8').replace(
            '<script type="module" src="/src/main.ts"></script>',
            '<link rel="stylesheet" href="/src/style.css">',
          ),
        });
      if (url.pathname === '/src/style.css')
        return route.fulfill({ contentType: 'text/css', body: readFileSync('src/style.css', 'utf8') });
      if (url.pathname === '/__atlas_dev/status')
        return route.fulfill({
          json: {
            serving: true,
            generation: {
              stale: false,
              job: {
                phase: 'running',
                started: Date.now(),
                percent: 40,
                message: 'Synthetic progress fixture',
              },
              log: Array.from({ length: 200 }, (_, i) => ({
                time: Date.now(),
                message: `Fixture log entry ${i}`,
              })),
            },
          },
        });
      return route.fulfill({ status: 404 });
    });
    await page.goto('http://atlas.test/');
    assert.equal(await page.locator('#search-panel h2').count(), 0);
    await page.evaluate(() => {
      document.querySelector('#explore-panel').hidden = true;
      document.querySelector('#search-panel').hidden = false;
      document.querySelector('#loading').hidden = true;
      const results = document.querySelector('#results');
      for (let i = 0; i < 100; i++) {
        const button = document.createElement('button');
        button.className = 'result';
        button.textContent = `Fixture result ${i}`;
        results.append(button);
      }
      localStorage.setItem('atlas-devtools', JSON.stringify({ open: true, tab: 'progress' }));
    });
    assert.equal(await page.locator('#results').evaluate((node) => getComputedStyle(node).maxHeight), 'none');
    assert.ok((await page.locator('#results').boundingBox()).height > 260);
    await page.locator('#results .result').last().scrollIntoViewIfNeeded();
    const resultBottom = await page.locator('#results .result').last().boundingBox();
    const sidebar = await page.locator('.sidebar-scroll').boundingBox();
    assert.ok(resultBottom.y + resultBottom.height <= sidebar.y + sidebar.height + 1);
    assert.ok((await page.locator('.sidebar-scroll').evaluate((node) => node.scrollTop)) > 0);
    await page.addScriptTag({ path: 'scripts/dev/devtools-client.js' });
    const log = page.locator('#atlas-devtools .log');
    await log.waitFor();
    assert.equal(await log.evaluate((node) => getComputedStyle(node).maxHeight), 'none');
    const first = await log.boundingBox();
    assert.ok(first.height > 260, `log fills available height: ${first.height}`);
    const section = page.locator('#atlas-devtools section[data-tab="progress"]');
    const panel = await section.boundingBox();
    assert.ok(Math.abs(first.y + first.height - (panel.y + panel.height - 14)) < 2);
    await page.setViewportSize(mobile ? { width: 390, height: 1044 } : { width: 1440, height: 1200 });
    const taller = await log.boundingBox();
    assert.ok(taller.height >= first.height + 190);
    await log.evaluate((node) => {
      node.scrollTop = node.scrollHeight;
    });
    const scrolled = await log.evaluate((node) => node.scrollTop);
    await page.waitForTimeout(1200);
    assert.equal(
      await log.evaluate((node) => node.scrollTop),
      scrolled,
      'status polling preserves a scrolled log',
    );
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log(
    'Passed full-height search results and progress logs, last-entry scrolling, resize growth and polling scroll preservation on desktop and mobile.',
  );
} finally {
  await browser.close();
}
