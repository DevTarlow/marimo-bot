/**
 * The offline replay: reading recorded trees and reporting what other settings
 * would have done.
 *
 * `@marimo/agent`'s `replay.ts` holds the simulation and is pure. This is the
 * half that touches a disk — it loads the logs, calls the simulator once per
 * candidate setting, and lines the results up so a person can compare them. The
 * split is the same one the recorder has, and for the same reason: the policy
 * arithmetic has to be importable by the live turn and the window, and neither of
 * those should be able to reach a filesystem through it.
 *
 * **No model is called and no tool is run.** Every number in the report comes
 * from a tree that is already on disk. That is the whole point of the feature and
 * it is worth restating here, at the layer where somebody might be tempted: the
 * cheap version of this report would be to re-run the turns against the engine
 * with different settings, and it would cost minutes per setting, need the model
 * downloaded and a GPU, and answer a *different* question — what the model does
 * when it is asked again — rather than the one being asked, which is what a
 * controller would have done to the work already done.
 *
 * ## The one thing this reports and one thing it refuses to
 *
 * It reports what a setting would have **withheld**: which actions would have
 * come off the menu, how many steps that saves, and how much of the turn's
 * observed reward survives. All three are counts and sums over the log.
 *
 * It refuses to report an **outcome**. A turn's answer depends on the results of
 * the steps it took, and a policy that withholds a step changes what the model
 * sees next — so the recorded continuation is the one that happened under the
 * *old* setting. The report says so in its own text rather than leaving a reader
 * to assume the numbers are a prediction, because a simulated improvement that
 * nobody qualified is exactly the kind of result this feature should not produce.
 */
import type {DreamTree, SearchPolicySettings} from '@marimo/protocol';

import {
  baselineOf,
  describeReport,
  replayTrees,
} from '@marimo/agent';
import type {ReplayReport} from '@marimo/agent';

import type {DreamStore} from './dream-store.js';
import {FeedbackStore} from './feedback.js';

/**
 * One setting as it would have performed across every recorded turn.
 *
 * `report.totals` is per-setting already; this adds the two comparisons that only
 * make sense against the others in a sweep — how it ranks, and whether it is the
 * settings the log was actually recorded under.
 */
export interface DreamSweepRow {
  settings: SearchPolicySettings;
  report: ReplayReport;
  /**
   * Whether this is the setting the turns ran under.
   *
   * The row worth finding first in any output: every other row is a hypothetical,
   * and this one is the measurement that says the replay agrees with reality. A
   * replay whose baseline row does not reproduce the observed step count has a
   * bug, and being able to see that at a glance is why the row is labelled.
   */
  baseline: boolean;
}

export interface DreamSweep {
  rows: DreamSweepRow[];
  /** How many trees were read, and from how many conversations. */
  loaded: {sessions: number; turns: number};
  /**
   * Settings the log was recorded under, when every turn agrees.
   *
   * Absent when the log holds turns recorded under different settings, which is
   * what a user who moved a slider mid-conversation produces. The report then
   * says nothing is marked as a baseline rather than picking one turn's weights
   * and calling it the control.
   */
  baseline?: SearchPolicySettings;
  /** Anything the logs could not be read for, in the order they were found. */
  problems: string[];
  /** The settings that withheld least while keeping the most return. */
  best?: SearchPolicySettings;
}

export interface DreamReplayOptions {
  store: DreamStore;
  /**
   * The settings to simulate.
   *
   * Supplied by the caller rather than defaulted here, because the interesting
   * sweep is almost always the stored settings plus a few variations, and a
   * default would be a second opinion about what is worth trying. The CLI builds
   * the grid; this runs it.
   */
  candidates: readonly SearchPolicySettings[];
  /** Restrict the replay to one conversation. */
  sessionId?: string;
  /**
   * The feedback document, when the caller has one.
   *
   * A path rather than a list of entries because it is a document this store's
   * sibling owns, and a caller that had to parse it would be a second reader of
   * the same file — the shape that lets one of them decide a corrupt document is
   * empty and the other decide it is an error. Absent means the replay reports
   * the log without the user's marks, which is what a run against a checkout
   * that has never used the feature should look like.
   */
  feedbackFile?: string;
}

