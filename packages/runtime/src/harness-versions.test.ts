import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';

import {afterEach, describe, expect, it} from 'vitest';

import {harnessHash, resolveHarness} from '@marimo/agent';
import type {HarnessAppDefaults, HarnessProfile} from '@marimo/agent';

import {HarnessVersionStore} from './harness-versions.js';

const roots: string[] = [];

async function root(): Promise<string> {
  const dir = await mkdtemp(join(process.cwd(), '.marimo-harness-versions-'));
  roots.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((dir) =>
      rm(dir, {recursive: true, force: true, maxRetries: 5, retryDelay: 20}),
    ),
  );
});

const profile: HarnessProfile = {
  id: 'writer',
  name: 'Writer',
  role: 'Write.',
  enabledTools: [],
  enabledSkills: [],
};

const app: HarnessAppDefaults = {
  model: {provider: 'deepseek', model: 'deepseek-chat'},
  allowPrivateNetworkFetch: false,
  learning: {mode: 'propose', retainTraces: false},
};

function spec(version = 1) {
  return resolveHarness({profile, app, version});
}

describe('HarnessVersionStore', () => {
  it('records one immutable document per distinct harness', async () => {
    const dir = await root();
    const store = new HarnessVersionStore({rootDir: dir});
    const first = await store.record(spec());
    expect(first.created).toBe(true);
    expect(first.record.hash).toBe(harnessHash(spec()));
    expect(first.record.harnessVersion).toBe(1);

    const second = await store.record(spec());
    expect(second.created).toBe(false);
    expect(second.record.recordedAt).toBe(first.record.recordedAt);

    const file = join(dir, `${first.record.hash}.json`);
    const body = JSON.parse(await readFile(file, 'utf8')) as {
      version: number;
      hash: string;
      spec: unknown;
    };
    expect(body.version).toBe(1);
    expect(body.hash).toBe(first.record.hash);
    expect(body.spec).toMatchObject({id: 'writer', version: 1});

    const loaded = await store.load(first.record.hash);
    expect(loaded?.spec).toEqual(spec());
    expect(await store.list()).toHaveLength(1);
  });

  it('refuses to overwrite a record from a newer build', async () => {
    const dir = await root();
    const store = new HarnessVersionStore({rootDir: dir});
    const hash = harnessHash(spec());
    const file = join(dir, `${hash}.json`);
    await writeFile(
      file,
      JSON.stringify({version: 99, hash, harnessVersion: 1}),
      'utf8',
    );
    await expect(store.load(hash)).rejects.toThrow('newer version');
    await expect(store.record(spec())).rejects.toThrow('newer version');
    expect(JSON.parse(await readFile(file, 'utf8')).version).toBe(99);
    expect(await store.list()).toEqual([]);
  });

  it('does not overwrite a record it cannot parse', async () => {
    const dir = await root();
    const store = new HarnessVersionStore({rootDir: dir});
    const hash = harnessHash(spec());
    const file = join(dir, `${hash}.json`);
    const broken = JSON.stringify({
      version: 1,
      hash,
      harnessVersion: 1,
      recordedAt: '2026-01-01T00:00:00.000Z',
      spec: {},
    });
    await writeFile(file, broken, 'utf8');
    expect(await store.load(hash)).toBeUndefined();
    await expect(store.record(spec())).rejects.toThrow('cannot read');
    expect(await readFile(file, 'utf8')).toBe(broken);
  });

  it('does not answer for a hash that is not one', async () => {
    const store = new HarnessVersionStore({rootDir: await root()});
    expect(await store.load('../secrets')).toBeUndefined();
    expect(await store.load('a'.repeat(64))).toBeUndefined();
  });
});
