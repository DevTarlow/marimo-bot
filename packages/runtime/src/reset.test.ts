/**
 * `resetInstall`: everything the app keeps, and nothing else.
 *
 * The whole point of this test is the second half of that sentence. The first
 * half is easy and is asserted by emptying a directory; the second is the one a
 * user cannot undo, because a reset that reached into a Space — or into the home
 * directory behind `defaultWorkspace` — has deleted somebody's work rather than
 * the app's own records.
 *
 * It is also the test that stops the reset from becoming a hand-kept list. The
 * folder holds a document the app writes, a store's directory, and a stray file
 * named nowhere in `AppPaths`; all three have to be gone.
 */
import {mkdir, mkdtemp, readdir, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';

import {afterEach, beforeEach, describe, expect, it} from 'vitest';

import {resetInstall} from './reset.js';
import {resolveAppPaths} from './paths.js';
import type {AppPaths} from './paths.js';

describe('resetInstall', () => {
  let dir: string;
  let paths: AppPaths;

  beforeEach(async () => {
    dir = await mkdtemp(join(process.cwd(), '.marimo-reset-'));
    paths = resolveAppPaths(dir);
  });

  afterEach(async () => {
    await rm(dir, {recursive: true, force: true});
  });

  /** One of everything a real install leaves behind. */
  async function fill(userData: string): Promise<void> {
    await writeFile(join(userData, 'settings.json'), '{}', 'utf8');
    await writeFile(join(userData, 'profiles.json'), '{}', 'utf8');
    await writeFile(join(userData, 'workspaces.json'), '{}', 'utf8');
    await writeFile(join(userData, 'jobs.json'), '{}', 'utf8');
    await writeFile(join(userData, 'memory-proposals.json'), '{}', 'utf8');
    await writeFile(join(userData, 'feedback.json'), '{}', 'utf8');
    await writeFile(join(userData, 'skills.json'), '{}', 'utf8');
    await writeFile(join(userData, 'window-state.json'), '{}', 'utf8');
    await writeFile(join(userData, 'companion-state.json'), '{}', 'utf8');
    await writeFile(join(userData, 'app.lock'), '1234', 'utf8');
    await writeFile(join(userData, 'recall.pid'), '1234', 'utf8');
    // Named nowhere in `AppPaths`, which is the point of enumerating the folder.
    await writeFile(join(userData, 'left-over.dat'), 'stray', 'utf8');

    await mkdir(join(userData, 'sessions'), {recursive: true});
    await writeFile(join(userData, 'sessions', 'chat.jsonl'), '', 'utf8');
    await mkdir(join(userData, 'secrets'), {recursive: true});
    await writeFile(join(userData, 'secrets', 'deepseek.bin'), '', 'utf8');
    await mkdir(join(userData, 'memory', 'lead'), {recursive: true});
    await writeFile(join(userData, 'memory', 'lead', 'memory.md'), '', 'utf8');
    await mkdir(join(userData, 'trees'), {recursive: true});
    await writeFile(join(userData, 'trees', 'chat.json'), '{}', 'utf8');
    await mkdir(join(userData, 'recall', 'lead'), {recursive: true});
    await writeFile(
      join(userData, 'recall', 'lead', 'index.json'),
      '{}',
      'utf8',
    );
    // The downloaded search model, engine and weights together.
    await mkdir(join(userData, 'model', 'recall', 'engine'), {recursive: true});
    await writeFile(
      join(userData, 'model', 'recall', 'engine', 'llama-server'),
      'binary',
      'utf8',
    );
    await mkdir(join(userData, 'Cache'), {recursive: true});
    await writeFile(join(userData, 'Cache', 'index'), 'cache', 'utf8');
  }

  it('empties the user-data folder', async () => {
    await fill(dir);

    const report = await resetInstall(paths);

    expect(await readdir(dir)).toEqual([]);
    expect(report.failures).toEqual([]);
    expect(report.userData).toBe(dir);
    // 12 files and 7 directories at the top level, so 19 entries in the first
    // pass; the second finds nothing to do.
    expect(report.removed).toBe(19);
  });

  it('leaves everything outside it alone', async () => {
    /*
     * Three things that must survive, each for its own reason: a Space with the
     * bot's own notes in it, the weights a checkout keeps elsewhere, and the
     * folder `defaultWorkspace` points at — now the app's starting Space, whose
     * files are the person's rather than the app's.
     */
    const space = await mkdtemp(join(process.cwd(), '.marimo-reset-space-'));
    const model = await mkdtemp(join(process.cwd(), '.marimo-reset-model-'));
    const home = await mkdtemp(join(process.cwd(), '.marimo-reset-home-'));
    try {
      await mkdir(join(space, '.marimo', 'lead'), {recursive: true});
      await writeFile(
        join(space, '.marimo', 'lead', 'memory.md'),
        '# notes',
        'utf8',
      );
      await writeFile(join(space, 'essay.md'), 'my work', 'utf8');
      await writeFile(join(model, 'weights.gguf'), 'weights', 'utf8');
      await writeFile(join(home, 'notes.md'), 'mine', 'utf8');

      await fill(dir);
      const report = await resetInstall({...paths, defaultWorkspace: home});

      expect(report.failures).toEqual([]);
      expect((await readdir(space)).sort()).toEqual(['.marimo', 'essay.md']);
      expect(await readdir(join(space, '.marimo', 'lead'))).toEqual([
        'memory.md',
      ]);
      expect(await readdir(model)).toEqual(['weights.gguf']);
      expect(await readdir(home)).toEqual(['notes.md']);
    } finally {
      await rm(space, {recursive: true, force: true});
      await rm(model, {recursive: true, force: true});
      await rm(home, {recursive: true, force: true});
    }
  });

  it('reports a folder that is not there as done, not as a failure', async () => {
    /*
     * What a second reset looks like, and what the runner would see on an
     * install whose folder has not been created yet. It is not an error.
     */
    const report = await resetInstall(resolveAppPaths(join(dir, 'never')));

    expect(report).toEqual({
      userData: join(dir, 'never'),
      removed: 0,
      failures: [],
    });
  });

  it('reports a path it cannot read rather than throwing', async () => {
    /*
     * The user-data path is a file here — the shape a misconfigured
     * `MARIMO_USER_DATA_DIR` arrives in. Answering "nothing was removed" as
     * though the job were done is the failure this asserts against, and so is a
     * throw: the caller has a relaunch to decide about.
     */
    const notAFolder = join(dir, 'settings.json');
    await writeFile(notAFolder, '{}', 'utf8');

    const report = await resetInstall({...paths, userData: notAFolder});

    expect(report.removed).toBe(0);
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]?.entry).toBe(notAFolder);
  });
});
