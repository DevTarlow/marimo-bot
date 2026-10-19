import {describe, expect, it} from 'vitest';

import {
  checkForUpdates,
  compareVersions,
  parseVersion,
} from '../src/main/updates.js';

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {'content-type': 'application/json'},
  });
}

const feed = {
  tag_name: 'v1.4.0',
  html_url: 'https://example.test/releases/v1.4.0',
  body: 'A quieter notification path.',
};

describe('checkForUpdates', () => {
  it('reports a newer published release without downloading anything', async () => {
    const result = await checkForUpdates({
      currentVersion: '1.3.0',
      fetchImpl: async () => response(feed),
      now: () => new Date('2026-01-01T00:00:00.000Z'),
    });
    expect(result).toMatchObject({
      currentVersion: '1.3.0',
      latestVersion: 'v1.4.0',
      available: true,
      url: 'https://example.test/releases/v1.4.0',
      checkedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(result.notes).toContain('quieter');
  });

  it('answers current when the tag is not newer', async () => {
    const result = await checkForUpdates({
      currentVersion: '1.4.0',
      fetchImpl: async () => response(feed),
    });
    expect(result.available).toBe(false);
  });

  it('reports a missing feed and a bad answer rather than throwing', async () => {
    const missing = await checkForUpdates({
      currentVersion: '1.0.0',
      fetchImpl: async () => response({}, 404),
    });
    expect(missing.error).toContain('No releases');
    const bad = await checkForUpdates({
      currentVersion: '1.0.0',
      fetchImpl: async () => response({tag_name: 12}),
    });
    expect(bad.error).toContain('did not answer with a release');
  });

  it('reports a network failure as an answer', async () => {
    const result = await checkForUpdates({
      currentVersion: '1.0.0',
      fetchImpl: async () => {
        throw new Error('offline');
      },
    });
    expect(result.error).toContain('offline');
  });
});

describe('version comparison', () => {
  it('compares numeric parts and treats a prerelease as older', () => {
    expect(compareVersions(parseVersion('1.2.3')!, parseVersion('1.2.2')!)).toBe(1);
    expect(compareVersions(parseVersion('v1.2.3')!, parseVersion('1.2.3')!)).toBe(0);
    expect(compareVersions(parseVersion('1.2.3-beta')!, parseVersion('1.2.3')!)).toBe(-1);
    expect(parseVersion('not-a-version')).toBeUndefined();
  });
});
