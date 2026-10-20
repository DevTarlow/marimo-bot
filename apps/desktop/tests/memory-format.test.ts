/**
 * How the memory size control reads.
 *
 * The formatting is not cosmetic here. The slider is labelled in kilobytes and
 * the readout counts bytes, so a formatter that rounds the wrong way makes the
 * two halves of one control disagree — "8.0 KB" under a slider sitting on 8 KB
 * is the sort of thing that reads as a bug in the number rather than as a style
 * choice. The states are pinned for the same reason: `over` is the line the
 * agent is warned at, and a sentence that said "room to spare" while the agent
 * was being told to prune would be actively misleading.
 */
import {describe, expect, it} from 'vitest';

import {
  formatKiB,
  summarizeDismissed,
  summarizeMemory,
} from '../src/renderer/memory-format.js';

const LIMIT = 8 * 1024;

describe('formatKiB', () => {
  it('writes whole kilobytes without a decimal', () => {
    expect(formatKiB(8 * 1024)).toBe('8 KB');
  });

  it('keeps one decimal where the size is fractional', () => {
    expect(formatKiB(8.5 * 1024)).toBe('8.5 KB');
  });

  /*
   * A fresh memory file is a few hundred bytes. Rounding that to "0 KB" would
   * read as a broken readout rather than as an empty file.
   */
  it('counts bytes below a kilobyte', () => {
    expect(formatKiB(0)).toBe('0 bytes');
    expect(formatKiB(512)).toBe('512 bytes');
    expect(formatKiB(1023)).toBe('1023 bytes');
  });
});

describe('summarizeMemory', () => {
  it('says nothing is remembered yet for an empty file', () => {
    const summary = summarizeMemory({
      bytes: 0,
      limitBytes: LIMIT,
      capBytes: 64 * 1024,
      reviewEvents: 40,
    });
    expect(summary.pressure).toBe('empty');
    expect(summary.size).toBe('0 bytes of 8 KB used');
    expect(summary.percent).toBe(0);
  });

  it('describes a file with room left', () => {
    const summary = summarizeMemory({
      bytes: 2048,
      limitBytes: LIMIT,
      capBytes: 64 * 1024,
      reviewEvents: 40,
    });
    expect(summary.pressure).toBe('room');
    expect(summary.size).toBe('2 KB of 8 KB used');
    expect(summary.percent).toBe(25);
  });

  /*
   * Exactly at the limit is not over it, which is the same boundary the agent's
   * warning uses. Getting this wrong here would show the user a warning state one
   * byte before the agent had anything to say.
   */
  it('is not over at exactly the limit', () => {
    const summary = summarizeMemory({
      bytes: LIMIT,
      limitBytes: LIMIT,
      capBytes: 64 * 1024,
      reviewEvents: 40,
    });
    expect(summary.pressure).toBe('room');
    expect(summary.percent).toBe(100);
  });

  it('is over one byte past the limit, and says the agent is pruning', () => {
    const summary = summarizeMemory({
      bytes: LIMIT + 1,
      limitBytes: LIMIT,
      capBytes: 64 * 1024,
      reviewEvents: 40,
    });
    expect(summary.pressure).toBe('over');
    expect(summary.detail).toContain('prune');
  });

  /*
   * The bar is drawn from a percentage, and a memory over the hard cap would
   * otherwise paint past the end of its own track.
   */
  it('never reports a percentage above one hundred', () => {
    const summary = summarizeMemory({
      bytes: 64 * 1024,
      limitBytes: LIMIT,
      capBytes: 64 * 1024,
      reviewEvents: 40,
    });
    expect(summary.pressure).toBe('over');
    expect(summary.percent).toBe(100);
  });
});

/*
 * The refusals and removals, which are the part of the memory panel that only
 * appears after a user has decided something — so the case that has to hold is
 * the one where there is nothing to draw.
 */
describe('summarizeDismissed', () => {
  it('draws nothing at all when nothing has been refused', () => {
    const summary = summarizeDismissed(0);
    expect(summary.heading).toBeUndefined();
    expect(summary.count).toBe('');
  });

  /*
   * One is the state a user reaches first, and the one most likely to be read —
   * "1 suggestions" is the kind of sentence that makes a panel look unfinished.
   */
  it('says one refusal in the singular', () => {
    const summary = summarizeDismissed(1);
    expect(summary.heading).toBeDefined();
    expect(summary.count).toBe('One fact will stay forgotten.');
  });

  it('counts many', () => {
    expect(summarizeDismissed(4).count).toBe('4 facts will stay forgotten.');
  });

  /*
   * A negative length is not a thing React can pass, but a count that came from
   * anywhere else has to read as empty rather than as "-1 suggestions".
   */
  it('treats a nonsense count as empty rather than rendering it', () => {
    expect(summarizeDismissed(-3).heading).toBeUndefined();
  });
});
