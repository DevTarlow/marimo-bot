import {mkdtemp, writeFile} from 'node:fs/promises';
import {join} from 'node:path';

import {describe, expect, it} from 'vitest';

import {REWARD_REASONS, REWARD_VALUES, rewardOf} from '@marimo/agent';
import type {DreamTree} from '@marimo/protocol';

import {DreamStore} from './dream-store.js';
import {renderSweep, sweepDreamTrees} from './dream-replay.js';

function at(n: number): string {
  return new Date(Date.UTC(2026, 8, 14, 0, 0, n)).toISOString();
}

/**
 * One recorded turn: a menu, and the calls the model made from it.
 *
 * The `attempted` list a step carries is its own call, and `stepsOf` folds the
 * prefix — so a fixture only has to state what happened, not what was known.
 */
function turn(options: {
  invocationId: string;
  outcome?: DreamTree['outcome'];
  policy?: {explorationWeight: number; pruningThreshold: number};
  menu: string[];
  steps: {tool: string; reward: number}[];
}): DreamTree {
  const nodes: DreamTree['nodes'] = [
    {
      id: `${options.invocationId}-root`,
      kind: 'turn',
      depth: 0,
      invocationId: options.invocationId,
      allowed: true,
      at: at(0),
    },
  ];

  let index = 0;
  for (const step of options.steps) {
    index += 1;
    const stepId = `${options.invocationId}-step-${index}`;
    const proposalId = `${options.invocationId}-proposal-${index}`;
    nodes.push({
      id: stepId,
      parentId: `${options.invocationId}-root`,
      kind: 'turn',
      depth: 1,
      invocationId: options.invocationId,
      offered: [...options.menu],
      allowed: true,
      at: at(index * 10),
    });
    nodes.push({
      id: proposalId,
      parentId: stepId,
      kind: 'propose',
      depth: 2,
      invocationId: options.invocationId,
      tool: step.tool,
      callId: `${options.invocationId}-call-${index}`,
      allowed: true,
      at: at(index * 10 + 1),
    });
    nodes.push({
      id: `${options.invocationId}-call-${index}`,
      parentId: proposalId,
      kind: 'call',
      depth: 3,
      invocationId: options.invocationId,
      tool: step.tool,
      callId: `${options.invocationId}-call-${index}`,
      result: 'ok',
      reward: {value: step.reward, reason: 'returned a result'},
      allowed: true,
      at: at(index * 10 + 2),
    });
  }

  return {
    version: 1,
    sessionId: 'session-1',
    invocationId: options.invocationId,
    startedAt: at(0),
    outcome: options.outcome ?? 'answered',
    policy: options.policy ?? {explorationWeight: 1, pruningThreshold: -1},
    nodes,
  };
}

async function storeUnder(): Promise<DreamStore> {
  const dir = await mkdtemp(join(process.cwd(), '.marimo-dream-'));
  return new DreamStore({dir, keepLogs: () => 200});
}

/** A store and the feedback document that sits beside it in user data. */
async function storeAndFeedback(): Promise<{
  store: DreamStore;
  feedbackFile: string;
}> {
  const dir = await mkdtemp(join(process.cwd(), '.marimo-dream-'));
  return {
    store: new DreamStore({dir, keepLogs: () => 200}),
    feedbackFile: join(dir, 'feedback.json'),
  };
}

function feedbackDocument(invocationIds: string[], version = 1): string {
  return JSON.stringify({
    version,
    entries: invocationIds.map((invocationId, index) => ({
      id: `feedback-${String(index)}`,
      profileId: 'default',
      sessionId: 'session-1',
      messageId: `message-${String(index)}`,
      invocationId,
      excerpt: 'An answer somebody judged.',
      correction: '',
      createdAt: at(index),
    })),
  });
}

