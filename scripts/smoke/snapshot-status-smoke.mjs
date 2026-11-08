// Test actual dev UI polling/reload against synthetic status; never starts generation.
import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  let published = { buildId: 'build-2', commit: 'upstream', snapshot: 'snapshot-2', maps: [] };
  await page.addInitScript(() => {
    if (!localStorage.getItem('fixture-dataset'))
      localStorage.setItem(
        'fixture-dataset',
        JSON.stringify({ buildId: 'build-2', commit: 'upstream', dataPath: 'snapshots/snapshot-2/' }),
      );
    window.__atlasDev = {
      snapshot: () => ({ dataset: JSON.parse(localStorage.getItem('fixture-dataset')) }),
    };
    localStorage.setItem('atlas-devtools', JSON.stringify({ open: true, tab: 'overview' }));
    localStorage.setItem('atlas-storage-mode', 'all');
  });
  await page.route('http://atlas.test/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/')
      return route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><meta charset="UTF-8"><script src="/__atlas_dev/devtools.js" defer></script>',
      });
    if (path === '/__atlas_dev/devtools.js')
      return route.fulfill({
        contentType: 'text/javascript',
        body: readFileSync('scripts/dev/devtools-client.js', 'utf8'),
      });
    if (path === '/__atlas_dev/status')
      return route.fulfill({
        json: {
          serving: true,
          dataset: published,
          generation: {
            mode: 'manual',
            stale: null,
            job: { phase: 'published', started: Date.now(), percent: 100, message: 'Published' },
            log: [],
          },
          maps: { selected: null, saved: false, environment: null },
          upstream: null,
        },
      });
    return route.fulfill({ status: 404 });
  });
  await page.goto('http://atlas.test/');
  const overview = page.locator('#atlas-devtools section[data-tab="overview"]');
  await page.waitForFunction(() =>
    document
      .querySelector('#atlas-devtools')
      ?.shadowRoot.querySelector('section.active')
      ?.textContent.includes('Map data is current.'),
  );
  assert.equal(
    await overview.locator('[data-action="reload"]').count(),
    0,
    'a published job must not prompt a page already using that build',
  );
  published = { ...published, buildId: 'build-3', snapshot: 'snapshot-3' };
  await overview.locator('.notice.published').waitFor();
  assert.equal(await overview.locator('[data-action="reload"]').count(), 1);
  await page.evaluate(() =>
    localStorage.setItem(
      'fixture-dataset',
      JSON.stringify({ buildId: 'build-3', commit: 'upstream', dataPath: 'snapshots/snapshot-3/' }),
    ),
  );
  await page.reload();
  await page.waitForFunction(() =>
    document
      .querySelector('#atlas-devtools')
      ?.shadowRoot.querySelector('section.active')
      ?.textContent.includes('Map data is current.'),
  );
  assert.equal(await overview.locator('[data-action="reload"]').count(), 0);
  assert.equal(
    await page.locator('#atlas-devtools .launcher').evaluate((node) => node.classList.contains('published')),
    false,
  );
  assert.equal(
    await page.evaluate(() => localStorage.getItem('atlas-storage-mode')),
    'all',
    'no storage reset is needed',
  );
  published = { ...published, snapshot: 'snapshot-3b' };
  await overview.locator('.notice.published').waitFor();
  await page.evaluate(() =>
    localStorage.setItem(
      'fixture-dataset',
      JSON.stringify({ buildId: 'build-3', commit: 'upstream', dataPath: 'snapshots/snapshot-3b/' }),
    ),
  );
  await overview.locator('.notice.published').waitFor({ state: 'detached' });
  assert.deepEqual(errors, []);
  console.log(
    'Passed stale/current snapshot detection, published-job handling, refresh without reset and snapshot path normalization.',
  );
} finally {
  await browser.close();
}
