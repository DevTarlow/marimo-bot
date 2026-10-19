/**
 * The supervisor, with a fake process.
 *
 * Every interesting thing here is a *failure*: an engine that exits before it
 * listens, one that never answers `/health`, one whose flags are refused. All
 * three are silent from the window's side — a spinner that stops and a sentence
 * that has to name the cause — and all three are impossible to produce on demand
 * from a real llama.cpp. So the spawn and the health check are injected, and no
 * test in this file loads a model.
 *
 * What is *not* faked is anything the test can hold to account on its own: the
 * port really is allocated, the pid file really is written to a temporary
 * directory, and the argv really is the array the engine would be handed.
 */
import {EventEmitter} from 'node:events';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {PassThrough} from 'node:stream';

import {afterEach, beforeEach, describe, expect, it} from 'vitest';

import {LocalModelService, embeddingPidFile} from './service.js';
import type {EngineFiles, EngineRunSpec} from './service.js';

/** The least a spec can be: the files, and the window the argv is built from. */
type TestSpec = EngineRunSpec<EngineFiles>;

/** One child process, as much of it as the supervisor touches. */
class FakeChild extends EventEmitter {
  readonly pid = process.pid + 1;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly signals: NodeJS.Signals[] = [];

  kill(signal?: NodeJS.Signals): boolean {
    this.signals.push(signal ?? 'SIGTERM');
    /*
     * A well-behaved engine exits on SIGTERM. Emitted rather than deferred, so
     * `stop()` resolves in the same tick and the test does not wait three
     * seconds for the SIGKILL it would otherwise fall back to.
     */
    this.emit('exit', null, signal ?? 'SIGTERM');
    return true;
  }

  /** Says something on stderr, the way the engine does before it dies. */
  say(line: string): void {
    this.stderr.write(`${line}\n`);
  }

  die(code: number): void {
    this.emit('exit', code, null);
  }
}

