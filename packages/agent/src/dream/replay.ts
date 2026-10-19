/**
 * Replaying a recorded turn to find out what different settings would have done.
 *
 * This is the paper's central idea in the smallest form that is honest about it:
 * a recorded discovery tree is a simulator of the search space that was actually
 * explored, so a policy can be evaluated against it without running the model
 * again. Every tool call in the log already happened and already has a reward;
 * what a replay changes is only the *decision*, and it recomputes those from the
 * same `SearchPolicy` the live turn uses. No model is called, no tool is run, and
 * no file is read beyond the log — which is what makes trying twenty settings
 * cheap enough to actually do.
 *
 * ## What it can and cannot tell you
 *
 * It is worth being exact, because a simulator believed beyond its evidence is
 * worse than no simulator.
 *
 * **It can tell you what a setting would have withheld.** The offered set is
 * recorded per step, so the replay knows exactly which actions a threshold would
 * have removed from the menu, and how much of the turn's budget they consumed.
 * This is a fact about the log, not an extrapolation.
 *
 * **It can tell you how many steps a setting saves.** Actions a setting would
 * have pruned were actions the model spent a step proposing, and the count of
 * those is in the log.
 *
 * **It cannot tell you what would have happened next.** The model's choice on the
 * next step depended on the result of the step it just took; withholding a step
 * changes the conversation, and the recorded continuation is the one that
 * happened under the *old* policy. So the replay does not claim a counterfactual
 * outcome, and it does not invent one. A policy that withholds a call the model
 * needed looks like a policy that saved a step.
 *
 * **It cannot tell you a reward it did not observe.** Rewards are folded from the
 * calls in the log; an action a candidate policy would have taken instead has no
 * recorded reward, and the replay does not guess one. Actions that were never run
 * keep their neutral "untried" statistics, which is the same state the live policy
 * would have been in — but the *reward* they would have earned is genuinely
 * unknown, and that is the boundary of what an offline replay can say.
 *
 * These three limits are the honest shape of "off-policy evaluation from
 * historical trees", and the report they produce is written so a reader cannot
 * mistake one for the other. The estimated-return figure is labelled an estimate
 * and computed only from observed rewards.
 */
import type {DreamTree} from '@marimo/protocol';

import {SearchPolicy} from './search.js';
import type {ActionStat, SearchPolicySettings} from './search.js';
import type {RecordedStep, RecordedTurn} from './tree-stats.js';
import {statsBefore, stepsOf} from './tree-stats.js';

/**
 * What a withheld call is worth, and it must equal what the live policy scores
 * one — `REWARD_VALUES[REWARD_REASONS.withheld]` in `reward.ts`, which is `-1`.
 *
 * Duplicated as a constant rather than imported, because importing the reward
 * module here would pull `describeResult` and the whole result-shaping half of
 * the recorder into the simulator for the sake of one number. The test that
 * pins it — "a replay scores a withheld call exactly as the live policy does" —
 * is what keeps the two from drifting, and it is a better guard than a shared
 * import would be: it fails on the *value*, at the moment somebody changes it.
 */
const WITHHELD_REWARD = -1;

/**
 * What one setting would have done to one turn.
 *
 * Everything here is a count from the log or an average over rewards the log
 * actually contains. There is no modelled quantity and nothing projected forward.
 */
