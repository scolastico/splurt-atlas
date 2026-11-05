import { execFileSync } from 'node:child_process';
import { readFileSync, appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export async function needsRebuild(event, commit, deployedURL, fetcher = fetch) {
  if (event !== 'schedule' || !deployedURL) return true;
  try {
    const url = new URL('data/manifest.json', deployedURL.replace(/\/?$/, '/'));
    url.searchParams.set('upstream-check', Date.now());
    const response = await fetcher(url, { cache: 'no-store', signal: AbortSignal.timeout(30000) });
    if (!response.ok) return true;
    return (await response.json()).commit !== commit;
  } catch {
    // Missing/unreachable deployments should retry a build, never hide updates.
    return true;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = JSON.parse(readFileSync('atlas.config.json'));
  const ref = config.upstreamRef || 'HEAD';
  const remote = execFileSync('git', ['ls-remote', config.repository, ref], { encoding: 'utf8', timeout: 60000 });
  const commit = remote.trim().split(/\s+/)[0];
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error(`Cannot resolve upstream ${ref}`);
  const build = await needsRebuild(process.env.GITHUB_EVENT_NAME, commit, process.env.ATLAS_DEPLOYED_URL);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `commit=${commit}\nbuild=${build}\n`);
  console.log(`Upstream ${ref}: ${commit}. ${build ? 'Build required.' : 'Already deployed; skipping conversion and deployment.'}`);
}
