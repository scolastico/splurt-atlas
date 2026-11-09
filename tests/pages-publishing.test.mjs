import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

test('README includes both runnable workflow examples verbatim', () => {
  const readme = readFileSync('README.md', 'utf8').replaceAll('\r\n', '\n');
  for (const file of ['atlas-main.yml', 'atlas-pr.yml']) {
    const yaml = readFileSync(path.join('examples/github-actions', file), 'utf8')
      .trimEnd()
      .replaceAll('\r\n', '\n');
    assert.ok(readme.includes('```yaml\n' + yaml + '\n```'), `README example differs from ${file}`);
  }
});