export interface ReplayTurnResult {
  invocationId: string;
  sessionId: string;
  /** Steps the turn actually took, under the settings it ran with. */
  observedSteps: number;
  /** Steps this setting would have taken. Never more than observed. */
  replayedSteps: number;
  /**
   * Actions the policy would have taken out of the menu.
   *
   * Counted per step, so a tool withheld on three steps counts three times —
   * which is the number that means "how many times did the model not get to ask",
   * rather than "how many distinct tools were involved".
   */
  withheld: number;
  /** Of those, how many the model actually proposed and was refused at the time. */
  withheldThatWereProposed: number;
  /** Which tools were withheld, by name, for a reader who wants to see them. */
  withheldTools: string[];
  /**
   * The user said this turn's answer was wrong.
   *
   * The only outcome in the report, and it is not inferred: it is read from the
   * feedback document for this invocation. That makes it the one axis a replay
   * can split its sample by without pretending to know what would have happened.
   * It explains nothing on its own — a wrong answer is usually wrong about
   * content, not about which tool ran — so the report counts it rather than
   * ranking by it.
   */
  markedWrong?: boolean;
  /**
   * Mean observed reward over the calls this setting would have allowed.
   *
   * `undefined` when it would have allowed none — a real possibility at a
   * threshold of `1`, and the reason this is not a zero. Zero is a number a
   * reader would compare against other settings; absent is the truth.
   */
  meanReward?: number;
  /**
   * Summed observed reward, which is what ranks two settings against each other.
   *
   * Deliberately not divided by the steps taken to produce a "reward per step".
   * Every action it counts did happen in the real turn, so the sum measures how
   * much of the turn's *observed* value a setting would have kept. A ratio would
   * flatter a setting that withheld a great deal, which is exactly the failure
   * mode a user needs to see rather than have smoothed away.
   */
  estimatedReturn: number;
}

/** What one setting would have done across every recorded turn. */
export interface ReplayReport {
  /** The settings being simulated, so a report is readable on its own. */
  settings: SearchPolicySettings;
  turns: ReplayTurnResult[];
  totals: {
    turns: number;
    observedSteps: number;
    replayedSteps: number;
    withheld: number;
    withheldThatWereProposed: number;
    estimatedReturn: number;
    meanReward?: number;
    /**
     * Turns in the sample the user said were wrong.
     *
     * Counted rather than scored: a turn judged wrong is not a turn that deserved
     * less reward, and folding it into the return would let one person's opinion
     * about an answer move a policy that is about tool choice.
     */
    markedWrong: number;
    /**
     * Of the withheld actions, how many were on those turns.
     *
     * The number worth reading next to `withheld`: a setting that takes calls off
     * the menu mostly on turns that went wrong is a different proposition from one
     * that does it evenly, and this is the split that makes that visible without
     * claiming the withholding was the cause.
     */
    withheldOnMarkedWrong: number;
  };
  /**
   * The settings the turns actually ran under, when the log agrees on one.
   *
   * `undefined` when the log holds turns recorded under different settings — a
   * user who moved a slider mid-conversation — because averaging two controls
   * into one baseline would make every comparison against it meaningless. The
   * report says so rather than picking one.
   */
  baseline?: SearchPolicySettings;
}

/**
 * Replays one recorded turn under one set of settings.
 *
 * The walk is the turn's own steps in order, and the decision at each step is
 * made from the statistics of the steps *before* it — never including the step
 * being decided. That exclusion is the difference between a simulation and a
 * lookup: a policy shown the reward of the call it is deciding about would reject
 * every call that turned out badly and look perfect doing it.
 */
