// End-to-end fixture: source change, removed/added cells, and a sprite-only edit.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { chromium } from '@playwright/test';

const root = path.resolve('.cache/qa', `diff-${randomUUID()}`);
const source = path.join(root, 'source');
const put = (file, text) => {
  const target = path.join(source, file);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, text);
};
const git = (...args) =>
  execFileSync('git', ['-C', source, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();
const cli = (...args) =>
  execFileSync(process.execPath, ['scripts/cli.mjs', '--source', source, '--workers', '3', ...args], {
    stdio: 'inherit',
    timeout: 120000,
  });
const sprite = async (name, color) => {
  mkdirSync(path.join(source, 'icons'), { recursive: true });
  await sharp({ create: { width: 32, height: 32, channels: 4, background: color } })
    .png()
    .toFile(path.join(source, `icons/${name}.dmi`));
};
put('tgstation.dme', '#include "code/main.dm"');
put(
  'code/main.dm',
  `/turf/open/floor
    name = "Floor"
    icon = 'icons/floor.dmi'
/obj/item/picture
    name = "Picture"
    icon = 'icons/picture.dmi'
/obj/item/chair
    name = "Chair"
    icon = 'icons/chair.dmi'
/area/test
    name = "Test room"
`,
);
put('LICENSE', 'Fixture license');
put('README.md', 'Diff smoke fixture');
put('_maps/one.json', JSON.stringify({ map_name: 'Test Station', map_path: 'one', map_file: 'station.dmm' }));
const map = (changed) => {
  const rows = Array.from({ length: 18 }, () => Array(33).fill('a'));
  rows[8][8] = 'b';
  if (changed) rows[9][10] = 'c';
  return (
    '"a" = (/turf/open/floor,/area/test)\n"b" = (/obj/item/picture,/turf/open/floor,/area/test)\n"c" = (/obj/item/chair,/turf/open/floor,/area/test)\n(1,1,1) = {"\n' +
    rows.map((row) => row.join('')).join('\n') +
    '\n"}\n' +
    (changed ? '(36,3,1)' : '(35,3,1)') +
    ' = {"a"}\n' +
    (changed ? '(1,22,1) = {"a"}\n' : '(1,1,2) = {"a"}\n')
  );
};
put('_maps/one/station.dmm', map(false));
await sprite('floor', '#283d4b');
await sprite('picture', '#ff6600');
await sprite('chair', '#3ce68a');
git('init', '-b', 'main');
git('add', '.');
git('-c', 'user.name=Atlas test', '-c', 'user.email=atlas@example.test', 'commit', '-m', 'before');
cli('--output', path.join(root, 'before'));
put('_maps/one/station.dmm', map(true));
await sprite('picture', '#3366ff');
git('add', '.');
git('-c', 'user.name=Atlas test', '-c', 'user.email=atlas@example.test', 'commit', '-m', 'after');
cli('--output', path.join(root, 'after'), '--viewer');
const mime = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
};
const server = createServer((request, response) => {
  try {
    const url = new URL(request.url, 'http://localhost');
    let target = path.resolve(root, '.' + decodeURIComponent(url.pathname));
    if (!target.startsWith(root + path.sep)) throw new Error('Invalid path');
    if (statSync(target).isDirectory()) target = path.join(target, 'index.html');
    response.setHeader('Content-Type', mime[path.extname(target)] || 'application/octet-stream');
    response.end(readFileSync(target));
  } catch {
    response.statusCode = 404;
    response.end('Not found');
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: false });
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
await page.addInitScript(() => localStorage.setItem('atlas-storage-mode', 'none'));
try {
  const comparison = base + '/after/#old=../before/&m=one&z=1&t=9,10,1&s=2';
  await page.goto(comparison);
  await page.locator('#loading').waitFor({ state: 'hidden', timeout: 30000 });
  await page.waitForFunction(
    () => document.getElementById('comparison-summary').textContent.includes('Sprite check complete'),
    null,
    { timeout: 30000 },
  );
  assert.match(await page.locator('#comparison-summary').textContent(), /^6 changed tiles/);
  assert.equal(await page.locator('#changed-tiles').isChecked(), true);
  assert.equal(await page.locator('#old-view').isVisible(), true);
  assert.match(
    await page.locator('#inspector').textContent(),
    /Current[\s\S]*Picture[\s\S]*Previous[\s\S]*Picture/,
  );
  assert.equal(await page.locator('#map').getAttribute('data-detail'), '0');
  assert.equal(await page.locator('#old-map').getAttribute('data-detail'), '0');
  // Both inspector revisions fit in the sidebar and share a draggable divider.
  const currentSection = await page.locator('.current-tile').boundingBox();
  const previousSection = await page.locator('.previous-tile').boundingBox();
  assert.ok(previousSection.y > currentSection.y);
  assert.ok(previousSection.y + previousSection.height < 1100);
  const divider = page.locator('#inspector-resize');
  const handle = await divider.boundingBox();
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2 + 90, { steps: 6 });
  await page.mouse.up();
  assert.ok((await page.locator('.current-tile').boundingBox()).height > currentSection.height + 80);
  await divider.dblclick();
  assert.equal(await divider.getAttribute('aria-valuenow'), '50');
  // Click the same coordinate in either pane; both inspect the same BYOND tile.
  const center = async (id) =>
    page.locator(id).evaluate((canvas) => {
      const rect = canvas.getBoundingClientRect();
      const inset =
        canvas.id === 'map' ? document.getElementById('sidebar').getBoundingClientRect().right : 0;
      return { x: rect.left + (rect.width + inset) / 2, y: rect.top + rect.height / 2 };
    });
  const oldPoint = await center('#old-map');
  await page.mouse.click(oldPoint.x, oldPoint.y);
  assert.match(await page.locator('#inspector').textContent(), /9, 10/);
  assert.equal(
    await page.locator('#old-map').evaluate((canvas) => getComputedStyle(canvas).outlineStyle),
    'none',
  );
  assert.equal(
    await page.locator('#old-view').evaluate((pane) => getComputedStyle(pane).borderLeftWidth),
    '6px',
  );
  const currentPoint = await center('#map');
  await page.mouse.click(currentPoint.x, currentPoint.y);
  assert.match(await page.locator('#inspector').textContent(), /9, 10/);
  await page.locator('#explore-tab').click();
  await page.locator('#changed-tiles').uncheck();
  await page.waitForTimeout(250);
  const withoutHighlights = page.url();
  await page.reload();
  await page.locator('#loading').waitFor({ state: 'hidden', timeout: 30000 });
  assert.equal(await page.locator('#changed-tiles').isChecked(), false);
  assert.match(withoutHighlights, /old=/);
  // A removed tile can still be inspected on the old map.
  await page.goto(base + '/after/#old=../before/&m=one&t=35,3,1&s=2');
  await page.locator('#loading').waitFor({ state: 'hidden', timeout: 30000 });
  assert.match(
    await page.locator('#inspector').textContent(),
    /Current[\s\S]*No mapped tile here[\s\S]*Previous/,
  );
  await page.screenshot({ path: path.join(root, 'diff-desktop.png'), fullPage: true });
  // Unchanged tile: no redundant Previous section.
  await page.goto(base + '/after/#old=../before/&m=one&t=2,2,1&s=2');
  await page.locator('#loading').waitFor({ state: 'hidden', timeout: 30000 });
  assert.equal(await page.locator('.previous-tile').count(), 0);
  assert.equal(await page.locator('#inspector-resize').count(), 0);
  assert.equal(
    await page
      .locator('.sidebar-scroll')
      .evaluate((panel) => panel.classList.contains('inspector-split-active')),
    false,
  );
  // A removed deck and an old tile outside the current map's dimensions remain selectable.
  await page.goto(base + '/after/#old=../before/&m=one&t=1,1,2&s=2');
  await page.locator('#loading').waitFor({ state: 'hidden', timeout: 30000 });
  assert.match(
    await page.locator('#inspector').textContent(),
    /Current[\s\S]*No mapped tile here[\s\S]*Previous/,
  );
  assert.equal(await page.locator('#decks .active').getAttribute('data-z'), '2');
  await page.goto(base + '/after/#current=../before/&old=./data/&m=one&t=1,22,1&s=2');
  await page.locator('#loading').waitFor({ state: 'hidden', timeout: 30000 });
  assert.match(
    await page.locator('#inspector').textContent(),
    /Current[\s\S]*No mapped tile here[\s\S]*Previous/,
  );
  const olderCenter = await center('#old-map');
  await page.mouse.click(olderCenter.x, olderCenter.y);
  assert.match(await page.locator('#inspector').textContent(), /1, 22/);
  // Equivalent paths and ordinary links both retain the normal single canvas.
  for (const fragment of ['m=one', 'm=one&current=./data/&old=./data/manifest.json']) {
    await page.goto(base + '/after/#' + fragment);
    await page.locator('#loading').waitFor({ state: 'hidden', timeout: 30000 });
    assert.equal(await page.locator('#old-view').isVisible(), false);
    assert.equal(await page.locator('#changed-tiles-option').isVisible(), false);
  }
  // Explicit index.html uses the same integrated comparison view.
  await page.goto(base + '/after/index.html#old=../before/&current=./data/&m=one&z=1');
  await page.locator('#loading').waitFor({ state: 'hidden', timeout: 30000 });
  assert.equal(await page.locator('#old-view').isVisible(), true);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: path.join(root, 'diff-mobile.png'), fullPage: true });
  assert.deepEqual(errors, []);
  writeFileSync(path.join(root, 'report.json'), JSON.stringify({ ok: true, errors, source, root }, null, 2));
  console.log(`Diff smoke passed. Fixtures and screenshots: ${root}`);
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
