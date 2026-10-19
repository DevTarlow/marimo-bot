/**
 * The usage counter behind a maintenance proposal.
 *
 * The only property that matters is that a load is counted and a removal is
 * forgotten: a count attached to a deleted skill is a fact about nothing, and a
 * missing count makes every skill look unused.
 */
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';

import {afterEach, beforeEach, describe, expect, it} from 'vitest';

import {SkillUsageStore} from './skill-usage.js';

describe('the skill usage store', () => {
  let dir: string;
  let file: string;
  let store: SkillUsageStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(process.cwd(), '.marimo-skill-usage-'));
    file = join(dir, 'learning', 'skill-usage.json');
    store = new SkillUsageStore({
      file,
      now: () => new Date('2026-01-01T00:00:00.000Z'),
    });
  });

  afterEach(async () => {
    await rm(dir, {recursive: true, force: true, maxRetries: 5, retryDelay: 20});
  });

  it('counts a load and dates it', async () => {
    await store.record('skill-1');
    const after = await store.load();
    expect(after.loads['skill-1']).toEqual({
      count: 1,
      lastAt: '2026-01-01T00:00:00.000Z',
    });

    await store.record('skill-1');
    expect((await store.load()).loads['skill-1']?.count).toBe(2);
  });

  it('survives a restart', async () => {
    await store.record('skill-1');
    const reopened = await new SkillUsageStore({file}).load();
    expect(reopened.loads['skill-1']?.count).toBe(1);
  });

  it('forgets a removed skill', async () => {
    await store.record('skill-1');
    await store.forget('skill-1');
    expect((await store.load()).loads['skill-1']).toBeUndefined();
  });

  it('refuses to write over a document from a newer build', async () => {
    await mkdir(join(dir, 'learning'), {recursive: true});
    await writeFile(file, '{"version":99,"loads":{}}\n', 'utf8');
    await expect(store.record('skill-1')).rejects.toThrow(/newer/i);
    const raw = JSON.parse(await readFile(file, 'utf8')) as {version: number};
    expect(raw.version).toBe(99);
  });
});
