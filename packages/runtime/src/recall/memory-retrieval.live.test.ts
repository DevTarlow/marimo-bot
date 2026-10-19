/**
 * Memory retrieval, against the real model.
 *
 * `indexer.test.ts` and `select.test.ts` fake the embedder, which is the right
 * default — nothing in the suite should load 310 MB of weights — and it leaves
 * one thing untested by construction: that a question *actually* retrieves the
 * memory bullet that answers it, through the pinned model, the pinned revision,
 * the task prefixes and the mean pooling that this app chose. A regression in any
 * of those returns vectors of the right width from the right model and a
 * plausible-looking result list, so the fake cannot see it and neither can the
 * window.
 *
 * So this file runs the real engine, and it is **skipped unless asked for**:
 *
 *   MARIMO_LIVE_EMBEDDINGS=1 \
 *   MARIMO_MODEL_DIR=$PWD/apps/desktop/.model-cache/local-model \
 *   pnpm --filter @marimo/runtime test
 *
 * The directory has to be the one the app itself would use: the weights at its
 * root and the engine in `engine/`, because that is where the supervisor takes
 * the engine's shared libraries from. A run without the weights, without the
 * engine, or with the app's *chat* engine build reports as skipped rather than
 * failing — a missing or wrong weight is not a broken build. The one mistake it
 * cannot report as skipped is the engine being there and unable to load the
 * model, which is what the model's own architecture error looks like, and
 * `RECALL_ENGINE` in `pins.ts` is where that is written down.
 *
 * Three things are worth asserting and they are different claims:
 *
 * - **Recall works at all.** A question about a preference finds the preference,
 *   and it is the *nearest* thing, not merely present.
 * - **The floor does its job.** A question memory cannot answer returns nothing,
 *   which is what makes "nothing found" a possible answer to a search rather than
 *   a polite list of everything.
 * - **The prefix recipe is load-bearing where it is used.** These assertions are
 *   the only executable statement of that claim; the measured cosine in
 *   `prefixes.ts` came from a one-off run, and this is the version that keeps
 *   being true.
 */
import {mkdtemp, rm} from 'node:fs/promises';
import {join} from 'node:path';

import {afterAll, beforeAll, describe, expect, it} from 'vitest';

import {EMBEDDING_PINS} from '../local-model/pins.js';
import {
  modelDir,
  recallSpec,
  resolveRecallFiles,
} from '../local-model/files.js';
import {RecallEngine} from './engine.js';
import {RecallService} from './service.js';
import {MIN_SCORE} from './search.js';

/** Opt-in, because this loads a model rather than because it is slow. */
const enabled = process.env['MARIMO_LIVE_EMBEDDINGS'] === '1';

const modelDirectory = modelDir({userData: process.cwd()});
const files = resolveRecallFiles({
  dir: modelDirectory,
  manifest: EMBEDDING_PINS,
  media: false,
});

/** Both halves have to be there: a binary with no weights answers nothing. */
const runnable = enabled && files.modelPresent && files.enginePresent;

/**
 * A memory, and the questions it can answer.
 *
 * Deliberately short and deliberately unalike: every fact is a distinct topic so
 * a question has exactly one right answer, and the questions avoid the bullets'
 * own words where they can. "Where do we deploy it" against a bullet that says
 * "staging box" is the kind of match a keyword search would miss and this is
 * meant to find.
 */
const MEMORY = [
  '## About the user',
  '- The user has a dog named Bramble and two cats.',
  '',
  '## Preferences and tone',
  '- The user prefers tabs over spaces, in every language.',
  '- The user hates being told a task is "simple".',
  '',
  '## Environment and conventions',
  '- The deployment target is the staging box at staging.internal.',
  '- The package manager is pnpm, never npm.',
].join('\n');

const BULLETS = {
  dog: 'The user has a dog named Bramble and two cats.',
  tabs: 'The user prefers tabs over spaces, in every language.',
  staging: 'The deployment target is the staging box at staging.internal.',
  pnpm: 'The package manager is pnpm, never npm.',
};

/*
 * What this corpus actually scores on the pinned build, measured rather than
 * guessed, because two of the assertions below are about *how far* above the
 * floor an answer lands and a number nobody wrote down is a number nobody can
 * judge a change against:
 *
 *   "what kind of pets…"      0.8294   (the strongest)
 *   "what is my dog called?"  0.7718
 *   "which package manager…"  0.7594
 *   "where does the release…" 0.7548
 *   "how should I indent…"    0.6806   (the thinnest; the floor is 0.68)
 *
 * The last one is the finding, and it is not a bug in anything: a four-word
 * question whose answer shares no noun with it is exactly the hard case, and it
 * clears the floor by six ten-thousandths. It is asserted anyway — a change that
 * costs six thousandths of cosine is a change worth being told about — and it is
 * also why this file does not claim a comfortable margin for every question.
 *
 * The drop when the query prefix is dropped, for the same reason: "pets" still
 * ranks, and the two weak questions do not — the package manager lands at
 * 0.7212, above the floor but below the margin the last test asks for. So the
 * floor alone would not have caught a missing prefix, and that margin assertion
 * is the half that does.
 */

