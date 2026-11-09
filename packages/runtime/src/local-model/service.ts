/**
 * A llama.cpp engine, supervised.
 *
 * The recall model's engine is the one this runs, and it is a *process*: one
 * long-lived child, started on demand and stopped when the app goes away.
 * Everything here exists because that goes wrong in three silent ways:
 *
 * 1. **It never comes up.** A missing shared library, an unsupported flag, a
 *    corrupted file — the engine prints one line to stderr and exits non-zero.
 *    So the last of what it said is kept and handed to whoever asked, because
 *    "the model is not running" without it is a dead end.
 * 2. **It comes up somewhere else.** The port is whatever was free a moment ago,
 *    so the address is read back from the supervisor rather than stored — a
 *    fixed port in a settings file is a promise about a machine this app does not
 *    own.
 * 3. **It outlives the app.** A stray `llama-server` is 400 MB of memory and a
 *    spinning fan on somebody's laptop with no window that explains it. A pid
 *    file, a kill on the way out, and a check on the way in.
 *
 * `spawnImpl` and `fetchImpl` are injected, so no test starts an engine: the
 * interesting failures are all about what happens when a child misbehaves, and a
 * test that had to load a model to cause them would not be run.
 */
import {spawn} from 'node:child_process';
import type {ChildProcess} from 'node:child_process';
import {readFile, rm, writeFile} from 'node:fs/promises';
import {createServer} from 'node:net';
import {join} from 'node:path';

/** How long the engine gets to load the weights and answer `/health`. */
const READY_TIMEOUT_MS = 90_000;
const READY_POLL_MS = 250;

/** How long it gets to exit politely before it is killed. */
const STOP_GRACE_MS = 3_000;

/**
 * How many of the engine's lines are kept for the window.
 *
 * Enough to hold a failure — a missing library is one line, a rejected flag is
 * two or three with the usage text — and short enough to be a card in a dialog.
 * The first lines are the ones worth having, because a llama.cpp load announces
 * what it is doing before it fails.
 */
const LOG_LINES = 40;

export interface LocalModelOptions<
  T extends EngineFiles,
  S extends EngineRunSpec<T>,
> {
  /**
   * Resolved fresh on every start and every status, so a settings change shows
   * up on the next question rather than the next launch.
   *
   * May be asynchronous, and await is used either way: both callers read a file
   * to answer it, and a callback that had to be synchronous would push that read
   * into whoever assembled this object — where the first symptom of getting it
   * wrong is "the engine is not installed, it should be at undefined".
   */
  spec: () => S | Promise<S>;
  /**
   * The command line, as data, for whatever model this supervisor is running.
   *
   * Required rather than defaulted: this class knows nothing about the model it
   * runs — not the flags, not the pooling, not whether a projector is passed — so
   * an argv with a fallback would be a second, silent definition of the command
   * line, and which one the engine actually got would be nobody's answer. A
   * supervisor duplicated to build argv would be a second copy of the pid file,
   * the reap, the health poll and the log tail, and every one of those is a
   * failure this class exists to have already handled.
   *
   * It is handed the whole spec rather than the fields this class reads, because
   * the resolver is allowed to know things the supervisor is not — the recall
   * spec carries the pooling its argv needs — and a callback typed to a
   * stripped-down spec would be a place a caller's field could go missing with
   * no type error to say so.
   */
  args: (spec: S, port: number | string) => string[];
  /** Where the pid file goes. Absent means no stray-process protection. */
  pidFile?: string;
  log?: (line: string) => void;
  spawnImpl?: typeof spawn;
  fetchImpl?: typeof fetch;
}

/**
 * What the supervisor needs to know about the files, whatever is being run.
 *
 * Narrower than what a caller resolves on purpose: the supervisor reads the
 * engine, the directory its libraries are in, and whether the two files it needs
 * are there. Everything else — the projector, the pooling, whether media was
 * asked for — belongs to whoever resolved the spec and reaches the argv through
 * `args`.
 */
export interface EngineFiles {
  engine: string;
  libraryDir: string;
  model: string;
  enginePresent: boolean;
  modelPresent: boolean;
}

/**
 * The files, plus the one number the argv is built from.
 *
 * `args` gets the whole spec, so a caller's spec is allowed to carry anything
 * else it needs — the recall spec's `pooling` and `media` are its own business —
 * and this stays the part the supervisor itself reads.
 */
export interface EngineRunSpec<T extends EngineFiles> {
  files: T;
  contextSize: number;
}