export function replayTurn(
  turn: RecordedTurn,
  settings: SearchPolicySettings,
  markedWrong = false,
): ReplayTurnResult {
  const policy = new SearchPolicy(settings);
  const steps = turn.steps;
  const withheldTools: string[] = [];
  let withheld = 0;
  let withheldThatWereProposed = 0;
  let estimatedReturn = 0;
  let allowed = 0;
  /**
   * Actions this replay has itself withheld, and how often.
   *
   * Folded into the history for the *later* steps, and without this the whole
   * threshold does nothing on the actions it matters most for. A withheld call
   * does not run, so it earns no reward, so the action keeps the "untried"
   * statistics that `SearchPolicy` never prunes — and a tool that is withheld at
   * every step is withheld at every step, forever, while the report claims it was
   * pruned. The live policy does not have that hole: a refusal is counted as an
   * attempt with a `-1` reward, which is how the controller learns to stop
   * offering it.
   *
   * The value matches the live one exactly — see `refusalReward` — so a replay
   * and a turn cannot disagree about what a withheld call cost.
   */
  const withheldSoFar = new Map<string, number>();

  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index] as RecordedStep;
    const history = statsBefore(steps, index);
    const stats = candidateStats(step, history, withheldSoFar);

    /*
     * The field is narrowed with the same `rank` call the live plugin uses, so
     * "what would be offered" is answered by the shipped implementation rather
     * than by a re-derivation of its rules.
     */
    const kept = new Set(policy.rank(stats).map((stat) => stat.action));
    for (const candidate of step.candidates) {
      if (!kept.has(candidate)) {
        withheld += 1;
        withheldTools.push(candidate);
        if (candidate === step.chosen) {
          withheldThatWereProposed += 1;
        }
        /*
         * Counted against the action only when the model actually reached for it,
         * which is the same rule the live plugin follows: the menu shrinking is
         * not something the model did, and scoring every pruned tool on every step
         * as a failure would drive the whole tool set negative in one turn.
         */
        if (candidate === step.chosen) {
          withheldSoFar.set(candidate, (withheldSoFar.get(candidate) ?? 0) + 1);
        }
      }
    }

    /*
     * A step whose chosen action survives still happened, and its reward is the
     * reward the log recorded for it. A step whose action was withheld did not
     * happen, contributes nothing, and — this is the part that matters — is not
     * counted as a step taken.
     */
    const ran = step.ran && step.chosen !== undefined && kept.has(step.chosen);
    if (ran) {
      allowed += 1;
      estimatedReturn += step.reward?.value ?? 0;
    }
  }

  return {
    invocationId: turn.invocationId,
    sessionId: turn.sessionId,
    observedSteps: steps.length,
    replayedSteps: allowed,
    withheld,
    withheldThatWereProposed,
    withheldTools,
    ...(allowed === 0 ? {} : {meanReward: estimatedReturn / allowed}),
    estimatedReturn,
    ...(markedWrong ? {markedWrong: true} : {}),
  };
}

/**
 * The statistics one step's decision is made from.
 *
 * Only what happened *before* this step, plus an entry for every action with no
 * history at all. The step's own attempt is deliberately not folded in, and the
 * reason is the whole honesty of a replay: at the moment a call is decided, its
 * result does not exist yet. A version that counted it would withhold the very
 * call it just watched fail — which reads as a thriftier policy and is in fact a
 * policy with knowledge of the future. This is the offline equivalent of
 * look-ahead bias, and it is invisible in the output because every number it
 * produces is a real number.
 *
 * So a tool's first bad call is always spent, in the replay and in life. What the
 * bad call buys is the evidence that decides the *second* one.
 */
function candidateStats(
  step: RecordedStep,
  history: readonly ActionStat[],
  withheldSoFar: ReadonlyMap<string, number>,
): ActionStat[] {
  const byAction = new Map(history.map((stat) => [stat.action, stat]));
  const actions = new Set([
    ...step.candidates,
    ...byAction.keys(),
    ...withheldSoFar.keys(),
  ]);

  return [...actions].map((action): ActionStat => {
    const known = byAction.get(action);
    const withheld = withheldSoFar.get(action) ?? 0;
    if (known === undefined) {
      return {
        action,
        visits: 0,
        meanReward: 0,
        attempts: withheld,
      };
    }
    if (withheld === 0) {
      return known;
    }
    /*
     * The withheld attempts folded in at the value a refusal carries live, as
     * visits *and* attempts: a refusal is evidence about the action, and evidence
     * is what a threshold acts on. A mean is recomputed from the running total
     * rather than taken of a mean, which drifts fastest on exactly the short
     * histories one turn produces.
     */
    const visits = known.visits + withheld;
    return {
      action,
      visits,
      meanReward:
        (known.meanReward * known.visits + withheld * WITHHELD_REWARD) / visits,
      attempts: known.attempts + withheld,
    };
  });
}

/**
 * Replays every turn in a log under one set of settings.
 *
 * `markedWrong` is the set of invocations the user judged wrong, and it is the
 * only input here that did not come out of the recorded turn. It is passed in
 * rather than read, because the simulator must stay importable by the live turn
 * and by tests that have no feedback document — and because the mark is a fact
 * about a *different* record, which this function has no business opening.
 */