describe('sweepDreamTrees', () => {
  it('reads the log once and reports every candidate against it', async () => {
    const store = await storeUnder();
    await store.append(
      turn({
        invocationId: 'inv-1',
        menu: ['read_file', 'shell'],
        steps: [
          {tool: 'shell', reward: -1},
          {tool: 'read_file', reward: 1},
        ],
      }),
    );

    const sweep = await sweepDreamTrees({
      store,
      candidates: [
        {explorationWeight: 1, pruningThreshold: -1},
        {explorationWeight: 1, pruningThreshold: 0},
      ],
    });

    expect(sweep.loaded).toEqual({sessions: 1, turns: 1});
    expect(sweep.rows).toHaveLength(2);
    // Exactly one row is the control, and it is the one the turn ran under.
    expect(sweep.rows.filter((row) => row.baseline)).toHaveLength(1);
    expect(sweep.rows[0]?.settings.pruningThreshold).toBe(-1);
    expect(sweep.rows[0]?.baseline).toBe(true);
    expect(sweep.baseline).toEqual({explorationWeight: 1, pruningThreshold: -1});
  });

  it("reports the user's judgement beside what a setting withheld", async () => {
    const {store, feedbackFile} = await storeAndFeedback();
    await store.append(
      turn({
        invocationId: 'inv-wrong',
        menu: ['read_file', 'shell'],
        steps: [
          {tool: 'shell', reward: -1},
          {tool: 'read_file', reward: 1},
        ],
      }),
    );
    await store.append(
      turn({
        invocationId: 'inv-right',
        menu: ['read_file', 'shell'],
        steps: [{tool: 'read_file', reward: 1}],
      }),
    );
    await writeFile(feedbackFile, feedbackDocument(['inv-wrong']), 'utf8');

    const sweep = await sweepDreamTrees({
      store,
      candidates: [{explorationWeight: 1, pruningThreshold: 0}],
      feedbackFile,
    });

    const report = sweep.rows[0]?.report;
    expect(report?.totals.markedWrong).toBe(1);
    expect(
      report?.turns.find((entry) => entry.invocationId === 'inv-wrong')
        ?.markedWrong,
    ).toBe(true);
    expect(
      report?.turns.find((entry) => entry.invocationId === 'inv-right')
        ?.markedWrong,
    ).toBeUndefined();
    /*
     * The split has to agree with the turn it came from — and the turn's own
     * count is the only thing it may be derived from. A total that did not add up
     * would let a setting look like it targeted the wrong turns when it did not.
     */
    const wrongTurn = report?.turns.find(
      (entry) => entry.invocationId === 'inv-wrong',
    );
    expect(report?.totals.withheldOnMarkedWrong).toBe(wrongTurn?.withheld);
  });

  it('says so when the feedback document cannot be read', async () => {
    const {store, feedbackFile} = await storeAndFeedback();
    await store.append(
      turn({
        invocationId: 'inv-1',
        menu: ['read_file'],
        steps: [{tool: 'read_file', reward: 1}],
      }),
    );
    // A document from a newer build: the reader refuses it rather than guessing
    // what its fields mean, and the report has to say the marks are missing.
    await writeFile(feedbackFile, feedbackDocument(['inv-1'], 99), 'utf8');

    const sweep = await sweepDreamTrees({
      store,
      candidates: [{explorationWeight: 1, pruningThreshold: -1}],
      feedbackFile,
    });

    expect(sweep.rows[0]?.report.totals.markedWrong).toBe(0);
    expect(
      sweep.problems.some((problem) => problem.includes('feedback.json')),
    ).toBe(true);
  });

  it('skips a turn that was still open when the process stopped', async () => {
    const store = await storeUnder();
    await store.append(
      turn({
        invocationId: 'inv-open',
        outcome: 'open',
        menu: ['shell'],
        steps: [{tool: 'shell', reward: -1}],
      }),
    );
    // A tree marked open is a prefix. Replaying it would report that a setting
    // withheld the steps the turn never got to take, which is the one way this
    // report can be actively misleading.
    const sweep = await sweepDreamTrees({
      store,
      candidates: [{explorationWeight: 1, pruningThreshold: 0}],
    });
    expect(sweep.loaded.turns).toBe(0);
  });

  it('skips a turn that called nothing', async () => {
    const store = await storeUnder();
    await store.append(
      turn({invocationId: 'inv-empty', menu: ['shell'], steps: []}),
    );
    const sweep = await sweepDreamTrees({
      store,
      candidates: [{explorationWeight: 1, pruningThreshold: 0}],
    });
    expect(sweep.loaded.turns).toBe(0);
  });

  it('names no best setting when the grid replayed nothing at all', async () => {
    const store = await storeUnder();
    /*
     * The shape `--json` prints for somebody who has not recorded anything yet.
     * A grid of candidates over zero turns scores every row at an estimated
     * return of nothing, so a "best" here is whichever setting sorted first —
     * a recommendation made out of the argument order.
     */
    const sweep = await sweepDreamTrees({
      store,
      candidates: [
        {explorationWeight: 0, pruningThreshold: -1},
        {explorationWeight: 1, pruningThreshold: 0},
      ],
    });
    expect(sweep.loaded.turns).toBe(0);
    expect(sweep.best).toBeUndefined();
    expect(sweep.rows).toHaveLength(2);
  });

  it('names a best setting only when there is something to compare', async () => {
    const store = await storeUnder();
    await store.append(
      turn({
        invocationId: 'inv-1',
        menu: ['read_file', 'shell'],
        steps: [
          {tool: 'shell', reward: -1},
          {tool: 'shell', reward: -1},
        ],
      }),
    );

    const one = await sweepDreamTrees({
      store,
      candidates: [{explorationWeight: 1, pruningThreshold: 0}],
    });
    // One candidate is not a comparison, and naming it "best" would read as a
    // finding.
    expect(one.best).toBeUndefined();

    const many = await sweepDreamTrees({
      store,
      candidates: [
        {explorationWeight: 1, pruningThreshold: -1},
        {explorationWeight: 1, pruningThreshold: 0},
      ],
    });
    expect(many.best).toBeDefined();
  });

  it('names no baseline when the turns ran under different settings', async () => {
    const store = await storeUnder();
    await store.append(
      turn({
        invocationId: 'inv-1',
        policy: {explorationWeight: 1, pruningThreshold: -1},
        menu: ['shell'],
        steps: [{tool: 'shell', reward: 1}],
      }),
    );
    await store.append(
      turn({
        invocationId: 'inv-2',
        policy: {explorationWeight: 2, pruningThreshold: 0},
        menu: ['shell'],
        steps: [{tool: 'shell', reward: 1}],
      }),
    );

    const sweep = await sweepDreamTrees({
      store,
      candidates: [{explorationWeight: 1, pruningThreshold: -1}],
    });
    // Averaging two controls into one baseline would make every comparison look
    // precise while being about a setting no turn ever ran with.
    expect(sweep.baseline).toBeUndefined();
    expect(sweep.rows.every((row) => !row.baseline)).toBe(true);
    expect(renderSweep(sweep)).toContain('no row is marked');
  });

  it('reports a session that could not be read and still replays the rest', async () => {
    const store = await storeUnder();
    await store.append(
      turn({
        invocationId: 'inv-1',
        menu: ['shell'],
        steps: [{tool: 'shell', reward: 1}],
      }),
    );
    const sweep = await sweepDreamTrees({
      store,
      candidates: [{explorationWeight: 1, pruningThreshold: -1}],
      sessionId: 'does-not-exist',
    });
    expect(sweep.loaded.turns).toBe(0);
    expect(renderSweep(sweep)).toContain('Nothing to replay');
  });

  it('restricts the replay to one conversation when asked', async () => {
    const store = await storeUnder();
    await store.append(
      turn({
        invocationId: 'inv-1',
        menu: ['shell'],
        steps: [{tool: 'shell', reward: 1}],
      }),
    );
    await store.append(
      turn({
        invocationId: 'inv-2',
        menu: ['shell'],
        steps: [{tool: 'shell', reward: 1}],
      }),
    );

    const sweep = await sweepDreamTrees({
      store,
      candidates: [{explorationWeight: 1, pruningThreshold: -1}],
      sessionId: 'session-1',
    });
    expect(sweep.loaded.turns).toBe(2);
    const scoped = await sweepDreamTrees({
      store,
      candidates: [{explorationWeight: 1, pruningThreshold: -1}],
      sessionId: 'nothing-here',
    });
    expect(scoped.loaded.turns).toBe(0);
  });
});

