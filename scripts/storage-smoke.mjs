import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';

const url = process.env.ATLAS_URL || 'http://127.0.0.1:5173/';
const browser = await chromium.launch({ headless: false }),
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }),
  errors = [];
page.on('pageerror', (error) => errors.push(error.message));
const savedKeys = () =>
  page.evaluate(
    () =>
      new Promise((resolve) => {
        const open = indexedDB.open('splurt-atlas-assets-v1');
        open.onsuccess = () => {
          const db = open.result,
            request = db.transaction('assets').objectStore('assets').getAllKeys();
          request.onsuccess = () => {
            resolve(request.result);
            db.close();
          };
        };
      }),
  );
try {
  const target = new URL(url);
  target.hash = 'm=tramstation';
  await page.goto(target.href);
  await page.locator('#storage-dialog').waitFor({ state: 'visible' });
  assert.equal(await page.locator('[data-storage-mode]').count(), 3);
  const estimate = await page.locator('#storage-current-size').textContent();
  assert.match(estimate, /Download size: .*MB for Tramstation; \d+\.\d+ MB to \d+\.\d+ MB/);
  assert.match(estimate, /Extracted size: /);
  assert.ok(!estimate.includes('?'));
  assert.match(await page.locator('#storage-all-size').textContent(), /MB for all 16 maps/);
  assert.deepEqual(await savedKeys(), [], 'No map download before the storage choice');
  mkdirSync('.cache/qa', { recursive: true });
  await page.screenshot({ path: '.cache/qa/storage-choice.png' });
  await page.locator('[data-storage-mode=current]').click();
  await page.locator('#loading').waitFor({ state: 'hidden', timeout: 120000 });
  await page.waitForFunction(
    () => document.querySelector('#cache-status').textContent.startsWith('Current map saved'),
    {},
    { timeout: 180000 },
  );
  const first = await savedKeys();
  assert.ok(first.length > 100);
  assert.ok(first.every((key) => key.endsWith(':catalog') || key.includes(':tramstation/')));
  await page.locator('#station').selectOption('biodome');
  await page.locator('#loading').waitFor({ state: 'hidden', timeout: 120000 });
  await page.waitForFunction(
    () => document.querySelector('#cache-status').textContent.startsWith('Current map saved'),
    {},
    { timeout: 180000 },
  );
  const second = await savedKeys();
  assert.ok(second.length > 100);
  assert.ok(
    second.every((key) => key.endsWith(':catalog') || key.includes(':biodome/')),
    'Switching maps replaces the previous map',
  );
  assert.match(
    await page.locator('#storage-size').textContent(),
    /Extracted size: .*MB for Biodome; .*MB to .*MB depending on the map/,
  );
  await page.reload();
  await page.locator('#loading').waitFor({ state: 'hidden', timeout: 120000 });
  assert.equal(await page.locator('#storage-dialog').isVisible(), false);
  assert.equal(await page.locator('#storage-mode').inputValue(), 'current');
  await page.locator('#regions').check();
  await page.waitForTimeout(250);
  const before = page.url();
  await page.locator('#storage-mode').selectOption('none');
  await page.waitForTimeout(250);
  assert.equal(page.url(), before, 'Changing local storage mode must not change shared URLs');
  assert.deepEqual(await savedKeys(), []);
  assert.equal(await page.evaluate(() => localStorage.getItem('atlas-storage-mode')), 'none');
  assert.deepEqual(errors, []);
  const report = {
    passed: true,
    firstVisitChoices: 3,
    currentMapEstimate: estimate,
    range: true,
    currentMapResources: first.length,
    replacementMapResources: second.length,
    previousMapRemoved: true,
    localPreference: true,
    errors,
  };
  writeFileSync('.cache/qa/storage-report.json', JSON.stringify(report, null, 2));
  console.log(report);
} finally {
  await browser.close();
}