/**
 * Replays every recorded conversation under every candidate setting.
 *
 * Reads once and simulates many times, which is the shape that makes the whole
 * thing cheap: loading the logs is the only I/O, and it happens once no matter
 * how many settings are compared.
 */
export async function sweepDreamTrees(
  options: DreamReplayOptions,
): Promise<DreamSweep> {
  const loaded =
    options.sessionId === undefined
      ? await options.store.loadAll()
      : [await options.store.load(options.sessionId)];

  const problems = loaded
    .map((entry) => entry.problem)
    .filter((problem): problem is string => problem !== undefined);

  const trees: DreamTree[] = [];
  for (const entry of loaded) {
    trees.push(...entry.trees.filter((tree) => !isAbandoned(tree)));
  }

  /*
   * What the user said about the answers those turns gave.
   *
   * Only entries that name an invocation can be joined: a tree has no message id,
   * so a correction recorded before the window sent the turn is reported as
   * missing rather than guessed at from a timestamp or an excerpt. A feedback
   * document from a newer build is the one read that is *refused* — `load` throws
   * for it — and the sentence goes into the report beside the trees' own
   * problems, because a replay that silently dropped the marks would present a
   * smaller sample as the whole one.
   */
  const markedWrong = new Set<string>();
  if (options.feedbackFile !== undefined) {
    try {
      const feedback = await new FeedbackStore({
        file: options.feedbackFile,
      }).load();
      for (const entry of feedback.entries) {
        if (entry.invocationId !== undefined) {
          markedWrong.add(entry.invocationId);
        }
      }
    } catch (error) {
      problems.push(
        `feedback.json could not be read (${
          error instanceof Error ? error.message : String(error)
        }), so no turn is marked wrong in this report.`,
      );
    }
  }

  const baseline = baselineOf(trees);
  const rows: DreamSweepRow[] = options.candidates.map((settings) => ({
    settings,
    report: replayTrees(trees, settings, markedWrong),
    baseline: baseline !== undefined && sameSettings(baseline, settings),
  }));
  const best = pickBest(rows);

  return {
    rows,
    loaded: {
      sessions: loaded.filter((entry) => entry.trees.length > 0).length,
      turns: trees.length,
    },
    ...(baseline === undefined ? {} : {baseline}),
    problems,
    ...(best === undefined ? {} : {best}),
  };
}

/**
 * Whether a tree should be left out of the replay entirely.
 *
 * A turn with no calls at all, and a turn still marked `'open'`. The first
 * measures nothing — there was no decision to make — and including it would put a
 * zero into every average. The second is a turn whose process died or whose
 * recording was interrupted, and its tree is a prefix: replaying a prefix would
 * report that a setting withheld the steps the turn never got to take, which is
 * the one way this report can be actively misleading.
 */
function isAbandoned(tree: DreamTree): boolean {
  if (tree.outcome === 'open') {
    return true;
  }
  return !tree.nodes.some((node) => node.kind === 'propose');
}

/**
 * The setting worth trying next.
 *
 * Ranked by estimated return, and then by three tie-breaks that all point the
 * same way — toward the least intrusive setting that achieves the result:
 *
 *   1. **More return wins.** The only measurement here.
 *   2. **The baseline wins a tie.** A sweep almost always contains the settings
 *      the turns actually ran under, and recommending a change that changes
 *      nothing measurable is how a user learns to ignore the recommendation.
 *   3. **Then the lower threshold, then the lower exploration weight.** Among
 *      settings that measure identically, the one that took fewer liberties with
 *      the agent's menu is the safer thing to suggest on evidence that cannot
 *      distinguish them.
 *
 * The ordering matters and it is the opposite of the obvious one. Ranking by
 * aggressiveness — most withheld wins — would recommend the setting most likely
 * to be quietly wrong, using a metric that cannot tell "saved a wasted step" from
 * "hid a tool the turn needed".
 *
 * Refuses to name a best setting when the sweep has nothing to compare: one
 * candidate is not a comparison, and naming it "best" would read as a finding.
 * Neither is a grid of candidates over zero replayed turns — every row then
 * scores an estimated return of nothing, and the ranking would hand back
 * whichever setting happened to be first in the list.
 */
