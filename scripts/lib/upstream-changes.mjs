// Which upstream files changed between the baseline's commit and the pinned
// one. Incremental exports use the list to skip maps whose inputs are untouched.
import { execFileSync } from 'node:child_process';

/**
 * Returns the changed file paths, or null when the comparison is impossible
 * (then every map's inputs are checked the slow way).
 */
export function changedFilesSince(root, previousCommit, commit) {
  try {
    if (!/^[a-f0-9]{40}$/.test(previousCommit)) throw new Error('Invalid baseline revision');
    try {
      execFileSync('git', ['cat-file', '-e', `${previousCommit}^{commit}`], { cwd: root, stdio: 'ignore' });
    } catch {
      execFileSync('git', ['fetch', '--depth=1', 'origin', previousCommit], { cwd: root, stdio: 'inherit' });
    }
    const changed = execFileSync(
      'git',
      ['diff', '--no-renames', '--name-only', '-z', previousCommit, commit],
      {
        cwd: root,
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
      },
    )
      .split('\0')
      .filter(Boolean);
    console.log(`Upstream changes since ${previousCommit.slice(0, 12)}: ${changed.length} files`);
    return changed;
  } catch (error) {
    console.log(`File comparison unavailable; checking all map inputs: ${error.message}`);
    return null;
  }
}
