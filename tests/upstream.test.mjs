import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldBuild, trustedBaselineRun } from '../scripts/ci/check-upstream.mjs';
test('scheduler compares the release catalog and manual full rebuild bypasses the check', () => {
  assert.equal(shouldBuild('schedule', 'abc', { commit: 'abc' }), false);
  assert.equal(shouldBuild('schedule', 'abc', { commit: 'old' }), true);
  assert.equal(shouldBuild('schedule', 'abc', null), true);
  assert.equal(shouldBuild('workflow_dispatch', 'abc', { commit: 'abc' }, true), true);
  assert.equal(shouldBuild('push', 'abc', { commit: 'abc' }), true);
});
test('baseline recovery accepts only this repository main-branch publishing workflow', () => {
  const run = {
    head_branch: 'main',
    head_repository: { full_name: 'scolastico/splurt-atlas' },
    event: 'push',
    path: '.github/workflows/pages.yml',
  };
  assert.equal(trustedBaselineRun(run, 'scolastico/splurt-atlas'), true);
  assert.equal(trustedBaselineRun({ ...run, event: 'pull_request' }, 'scolastico/splurt-atlas'), false);
  assert.equal(
    trustedBaselineRun(
      { ...run, head_repository: { full_name: 'fork/splurt-atlas' } },
      'scolastico/splurt-atlas',
    ),
    false,
  );
  assert.equal(
    trustedBaselineRun({ ...run, path: '.github/workflows/unrelated.yml' }, 'scolastico/splurt-atlas'),
    false,
  );
});
