/**
 * Recall as a caller uses it, which is where the promises are kept.
 *
 * Three of them are asserted here and each is a sentence somebody could rely on:
 * a search brings the index up to date before it answers, a hit's text is the text
 * that is in the file *now* — or the hit says it is stale — and a corpus that is
 * not available is not offered as a scope that would come back empty.
 *
 * The last is the one worth the most: the caller here is a model choosing between
 * tools, and a scope the index cannot honour is a tool call that returns "nothing
 * found" about a folder full of the answer.
 */
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';

import {afterEach, beforeEach, describe, expect, it} from 'vitest';

import {RecallService} from './service.js';
import {ConversationWatermarkStore} from './conversations.js';
import type {ConversationEvent} from './conversations.js';
import type {IndexModel} from './store.js';

const MODEL: IndexModel = {
  repo: 'unsloth/embeddinggemma-2-GGUF',
  revision: 'rev2',
  dims: 8,
};
const VOCABULARY = [
  'retry',
  'upload',
  'cookie',
  'bake',
  'memory',
  'tabs',
  'oven',
  'user',
];

function fakeEmbedder(): (
  texts: readonly string[],
) => Promise<{vectors: Float32Array[]}> {
  return async (texts) => ({
    vectors: texts.map((text) => {
      const vector = new Float32Array(VOCABULARY.length);
      for (const [index, word] of VOCABULARY.entries()) {
        if (text.toLowerCase().includes(word)) {
          vector[index] += 1;
        }
      }
      if (vector.every((value) => value === 0)) {
        vector[0] = 0.01;
      }
      return vector;
    }),
  });
}

