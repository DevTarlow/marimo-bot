import {describe, expect, it} from 'vitest';

import type {DreamTree} from '@marimo/protocol';

import {TreeRecorder, type DreamSink} from './recorder.js';
import {REWARD_REASONS, rewardForResult} from './reward.js';
import {baselineOf, describeReport, replayTrees} from './replay.js';
import {stepsOf} from './tree-stats.js';

/**
 * A sink that keeps every snapshot, so a test can assert on the tree as it
 * looked at each point rather than only at the end.
 */
function collecting(): {sink: DreamSink; snapshots: DreamTree[]} {
  const snapshots: DreamTree[] = [];
  return {
    snapshots,
    sink: {
      append: (tree) => {
        snapshots.push(tree);
      },
    },
  };
}

let clock = 0;
function tick(): Date {
  clock += 1000;
  return new Date(Date.UTC(2026, 8, 14, 0, 0, 0) + clock);
}

function recorder(sink: DreamSink, resultBytes = 256): TreeRecorder {
  return new TreeRecorder(
    {
      sessionId: 'session-1',
      invocationId: 'inv-1',
      profileId: 'profile-1',
      policy: {explorationWeight: 1, pruningThreshold: -1},
    },
    sink,
    {resultBytes, now: tick},
  );
}

describe('TreeRecorder', () => {
  it('writes a turn root, a step, a proposal and a call as a chain', () => {
    const {sink, snapshots} = collecting();
    const tree = recorder(sink);
    tree.step();
    const proposal = tree.propose({tool: 'read_file', callId: 'c1', args: {}, allowed: true});
    tree.recordCall({
      proposalId: proposal,
      tool: 'read_file',
      callId: 'c1',
      result: 'hello',
      reward: rewardForResult('hello'),
    });
    tree.finish('answered');

    const final = snapshots.at(-1);
    expect(final).toBeDefined();
    const nodes = final?.nodes ?? [];
    expect(nodes.map((node) => node.kind)).toEqual([
      'turn',
      'turn',
      'propose',
      'call',
    ]);
    // The parent chain is the tree: call → proposal → step → root.
    expect(nodes[1]?.parentId).toBe(nodes[0]?.id);
    expect(nodes[2]?.parentId).toBe(nodes[1]?.id);
    expect(nodes[3]?.parentId).toBe(nodes[2]?.id);
    expect(nodes.map((node) => node.depth)).toEqual([0, 1, 2, 3]);
  });

  it('records a withheld proposal with no result and a negative reward', () => {
    const {sink, snapshots} = collecting();
    const tree = recorder(sink);
    tree.step();
    const proposal = tree.propose({tool: 'shell', callId: 'c1', allowed: false});
    tree.recordRefusal({
      proposalId: proposal,
      tool: 'shell',
      callId: 'c1',
      reward: {value: -1, reason: REWARD_REASONS.withheld},
    });
    tree.finish('answered');

    const nodes = snapshots.at(-1)?.nodes ?? [];
    const proposed = nodes.find((node) => node.kind === 'propose');
    const call = nodes.find((node) => node.kind === 'call');
    // The pair is what makes a replay possible: the proposal says the model
    // asked, the call says it did not run, and `allowed: false` is what tells
    // that apart from a call that ran and failed.
    expect(proposed?.allowed).toBe(false);
    expect(call?.result).toBe('');
    expect(call?.reward?.reason).toBe(REWARD_REASONS.withheld);
  });

  it('caps a result and says how long the whole thing was', () => {
    const {sink, snapshots} = collecting();
    const tree = recorder(sink, 10);
    tree.step();
    const proposal = tree.propose({tool: 'read_file', callId: 'c1', allowed: true});
    tree.recordCall({
      proposalId: proposal,
      tool: 'read_file',
      callId: 'c1',
      result: 'x'.repeat(100),
      reward: rewardForResult('x'.repeat(100)),
    });

    const call = snapshots
      .at(-1)
      ?.nodes.find((node) => node.kind === 'call');
    // Invisible truncation is the failure this app names explicitly for tool
    // results: the marker says it was cut, the byte count says from how much.
    expect(call?.result).toBe(`${'x'.repeat(10)}…`);
    expect(call?.resultBytes).toBe(100);
  });

  it('records an answer so a silent turn is distinguishable from one', () => {
    const {sink, snapshots} = collecting();
    const tree = recorder(sink);
    tree.step();
    tree.answer('Here is the answer.');
    tree.finish('answered');
    expect(
      snapshots.at(-1)?.nodes.some((node) => node.kind === 'answer'),
    ).toBe(true);
  });

  it('flushes on completion rather than on every node', () => {
    const {sink, snapshots} = collecting();
    const tree = recorder(sink);
    tree.step();
    tree.propose({tool: 'read_file', callId: 'c1', allowed: true});
    // A step and a proposal are halves of a decision, so nothing is written
    // yet: the snapshot on disk is never a proposal without its outcome.
    expect(snapshots).toHaveLength(0);
    expect(tree.size).toBe(3);
  });

  it('writes the offered tool set on the step', () => {
    const {sink, snapshots} = collecting();
    const tree = recorder(sink);
    tree.step();
    tree.offer(['web_search', 'read_file']);
    tree.finish('answered');
    /*
     * Found by the field rather than by kind, because a turn's root is also a
     * `turn` node — a step is a turn node with a parent, and only a step is ever
     * offered anything.
     */
    const step = snapshots
      .at(-1)
      ?.nodes.find((node) => node.offered !== undefined);
    // In the order it arrived, not sorted: the log records what the model was
    // actually offered, and every decision reads it as a set.
    expect(step?.offered).toEqual(['web_search', 'read_file']);
  });

  it('records the policy it ran under', () => {
    const {sink, snapshots} = collecting();
    const tree = recorder(sink);
    tree.finish('failed');
    expect(snapshots.at(-1)?.policy).toEqual({
      explorationWeight: 1,
      pruningThreshold: -1,
    });
    expect(snapshots.at(-1)?.outcome).toBe('failed');
  });
});

