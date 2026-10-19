/**
 * A lock that has to work between processes.
 *
 * Tested in one process, because a test cannot easily fork — but every property
 * asserted here is one that only matters *because* the callers are separate
 * processes: that a second caller waits rather than proceeding, that a task
 * which throws still releases, and that a lock left behind by a killed process
 * does not wedge the file forever.
 */
import {mkdtemp, rm, stat, utimes, writeFile} from 'node:fs/promises';
import {join} from 'node:path';

import {afterEach, beforeEach, describe, expect, it} from 'vitest';

import {FileLockTimeoutError, withFileLock} from './lock.js';

describe('withFileLock', () => {
  let dir: string;
  let lock: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(process.cwd(), '.marimo-lock-'));
    lock = join(dir, 'jobs.json.lock');
  });

  afterEach(async () => {
    await rm(dir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 20,
    });
  });

  /** A sleep that records how long it was asked to wait, without waiting. */
  function instantSleep(): {
    sleep: (ms: number) => Promise<void>;
    waits: number[];
  } {
    const waits: number[] = [];
    return {
      waits,
      sleep: async (ms: number) => {
        waits.push(ms);
      },
    };
  }

  it('runs the task and answers with what it returned', async () => {
    await expect(withFileLock(lock, async () => 'done')).resolves.toBe('done');
  });

  it('leaves no lock behind afterwards', async () => {
    await withFileLock(lock, async () => undefined);
    await expect(stat(lock)).rejects.toThrow();
  });

  /*
   * A store reports a bad document by throwing, so this is the ordinary path
   * rather than an exceptional one. A lock left behind would wedge every later
   * caller until the staleness window passed — turning one corrupt file into
   * several seconds of a stalled app.
   */
  it('releases when the task throws, and passes the throw on', async () => {
    await expect(
      withFileLock(lock, async () => {
        throw new Error('a corrupt document');
      }),
    ).rejects.toThrow('a corrupt document');

    await expect(stat(lock)).rejects.toThrow();
  });

  it('serialises callers that arrive together', async () => {
    const order: string[] = [];

    const first = withFileLock(lock, async () => {
      order.push('first-in');
      await new Promise((resolve) => setTimeout(resolve, 30));
      order.push('first-out');
    });
    // Given a moment to take the lock before the second asks for it.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = withFileLock(lock, async () => {
      order.push('second-in');
    });

    await Promise.all([first, second]);

    // Never interleaved: the second starts only after the first has finished.
    expect(order).toEqual(['first-in', 'first-out', 'second-in']);
  });

  /*
   * The case a killed process leaves: a lock file with nothing behind it. If it
   * were respected forever, one crash would stop every scheduled job until
   * somebody found and deleted a file they have never heard of.
   */
  it('takes over a lock left behind by a process that is gone', async () => {
    await writeFile(lock, '', 'utf8');
    // Backdated past the staleness window, the way an abandoned lock looks.
    const long = new Date(Date.now() - 60_000);
    await utimes(lock, long, long);

    await expect(withFileLock(lock, async () => 'taken')).resolves.toBe(
      'taken',
    );
  });

  it('does not take over a lock that is still fresh', async () => {
    const {sleep} = instantSleep();
    await writeFile(lock, '', 'utf8');

    await expect(
      withFileLock(lock, async () => 'never', {
        timeoutMs: 0,
        sleep,
      }),
    ).rejects.toBeInstanceOf(FileLockTimeoutError);
  });

  /*
   * A caller that cannot get the lock has to decide something — try later, skip
   * this look — and it cannot decide well from a silent hang.
   */
  it('gives up rather than waiting forever', async () => {
    const {sleep, waits} = instantSleep();
    await writeFile(lock, '', 'utf8');

    await expect(
      withFileLock(lock, async () => undefined, {timeoutMs: 100, sleep}),
    ).rejects.toThrow(/another copy of Marimo Bot/iu);

    // And it waited, rather than giving up on the first refusal.
    expect(waits.length).toBeGreaterThan(0);
  });

  it('names the file it could not lock, for whoever has to look', async () => {
    const {sleep} = instantSleep();
    await writeFile(lock, '', 'utf8');

    await expect(
      withFileLock(lock, async () => undefined, {timeoutMs: 0, sleep}),
    ).rejects.toThrow(lock);
  });

  it('creates the directory the lock lives in', async () => {
    const nested = join(dir, 'deeper', 'still', 'file.lock');
    await expect(withFileLock(nested, async () => 'ok')).resolves.toBe('ok');
  });
});
