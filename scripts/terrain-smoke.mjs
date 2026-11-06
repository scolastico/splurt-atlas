import { decodeMap, decodeLevel } from './lib/map-format.mjs';
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
const url = process.env.ATLAS_URL || 'http://127.0.0.1:5173/',
  catalog = await fetch(new URL('data/manifest.json', url)).then((r) => r.json()),
  root = new URL(`data/${catalog.dataPath || ''}`, url);
const ice = decodeMap(await fetch(new URL('icebox/map.json', root)).then((r) => r.json())),
  level = decodeLevel(await fetch(new URL('icebox/3.json', root)).then((r) => r.json())),
  index = level.grid.findIndex((id) => ice.definitions[id]?.runtimeTerrain),
  x = (index % ice.width) + 1,
  y = ice.height - Math.floor(index / ice.width);
const tram = decodeMap(await fetch(new URL('tramstation/map.json', root)).then((r) => r.json()));
const broad = tram.definitions.findIndex((d) =>
  d.atoms.some(
    (a) => a.doorAccess?.kind === 'restricted' && a.doorAccess.roles.length > tram.jobRoles.length / 2,
  ),
);
let door;
for (const z of tram.levels) {
  const grid = decodeLevel(await fetch(new URL(`tramstation/${z}.json`, root)).then((r) => r.json())),
    i = grid.grid.indexOf(broad);
  if (i >= 0) {
    door = { x: (i % tram.width) + 1, y: tram.height - Math.floor(i / tram.width), z };
    break;
  }
}
const browser = await chromium.launch({ headless: false }),
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }),
  errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.addInitScript(() => localStorage.setItem('atlas-storage-mode', 'none'));
try {
  const target = new URL(url);
  target.hash = `m=icebox&z=3&x=${(x - 0.5) * 32}&y=${(ice.height - y + 0.5) * 32}&s=1`;
  await page.goto(target.href);
  await page.locator('#loading').waitFor({ state: 'hidden', timeout: 120000 });
  assert.equal(await page.locator('#runtime-terrain').isChecked(), true);
  const sample = () =>
    page.locator('#map').evaluate((canvas) => {
      const readStation = (canvas, x, y, w, h) => {
        const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
        if (!gl) return Array.from(canvas.getContext('2d').getImageData(x, y, w, h).data);
        const raw = new Uint8Array(w * h * 4);
        gl.readPixels(x, canvas.height - y - h, w, h, gl.RGBA, gl.UNSIGNED_BYTE, raw);
        const out = [];
        for (let row = h - 1; row >= 0; row--) out.push(...raw.subarray(row * w * 4, (row + 1) * w * 4));
        return out;
      };
      const pixels = readStation(
          canvas,
          Math.floor(
            (canvas.width +
              (innerWidth > 650 && !document.body.classList.contains('sidebar-collapsed')
                ? (document.querySelector('#sidebar').getBoundingClientRect().width * canvas.width) /
                  canvas.getBoundingClientRect().width
                : 0)) /
              2 -
              8,
          ),
          Math.floor(canvas.height / 2 - 8),
          16,
          16,
        ),
        sums = [0, 0, 0];
      for (let i = 0; i < pixels.length; i += 4) for (let c = 0; c < 3; c++) sums[c] += pixels[i + c] / 256;
      return sums;
    });
  const natural = await sample();
  await page.locator('#runtime-terrain').uncheck();
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(150);
  const raw = await sample();
  assert.ok(
    Math.max(...natural) - Math.min(...natural) < 50,
    'Snow replacement should have a natural muted palette',
  );
  assert.ok(
    Math.max(...raw) - Math.min(...raw) > 75,
    'Disabling replacement should restore the saturated mapper placeholder',
  );
  await page.locator('#runtime-terrain').check();
  await page.waitForFunction(
    () => !!(Number(new URLSearchParams(location.hash.slice(1)).get('o')) & (1 << 14)),
  );
  mkdirSync('.cache/qa', { recursive: true });
  await page.screenshot({ path: '.cache/qa/runtime-terrain.png' });
  const link = new URL(url);
  link.searchParams.set('qa', 'door');
  link.hash = `m=tramstation&z=${door.z}&x=${(door.x - 0.5) * 32}&y=${(tram.height - door.y + 0.5) * 32}&s=1&t=${door.x},${door.y},${door.z}`;
  await page.goto(link.href);
  await page.locator('#loading').waitFor({ state: 'hidden', timeout: 120000 });
  await page.waitForFunction(() =>
    document.querySelector('#inspector').textContent.includes('Who can NOT open'),
  );
  assert.equal(await page.locator('#inspector details,#inspector a').count(), 0);
  await page.screenshot({ path: '.cache/qa/door-exclusions.png' });
  assert.deepEqual(errors, []);
  const report = {
    passed: true,
    naturalRGB: natural,
    mapperRGB: raw,
    defaultOn: true,
    toggleRestoresOriginal: true,
    bitmaskPersists: true,
    negativeDoorList: true,
    errors,
  };
  writeFileSync('.cache/qa/terrain-report.json', JSON.stringify(report, null, 2));
  console.log(report);
} finally {
  await browser.close();
}