function pickBest(
  rows: readonly DreamSweepRow[],
): SearchPolicySettings | undefined {
  if (rows.length < 2) {
    return undefined;
  }
  if (!rows.some((row) => row.report.totals.turns > 0)) {
    return undefined;
  }
  const ranked = [...rows].sort((left, right) => {
    const byReturn =
      right.report.totals.estimatedReturn - left.report.totals.estimatedReturn;
    if (byReturn !== 0) {
      return byReturn;
    }
    if (left.baseline !== right.baseline) {
      return left.baseline ? -1 : 1;
    }
    const byPruning =
      left.settings.pruningThreshold - right.settings.pruningThreshold;
    if (byPruning !== 0) {
      return byPruning;
    }
    return left.settings.explorationWeight - right.settings.explorationWeight;
  });
  return ranked[0]?.settings;
}

function sameSettings(
  left: SearchPolicySettings,
  right: SearchPolicySettings,
): boolean {
  return (
    left.explorationWeight === right.explorationWeight &&
    left.pruningThreshold === right.pruningThreshold
  );
}

/**
 * The whole report as text, for a terminal.
 *
 * Written here rather than in the CLI so that the wording that keeps the numbers
 * honest lives beside the code that computed them. The two paragraphs at the end
 * are not decoration: they are the boundary of what an offline replay can claim,
 * and a reader who scrolls past a table of numbers will still read the sentence
 * that says what the numbers are not.
 */
export function renderSweep(sweep: DreamSweep): string {
  const lines: string[] = [];
  lines.push(
    `Read ${sweep.loaded.turns} turn(s) from ${sweep.loaded.sessions} conversation(s).`,
  );

  for (const problem of sweep.problems) {
    lines.push(`  ! ${problem}`);
  }

  if (sweep.loaded.turns === 0) {
    lines.push('');
    lines.push(
      'Nothing to replay. Turn Dream-RSI on in Settings and run a few turns ' +
        'first — the replay reads what the bot actually did, and there is no ' +
        'way to simulate a turn that was never recorded.',
    );
    return lines.join('\n');
  }

  if (sweep.baseline === undefined) {
    lines.push(
      'These turns were recorded under different settings, so no row is marked ' +
        'as the baseline. That is what moving a slider mid-conversation ' +
        'produces, and comparing against an average of two controls would be ' +
        'comparing against nothing.',
    );
  } else {
    lines.push(
      `Recorded under: exploration ${sweep.baseline.explorationWeight}, ` +
        `pruning ${sweep.baseline.pruningThreshold}.`,
    );
  }

  lines.push('');
  for (const row of sweep.rows) {
    const marker = row.baseline ? '*' : ' ';
    lines.push(`${marker} ${describeReport(row.report)}`);
  }

  if (sweep.best !== undefined) {
    lines.push('');
    lines.push(
      `Most observed return: exploration ${sweep.best.explorationWeight}, ` +
        `pruning ${sweep.best.pruningThreshold}.`,
    );
  }

  lines.push('');
  lines.push(
    'What this says: "withheld" counts actions a setting would have taken off ' +
      'the menu, and "the model asked for" is how many of those the model ' +
      'actually reached for. Both are facts read out of the log.',
  );
  lines.push(
    'What it does not say: what would have happened next. The model chose each ' +
      'step from the result of the one before it, so withholding a step changes ' +
      'the conversation — and the recorded continuation is the one that happened ' +
      'under the old settings. Treat the return as "how much of the value already ' +
      'observed survives", not as a prediction.',
  );
  /* Only when the sample carries a judgement: a paragraph explaining a column
     that is not there is noise, and the log's other boundaries are already
     stated above. */
  if (sweep.rows.some((row) => row.report.totals.markedWrong > 0)) {
    lines.push(
      '"Marked wrong" is the user\'s own judgement about an answer, joined to ' +
        'the turn by its invocation. It splits the sample and does not explain ' +
        'it: an answer is usually wrong about what it said rather than about ' +
        'which tool ran, so it is counted and never used to rank a setting.',
    );
  }
  return lines.join('\n');
}
