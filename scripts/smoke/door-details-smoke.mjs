import { decodeMap, decodeLevel } from '../lib/map-format.mjs';
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
const url = process.env.ATLAS_URL || 'http://127.0.0.1:5173/',
  manifest = await fetch(new URL('data/manifest.json', url)).then((response) => response.json()),
  base = new URL('data/' + (manifest.dataPath || ''), url),
  meta = decodeMap(await fetch(new URL('biodome/map.json', base)).then((response) => response.json()));
const levels = await Promise.all(
  meta.levels.map((z) =>
    fetch(new URL(`biodome/${z}.json`, base))
      .then((response) => response.json())
      .then(decodeLevel),
  ),
);
let helperTile, controlTile;
for (const level of levels)
  for (let index = 0; index < level.grid.length; index++) {
    const definition = meta.definitions[level.grid[index]];
    if (!definition) continue;
    const tile = { x: (index % meta.width) + 1, y: meta.height - Math.floor(index / meta.width), z: level.z };
    if (!helperTile && definition.atoms.some((atom) => atom.doorAccess?.sources?.helpers?.length))
      helperTile = tile;
    if (!controlTile)
      for (const door of definition.atoms.filter((atom) => atom.controlKeys?.length)) {
        const control = meta.doorControls.find(
          (control) =>
            door.controlKeys.some((key) => key.kind === control.kind && key.id === control.id) &&
            (!control.range ||
              (control.z === tile.z &&
                Math.max(Math.abs(control.x - tile.x), Math.abs(control.y - tile.y)) <= control.range)) &&
            meta.definitions[
              levels.find((level) => level.z === control.z).grid[
                (meta.height - control.y) * meta.width + control.x - 1
              ]
            ]?.atoms[control.atomIndex]?.visual,
        );
        if (control) {
          controlTile = { ...tile, control };
          break;
        }
      }
  }
assert.ok(helperTile);
assert.ok(controlTile);
const browser = await chromium.launch({ headless: false }),
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }),
  errors = [];
page.on('pageerror', (error) => errors.push(error.message));
await page.addInitScript(() => localStorage.setItem('atlas-storage-mode', 'none'));
const target = (tile) =>
  url +
  `#m=biodome&z=${tile.z}&x=${(tile.x - 0.5) * 32}&y=${(meta.height - tile.y + 0.5) * 32}&s=2&t=${tile.x},${tile.y},${tile.z}`;
try {
  await page.goto(target(helperTile));
  await page.locator('#loading').waitFor({ state: 'hidden', timeout: 120000 });
  await page.locator('#detailed-view').check();
  assert.ok((await page.locator('.access-provenance').count()) > 0);
  await page.locator('.access-provenance > summary').first().click();
  assert.ok((await page.locator('.access-provenance a').count()) > 0);
  assert.match(await page.locator('.access-provenance').first().textContent(), /get_access\(\)/);
  assert.match(
    await page.locator('.access-provenance').first().textContent(),
    /Job ID access definitions \([1-9]/,
  );
  mkdirSync('.cache/qa', { recursive: true });
  await page.screenshot({ path: '.cache/qa/door-access-sources.png' });
  await page.goto(target(controlTile));
  await page.locator('#loading').waitFor({ state: 'hidden', timeout: 120000 });
  const link = page.locator('.door-control-link').filter({ hasText: controlTile.control.name }).first();
  await link.click();
  await page.waitForTimeout(300);
  assert.equal(
    new URLSearchParams(new URL(page.url()).hash.slice(1)).get('t'),
    `${controlTile.control.x},${controlTile.control.y},${controlTile.control.z}`,
  );
  assert.equal(
    await page
      .locator(`.offset-objects input[data-object-index="${controlTile.control.atomIndex}"]`)
      .isChecked(),
    true,
  );
  assert.equal(
    new URLSearchParams(new URL(page.url()).hash.slice(1)).get('h'),
    String(controlTile.control.atomIndex),
  );
  await page.screenshot({ path: '.cache/qa/button-object-highlight.png' });
  await page.reload();
  await page.locator('#loading').waitFor({ state: 'hidden', timeout: 120000 });
  assert.equal(
    await page
      .locator(`.offset-objects input[data-object-index="${controlTile.control.atomIndex}"]`)
      .isChecked(),
    true,
  );
  await page.goto(target({ x: 127, y: 78, z: 1 }) + '&o=29800');
  await page.locator('#loading').waitFor({ state: 'hidden', timeout: 120000 });
  await page
    .locator('.door-control-link')
    .filter({ hasText: 'Engineering Lockdown - Deck 1 · 134, 67' })
    .click();
  await page.waitForTimeout(350);
  assert.equal(await page.locator('.offset-objects input:checked').count(), 1);
  assert.equal(await page.locator('.offset-objects input[data-object-index="4"]').isChecked(), true);
  await page.screenshot({ path: '.cache/qa/engineering-button-highlight.png' });
  assert.deepEqual(errors, []);
  const report = { passed: true, helperTile, controlTile, sourceLinks: true, buttonTileLinks: true, errors };
  writeFileSync('.cache/qa/door-details-report.json', JSON.stringify(report, null, 2));
  console.log(report);
} finally {
  await browser.close();
}