describe('rewardForResult', () => {
  it('scores a returned value positively', () => {
    expect(rewardForResult('text').value).toBe(1);
    expect(rewardForResult({result: 'text'}).value).toBe(1);
  });

  it('scores an empty answer below a real one but above a failure', () => {
    // "No files match that pattern" is a fact, not a failure — scoring it as one
    // would train the controller away from the tools that say when to stop.
    expect(rewardForResult('').value).toBe(-0.5);
    expect(rewardForResult([]).value).toBe(-0.5);
    expect(rewardForResult(null).value).toBe(-0.5);
    expect(rewardForResult('').value).toBeGreaterThan(
      rewardForResult({error: 'boom'}).value,
    );
  });

  it('scores an error as a failure even when it carries partial output', () => {
    expect(rewardForResult({error: 'boom', result: 'some of it'}).value).toBe(-1);
    expect(rewardForResult({errorMessage: 'boom'}).value).toBe(-1);
  });

  it('counts zero and false as results rather than as emptiness', () => {
    // The falsiness bug this exists to not have: a line count of zero, a grep
    // that matched nothing, a check that passed.
    expect(rewardForResult(0).value).toBe(1);
    expect(rewardForResult(false).value).toBe(1);
  });
});

/**
 * A recorded turn built by hand, so a replay test states the tree it is about
 * rather than the sequence of recorder calls that would produce it.
 */
