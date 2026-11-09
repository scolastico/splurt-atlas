import test from 'node:test';
import assert from 'node:assert/strict';
import { workerCount } from '../scripts/export-parallel.mjs';
test('conversion worker count respects CPU, RAM, work-item count and explicit overrides', () => {
  const gb = 1024 ** 3;
  assert.equal(workerCount(16, 16, 16 * gb, undefined), 4);
  assert.equal(workerCount(16, 2, 16 * gb, 8), 2);
  assert.equal(workerCount(16, 16, 3 * gb, 8), 1);
  assert.equal(workerCount(2, 16, 32 * gb, 8), 2);
  assert.equal(workerCount(16, 16, 32 * gb, 8), 8);
  assert.equal(workerCount(16, 16, 32 * gb, 1), 1);
  assert.throws(() => workerCount(16, 16, 32 * gb, 0), /positive integer/);
});
test('a single station can use the whole render pool regardless of station count', () => {
  assert.equal(workerCount(Infinity, 8, 16 * 1024 ** 3, 4), 4);
});
