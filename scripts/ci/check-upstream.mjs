import { execFileSync } from 'node:child_process';
import { readFileSync, appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function shouldBuild(event, commit, baseline, full = false) {
  return full || event !== 'schedule' || baseline?.commit !== commit;
}
export function trustedBaselineRun(run, repository) {
  return (
    run.head_branch === 'main' &&
    run.head_repository?.full_name === repository &&
    ['push', 'workflow_dispatch', 'schedule'].includes(run.event) &&
    run.path?.split('@')[0] === '.github/workflows/pages.yml'
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = JSON.parse(readFileSync('atlas.config.json'));
  const ref = config.upstreamRef || 'HEAD';
  const remote = execFileSync('git', ['ls-remote', config.repository, ref], {
    encoding: 'utf8',
    timeout: 60000,
  });
  const commit = remote.trim().split(/\s+/)[0];
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error(`Cannot resolve upstream ${ref}`);
  const repository = process.env.GITHUB_REPOSITORY;
  const api = (endpoint) =>
    JSON.parse(
      execFileSync('gh', ['api', `repos/${repository}/${endpoint}`], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    );
  let baseline = null,
    artifactRun = '';
  try {
    const file = api('contents/data/manifest.json?ref=release');
    baseline = JSON.parse(Buffer.from(file.content, 'base64').toString('utf8'));
  } catch {}
  if (!baseline) {
    try {
      const { artifacts } = api('actions/artifacts?name=station-atlas&per_page=100');
      for (const artifact of artifacts) {
        if (artifact.expired || artifact.workflow_run?.head_branch !== 'main') continue;
        const run = api(`actions/runs/${artifact.workflow_run.id}`);
        if (trustedBaselineRun(run, repository)) {
          artifactRun = String(run.id);
          break;
        }
      }
    } catch (error) {
      console.log('No reusable build artifact: ' + error.message);
    }
  }
  const build = shouldBuild(
    process.env.GITHUB_EVENT_NAME,
    commit,
    baseline,
    process.env.ATLAS_FULL_REBUILD === 'true',
  );
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `commit=${commit}\nbuild=${build}\nrelease=${!!baseline}\nartifact_run=${artifactRun}\n`,
    );
  console.log(
    `Upstream ${ref}: ${commit}. ${build ? 'Build required.' : 'Release branch is current; skipping build.'}`,
  );
}