function treeOf(options: {
  outcome?: DreamTree['outcome'];
  policy?: {explorationWeight: number; pruningThreshold: number};
  /**
   * The menu at every step.
   *
   * Explicit rather than derived, because a real log records the whole tool set
   * the model was offered — see `beforeToolSelection` — and a replay measures
   * pruning against exactly that. Deriving it from the tools the model happened
   * to touch would make these tests describe a turn in which no tool was ever
   * offered until it was used, which is not a turn this app can produce.
   */
  menu?: string[];
  steps: {
    tool: string;
    reward?: number;
    ran: boolean;
  }[];
}): DreamTree {
  const menu = options.menu ?? [];
  const nodes: DreamTree['nodes'] = [];
  let clock = 0;
  const at = (): string => {
    clock += 1;
    return new Date(Date.UTC(2026, 8, 14, 0, 0, clock)).toISOString();
  };
  const rootId = 'root';
  nodes.push({
    id: rootId,
    kind: 'turn',
    depth: 0,
    invocationId: 'inv-1',
    allowed: true,
    at: at(),
  });

  let step = 0;
  for (const entry of options.steps) {
    step += 1;
    const stepId = `step-${step}`;
    nodes.push({
      id: stepId,
      parentId: rootId,
      kind: 'turn',
      depth: 1,
      invocationId: 'inv-1',
      ...(menu.length === 0 ? {} : {offered: [...menu]}),
      allowed: true,
      at: at(),
    });
    const proposalId = `proposal-${step}`;
    nodes.push({
      id: proposalId,
      parentId: stepId,
      kind: 'propose',
      depth: 2,
      invocationId: 'inv-1',
      tool: entry.tool,
      callId: `call-${step}`,
      allowed: entry.ran,
      at: at(),
    });
    /*
     * A withheld proposal has no call node at all — the recorder writes a call
     * node for it with an empty result, but the *shape* a replay has to survive
     * is the one where the pair is incomplete, which is what a log from an
     * interrupted turn looks like.
     */
    if (!entry.ran) {
      continue;
    }
    nodes.push({
      id: `call-${step}`,
      parentId: proposalId,
      kind: 'call',
      depth: 3,
      invocationId: 'inv-1',
      tool: entry.tool,
      callId: `call-${step}`,
      result: 'ok',
      ...(entry.reward === undefined
        ? {}
        : {reward: {value: entry.reward, reason: 'test'}}),
      allowed: true,
      at: at(),
    });
  }

  return {
    version: 1,
    sessionId: 'session-1',
    invocationId: 'inv-1',
    startedAt: at(),
    outcome: options.outcome ?? 'answered',
    policy: options.policy ?? {explorationWeight: 1, pruningThreshold: -1},
    nodes,
  };
}

describe('stepsOf', () => {
  it('keeps the model order and grows the candidate set as the turn goes', () => {
    const steps = stepsOf(
      treeOf({
        steps: [
          {tool: 'read_file', reward: 1, ran: true},
          {tool: 'web_search', reward: 1, ran: true},
          {tool: 'read_file', reward: 1, ran: true},
        ],
      }),
    );
    expect(steps.map((step) => step.chosen)).toEqual([
      'read_file',
      'web_search',
      'read_file',
    ]);
    // A live controller cannot see a tool the model has not proposed yet, so a
    // replay must not either — otherwise it measures a controller with knowledge
    // the real one does not have.
    expect(steps[0]?.candidates).toEqual(['read_file']);
    expect(steps[1]?.candidates).toEqual(['read_file', 'web_search']);
  });

  it('marks a withheld proposal as not run and carries no reward', () => {
    const steps = stepsOf(
      treeOf({steps: [{tool: 'shell', ran: false}]}),
    );
    expect(steps[0]?.ran).toBe(false);
    expect(steps[0]?.reward).toBeUndefined();
  });
});