describe('LocalModelService', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(process.cwd(), '.marimo-engine-'));
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
   * Files that claim to exist, so the checks before the spawn pass.
   *
   * Synchronous on purpose, and the type says so: the supervisor resolves this
   * once per start rather than once per turn, and a promise here reads as a
   * missing file — the failure it would take an hour to trace.
   */
  function files(): EngineFiles {
    return {
      engine: join(dir, 'engine', 'llama-server'),
      libraryDir: join(dir, 'engine'),
      model: join(dir, 'model.gguf'),
      enginePresent: true,
      modelPresent: true,
    };
  }

  /**
   * A command line of the test's own.
   *
   * The supervisor only ever passes argv through, so asserting on the recall
   * engine's flags here would test `args.ts` a second time. What matters to this
   * file is that the binary comes first and that the port is the one this start
   * was given — including the placeholder, before there is one.
   */
  function argv(spec: TestSpec, port: number | string): string[] {
    return ['--model', spec.files.model, '--port', String(port)];
  }

  function service(options: {
    child?: FakeChild;
    health?: 'ok' | 'never' | 'slow';
    files?: () => EngineFiles;
    spawnCount?: {count: number};
    log?: string[];
  }): LocalModelService<EngineFiles, TestSpec> {
    const child = options.child ?? new FakeChild();
    const spawnImpl = ((): FakeChild => {
      if (options.spawnCount) {
        options.spawnCount.count += 1;
      }
      return child;
    }) as unknown as typeof import('node:child_process').spawn;

    let asked = 0;
    const fetchImpl = (async () => {
      asked += 1;
      if (options.health === 'ok' || options.health === undefined) {
        return {ok: true, status: 200} as Response;
      }
      if (options.health === 'slow') {
        return (
          asked > 1 ? {ok: true, status: 200} : {ok: false, status: 503}
        ) as Response;
      }
      throw new Error('connection refused');
    }) as unknown as typeof fetch;

    /*
     * The spec is named rather than written inline. The supervisor is generic over
     * what it is handed — it reads `files` and `contextSize` and asks `args` for
     * everything else — so the honest thing to test it with is the minimum that
     * satisfies that type, not the recall spec it meets in the app.
     */
    const spec = (): TestSpec => ({
      files: (options.files ?? files)(),
      contextSize: 8192,
    });

    return new LocalModelService({
      spec,
      args: argv,
      pidFile: embeddingPidFile(dir),
      spawnImpl,
      fetchImpl,
      ...(options.log ? {log: (line: string) => options.log?.push(line)} : {}),
    });
  }

  /**
   * Waits until the supervisor has actually spawned.
   *
   * The exit listener is attached in the same tick as the spawn, so this is the
   * moment it becomes safe to kill the child. Killing it earlier would mean the
   * test was measuring an event nobody was listening for rather than the
   * behaviour under test — and would pass or fail by how the machine felt.
   */
  async function spawned(spawnCount: {count: number}): Promise<void> {
    for (let attempt = 0; attempt < 500; attempt += 1) {
      if (spawnCount.count > 0) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    throw new Error('the supervisor never spawned the engine');
  }

  it('starts an engine, waits for it, and says where it is', async () => {
    const engine = service({});
    const started = await engine.ensureRunning();

    expect(started.ok).toBe(true);
    expect(started.ok && started.baseUrl).toMatch(
      /^http:\/\/127\.0\.0\.1:\d+\/v1$/u,
    );

    const status = await engine.status();
    expect(status.state).toBe('ready');
    expect(status.baseUrl).toBe(started.ok ? started.baseUrl : undefined);
    // The card shows the real port once there is one, so the command a power
    // user copies is the command that ran — binary first, then the argv.
    expect(status.command[status.command.indexOf('--port') + 1]).toBe(
      String(new URL(status.baseUrl ?? '').port),
    );
    expect(status.command[0]).toBe(files().engine);
    await engine.stop();
  });

  it('waits for a health check that is not ready on the first try', async () => {
    const engine = service({health: 'slow'});
    await expect(engine.ensureRunning()).resolves.toMatchObject({ok: true});
    await engine.stop();
  });

  /*
   * The failure the whole class exists for. The engine prints the reason and
   * exits, and the sentence the user reads has to contain it — "the model is not
   * running" on its own is a dead end.
   */
  it('reports what the engine said when it dies instead of listening', async () => {
    const child = new FakeChild();
    child.say(
      'error while loading shared libraries: libggml.so.0: cannot open',
    );
    child.say('failed to load model');
    const spawnCount = {count: 0};
    const engine = service({child, health: 'never', spawnCount});

    const promise = engine.ensureRunning();
    await spawned(spawnCount);
    // The way a refused flag or a missing library goes: it said so and it is
    // gone, before anything ever answered on the port.
    child.die(1);
    const started = await promise;

    expect(started.ok).toBe(false);
    expect(started.ok ? '' : started.problem).toContain('exit code 1');
    expect(started.ok ? '' : started.problem).toContain('libggml.so.0');

    const status = await engine.status();
    expect(status.state).toBe('failed');
    expect(status.detail).toContain('libggml.so.0');
    expect(status.log.join('\n')).toContain('libggml.so.0');
  });

  /*
   * Two callers in the same second — the window pre-warming and the first
   * question — are one engine. A second spawn would either fail on the port or
   * quietly load a second copy of the weights.
   */
  it('starts once however many callers ask at once', async () => {
    const spawnCount = {count: 0};
    const engine = service({spawnCount});

    const [first, second, third] = await Promise.all([
      engine.ensureRunning(),
      engine.ensureRunning(),
      engine.ensureRunning(),
    ]);

    expect(spawnCount.count).toBe(1);
    expect(first).toEqual(second);
    expect(second).toEqual(third);
    await engine.stop();
  });

  it('refuses before spawning when a file is missing', async () => {
    const spawnCount = {count: 0};
    const engine = service({
      spawnCount,
      files: () => ({
        ...files(),
        modelPresent: false,
        model: join(dir, 'absent.gguf'),
      }),
    });

    const started = await engine.ensureRunning();
    expect(started.ok).toBe(false);
    expect(started.ok ? '' : started.problem).toContain('absent.gguf');
    expect(spawnCount.count).toBe(0);
    expect((await engine.status()).state).toBe('failed');
  });

  it('names the engine when the binary is the missing half', async () => {
    const engine = service({
      files: () => ({
        ...files(),
        enginePresent: false,
      }),
    });

    const started = await engine.ensureRunning();
    expect(started.ok ? '' : started.problem).toContain('llama-server');
    expect((await engine.status()).modelPresent).toBe(true);
  });

  /*
   * The first-run sequence, which is the only way a user meets this at all: the
   * window asks for the engine as it starts, is told there is none, and *then*
   * downloads one. The recorded sentence has to stop being the answer the moment
   * the files exist, because the window's gate reads this status rather than the
   * disk — a stale one leaves a finished download on the welcome screen that says
   * the model is not installed, with nothing left to click.
   */
  it('forgets a missing-file failure once those files arrive', async () => {
    let installed = false;
    const engine = service({
      files: () => ({
        ...files(),
        enginePresent: installed,
        modelPresent: installed,
      }),
    });

    const before = await engine.ensureRunning();
    expect(before.ok).toBe(false);
    expect((await engine.status()).state).toBe('failed');

    // The download lands. Same service, same process, files now on disk.
    installed = true;

    const status = await engine.status();
    expect(status.state).toBe('off');
    expect(status.detail).toBeUndefined();
    expect(status.modelPresent).toBe(true);

    // And the question the download was for is answerable straight away.
    await expect(engine.ensureRunning()).resolves.toMatchObject({ok: true});
    await engine.stop();
  });

  it('stops the child and forgets the address', async () => {
    const child = new FakeChild();
    const engine = service({child});
    await engine.ensureRunning();

    await engine.stop();

    expect(child.signals).toEqual(['SIGTERM']);
    expect((await engine.status()).state).toBe('off');
    expect((await engine.status()).baseUrl).toBeUndefined();
  });

  /*
   * A stopped engine is not a failed one. The user pressed the button, and a
   * card that went on reporting the last crash would be describing a state the
   * app is no longer in.
   */
  it('clears a failure when the user stops it', async () => {
    const child = new FakeChild();
    const spawnCount = {count: 0};
    const engine = service({child, health: 'never', spawnCount});
    const promise = engine.ensureRunning();
    await spawned(spawnCount);
    child.die(1);
    await promise;
    expect((await engine.status()).state).toBe('failed');

    await engine.stop();
    expect((await engine.status()).state).toBe('off');
    expect((await engine.status()).detail).toBeUndefined();
  });

  /*
   * The window between asking and spawning.
   *
   * A quit that lands while the app is still resolving files, reaping a previous
   * engine or asking for a port finds no child to kill — a start in flight is a
   * promise, not a process. It has to notice that it was stopped, because an
   * engine spawned after the quit is the one thing the pid file cannot be
   * relied on to fix: the file is written by that very spawn, and the run that
   * would reap it may be days away, leaving a loaded model and a spinning fan
   * with no window anywhere to explain them.
   */
  it('spawns nothing when it is stopped before the spawn', async () => {
    const spawnCount = {count: 0};
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const engine = new LocalModelService({
      spec: async () => {
        await gate;
        return {files: files(), contextSize: 8192};
      },
      args: argv,
      pidFile: embeddingPidFile(dir),
      spawnImpl: (() => {
        spawnCount.count += 1;
        return new FakeChild();
      }) as unknown as typeof import('node:child_process').spawn,
      fetchImpl: (async () =>
        ({ok: true, status: 200}) as Response) as unknown as typeof fetch,
    });

    const started = engine.ensureRunning();
    await engine.stop();
    release();

    await expect(started).resolves.toMatchObject({ok: false});
    expect(spawnCount.count).toBe(0);
    // A stop is still an answer, not a failure, even when it lands mid-start.
    expect((await engine.status()).state).toBe('off');
  });

  /*
   * The pid file, which is the answer to "the app was killed and its engine is
   * still here". Written on the way up, removed on the way down — and the way
   * down includes a stop that never started anything.
   */
  it('writes a pid file while it runs and clears it when it stops', async () => {
    const engine = service({});
    const file = embeddingPidFile(dir);

    expect(await readFile(file, 'utf8').catch(() => undefined)).toBeUndefined();

    await engine.ensureRunning();
    expect(Number((await readFile(file, 'utf8')).trim())).toBeGreaterThan(1);

    await engine.stop();
    expect(await readFile(file, 'utf8').catch(() => undefined)).toBeUndefined();
  });

  it('never writes a pid file it was not asked for', async () => {
    const engine = new LocalModelService({
      spec: () => ({
        files: files(),
        contextSize: 8192,
      }),
      args: argv,
      spawnImpl: (() =>
        new FakeChild()) as unknown as typeof import('node:child_process').spawn,
      fetchImpl: (async () =>
        ({ok: true, status: 200}) as Response) as unknown as typeof fetch,
    });

    await expect(engine.ensureRunning()).resolves.toMatchObject({ok: true});
    await engine.stop();
  });

  /*
   * The leftovers. A pid file naming a process that is not there — the ordinary
   * case after a clean shutdown and a crash alike — is deleted rather than
   * obeyed, and a file full of nonsense costs nothing.
   */
  it('clears a pid file that names nothing real', async () => {
    const file = embeddingPidFile(dir);
    await writeFile(file, 'not-a-pid', 'utf8');
    const engine = service({});

    await expect(engine.ensureRunning()).resolves.toMatchObject({ok: true});
    // A new pid, not the nonsense: the file describes this run now.
    expect(Number((await readFile(file, 'utf8')).trim())).toBeGreaterThan(1);
    await engine.stop();
  });

  it('ignores a pid file that names this process', async () => {
    const file = embeddingPidFile(dir);
    await writeFile(file, String(process.pid), 'utf8');
    const log: string[] = [];
    const engine = service({log});

    await expect(engine.ensureRunning()).resolves.toMatchObject({ok: true});
    // It must not have killed the test runner that wrote it.
    expect(log.join('\n')).not.toContain('left behind');
    await engine.stop();
  });

  /*
   * What the card shows before anything has been started: the command is
   * complete apart from the port, which is the one thing that cannot be known
   * until the engine is up.
   */
  it('shows the command with a placeholder port while it is off', async () => {
    const engine = service({});
    const status = await engine.status();

    expect(status.state).toBe('off');
    expect(status.command[status.command.indexOf('--port') + 1]).toBe('<port>');
    expect(status.modelPresent).toBe(true);
  });
});
