/** Dataset paths live in the fragment so shared views retain both revisions. */
export function manifestUrl(path: string, base: string): URL {
  const url = new URL(path, base);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Dataset URLs must use HTTP or HTTPS');
  if (!url.pathname.endsWith('.json')) {
    if (!url.pathname.endsWith('/')) url.pathname += '/';
    url.pathname += 'manifest.json';
  }
  url.hash = '';
  return url;
}

export function datasetPaths(hash: string, base: string, normal = './data/') {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const current = manifestUrl(params.get('current') || normal, base);
  const old = manifestUrl(params.get('old') || normal, base);
  return { current, old, comparing: current.href !== old.href };
}
