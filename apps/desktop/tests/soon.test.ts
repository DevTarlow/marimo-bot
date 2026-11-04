/**
 * The scheduler the recall index uses, tested with no recall in it.
 *
 * Four claims, and each one is a way the index could go wrong: a burst of turns
 * becomes one pass, a call that arrives while a pass is running is not lost, a
 * pending pass can be cancelled, and one failure does not stop the key for the
 * rest of the session. Fake timers only — nothing here embeds anything.
 */
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {Soon} from '../src/main/soon.js';

describe('the debounced scheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs once for a burst of calls, after the quiet period', async () => {
    const runs: string[] = [];
    const soon = new Soon({
      delayMs: 1_000,
      run: async (key) => {
        runs.push(key);
      },
    });

    soon.soon('one');
    await vi.advanceTimersByTimeAsync(600);
    soon.soon('one');
    await vi.advanceTimersByTimeAsync(600);
    expect(runs).toEqual([]);

    await vi.advanceTimersByTimeAsync(400);
    expect(runs).toEqual(['one']);
  });

  it('keeps separate keys separate', async () => {
    const runs: string[] = [];
    const soon = new Soon({
      delayMs: 1_000,
      run: async (key) => {
        runs.push(key);
      },
    });

    soon.soon('one');
    soon.soon('two');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(runs.sort()).toEqual(['one', 'two']);
  });

  it('runs exactly one follow-up when asked during a pass', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runs: string[] = [];
    const soon = new Soon({
      delayMs: 1_000,
      run: async (key) => {
        runs.push(key);
        await gate;
      },
    });

    soon.soon('one');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(runs).toEqual(['one']);

    // Asked for twice while the first pass is still writing.
    soon.soon('one');
    await vi.advanceTimersByTimeAsync(1_000);
    soon.soon('one');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(runs).toEqual(['one']);

    release();
    await vi.runAllTimersAsync();
    expect(runs).toEqual(['one', 'one']);
  });

  it('drops a pending run when one key is cancelled', async () => {
    const runs: string[] = [];
    const soon = new Soon({
      delayMs: 1_000,
      run: async (key) => {
        runs.push(key);
      },
    });

    soon.soon('one');
    soon.cancel('one');
    await vi.runAllTimersAsync();
    expect(runs).toEqual([]);
  });

  it('drops every pending run when everything is cancelled', async () => {
    const runs: string[] = [];
    const soon = new Soon({
      delayMs: 1_000,
      run: async (key) => {
        runs.push(key);
      },
    });

    soon.soon('one');
    soon.soon('two');
    soon.cancelAll();
    await vi.runAllTimersAsync();
    expect(runs).toEqual([]);
  });

  it('does not latch on a failure', async () => {
    let calls = 0;
    const soon = new Soon({
      delayMs: 1_000,
      run: async () => {
        calls += 1;
        if (calls === 1) {
          throw new Error('the first pass failed');
        }
      },
    });

    soon.soon('one');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls).toBe(1);

    soon.soon('one');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls).toBe(2);
  });
});
