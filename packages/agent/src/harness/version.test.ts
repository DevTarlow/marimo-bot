import {describe, expect, it} from 'vitest';

import {resolveHarness} from './resolve.js';
import type {HarnessAppDefaults, HarnessProfile} from './spec.js';
import {
  assertHarnessVersion,
  canonicalJson,
  harnessHash,
  nextHarnessVersion,
} from './version.js';

const app: HarnessAppDefaults = {
  model: {provider: 'deepseek', model: 'deepseek-chat'},
  allowPrivateNetworkFetch: false,
  learning: {mode: 'propose', retainTraces: false},
};

const profile: HarnessProfile = {
  id: 'writer',
  name: 'Writer',
  role: 'Write for the person.',
  enabledTools: ['read_file'],
  enabledSkills: [],
};

function spec(version: number): ReturnType<typeof resolveHarness> {
  return resolveHarness({profile, app, version});
}

describe('canonical JSON', () => {
  it('ignores property order', () => {
    expect(canonicalJson({b: 1, a: 2})).toBe(canonicalJson({a: 2, b: 1}));
  });

  it('ignores property order at every depth', () => {
    expect(canonicalJson({outer: {z: [{b: 1, a: 2}]}})).toBe(
      canonicalJson({outer: {z: [{a: 2, b: 1}]}}),
    );
  });

  it('drops undefined fields rather than encoding them differently', () => {
    expect(canonicalJson({a: 1, b: undefined})).toBe(canonicalJson({a: 1}));
  });
});

describe('harness hashes', () => {
  it('are stable for the same spec', () => {
    expect(harnessHash(spec(1))).toBe(harnessHash(spec(1)));
  });

  it('change when a budget changes', () => {
    const changed = resolveHarness({
      profile: {...profile, harness: {tools: {budgets: {maxSteps: 3}}}},
      app,
      version: 1,
    });
    expect(harnessHash(changed)).not.toBe(harnessHash(spec(1)));
  });
});

describe('the version chain', () => {
  it('starts at 1 with no parent', () => {
    const v1 = nextHarnessVersion({
      spec: spec(1),
      reason: 'The first harness.',
      now: new Date('2026-01-01T00:00:00.000Z'),
    });
    expect(v1.version).toBe(1);
    expect(v1.parent).toBeUndefined();
    expect(v1.createdAt).toBe('2026-01-01T00:00:00.000Z');
    expect(v1.hash).toBe(harnessHash(v1.spec));
  });

  it('accepts a direct child', () => {
    const v1 = nextHarnessVersion({spec: spec(1), reason: 'Start.'});
    const v2 = nextHarnessVersion({
      previous: v1,
      spec: spec(2),
      reason: 'A smaller step budget.',
    });
    expect(v2.version).toBe(2);
    expect(v2.parent).toBe(1);
    expect(assertHarnessVersion(v1, v2)).toBe(v2);
  });

  it('refuses a skipped version', () => {
    const v1 = nextHarnessVersion({spec: spec(1), reason: 'Start.'});
    const v3spec = spec(3);
    const v3 = {
      profileId: 'writer',
      version: 3,
      parent: 1,
      hash: harnessHash(v3spec),
      spec: v3spec,
      createdAt: new Date(0).toISOString(),
      reason: 'Skip.',
    };
    expect(() => assertHarnessVersion(v1, v3)).toThrow(
      /Expected harness version 2/,
    );
  });

  it('refuses a hash that does not match the spec', () => {
    const v1 = nextHarnessVersion({spec: spec(1), reason: 'Start.'});
    expect(() =>
      assertHarnessVersion(undefined, {...v1, hash: '0'.repeat(64)}),
    ).toThrow(/does not match its own hash/);
  });

  it('refuses a spec whose version disagrees with the document', () => {
    const v1 = nextHarnessVersion({spec: spec(1), reason: 'Start.'});
    expect(() =>
      assertHarnessVersion(undefined, {
        ...v1,
        version: 2,
        spec: v1.spec,
        hash: harnessHash(v1.spec),
      }),
    ).toThrow(/carries a spec for version 1/);
  });

  it('refuses a first version with a parent', () => {
    const v1 = nextHarnessVersion({spec: spec(1), reason: 'Start.'});
    expect(() => assertHarnessVersion(undefined, {...v1, parent: 1})).toThrow(
      /version 1 with no parent/,
    );
  });

  it('refuses a child attached to another profile', () => {
    const v1 = nextHarnessVersion({spec: spec(1), reason: 'Start.'});
    const other = resolveHarness({
      profile: {...profile, id: 'coder'},
      app,
      version: 2,
    });
    expect(() =>
      assertHarnessVersion(v1, {
        profileId: 'coder',
        version: 2,
        parent: 1,
        hash: harnessHash(other),
        spec: other,
        createdAt: new Date().toISOString(),
        reason: 'Wrong profile.',
      }),
    ).toThrow(/different profile/);
  });
});
