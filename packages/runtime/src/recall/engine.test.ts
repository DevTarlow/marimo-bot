/**
 * The recall engine's life, with a fake process and a fake HTTP.
 *
 * The interesting failures here are all about a *second* engine, and none of
 * them is visible from the window: one that never stops is 400 MB of weights
 * and a fan on somebody's laptop; one that is killed under a request turns a
 * good answer into a failure; one whose argv belongs to a chat server is a process
 * that starts, loads, moves no vectors at all, and reports itself healthy. So
 * the spawn and the two HTTP calls are injected, and the argv is asserted as an
 * array.
 *
 * What is not faked is the idle timer or the queue, because those are the two
 * behaviours this class adds over the supervisor it wraps.
 */
import {EventEmitter} from 'node:events';
import {mkdtemp, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {PassThrough} from 'node:stream';

import {afterEach, beforeEach, describe, expect, it} from 'vitest';

import {
  EMBEDDING_PINS,
  embeddingPidFile,
  recallSpec,
} from '../local-model/index.js';
import {EmbeddingError} from './client.js';
import {RecallEngine} from './engine.js';

/**
 * As much of a child process as the supervisor touches.
 *
 * The pid is *this* process, and that is deliberate rather than lazy. The
 * supervisor reaps whatever pid a leftover pid file names before it starts
 * anything, and a test that runs two engines over one directory would otherwise
 * have the second one kill the first — which, in a test process, means killing a
 * vitest worker with SIGKILL and a report that says nothing about why. The
 * supervisor refuses to kill its own pid on purpose, so claiming to be it is the
 * one value that cannot do any harm here.
 */
class FakeChild extends EventEmitter {
  readonly pid = process.pid;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();

  kill(signal?: NodeJS.Signals): boolean {
    this.emit('exit', null, signal ?? 'SIGTERM');
    return true;
  }
}

describe('RecallEngine', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(process.cwd(), '.marimo-recall-'));
  });

  afterEach(async () => {
    await rm(dir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 20,
    });
  });

  /**
   * The spec, claiming both model files are there.
   *
   * Files that *say* they exist are enough: what the supervisor checks before a
   * spawn is the two presence booleans, and a test that had to write 300 MB to
   * disk to prove an argv is a test nobody runs.
   */
  function spec(options: {media?: boolean; projectorPresent?: boolean} = {}) {
    const resolved = recallSpec({
      dir,
      manifest: EMBEDDING_PINS,
      media: options.media ?? false,
    });
    return {
      ...resolved,
      files: {
        ...resolved.files,
        enginePresent: true,
        modelPresent: true,
        projectorPresent: options.projectorPresent ?? false,
        ...(options.media === true
          ? {projector: join(dir, EMBEDDING_PINS.weights.pieces.media.file)}
          : {}),
      },
    };
  }

  function engine(options: {
    child?: FakeChild;
    spec?: ReturnType<typeof spec>;
    spawns?: {count: number};
    argv?: string[][];
    idleMs?: number;
    onEmbed?: (body: unknown) => Response;
  }): RecallEngine {
    const child = options.child ?? new FakeChild();
    const spawnImpl = ((_file: string, args: string[]): FakeChild => {
      if (options.spawns) {
        options.spawns.count += 1;
      }
      options.argv?.push(args);
      return child;
    }) as unknown as typeof import('node:child_process').spawn;

    const fetchImpl = (async (url: string, init?: RequestInit) => {
      if (String(url).endsWith('/health')) {
        return {ok: true, status: 200} as Response;
      }
      const body =
        init?.body === undefined ? undefined : JSON.parse(String(init.body));
      return options.onEmbed === undefined
        ? new Response(
            JSON.stringify({
              data: [{index: 0, embedding: new Array<number>(768).fill(0.1)}],
              usage: {prompt_tokens: 3},
            }),
            {status: 200},
          )
        : options.onEmbed(body);
    }) as unknown as typeof fetch;

    return new RecallEngine({
      spec: () => options.spec ?? spec(),
      pidFile: embeddingPidFile(dir),
      dims: EMBEDDING_PINS.weights.dims,
      spawnImpl,
      fetchImpl,
      ...(options.idleMs === undefined ? {} : {idleMs: options.idleMs}),
    });
  }

  it('starts nothing until something asks for a vector', async () => {
    const spawns = {count: 0};
    const recall = engine({spawns});
    const status = await recall.status();

    expect(status.state).toBe('off');
    expect(spawns.count).toBe(0);
  });

  /*
   * The argv, asserted as data. This is the one thing that cannot be checked any
   * other way: an engine started with a chat server's flags loads the model,
   * answers `/health`, and embeds nothing — `--embeddings` is what restricts it
   * to the endpoint we call, and `--pooling mean` is what makes a single vector
   * come out of a long input at all.
   */
  it('starts the engine with the embedding flags', async () => {
    const argv: string[][] = [];
    await engine({argv}).embedText(['hello']);

    const args = argv[0] ?? [];
    expect(args).toContain('--embeddings');
    expect(args[args.indexOf('--pooling') + 1]).toBe('mean');
    expect(args).not.toContain('--jinja');
    expect(args).not.toContain('--flash-attn');
    // On the processor: this model's card warns about float16 activations, and
    // the CPU backend accumulates in f32.
    expect(args[args.indexOf('--n-gpu-layers') + 1]).toBe('0');
    // Both halves of the batch, or llama.cpp clamps one down to the other and
    // any media input over 512 tokens is refused with a 500.
    expect(args[args.indexOf('--batch-size') + 1]).toBe('4096');
    expect(args[args.indexOf('--ubatch-size') + 1]).toBe('4096');
    expect(args).toContain('--no-webui');
  });

  it('passes the projector only when this install has one', async () => {
    const without = engine({argv: []});
    await without.embedText(['hello']);

    const argv: string[][] = [];
    const withMedia = engine({
      argv,
      spec: spec({media: true, projectorPresent: true}),
    });
    await withMedia.embedText(['hello']);

    expect(argv[0]).toContain('--mmproj');
  });

  /*
   * Asked for but not downloaded is not "media preferred": the engine would fail
   * to load a file that is not there, and the failure a user would see would be
   * about a path rather than about a download they have not done.
   */
  it('leaves the projector off when the file is missing', async () => {
    const argv: string[][] = [];
    await engine({
      argv,
      spec: spec({media: true, projectorPresent: false}),
    }).embedText(['hello']);

    expect(argv[0]).not.toContain('--mmproj');
  });

  it('answers with the engine’s vectors', async () => {
    const result = await engine({}).embedText(['hello']);

    expect(result.vectors).toHaveLength(1);
    expect(result.vectors[0]?.length).toBe(768);
    expect(result.tokens).toBe(3);
  });

  it('stops itself after sitting idle', async () => {
    const child = new FakeChild();
    const recall = engine({child, idleMs: 20});

    await recall.embedText(['hello']);
    expect(await recall.status()).toMatchObject({state: 'ready'});

    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(await recall.status()).toMatchObject({state: 'off'});
    // The stop is the same one `stop()` does, so the pid file is gone too.
    await recall.stop();
  });

  /*
   * One engine, one request at a time. Two embeds in flight would be two
   * requests against a server started with `--parallel 1`, which is a queue
   * inside the engine rather than in front of it — and the caller waiting on the
   * second would be waiting on work it cannot see.
   */
  it('runs one embed at a time, in the order they were asked for', async () => {
    const order: string[] = [];
    const recall = engine({
      onEmbed: (body) => {
        const text = (body as {input: Array<{content: Array<{text: string}>}>})
          .input[0]?.content[0]?.text;
        order.push(text ?? '');
        return new Response(
          JSON.stringify({
            data: [{index: 0, embedding: new Array<number>(768).fill(0.1)}],
            usage: {prompt_tokens: 1},
          }),
          {status: 200},
        );
      },
    });

    await Promise.all([
      recall.embedText(['first']),
      recall.embedText(['second']),
      recall.embedText(['third']),
    ]);

    expect(order).toEqual(['first', 'second', 'third']);
  });

  it('reports a start failure as a sentence rather than as a broken promise', async () => {
    const failing = recallSpec({
      dir: join(dir, 'nothing-here'),
      manifest: EMBEDDING_PINS,
      media: false,
    });
    const recall = engine({
      spec: {...failing, files: {...failing.files, enginePresent: false}},
    });

    await expect(recall.embedText(['hello'])).rejects.toThrow(EmbeddingError);
    await expect(recall.embedText(['hello'])).rejects.toThrow(
      /engine is not installed/u,
    );
  });

  /*
   * The pid file names a process the next start will SIGKILL, so it has to be
   * this engine's own name in the directory both processes resolve — never a
   * path another part of the app might also write.
   */
  it('keeps its pid file under a name only this engine writes', () => {
    expect(embeddingPidFile('/data')).toBe(join('/data', 'recall.pid'));
  });
});