describe('replayTrees', () => {
  it('reproduces the observed turn when given the setting it ran under', () => {
    const tree = treeOf({
      menu: ['read_file', 'web_search'],
      steps: [
        {tool: 'read_file', reward: 1, ran: true},
        {tool: 'read_file', reward: 1, ran: true},
      ],
      policy: {explorationWeight: 1, pruningThreshold: -1},
    });
    const report = replayTrees([tree], {
      explorationWeight: 1,
      pruningThreshold: -1,
    });
    // The baseline row is the check that the replay agrees with reality. Prune
    // nothing and every step the turn took survives.
    expect(report.totals.replayedSteps).toBe(2);
    expect(report.totals.withheld).toBe(0);
    expect(report.totals.estimatedReturn).toBe(2);
  });

  it('withholds a failing action once the threshold excludes it', () => {
    const tree = treeOf({
      menu: ['read_file', 'shell'],
      steps: [
        {tool: 'shell', reward: -1, ran: true},
        {tool: 'read_file', reward: 1, ran: true},
        {tool: 'read_file', reward: 1, ran: true},
      ],
    });
    const report = replayTrees([tree], {
      explorationWeight: 1,
      pruningThreshold: 0,
    });
    /*
     * Three numbers, three different quantities, and the middle one is the point.
     *
     * `withheld` is 2 because `shell` comes off the menu at *both* later steps.
     * The menu is pruned per step regardless of what the model was about to reach
     * for, so this counts a step where the model wanted something else entirely —
     * which is why it is the number a user reads as "how much did pruning do"
     * rather than as "how much did it cost me".
     *
     * `withheldThatWereProposed` is 0: nothing the model actually chose was
     * withheld. `shell` failed at step 1 and was never asked for again, and
     * `read_file` was untried when it was first reached for, so all three steps
     * still run. That is the case worth a test — a threshold that removes menu
     * entries the model had already stopped wanting costs nothing, and a report
     * showing only `withheld` would make it look expensive.
     *
     * And because the model never asked for the pruned action, the observed
     * return is unchanged at 1. Pruning is free here, which is the honest result
     * rather than the flattering one.
     */
    expect(report.totals.withheld).toBe(2);
    expect(report.totals.withheldThatWereProposed).toBe(0);
    expect(report.totals.replayedSteps).toBe(3);
    expect(report.totals.estimatedReturn).toBe(1);
  });

  it('keeps an action withheld once it has been withheld', () => {
    const tree = treeOf({
      menu: ['read_file', 'shell'],
      steps: [
        {tool: 'shell', reward: -1, ran: true},
        {tool: 'shell', reward: -1, ran: true},
        {tool: 'shell', reward: -1, ran: true},
      ],
    });
    const report = replayTrees([tree], {
      explorationWeight: 1,
      pruningThreshold: 0,
    });
    // Both later attempts are withheld, and that is the behaviour rather than a
    // bug in the count. A withheld call does not run, so it earns no reward — and
    // without the replay folding its own refusals back into the history as the
    // penalty a refusal actually carries, `shell` would sit at "untried" forever
    // and be re-offered at every step while the report claimed it was pruned.
    expect(report.totals.withheld).toBe(2);
    expect(report.totals.withheldThatWereProposed).toBe(2);
    expect(report.totals.replayedSteps).toBe(1);
  });

  it('never withholds an action the turn has not tried yet', () => {
    const tree = treeOf({
      menu: ['read_file', 'shell'],
      steps: [
        {tool: 'read_file', reward: 1, ran: true},
        {tool: 'shell', reward: -1, ran: true},
      ],
    });
    // Threshold 1 prunes everything that is not a certain success — and `shell`
    // still runs at step 2, because at the moment of that decision nothing had
    // been observed against it. The evidence against it is the step itself, and
    // a replay that peeked at it would be reading the answer off the log.
    const report = replayTrees([tree], {
      explorationWeight: 1,
      pruningThreshold: 1,
    });
    expect(report.totals.replayedSteps).toBe(2);
    expect(report.totals.withheld).toBe(0);
  });

  it('does not let a step be decided from its own outcome', () => {
    const tree = treeOf({
      menu: ['shell'],
      steps: [{tool: 'shell', reward: -1, ran: true}],
    });
    const report = replayTrees([tree], {
      explorationWeight: 1,
      pruningThreshold: 0,
    });
    expect(report.totals.replayedSteps).toBe(1);
    expect(report.totals.withheld).toBe(0);
  });

  it('counts an offered tool the model never reached for', () => {
    const tree = treeOf({
      menu: ['read_file', 'shell'],
      steps: [
        {tool: 'shell', reward: -1, ran: true},
        {tool: 'read_file', reward: 1, ran: true},
      ],
    });
    const report = replayTrees([tree], {
      explorationWeight: 1,
      pruningThreshold: 0,
    });
    // `shell` comes off the menu at step 2, so the count is 1 even though the
    // model proposed `read_file` there — the number that means "how many times
    // did the model not get to ask".
    expect(report.totals.withheld).toBe(1);
    expect(report.totals.withheldThatWereProposed).toBe(0);
  });

  it('leaves meanReward absent rather than zero when nothing is allowed', () => {
    const tree = treeOf({
      menu: ['read_file', 'shell'],
      steps: [
        {tool: 'read_file', reward: -1, ran: true},
        {tool: 'read_file', reward: -1, ran: true},
      ],
    });
    // Every action that has been tried averages below the threshold, and the one
    // that has not is past its step — so nothing runs.
    const report = replayTrees([tree], {
      explorationWeight: 1,
      pruningThreshold: 0,
    });
    const turn = report.turns[0];
    expect(turn?.replayedSteps).toBe(1);
    expect(turn?.meanReward).toBe(-1);
    expect(report.totals.meanReward).toBe(-1);
  });

  it('spends one bad call before it can prune anything', () => {
    const tree = treeOf({
      menu: ['read_file', 'shell'],
      steps: [
        {tool: 'shell', reward: -1, ran: true},
        {tool: 'shell', reward: -1, ran: true},
        {tool: 'shell', reward: -1, ran: true},
      ],
    });
    const report = replayTrees([tree], {
      explorationWeight: 1,
      pruningThreshold: 0,
    });
    // Stated because it is the limitation a user should know before they set a
    // threshold: the first step of a turn has no history, so the first call is
    // always spent. A setting can save the second and third attempts, never the
    // first — which is why the honest pitch for this feature is "the turn stops
    // sooner", not "the turn does not go wrong".
    expect(report.totals.replayedSteps).toBe(1);
    expect(report.totals.withheld).toBe(2);
    expect(report.totals.estimatedReturn).toBe(-1);
  });

  it('cannot withhold a turn whose only action has never been tried', () => {
    const tree = treeOf({
      menu: ['shell'],
      steps: [{tool: 'shell', reward: -1, ran: true}],
    });
    // Stated as a test because it is a real property and not an oversight: the
    // first decision of a turn is made with no history at all, so every action on
    // the menu is untried and every threshold keeps all of them. A policy can
    // only ever start pruning from the *second* step, which is why a threshold
    // that is too eager costs a turn one bad call rather than the whole turn.
    const report = replayTrees([tree], {
      explorationWeight: 1,
      pruningThreshold: 1,
    });
    expect(report.totals.replayedSteps).toBe(1);
    expect(report.totals.withheld).toBe(0);
  });

  it('never reports more steps than the turn observed', () => {
    const tree = treeOf({
      menu: ['a', 'b'],
      steps: [
        {tool: 'a', reward: 1, ran: true},
        {tool: 'b', reward: 1, ran: true},
        {tool: 'a', reward: 1, ran: true},
      ],
    });
    for (const pruningThreshold of [-1, -0.5, 0, 0.5, 1]) {
      for (const explorationWeight of [0, 0.5, 1, 3]) {
        const report = replayTrees([tree], {
          explorationWeight,
          pruningThreshold,
        });
        expect(report.totals.replayedSteps).toBeLessThanOrEqual(3);
      }
    }
  });
});

