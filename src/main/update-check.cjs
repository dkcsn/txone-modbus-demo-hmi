const UPDATE_REPOSITORY = 'dkcsn/txone-modbus-demo-hmi';
const LATEST_RELEASE_URL = `https://api.github.com/repos/${UPDATE_REPOSITORY}/releases/latest`;
const RELEASE_PAGE_PREFIX = `https://github.com/${UPDATE_REPOSITORY}/releases/`;

function parseVersion(value) {
  const match = String(value || '').trim().match(/^v?(\d+)\.(\d+)\.(\d+)/);
  return match ? match.slice(1, 4).map(Number) : null;
}

function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) throw new Error(`Invalid version: ${left ? b : a}`);
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] > right[index] ? 1 : -1;
  }
  return 0;
}

function parseRelease(release) {
  const version = String(release?.tag_name || '').replace(/^v/, '');
  if (!parseVersion(version)) throw new Error('Latest release has no valid version tag');
  // Only ever open this repository's release pages, whatever the API returns.
  const url = String(release.html_url || '').startsWith(RELEASE_PAGE_PREFIX)
    ? release.html_url
    : `${RELEASE_PAGE_PREFIX}latest`;
  return { version, url, publishedAt: release.published_at || null };
}

async function checkForUpdate({ currentVersion, fetch, timeoutMs = 10_000 }) {
  const response = await fetch(LATEST_RELEASE_URL, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'txone-modbus-demo-hmi' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (response.status === 404) return { available: false, currentVersion, latestVersion: null, url: null, checkedAt: Date.now() };
  if (!response.ok) throw new Error(`GitHub responded ${response.status}`);
  const latest = parseRelease(await response.json());
  return {
    available: compareVersions(latest.version, currentVersion) > 0,
    currentVersion,
    latestVersion: latest.version,
    url: latest.url,
    publishedAt: latest.publishedAt,
    checkedAt: Date.now(),
  };
}

module.exports = { UPDATE_REPOSITORY, LATEST_RELEASE_URL, RELEASE_PAGE_PREFIX, parseVersion, compareVersions, parseRelease, checkForUpdate };