describe.runIf(runnable)('memory retrieval against the pinned model', () => {
  let engine: RecallEngine;
  let service: RecallService;
  let indexDir: string;

  beforeAll(async () => {
    indexDir = await mkdtemp(join(process.cwd(), '.marimo-live-idx-'));
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
    // The first search builds the index; every assertion below reads it.
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

  /** The memory hits for one question, nearest first. */
  async function asked(query: string) {
    const answer = await service.search({query, scopes: ['memory']});
    return answer.hits.filter((hit) => hit.kind === 'memory');
  }

  /*
   * The claim the whole feature rests on, and the one a prefix regression breaks
   * silently. Asserted as "the nearest bullet is the right one" rather than "the
   * right bullet is somewhere in the list": a ranking that has the answer third
   * behind a dog and a package manager is a prompt block that narrows memory to
   * the wrong facts.
   */
  it('finds the bullet that answers the question, nearest first', async () => {
    const hits = await asked('what kind of pets does the user have?');
    expect(hits[0]?.text).toBe(BULLETS.dog);
    expect(hits[0]?.score).toBeGreaterThanOrEqual(MIN_SCORE);
    expect(hits[0]?.section).toBe('About the user');
    // Verified, not quoted from the index: the text is read back from the file.
    expect(hits[0]?.stale).toBe(false);
  }, 60_000);

  it('matches a preference asked for in different words', async () => {
    const hits = await asked('how should I indent code?');
    expect(hits[0]?.text).toBe(BULLETS.tabs);
    /*
     * The thin one: 0.6806 against a floor of 0.68. Asserted at the floor rather
     * than with the margin below, because this question is genuinely the hardest
     * in the corpus and asking it to score comfortably would be asking the model
     * to be better than it is. What makes it worth having is that a change which
     * costs six thousandths of cosine turns this from a passing test into a
     * failing one — see the measurements above.
     */
    expect(hits[0]?.score).toBeGreaterThanOrEqual(MIN_SCORE);
  }, 60_000);

  it("matches a fact named by neither side's words", async () => {
    // "release" appears in the bullet only as "deployment", and "server" only as
    // "box" — this is the case a literal search cannot do at all.
    const hits = await asked('where does the release get deployed to?');
    expect(hits[0]?.text).toBe(BULLETS.staging);
    expect(hits[0]?.score).toBeGreaterThan(MIN_SCORE + 0.05);
  }, 60_000);

  /*
   * The floor, and the reason "nothing found" is an answer this app can give. A
   * question the memory cannot answer must come back empty rather than with the
   * least-unrelated bullets it happens to hold — that list is what makes a model
   * believe the folder answered it.
   */
  it('returns nothing for a question memory cannot answer', async () => {
    const hits = await asked('what is the boiling point of mercury?');
    expect(hits).toEqual([]);
  }, 60_000);

  /*
   * And the other side of the same coin, which is the assertion that catches a
   * forgotten query prefix. The floor alone cannot: without the prefix this
   * question still clears it, at 0.7212, and the answer is still nearest. What
   * changes is the margin — 0.7594 with the recipe, 0.7212 without — so this is
   * the test that fails when the prefixes stop being applied, which is the one
   * regression the whole feature would otherwise absorb in silence.
   */
  it('scores a real answer clear of the floor', async () => {
    const hits = await asked('which package manager does this project use?');
    expect(hits[0]?.text).toBe(BULLETS.pnpm);
    expect(hits[0]?.score).toBeGreaterThan(MIN_SCORE + 0.05);
  }, 60_000);

  /*
   * The strongest question, and the one that says the numbers above are not a
   * fluke of four-word questions: a full sentence about a pet scores 0.77 here.
   */
  it('scores a short, direct question well above the floor', async () => {
    const hits = await asked('what is my dog called?');
    expect(hits[0]?.text).toBe(BULLETS.dog);
    expect(hits[0]?.score).toBeGreaterThan(MIN_SCORE + 0.05);
  }, 60_000);
});

/*
 * Said out loud, so a skipped run is not mistaken for a passing one. The suite
 * prints nothing about a `runIf` that was false, and "memory retrieval is tested"
 * is exactly the belief this file exists to make true rather than assumed.
 */
if (!runnable) {
  describe('memory retrieval against the pinned model', () => {
    it.skip(`skipped: ${enabled ? 'the model or engine is not installed' : 'set MARIMO_LIVE_EMBEDDINGS=1 to run it'}`, () =>
      undefined);
  });
}