describe('baselineOf', () => {
  it('answers the shared setting when every turn agrees', () => {
    const settings = {explorationWeight: 1, pruningThreshold: 0};
    expect(
      baselineOf([treeOf({steps: [], policy: settings}), treeOf({steps: [], policy: settings})]),
    ).toEqual(settings);
  });

  it('answers nothing when the turns ran under different settings', () => {
    // What a user who moved a slider mid-conversation produces. A baseline that
    // averaged the two would be a number no turn ever ran with, which would make
    // every comparison against it look precise while being about nothing.
    expect(
      baselineOf([
        treeOf({steps: [], policy: {explorationWeight: 1, pruningThreshold: 0}}),
        treeOf({steps: [], policy: {explorationWeight: 2, pruningThreshold: 0}}),
      ]),
    ).toBeUndefined();
  });
});

describe('describeReport', () => {
  it('says how many withheld actions the model actually asked for', () => {
    const tree = treeOf({
      menu: ['read_file', 'shell'],
      steps: [
        {tool: 'shell', reward: -1, ran: true},
        {tool: 'shell', reward: -1, ran: true},
      ],
    });
    const line = describeReport(
      replayTrees([tree], {explorationWeight: 1, pruningThreshold: 0}),
    );
    // The two numbers mean different things and the summary must not print the
    // first without the second.
    expect(line).toContain('withheld 1');
    expect(line).toContain('the model asked for');
  });

  it('says nothing about wrong answers until somebody has judged one', () => {
    /*
     * The absence matters. "0 marked wrong" on a log nobody has read would be a
     * verdict about the agent rather than a statement that no data exists, and
     * the line already carries enough counts to be misread.
     */
    const tree = treeOf({
      menu: ['read_file'],
      steps: [{tool: 'read_file', reward: 1, ran: true}],
    });
    const settings = {explorationWeight: 1, pruningThreshold: -1};
    expect(describeReport(replayTrees([tree], settings))).not.toContain(
      'marked wrong',
    );
    expect(
      describeReport(replayTrees([tree], settings, new Set([tree.invocationId]))),
    ).toContain('1 marked wrong');
  });
});
