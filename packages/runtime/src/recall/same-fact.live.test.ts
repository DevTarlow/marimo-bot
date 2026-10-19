/**
 * The "same fact" floor, against the real model.
 *
 * `update_memory` warns when a new bullet is close enough to an existing one that
 * the two are probably the same fact in different words — a restatement the
 * store's own line de-duplication cannot see, because the two sentences share no
 * words. That warning is only as good as the number behind it, and the number is
 * a similarity threshold: too low and it fires on unrelated facts, too high and
 * it never fires at all.
 *
 * So this file is the measurement, in the same skipped-unless-asked-for form as
 * `memory-retrieval.live.test.ts` and for the same reason: it needs the pinned
 * weights and engine, and nothing in the default suite should load 310 MB.
 *
 *   MARIMO_LIVE_EMBEDDINGS=1 \
 *   MARIMO_MODEL_DIR=$PWD/apps/desktop/.model-cache/live-model \
 *   pnpm --filter @marimo/runtime test
 *
 * **`SAME_FACT_SCORE` is too high until this says otherwise.** It ships at a
 * conservative value on purpose: a false positive tells the model to remove a
 * bullet that was a separate fact, and a false negative only means the advisory
 * stays quiet and the store's string de-duplication still runs. The assertion
 * below is therefore written in both directions — the paraphrase cases *and* the
 * unrelated ones — so the first person to run this with weights gets told which
 * way to move the number rather than being told it is wrong.
 */
import {mkdtemp, rm} from 'node:fs/promises';
import {join} from 'node:path';

import {afterAll, beforeAll, describe, expect, it} from 'vitest';

import {SAME_FACT_SCORE} from '@marimo/agent';

import {EMBEDDING_PINS} from '../local-model/pins.js';
import {
  modelDir,
  recallSpec,
  resolveRecallFiles,
} from '../local-model/files.js';
import {RecallEngine} from './engine.js';
import {RecallService} from './service.js';

/** Opt-in, because this loads a model rather than because it is slow. */
const enabled = process.env['MARIMO_LIVE_EMBEDDINGS'] === '1';

const modelDirectory = modelDir({userData: process.cwd()});
const files = resolveRecallFiles({
  dir: modelDirectory,
  manifest: EMBEDDING_PINS,
  media: false,
});

const runnable = enabled && files.modelPresent && files.enginePresent;

/**
 * A memory and the facts that should and should not be called restatements of it.
 *
 * The corpus is deliberately short and its bullets deliberately unalike, so a
 * score means one thing. The `same` cases are the two shapes the advisory exists
 * for: a paraphrase that shares no words with the bullet, and a *contradiction*,
 * which is the dangerous one — "we use npm now" against "the package manager is
 * pnpm, never npm" is the moment a second, contradicting bullet must not be
 * added silently.
 */
const MEMORY = [
  '## About the user',
  '- The user has a dog named Bramble and two cats.',
  '',
  '## Preferences and tone',
  '- The user prefers tabs over spaces, in every language.',
  '- The package manager is pnpm, never npm.',
  '',
  '## Environment and conventions',
  '- The deployment target is the staging box at staging.internal.',
].join('\n');

const CASES: ReadonlyArray<{fact: string; same: boolean}> = [
  // Paraphrases: no content word in common with the bullet they restate.
  {fact: 'They indent with tabs whatever the language is.', same: true},
  {fact: 'Their dog is called Bramble.', same: true},
  // A contradiction, which is the case that must be caught.
  {fact: 'We use npm for this project now.', same: true},
  {fact: 'The package manager is npm.', same: true},
  // Unrelated facts, which must not be.
  {fact: 'They work from Lisbon on Tuesdays.', same: false},
  {fact: 'The release is tagged from a git branch.', same: false},
];

describe.runIf(runnable)('the same-fact floor against the pinned model', () => {
  let engine: RecallEngine;
  let service: RecallService;
  let indexDir: string;

  beforeAll(async () => {
    indexDir = await mkdtemp(join(process.cwd(), '.marimo-live-same-'));
    engine = new RecallEngine({
      spec: () =>
        recallSpec({
          dir: modelDirectory,
          manifest: EMBEDDING_PINS,
          media: false,
        }),
      pidFile: join(indexDir, 'recall.pid'),
      dims: EMBEDDING_PINS.weights.dims,
    });
    const started = await engine.ensureRunning();
    if (!started.ok) {
      throw new Error(`the recall engine did not start: ${started.problem}`);
    }
    service = new RecallService({
      dir: indexDir,
      model: {
        repo: EMBEDDING_PINS.weights.repo,
        revision: EMBEDDING_PINS.weights.revision,
        dims: EMBEDDING_PINS.weights.dims,
      },
      embed: async (texts) => await engine.embedText(texts),
      warm: async () => {
        await engine.ensureRunning();
      },
      readMemory: async () => MEMORY,
    });
    await service.search({query: 'warm the index', scopes: ['memory']});
  }, 180_000);

  afterAll(async () => {
    await engine?.stop();
    if (indexDir !== undefined) {
      await rm(indexDir, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 20,
      });
    }
  });

  /**
   * The nearest memory score for one candidate fact, exactly as the advisory asks.
   *
   * `minScore: 0` deliberately: the question here is what a fact scores, not
   * whether it clears the *retrieval* floor, and a case that fell below that floor
   * would otherwise come back as an empty list with no number attached.
   */
  async function score(fact: string): Promise<number> {
    const answer = await service.search({
      query: fact,
      scopes: ['memory'],
      limit: 3,
      minScore: 0,
    });
    return answer.hits.filter((hit) => hit.kind === 'memory')[0]?.score ?? 0;
  }

  it('calls a restatement the same fact, and an unrelated fact not', async () => {
    const measured: Array<{fact: string; score: number; same: boolean}> = [];
    for (const item of CASES) {
      measured.push({...item, score: await score(item.fact)});
    }

    const wrong = measured.filter(
      (entry) => entry.same !== entry.score >= SAME_FACT_SCORE,
    );
    /*
     * Reported as the numbers rather than as "expected true, got false", because
     * the useful answer is which way the threshold has to move and by how much.
     */
    expect(
      wrong.map(
        (entry) =>
          `${entry.same ? 'should be' : 'should not be'} a restatement at ` +
          `${entry.score.toFixed(4)}: ${entry.fact}`,
      ),
      `SAME_FACT_SCORE is ${String(SAME_FACT_SCORE)}; measured ` +
        measured
          .map(
            (entry) =>
              `${entry.score.toFixed(4)} ${entry.same ? 'same' : 'other'}`,
          )
          .join(', '),
    ).toEqual([]);
  }, 120_000);
});