/**
 * What the supervisor answers when anything asks what it is doing.
 *
 * The shape came from the old chat model card's status and stayed when that card
 * did. A status is a fact about a *process this
 * class started*, so it belongs beside the class rather than in the IPC contract,
 * and the recall card is the one reader left.
 *
 * `modelPresent`, `enginePresent`, `modelPath` and `enginePath` are produced for
 * every caller and read by none of them: the recall card asks `resolveRecallFiles`
 * and `recallPiecesInstalled` for the same facts, because it has to tell "asked
 * for and not downloaded" from "not asked for", and two booleans cannot say that.
 * They stay because a status describes the files it was built from — "off" is not
 * an answer without knowing which engine and which model were looked for.
 */
export interface EngineStatus {
  state: 'off' | 'starting' | 'ready' | 'failed';
  baseUrl?: string;
  detail?: string;
  modelPresent: boolean;
  enginePresent: boolean;
  modelPath: string;
  enginePath: string;
  command: string[];
  log: string[];
}

type Child = Pick<
  ChildProcess,
  'pid' | 'stdout' | 'stderr' | 'kill' | 'once' | 'removeListener'
>;

type Started = {ok: true; baseUrl: string} | {ok: false; problem: string};

export class LocalModelService<
  T extends EngineFiles,
  S extends EngineRunSpec<T>,
