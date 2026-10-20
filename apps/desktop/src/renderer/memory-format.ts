/**
 * What the memory size control says.
 *
 * Kept out of the component because it is the part worth pinning: a byte count
 * is not a sentence a person can act on, and "8 KB" beside a slider labelled
 * "32 KB" is how a control comes to look broken. The formatting and the
 * judgement about which state memory is in are both pure, so they are testable
 * without a window.
 */
import type {MemoryUsage} from '@marimo/protocol';

/**
 * A byte count in the unit the slider uses.
 *
 * Whole kilobytes with no trailing `.0`, because the control's steps are whole
 * kilobytes: `8 KB`, not `8.0 KB`. Below a kilobyte the decimal is kept, since a
 * new memory file is a few hundred bytes and rounding that to `0 KB` would read
 * as a bug rather than as an empty file.
 */
export function formatKiB(bytes: number): string {
  if (bytes < 1024) {
    return `${String(bytes)} bytes`;
  }
  const kib = bytes / 1024;
  return Number.isInteger(kib) ? `${String(kib)} KB` : `${kib.toFixed(1)} KB`;
}

/** Which of the three states the control is describing. */
export type MemoryPressure = 'empty' | 'room' | 'over';

export interface MemorySummary {
  pressure: MemoryPressure;
  /** The headline, e.g. `3.2 KB of 8 KB used`. */
  size: string;
  /** A sentence saying what that means and what to do about it. */
  detail: string;
  /** How full, as a percentage, for the meter. Capped at 100. */
  percent: number;
}

/**
 * Turns three numbers into the thing the user reads.
 *
 * The states are deliberately few and each says one thing. `over` is the same
 * state the agent is warned in — that correspondence is the point of showing it:
 * the user is looking at the line the agent will be told it crossed.
 */
export function summarizeMemory(usage: MemoryUsage): MemorySummary {
  const percent = Math.min(
    100,
    Math.round((usage.bytes / usage.limitBytes) * 100),
  );
  const size = `${formatKiB(usage.bytes)} of ${formatKiB(usage.limitBytes)} used`;

  if (usage.bytes === 0) {
    return {
      pressure: 'empty',
      size,
      detail:
        'Nothing remembered for this bot yet. Facts it decides are worth keeping are added here, and the whole file is shown to it at the start of every conversation.',
      percent,
    };
  }

  if (usage.bytes > usage.limitBytes) {
    return {
      pressure: 'over',
      size,
      detail:
        'Past the size you set, so the bot is being told to prune. Raise the limit or let it tidy up with prune_memory — nothing is refused until the file reaches the hard cap.',
      percent,
    };
  }

  return {
    pressure: 'room',
    size,
    detail:
      'Memory is shown to the bot at the start of every conversation, so it is worth keeping short. Past this size the bot is told to prune.',
    percent,
  };
}

export interface DismissedSummary {
  /** The count in words, e.g. `3 suggestions are being suppressed.` */
  count: string;
  /**
   * The list's heading, or `undefined` when there is nothing to draw.
   *
   * The `undefined` is the judgement this exists to pin: a fresh install has
   * nothing refused, and a heading explaining a capability nobody has reached
   * for is one more thing to read on the way to the parts that matter. The panel
   * asks this rather than testing `length > 0` itself, so the rule has one home
   * and a name in a test.
   */
  heading?: string;
}

/**
 * What to say about facts the user refused or removed.
 *
 * The count leads because it is the only part that is actionable in a glance —
 * the text is there to be checked, not read — and it is phrased as a sentence
 * rather than as a number because "3 being suppressed" is a fragment nobody
 * finishes. Singular and plural both, since one is the state a user reaches
 * first and the one most likely to be read.
 *
 * The wording covers both ways a fact gets here. A refusal is an answer to a
 * suggestion; a removal is an answer to a fact the bot wrote on its own, and
 * both end at the same place — the reviewer will not bring it up again.
 */
export function summarizeDismissed(count: number): DismissedSummary {
  if (count <= 0) {
    return {count: ''};
  }
  return {
    heading: 'What it will not bring up again',
    count:
      count === 1
        ? 'One fact will stay forgotten.'
        : `${String(count)} facts will stay forgotten.`,
  };
}