export function replayTrees(
  trees: readonly DreamTree[],
  settings: SearchPolicySettings,
  markedWrong: ReadonlySet<string> = new Set(),
): ReplayReport {
  const results: ReplayTurnResult[] = [];
  for (const tree of trees) {
    const steps = stepsOf(tree);
    // A turn that called nothing has no decision to replay and would divide
    // every average it entered by nothing.
    if (steps.length === 0) {
      continue;
    }
    results.push(
      replayTurn(
        {
          sessionId: tree.sessionId,
          invocationId: tree.invocationId,
          policy: tree.policy,
          outcome: tree.outcome,
          steps,
        },
        settings,
        markedWrong.has(tree.invocationId),
      ),
    );
  }

  return {settings, turns: results, totals: totalsOf(results)};
}

function totalsOf(turns: readonly ReplayTurnResult[]): ReplayReport['totals'] {
  let observedSteps = 0;
  let replayedSteps = 0;
  let withheld = 0;
  let withheldThatWereProposed = 0;
  let estimatedReturn = 0;
  let markedWrong = 0;
  let withheldOnMarkedWrong = 0;

  for (const turn of turns) {
    observedSteps += turn.observedSteps;
    replayedSteps += turn.replayedSteps;
    withheld += turn.withheld;
    withheldThatWereProposed += turn.withheldThatWereProposed;
    estimatedReturn += turn.estimatedReturn;
    if (turn.markedWrong === true) {
      markedWrong += 1;
      withheldOnMarkedWrong += turn.withheld;
    }
  }

  return {
    turns: turns.length,
    observedSteps,
    replayedSteps,
    withheld,
    withheldThatWereProposed,
    estimatedReturn,
    markedWrong,
    withheldOnMarkedWrong,
    ...(replayedSteps === 0
      ? {}
      : {meanReward: estimatedReturn / replayedSteps}),
  };
}

/**
 * The settings a log was recorded under, when every turn agrees.
 *
 * Returns `undefined` rather than a majority or a mean when they disagree. A
 * baseline is what the report compares candidates *against*, and a baseline that
 * is an average of two controls is a number no turn ever ran with — which would
 * make the comparison look precise while being about nothing.
 */
export function baselineOf(
  trees: readonly DreamTree[],
): SearchPolicySettings | undefined {
  let baseline: SearchPolicySettings | undefined;
  for (const tree of trees) {
    const settings = {
      explorationWeight: tree.policy.explorationWeight,
      pruningThreshold: tree.policy.pruningThreshold,
    };
    if (baseline === undefined) {
      baseline = settings;
      continue;
    }
    if (
      baseline.explorationWeight !== settings.explorationWeight ||
      baseline.pruningThreshold !== settings.pruningThreshold
    ) {
      return undefined;
    }
  }
  return baseline;
}

/**
 * The one-line summary of a report, for a terminal.
 *
 * Here rather than in the CLI because the arithmetic that makes it honest belongs
 * beside the replay that produced the numbers: "withheld 12" means something
 * different from "withheld 12, of which 9 the model actually asked for", and a
 * formatter free to print the first without the second is a formatter that will.
 */
export function describeReport(report: ReplayReport): string {
  const {totals} = report;
  const parts = [
    `w=${report.settings.explorationWeight}`,
    `prune=${report.settings.pruningThreshold}`,
    `${totals.turns} turn(s)`,
    `steps ${totals.replayedSteps}/${totals.observedSteps}`,
    `withheld ${totals.withheld}` +
      (totals.withheldThatWereProposed > 0
        ? ` (${totals.withheldThatWereProposed} the model asked for)`
        : ''),
    `return ${totals.estimatedReturn.toFixed(2)}`,
    totals.meanReward === undefined
      ? 'no calls allowed'
      : `mean ${totals.meanReward.toFixed(2)}`,
    /* Only when somebody has said something, because "0 marked wrong" on a log
       nobody has judged would read as a verdict rather than as no data. */
    ...(totals.markedWrong === 0
      ? []
      : [
          `${totals.markedWrong} marked wrong` +
            (totals.withheldOnMarkedWrong > 0
              ? ` (${totals.withheldOnMarkedWrong} withheld there)`
              : ''),
        ]),
  ];
  return parts.join('  ');
}