> {
  private child: Child | undefined;
  private starting: Promise<Started> | undefined;
  private url: string | undefined;
  private port: number | undefined;
  /**
   * The last start failure, with the file situation it was recorded against.
   *
   * The two presence flags are here because a failure about *missing files* has a
   * shelf life: it is the answer to a question a download changes. Reported after
   * the files have arrived, it is what leaves the Recall card saying the model is
   * not installed — the card reads this, not the disk — and the download that
   * just finished is the one thing that disproves it.
   */
  private failure:
    | {problem: string; enginePresent: boolean; modelPresent: boolean}
    | undefined;
  /**
   * Bumped by `stop`, so a start already in flight can see that it was stopped.
   *
   * `stop` is what a quit calls, and a start in flight is a promise rather than a
   * process: it has asked for the files, reaped a previous engine and asked for a
   * port without spawning anything yet, so there is no child for `stop` to kill.
   * Counted rather than held as a flag, because a stop is not the end of the
   * supervisor — a caller that asks again afterwards gets a fresh start.
   */
  private generation = 0;
  private readonly log: string[] = [];

  constructor(private readonly options: LocalModelOptions<T, S>) {}

  /**
   * Starts the engine if it is not already up, and answers where it is.
   *
   * Concurrent callers share one start: the window pre-warming and a turn
   * beginning a moment later are one engine, not two, and a second spawn would
   * either fail on the port or quietly load a second copy of the weights.
   */
  async ensureRunning(): Promise<Started> {
    if (this.url !== undefined) {
      return {ok: true, baseUrl: this.url};
    }
    if (this.starting !== undefined) {
      return await this.starting;
    }

    this.starting = this.start();
    try {
      return await this.starting;
    } finally {
      this.starting = undefined;
    }
  }

  /** Stops the engine, if this process is the one that started it. */
  async stop(): Promise<void> {
    const child = this.child;
    this.child = undefined;
    this.url = undefined;
    this.port = undefined;
    /*
     * Any start that is still resolving is told to abandon, here and not later:
     * it is about to spawn, and a child born after the quit is one nothing will
     * outlive to stop. The pid file is not a substitute — the spawn writes it.
     */
    this.generation += 1;
    /*
     * A stop is an answer, so it clears a failure. The user pressed the button,
     * and a card that went on saying "it stopped immediately" about a run that
     * was deliberately ended would be describing a state the app is not in.
     */
    this.failure = undefined;
    if (child === undefined) {
      await this.clearPidFile();
      return;
    }

    await new Promise<void>((resolve) => {
      const done = (): void => {
        resolve();
      };
      child.once('exit', done);
      child.kill('SIGTERM');
      const timer = setTimeout(() => {
        // Still there: it is not going to stop on its own, and a process holding
        // a gigabyte of weights is worse than an abrupt end.
        child.kill('SIGKILL');
        done();
      }, STOP_GRACE_MS);
      timer.unref?.();
      child.once('exit', () => {
        clearTimeout(timer);
      });
    });

    await this.clearPidFile();
  }

  async status(): Promise<EngineStatus> {
    const spec = await this.options.spec();
    const {files} = spec;
    const failure = this.liveFailure(files);
    const state: EngineStatus['state'] =
      this.url !== undefined
        ? 'ready'
        : this.starting !== undefined
          ? 'starting'
          : failure !== undefined
            ? 'failed'
            : 'off';

    return {
      state,
      ...(this.url === undefined ? {} : {baseUrl: this.url}),
      ...(failure === undefined ? {} : {detail: failure}),
      modelPresent: files.modelPresent,
      enginePresent: files.enginePresent,
      modelPath: files.model,
      enginePath: files.engine,
      command: this.command(spec),
      log: [...this.log],
    };
  }

  /**
   * The exact command line, with the port filled in once there is one.
   *
   * Shown to a power user, and worth showing for the same reason
   * `service.definitionPath` is: it is the difference between "the app runs a
   * model" and being able to run the same thing by hand and see what it says.
   */
  private command(spec: S): string[] {
    return [spec.files.engine, ...this.options.args(spec, this.port ?? '<port>')];
  }

  private async start(): Promise<Started> {
    this.failure = undefined;
    this.log.length = 0;
    const generation = this.generation;

    const spec = await this.options.spec();
    const {files} = spec;
    if (!files.enginePresent) {
      return this.fail(
        `The model engine is not installed. It should be at ${files.engine}.`,
        files,
      );
    }
    if (!files.modelPresent) {
      return this.fail(
        `The model file is not installed. It should be at ${files.model}.`,
        files,
      );
    }

    /*
     * Anything left over from a previous run, before a port is chosen and before
     * a second copy of the weights is loaded. Best effort: a pid file that names
     * a process which is not ours is deleted rather than obeyed.
     */
    await this.reapPrevious();

    const port = await freePort();

    /*
     * The last place a stop can be noticed, and the only one needed: everything
     * from here to the spawn is synchronous, so nothing can interleave between
     * this check and the child existing. Asked again after the waits above
     * because a quit during any of them finds no child to kill.
     *
     * Answered without recording a failure, because a stop is not one — and the
     * `stop` that got here has just cleared the last failure for this reason.
     */
    if (this.generation !== generation) {
      return {ok: false, problem: 'The model was stopped.'};
    }

    const args = this.options.args(spec, port);

    const spawnImpl = this.options.spawnImpl ?? spawn;
    let child: Child;
    try {
      child = spawnImpl(files.engine, args, {
        // The released archives expect to be run from where they were unpacked,
        // and their shared libraries sit beside the binary.
        cwd: files.libraryDir,
        env: {...process.env, LD_LIBRARY_PATH: libraryPath(files)},
        stdio: ['ignore', 'pipe', 'pipe'],
      }) as Child;
    } catch (failure) {
      return this.fail(
        `The model engine could not be started: ${describe(failure)}`,
        files,
      );
    }

    this.child = child;
    this.capture(child);

    /*
     * An early exit is a failure, and the only place it can be reported from is
     * here: the promise below is racing the health check against the child
     * going away, and a spawn that rejects with nobody listening is an unhandled
     * error rather than a sentence in a dialog.
     *
     * Attached before the pid file is written, in the same tick as the spawn, so
     * there is no window in which an engine that dies instantly — a refused
     * flag, a missing library — is anything other than a failure this code has
     * already heard about. It also covers the engine dying *after* it was ready,
     * which is a crash mid-turn: clearing the address is the point, so the next
     * call starts a new one rather than handing out a URL with nothing behind it.
     */
    const exited = new Promise<Started>((resolve) => {
      child.once('exit', (code, signal) => {
        if (this.child !== child) {
          // Stopped on purpose. `stop` is the only caller that does this, and it
          // has already answered whoever was waiting.
          resolve({ok: false, problem: 'The model was stopped.'});
          return;
        }
        this.child = undefined;
        this.url = undefined;
        this.port = undefined;
        resolve(
          this.fail(
            `The model engine stopped (${describeExit(code, signal)}). ` +
              this.tail(),
            files,
          ),
        );
      });
    });

    await this.writePidFile(child.pid);

    const baseUrl = `http://127.0.0.1:${String(port)}/v1`;
    const ready = this.waitForHealth(baseUrl, files);
    const result = await Promise.race([ready, exited]);
    if (!result.ok) {
      return result;
    }

    this.url = baseUrl;
    this.port = port;
    this.options.log?.(`[marimo] the built-in model is up at ${baseUrl}`);
    return {ok: true, baseUrl};
  }

  /** Polls `/health` until it answers, or gives up. */
  private async waitForHealth(
    baseUrl: string,
    files: EngineFiles,
  ): Promise<Started> {
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const deadline = Date.now() + READY_TIMEOUT_MS;

    while (Date.now() < deadline) {
      try {
        const response = await fetchImpl(`${baseUrl}/health`, {
          signal: AbortSignal.timeout(2_000),
        });
        if (response.ok) {
          return {ok: true, baseUrl};
        }
      } catch {
        // Not listening yet, which is the normal answer for the first second or
        // two while a gigabyte of weights is mapped.
      }
      await delay(READY_POLL_MS);
    }

    return this.fail(
      `The model did not finish loading within ${String(
        Math.round(READY_TIMEOUT_MS / 1000),
      )} seconds. ${this.tail()}`,
      files,
    );
  }

  private capture(child: Child): void {
    for (const stream of [child.stdout, child.stderr]) {
      stream?.setEncoding('utf8');
      stream?.on('data', (chunk: string) => {
        for (const line of chunk.split('\n')) {
          if (line.trim().length === 0) {
            continue;
          }
          this.log.push(line.trimEnd());
          while (this.log.length > LOG_LINES) {
            this.log.shift();
          }
        }
      });
    }
  }

  /**
   * The recorded failure, while it still describes these files.
   *
   * A failure is recorded once and read on every settings load, and what it was
   * about can change underneath it — that is what a download *is*: the card asks
   * for the engine, is told there is none, and then downloads one.
   * Only a change in which files are present invalidates the answer, because that
   * is the premise the sentence was built on. An engine that is here and crashes
   * is a failure about the engine, and it stands until the next start.
   */
  private liveFailure(files: EngineFiles): string | undefined {
    const failure = this.failure;
    if (failure === undefined) {
      return undefined;
    }
    return failure.enginePresent === files.enginePresent &&
      failure.modelPresent === files.modelPresent
      ? failure.problem
      : undefined;
  }

  private fail(problem: string, files: EngineFiles): Started {
    this.failure = {
      problem,
      enginePresent: files.enginePresent,
      modelPresent: files.modelPresent,
    };
    this.options.log?.(`[marimo] ${problem}`);
    return {ok: false, problem};
  }

  /** The engine's own words, so a failure names its cause. */
  private tail(): string {
    const lines = this.log.slice(-6);
    return lines.length === 0 ? 'It printed nothing.' : lines.join('\n');
  }

  /*
   * The pid file.
   *
   * One file, holding one pid, written after the spawn and removed on the way
   * out. It exists for the case neither the app nor the runner can cover: this
   * process killed without warning, leaving an engine that nothing will ever
   * stop. The next start reads it, checks the process is still there, and kills
   * it before loading another copy.
   */

  private async writePidFile(pid: number | undefined): Promise<void> {
    const file = this.options.pidFile;
    if (file === undefined || pid === undefined) {
      return;
    }
    try {
      await writeFile(file, String(pid), 'utf8');
    } catch {
      // Not fatal, and deliberately not reported: this is a courtesy to the
      // *next* run, and failing to write it costs one stray process at worst.
    }
  }

  private async clearPidFile(): Promise<void> {
    const file = this.options.pidFile;
    if (file === undefined) {
      return;
    }
    await rm(file, {force: true}).catch(() => undefined);
  }

  private async reapPrevious(): Promise<void> {
    const file = this.options.pidFile;
    if (file === undefined) {
      return;
    }
    let pid: number;
    try {
      pid = Number((await readFile(file, 'utf8')).trim());
    } catch {
      return;
    }
    if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) {
      await this.clearPidFile();
      return;
    }

    try {
      // Signal 0 asks whether the process exists without touching it.
      process.kill(pid, 0);
      process.kill(pid, 'SIGKILL');
      this.options.log?.(
        `[marimo] stopped a model engine left behind by an earlier run (${String(pid)})`,
      );
    } catch {
      // Already gone, which is the usual case and not worth a word.
    }
    await this.clearPidFile();
  }
}

