const test = require('node:test');
const assert = require('node:assert/strict');
const {
  LATEST_RELEASE_URL,
  RELEASE_PAGE_PREFIX,
  compareVersions,
  parseRelease,
  checkForUpdate,
} = require('../src/main/update-check.cjs');

function fakeFetch(status, body) {
  const calls = [];
  const fetch = async (url, options) => {
    calls.push({ url, options });
    return { status, ok: status >= 200 && status < 300, json: async () => body };
  };
  return { fetch, calls };
}

test('versions compare numerically and ignore a leading v', () => {
  assert.equal(compareVersions('0.1.10', '0.1.9'), 1);
  assert.equal(compareVersions('v0.2.0', '0.10.0'), -1);
  assert.equal(compareVersions('v1.0.0', '1.0.0'), 0);
  assert.throws(() => compareVersions('latest', '1.0.0'), /Invalid version/);
});

test('release pages outside this repository are never opened', () => {
  assert.deepEqual(parseRelease({ tag_name: 'v0.2.0', html_url: `${RELEASE_PAGE_PREFIX}tag/v0.2.0`, published_at: '2026-10-21T00:00:00Z' }), {
    version: '0.2.0',
    url: `${RELEASE_PAGE_PREFIX}tag/v0.2.0`,
    publishedAt: '2026-10-21T00:00:00Z',
  });
  assert.equal(parseRelease({ tag_name: 'v0.2.0', html_url: 'https://example.com/evil' }).url, `${RELEASE_PAGE_PREFIX}latest`);
  assert.throws(() => parseRelease({ tag_name: 'nightly' }), /no valid version/);
});

test('a newer GitHub release is reported as available', async () => {
  const { fetch, calls } = fakeFetch(200, { tag_name: 'v0.2.0', html_url: `${RELEASE_PAGE_PREFIX}tag/v0.2.0` });
  const result = await checkForUpdate({ currentVersion: '0.1.0', fetch });
  assert.equal(calls[0].url, LATEST_RELEASE_URL);
  assert.equal(result.available, true);
  assert.equal(result.latestVersion, '0.2.0');
  assert.equal(result.url, `${RELEASE_PAGE_PREFIX}tag/v0.2.0`);
});

test('the same or an older release is not an update', async () => {
  for (const tag of ['v0.1.0', 'v0.0.9']) {
    const { fetch } = fakeFetch(200, { tag_name: tag, html_url: `${RELEASE_PAGE_PREFIX}tag/${tag}` });
    assert.equal((await checkForUpdate({ currentVersion: '0.1.0', fetch })).available, false);
  }
});

test('a repository without releases is not an error, other failures are', async () => {
  assert.equal((await checkForUpdate({ currentVersion: '0.1.0', fetch: fakeFetch(404, {}).fetch })).available, false);
  await assert.rejects(checkForUpdate({ currentVersion: '0.1.0', fetch: fakeFetch(403, {}).fetch }), /GitHub responded 403/);
});
