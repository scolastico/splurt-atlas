import test from 'node:test';
import assert from 'node:assert/strict';
import { datasetPaths } from '../src/model/dataset-paths.ts';
import { viewFragment, encodeOptions, decodeOptions } from '../src/model/view-state.ts';

const base = 'https://example.test/atlas/';
test('normal atlas and equivalent dataset paths retain a single view', () => {
  for (const hash of [
    '',
    '#m=one',
    '#current=./data',
    '#old=data/manifest.json',
    '#current=data/&old=./data/',
  ])
    assert.equal(datasetPaths(hash, base).comparing, false, hash);
});

test('either omitted revision uses the normal data path, including the query override', () => {
  const current = datasetPaths('#current=./preview/data/', base);
  assert.equal(current.current.href, base + 'preview/data/manifest.json');
  assert.equal(current.old.href, base + 'data/manifest.json');
  assert.equal(current.comparing, true);
  const old = datasetPaths('#old=../baseline/', base, './custom/');
  assert.equal(old.current.href, base + 'custom/manifest.json');
  assert.equal(old.old.href, 'https://example.test/baseline/manifest.json');
  assert.equal(old.comparing, true);
  assert.equal(datasetPaths('', base, './custom/').comparing, false);
});

test('dataset paths survive camera, selection and option sharing', () => {
  const params = new URLSearchParams(
    viewFragment({
      map: { id: 'one' },
      z: 1,
      x: 32,
      y: 64,
      zoom: 2,
      current: '../new/data/',
      old: '../old/data/',
      selected: { x: 1, y: 2, z: 1 },
      optionMask: encodeOptions({ 'changed-tiles': true }),
    }).slice(1),
  );
  assert.equal(params.get('current'), '../new/data/');
  assert.equal(params.get('old'), '../old/data/');
  assert.equal(decodeOptions(params.get('o'))['changed-tiles'], true);
  assert.equal(decodeOptions(0)['changed-tiles'], false);
});

test('dataset paths reject non-HTTP schemes', () => {
  assert.throws(() => datasetPaths('#old=javascript:alert(1)', base), /HTTP/);
});