/**
 * A port nothing is listening on, asked for rather than guessed.
 *
 * Between this and the spawn the port can be taken, which is what the engine's
 * own failure to bind looks like: one line of stderr and an exit. That is
 * reported with the engine's words, which is the honest answer — a retry loop
 * here would hide a machine that genuinely has no free ports.
 */
export async function freePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port =
        address !== null && typeof address === 'object' ? address.port : 0;
      server.close(() => {
        resolve(port);
      });
    });
  });
}

/** `LD_LIBRARY_PATH`, keeping whatever the user's environment already had. */
function libraryPath(files: EngineFiles): string {
  const existing = process.env['LD_LIBRARY_PATH'];
  return existing !== undefined && existing.length > 0
    ? `${files.libraryDir}:${existing}`
    : files.libraryDir;
}

function describeExit(code: number | null, signal: string | null): string {
  if (signal !== null) {
    return `killed by ${signal}`;
  }
  return `exit code ${String(code ?? 'unknown')}`;
}

function describe(failure: unknown): string {
  return failure instanceof Error ? failure.message : String(failure);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Where the recall engine's pid file lives, given a user-data directory.
 *
 * `recall.pid` rather than a generic name, because `reapPrevious` SIGKILLs
 * whatever pid the file names before loading its own model: the file has to be
 * one only this engine writes. The directory is the user-data one both processes
 * already resolve the same way, which is what lets the runner reap a window's
 * engine that outlived a crash.
 */
export function embeddingPidFile(userData: string): string {
  return join(userData, 'recall.pid');
}