describe('renderSweep', () => {
  it('says what the numbers are not', async () => {
    const store = await storeUnder();
    await store.append(
      turn({
        invocationId: 'inv-1',
        menu: ['read_file', 'shell'],
        steps: [
          {tool: 'shell', reward: -1},
          {tool: 'read_file', reward: 1},
        ],
      }),
    );
    const text = renderSweep(
      await sweepDreamTrees({
        store,
        candidates: [
          {explorationWeight: 1, pruningThreshold: -1},
          {explorationWeight: 1, pruningThreshold: 0},
        ],
      }),
    );
    // The boundary of an offline replay, stated in the output rather than only
    // in a comment: a reader who scrolls past the table still reads this.
    expect(text).toContain('What this says');
    expect(text).toContain('What it does not say');
    expect(text).toContain('*');
  });
});

describe('the replay and the live policy agree', () => {
  it('scores a withheld call exactly as the live policy does', () => {
    // `replay.ts` keeps its own copy of this number so the simulator does not
    // have to import the result-shaping half of the recorder for one constant.
    // This is what stops the two drifting — and it fails on the *value*, at the
    // moment somebody changes it, which is better than a shared import.
    expect(REWARD_VALUES[REWARD_REASONS.withheld]).toBe(-1);
    expect(rewardOf(REWARD_REASONS.withheld).value).toBe(-1);
  });
});