describe('RecallService', () => {
  let workspace: string;
  let indexDir: string;
  let memory: string;

  beforeEach(async () => {
    workspace = await mkdtemp(join(process.cwd(), '.marimo-recall-svc-ws-'));
    indexDir = await mkdtemp(join(process.cwd(), '.marimo-recall-svc-idx-'));
    memory = '## Notes\n- the user prefers tabs\n';
  });

  afterEach(async () => {
    await rm(workspace, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 20,
    });
    await rm(indexDir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 20,
    });
  });

  function service(
    options: {
      memory?: boolean;
      folder?: boolean;
      warm?: () => Promise<void>;
    } = {},
  ): RecallService {
    return new RecallService({
      workspaceRoot: options.folder === false ? '' : workspace,
      dir: indexDir,
      model: MODEL,
      embed: fakeEmbedder(),
      ...(options.memory === false ? {} : {readMemory: async () => memory}),
      ...(options.warm === undefined ? {} : {warm: options.warm}),
    });
  }

  async function write(path: string, text: string): Promise<void> {
    const absolute = join(workspace, path);
    await mkdir(join(absolute, '..'), {recursive: true});
    await writeFile(absolute, text, 'utf8');
  }

  it('offers only the corpora it can honour', () => {
    expect(service().scopes()).toEqual(['folder', 'memory']);
    expect(service({folder: false}).scopes()).toEqual(['memory']);
    expect(service({memory: false}).scopes()).toEqual(['folder']);
    expect(service({folder: false, memory: false}).scopes()).toEqual([]);
  });

  it('answers a question about the code with the lines themselves', async () => {
    await write(
      'src/retry.ts',
      'export function withRetry() {\n  // three attempts\n}',
    );
    await write('src/oven.ts', 'export function preheat() {}');

    const answer = await service().search({query: 'how does retry work?'});

    const hit = answer.hits.find((entry) => entry.path === 'src/retry.ts');
    expect(hit).toBeDefined();
    expect(hit?.text).toContain('withRetry');
    expect(hit?.startLine).toBe(1);
    expect(hit?.endLine).toBe(3);
    expect(hit?.stale).toBe(false);
    expect(answer.searched).toEqual(['folder', 'memory']);
  });

  /*
   * Memory and the folder are one space, which is the point of the feature: the
   * same question finds a bullet the agent wrote about the user and a line of
   * their code, and the caller does not have to ask twice.
   */
  it('finds memory through the same question as the folder', async () => {
    await write('src/retry.ts', 'export function withRetry() {}');
    memory = '## Preferences and tone\n- the user prefers tabs over spaces\n';

    const answer = await service().search({
      query: 'what does the user prefer?',
    });

    const hit = answer.hits.find((entry) => entry.kind === 'memory');
    expect(hit).toBeDefined();
    expect(hit?.section).toBe('Preferences and tone');
    expect(hit?.text).toBe('the user prefers tabs over spaces');
  });

  it('searches only the corpora it was asked for', async () => {
    await write('src/retry.ts', 'export function withRetry() {}');
    memory = '## Notes\n- the retry code lives in src/retry.ts\n';

    const answer = await service().search({query: 'retry', scopes: ['memory']});

    expect(answer.searched).toEqual(['memory']);
    expect(answer.hits.every((hit) => hit.kind === 'memory')).toBe(true);
  });

  it('brings the index up to date before answering', async () => {
    await write('src/retry.ts', 'export function withRetry() {}');
    const recall = service();
    await recall.search({query: 'retry'});

    await new Promise((resolve) => setTimeout(resolve, 12));
    await write('src/upload.ts', 'export function uploadRetry() {}');

    const answer = await recall.search({query: 'upload'});

    expect(answer.coverage.embedded).toBe(1);
    expect(answer.hits.some((hit) => hit.path === 'src/upload.ts')).toBe(true);
  });

  /*
   * The promise this whole design rests on: a hit either carries text that is in
   * the file now, or it says it is stale. A preview is not enough — a person
   * looking at a result has to be able to trust the lines under it.
   */
  it('says a hit is stale rather than quoting a file that has changed', async () => {
    await write('src/retry.ts', 'export function withRetry() {}');
    const recall = service();
    await recall.search({query: 'retry'});

    await new Promise((resolve) => setTimeout(resolve, 12));
    await write('src/retry.ts', 'export function somethingElse() {}');

    /*
     * A refresh that is not allowed to embed anything, which is what happens to a
     * changed file when the folder is bigger than one slice — and what a file
     * edited between the refresh and the read looks like.
     */
    const held = new RecallService({
      workspaceRoot: workspace,
      dir: indexDir,
      model: MODEL,
      embed: fakeEmbedder(),
      maxFiles: 0,
    });
    const answer = await held.search({query: 'retry'});

    const hit = answer.hits.find((entry) => entry.path === 'src/retry.ts');
    expect(hit?.stale).toBe(true);
    expect(hit?.text).toBe('');
    expect(answer.coverage.truncated).toBe(true);
    expect(answer.notes.join(' ')).toMatch(/not indexed yet/u);
  });

  it('forgets the index when asked, and rebuilds it afterwards', async () => {
    await write('src/retry.ts', 'export function withRetry() {}');
    const recall = service();
    await recall.search({query: 'retry'});
    expect((await recall.status()).records).toBeGreaterThan(0);

    await recall.forget();
    expect((await recall.status()).records).toBe(0);

    const again = await recall.search({query: 'retry'});
    expect(again.hits.length).toBeGreaterThan(0);
  });

  /*
   * A question with nothing in it, or a caller asking for a corpus that does not
   * exist here, must not be a search that reads the whole folder and then says
   * nothing was found.
   */
  /*
   * The floor, as a caller meets it. A question nothing in the index comes close
   * to is a question with no answer here, and the answer has to *say* that
   * rather than hand back the least-unrelated rows — because "the folder does not
   * say this" and "the folder says thirty things about something else" are
   * different sentences and a reader acts on them differently.
   */
  it('answers nothing when nothing here is close, and says so', async () => {
    await write('src/retry.ts', 'export function withRetry() {}');

    const answer = await service().search({query: 'bake'});

    expect(answer.hits).toEqual([]);
    expect(answer.notes.join(' ')).toMatch(/close enough/u);
  });

  /*
   * And the way back: `minScore: 0` is the same ranking with the floor off, which
   * is what the window asks for when somebody chooses to see what was withheld.
   */
  it('returns the nearest anyway when the caller asks for them', async () => {
    await write('src/retry.ts', 'export function withRetry() {}');

    const answer = await service().search({query: 'bake', minScore: 0});

    expect(answer.hits.map((hit) => hit.path)).toContain('src/retry.ts');
  });

  it('does no work for an empty question or an impossible scope', async () => {
    await write('src/retry.ts', 'export function withRetry() {}');

    const empty = await service().search({query: '   '});
    expect(empty.hits).toEqual([]);
    expect(empty.coverage.embedded).toBe(0);

    const impossible = await service({folder: false}).search({
      query: 'retry',
      scopes: ['folder'],
    });
    expect(impossible.hits).toEqual([]);
    expect(impossible.searched).toEqual([]);
    expect(impossible.notes.join(' ')).toMatch(/Nothing is available/u);
  });

  /*
   * The runner's mode. A scheduled job has nobody watching, can be killed at any
   * moment, and must not fight the window over the same files — so it may embed a
   * question and is refused the refresh that would write an index. What it must
   * never do is answer "nothing found" about a folder it did not look at.
   */
  it('never writes when it is read-only, and says when there is nothing to read', async () => {
    await write('src/retry.ts', 'export function withRetry() {}');
    const quiet = new RecallService({
      workspaceRoot: workspace,
      dir: indexDir,
      model: MODEL,
      embed: fakeEmbedder(),
      readOnly: true,
    });

    const first = await quiet.search({query: 'retry'});
    expect(first.coverage.embedded).toBe(0);
    expect(first.hits).toEqual([]);
    expect(first.notes.join(' ')).toMatch(/does not build an index/u);

    // Once somebody else has built one, the same read-only search finds things
    // and still writes nothing.
    await service().search({query: 'retry'});
    const second = await quiet.search({query: 'retry'});
    expect(second.hits.length).toBeGreaterThan(0);
    expect(second.coverage.embedded).toBe(0);
  });

  /*
   * The code prompt, chosen by the setting rather than guessed per query. Tested
   * by what reaches the engine, because nothing else about the answer would show
   * which instruction was used.
   */
  it('asks questions the code way when it is told the folder is code', async () => {
    await write('src/retry.ts', 'export function withRetry() {}');
    const asked: string[] = [];
    const recall = new RecallService({
      workspaceRoot: workspace,
      dir: indexDir,
      model: MODEL,
      codeQueries: true,
      embed: async (texts) => {
        asked.push(...texts);
        return {
          vectors: texts.map(() => Float32Array.from([1, 0, 0, 0, 0, 0, 0, 0])),
        };
      },
    });

    await recall.search({query: 'where is retry'});

    expect(
      asked.some((text) => text.startsWith('task: code retrieval | query:')),
    ).toBe(true);
  });

  it('reports what it indexed when a folder is only partly done', async () => {
    await write('a.ts', 'const retry = 1;');
    await write('b.ts', 'const bake = 2;');
    const recall = new RecallService({
      workspaceRoot: workspace,
      dir: indexDir,
      model: MODEL,
      embed: fakeEmbedder(),
      maxFiles: 1,
    });

    const answer = await recall.search({query: 'retry'});

    expect(answer.coverage.truncated).toBe(true);
    expect(answer.coverage.pending).toBe(1);
    expect(answer.index.records).toBeGreaterThan(0);
  });

  /*
   * The third corpus, and the promise that makes it a corpus rather than a
   * copy: a hit's text is the conversation *as it is now*, rendered again from
   * the stored events and checked against the digest, and a chat that is
   * deleted stops being found at once.
   */
  describe('conversations', () => {
    function recallWith(events: () => readonly ConversationEvent[]) {
      const watermark = new ConversationWatermarkStore({
        file: join(indexDir, 'conversations.json'),
      });
      const conversations = {
        list: async () => [
          {sessionId: 's1', title: 'Retries', eventCount: events().length},
        ],
        read: async () => ({title: 'Retries', events: events()}),
      };
      return new RecallService({
        workspaceRoot: workspace,
        dir: indexDir,
        model: MODEL,
        embed: fakeEmbedder(),
        conversations,
        watermark,
      });
    }

    it('offers the conversation scope only when there is something to read it', () => {
      expect(service().scopes()).not.toContain('conversation');
      expect(recallWith(() => []).scopes()).toContain('conversation');
    });

    it('finds a chat and reads the stretch back', async () => {
      const recall = recallWith(() => [
        {
          author: 'user',
          content: {parts: [{text: 'how should the retry work?'}]},
        },
        {
          author: 'agent',
          content: {parts: [{text: 'three attempts, then give up'}]},
        },
      ]);

      const answer = await recall.search({
        query: 'retry',
        scopes: ['conversation'],
      });

      expect(answer.searched).toEqual(['conversation']);
      const hit = answer.hits.find((entry) => entry.kind === 'conversation');
      expect(hit).toBeDefined();
      expect(hit?.sessionId).toBe('s1');
      expect(hit?.title).toBe('Retries');
      expect(hit?.text).toContain('USER: how should the retry work?');
      expect(hit?.stale).toBe(false);
    });

    it('stops finding a chat that has been forgotten', async () => {
      let events: ConversationEvent[] = [
        {
          author: 'user',
          content: {parts: [{text: 'how should the retry work?'}]},
        },
      ];
      const recall = recallWith(() => events);
      const first = await recall.search({
        query: 'retry',
        scopes: ['conversation'],
      });
      expect(first.hits.length).toBeGreaterThan(0);

      await recall.forgetSessions(['s1']);
      events = [];

      const second = await recall.search({
        query: 'retry',
        scopes: ['conversation'],
      });
      expect(second.hits).toEqual([]);
    });

    it('offers media only when there is a decoder', () => {
      expect(service().scopes()).not.toContain('media');
      const withMedia = new RecallService({
        workspaceRoot: workspace,
        dir: indexDir,
        model: MODEL,
        embed: fakeEmbedder(),
        media: {
          decode: async () => [],
          embedParts: async () => ({vectors: []}),
        },
      });
      expect(withMedia.scopes()).toContain('media');
    });
  });

  /*
   * The two answers a memory write needs, and both are about timing rather than
   * content: whether the vectors on disk describe the file in front of you, and
   * a way to spend the engine's load time somewhere other than inside a turn's
   * retrieval deadline.
   */
  describe('memory freshness', () => {
    it('says nothing has been indexed before the first search', async () => {
      const state = await service().memoryState();
      expect(state).toEqual({vectors: 0, index: false, behind: true});
    });

    it('is current once a search has refreshed the index', async () => {
      await service().search({query: 'tabs', scopes: ['memory']});
      const state = await service().memoryState();
      expect(state.index).toBe(true);
      expect(state.vectors).toBe(1);
      expect(state.behind).toBe(false);
    });

    /*
     * The case the note exists for: memory was written, nothing has searched
     * since, and the index still holds the bullets from before. The state has to
     * be read from the digests rather than remembered, because the refresh that
     * closes the gap is performed by a *search* — anything the service cached
     * would claim a freshness that only the next search can produce.
     */
    it('reports the index behind after the file changes', async () => {
      await service().search({query: 'tabs', scopes: ['memory']});
      memory = `${memory}- the user also prefers pnpm\n`;

      const state = await service().memoryState();
      expect(state.index).toBe(true);
      expect(state.behind).toBe(true);
      // Still the *old* count: the vectors are what is behind, not the file.
      expect(state.vectors).toBe(1);
    });

    /*
     * An empty memory is not behind. Nothing to embed and nothing embedded is the
     * same state, and a note saying otherwise would be a sentence the model reads
     * on the very first write of a fresh install.
     */
    it('is not behind when the file has no bullets at all', async () => {
      memory = '';
      expect(await service().memoryState()).toEqual({
        vectors: 0,
        index: false,
        behind: false,
      });
    });

    it('has no memory state to report when memory is not a corpus', async () => {
      expect(await service({memory: false}).memoryState()).toEqual({
        vectors: 0,
        index: false,
        behind: false,
      });
    });

    /*
     * The warm is a delegation and nothing more. Asserting the call rather than
     * an effect is deliberate: what "up" means belongs to the engine, and a
     * service that embedded something here would be a second thing deciding what
     * has to be in the index.
     */
    it('warms the engine without embedding anything', async () => {
      let warms = 0;
      let embedded = 0;
      const recall = new RecallService({
        workspaceRoot: workspace,
        dir: indexDir,
        model: MODEL,
        embed: async (texts) => {
          embedded += texts.length;
          return await fakeEmbedder()(texts);
        },
        readMemory: async () => memory,
        warm: async () => {
          warms += 1;
        },
      });

      await recall.warm();
      expect(warms).toBe(1);
      expect(embedded).toBe(0);
    });

    it('has nothing to warm when the caller supplied no engine', async () => {
      await expect(service().warm()).resolves.toBeUndefined();
    });
  });
});
