/**
 * Voice input in the main process: the model's download, the CPU graphs and the
 * one microphone lease every window shares.
 *
 * The split with `@marimo/runtime` is deliberate. That package owns the
 * arithmetic — padding, the frontend loop, the windowed encoder, greedy
 * decoding, the token table — and knows nothing about a native module. This file
 * owns the process-shaped facts: the model directory, the download's events, a
 * lazy five-graph load, one transcription at a time, the microphone token and the
 * five-minute unload. It is also where the app stops speaking when a microphone
 * starts, which is the difference between transcribing the person and
 * transcribing the bot.
 *
 * **The microphone is a lease.** The renderer owns the `MediaStream` and the OS
 * indicator, but the main process grants exactly one capture at a time and the
 * token is what proves a later transcription belongs to that recording. A second
 * window is refused with the surface already holding it rather than opening a
 * second microphone.
 *
 * **A cancelled recording never becomes text.** A stop aborts the engine between
 * windows or decoder steps; the host answers `cancelled` and the renderer also
 * checks its own clip id. ONNX cannot be interrupted mid-run, so the boundary is
 * the step, which is the shortest unit that matters.
 */
import {randomUUID} from 'node:crypto';
import {rm} from 'node:fs/promises';

import type {
  AgentUiEvent,
  ListenCaptureGrant,
  ListenDownloadProgress,
  ListenSettings,
  ListenStatus,
  ListenSurface,
  ListenTranscription,
} from '@marimo/protocol';
import {
  LISTEN_MAX_SECONDS,
  LISTEN_MIN_SECONDS,
  LISTEN_MODEL_BYTES,
} from '@marimo/protocol';
import {
  installListen,
  isListenInstalled,
  isOwnedListenDir,
  ListenCancelledError,
  pcmFromInt16,
  readListenAssets,
  transcribePcm,
} from '@marimo/runtime';
import type {
  ListenBinTokenizer,
  ListenConfig,
  ListenGraphs,
} from '@marimo/runtime';

/** How long the decoder is kept after the last transcription. */
const IDLE_MS = 5 * 60_000;

/**
 * How long a lease may live without a transcription.
 *
 * The renderer has its own 60-second stop, but a crashed window or a lost IPC
 * reply must not leave the other window's microphone dead forever. Ten seconds
 * past the cap is enough for a slow stop and short enough that "wait a minute"
 * is a recoverable answer.
 */
const CAPTURE_GRACE_MS = (LISTEN_MAX_SECONDS + 10) * 1000;

export interface ListenHostOptions {
  /** The `model/listen/small` directory, from `listenDir`. */
  dir: string;
  /** The stored preference, read per call so a change applies at once. */
  readSettings: () => Promise<ListenSettings>;
  sendEvent: (event: AgentUiEvent) => void;
  /** macOS asks the OS; the other platforms answer true. Injected for tests. */
  ensureAccess?: () => Promise<boolean>;
  /**
   * Called when a lease is granted, before the renderer opens the microphone.
   * The agent uses it to cancel every spoken utterance.
   */
  onCaptureStarted?: () => void;
  /** Test seams; production uses the pinned check and the CPU runtime. */
  isInstalled?: () => Promise<boolean>;
  createGraphs?: (dir: string, config: ListenConfig) => Promise<ListenGraphs>;
}

interface Loaded {
  graphs: ListenGraphs;
  config: ListenConfig;
  tokenizer: ListenBinTokenizer;
}

interface DownloadState {
  controller: AbortController;
  progress?: ListenDownloadProgress;
}

interface Capture {
  token: string;
  surface: ListenSurface;
  timer: NodeJS.Timeout;
}

interface Transcription {
  controller: AbortController;
  token: string;
  clipId: string;
}

export class ListenHost {
  private loaded: Loaded | undefined;
  private loading: Promise<Loaded> | undefined;
  private download: DownloadState | undefined;
  private capture: Capture | undefined;
  private transcribing: Transcription | undefined;
  private idle: NodeJS.Timeout | undefined;
  private disposed = false;

  constructor(private readonly options: ListenHostOptions) {}

  /** What the card draws, without loading a graph. */
  async status(): Promise<ListenStatus> {
    const installed = await this.installed();
    const downloading = this.download?.progress;
    const engine =
      this.loading !== undefined
        ? 'loading'
        : this.loaded !== undefined
          ? 'ready'
          : 'idle';
    const base = {
      modelBytes: LISTEN_MODEL_BYTES,
      maxSeconds: LISTEN_MAX_SECONDS,
      engine,
      ...(downloading === undefined ? {} : {downloading}),
    } as const;
    if (!installed) {
      return {installed: false, ...base};
    }
    try {
      /*
       * The config and tokenizer are small and are what a repair is for. The
       * 165 MB graphs are not loaded here: a Settings card that did would be the
       * app's largest side effect on a read.
       */
      await readListenAssets(this.options.dir);
      return {installed: true, ...base};
    } catch (failure) {
      return {installed: true, ...base, error: describe(failure)};
    }
  }

  /**
   * Starts the download and answers as soon as it has started.
   *
   * The promise is not the caller's: a Settings card is closed long before
   * 158 MB arrive, and the events are how it finds out. A second press while one
   * is running is the same download. A press when the model is installed is a
   * repair: the installer hashes what is there and re-fetches only what does not
   * match.
   */
  async install(): Promise<{started: boolean}> {
    if (this.download !== undefined) {
      return {started: true};
    }
    if (this.transcribing !== undefined) {
      throw new Error(
        'Wait for the transcription to finish before downloading the model.',
      );
    }
    if (this.capture !== undefined) {
      throw new Error(
        'Stop the recording before downloading the voice-input model.',
      );
    }
    await this.releaseLoaded();
    const state: DownloadState = {controller: new AbortController()};
    this.download = state;
    void installListen({
      dir: this.options.dir,
      signal: state.controller.signal,
      onProgress: (progress) => {
        const next: ListenDownloadProgress = {
          label: progress.label,
          receivedBytes: progress.receivedBytes,
          totalBytes: progress.totalBytes,
          ...(progress.percent === undefined
            ? {}
            : {percent: progress.percent}),
        };
        state.progress = next;
        this.emit({
          type: 'listen.progress',
          label: next.label,
          receivedBytes: next.receivedBytes,
          totalBytes: next.totalBytes,
          ...(next.percent === undefined ? {} : {percent: next.percent}),
        });
      },
    })
      .then(() => {
        this.emit({type: 'listen.installed'});
      })
      .catch((failure: unknown) => {
        if (!state.controller.signal.aborted) {
          this.emit({type: 'listen.failed', message: describe(failure)});
        }
      })
      .finally(() => {
        if (this.download === state) {
          this.download = undefined;
        }
      });
    return {started: true};
  }

  /** Stops a download in flight; the `.part` files are what a retry resumes. */
  cancelInstall(): {cancelled: boolean} {
    if (this.download === undefined) {
      return {cancelled: false};
    }
    this.download.controller.abort();
    this.download = undefined;
    return {cancelled: true};
  }

  /**
   * Deletes the cached model, and refuses while voice input is on or busy.
   *
   * The renderer sends no path. The only directory this can remove is the one
   * it was constructed with, and `isOwnedListenDir` is the second half of that:
   * a mis-wired directory is refused rather than recursively deleted.
   */
  async remove(): Promise<{removed: boolean}> {
    const settings = await this.options.readSettings();
    if (settings.enabled) {
      throw new Error(
        'Turn voice input off before removing its model, so the next recording ' +
          'does not fail silently.',
      );
    }
    if (this.capture !== undefined || this.transcribing !== undefined) {
      throw new Error(
        'Stop the recording or transcription before removing the voice-input ' +
          'model.',
      );
    }
    if (!isOwnedListenDir(this.options.dir)) {
      throw new Error(
        'The voice-input model directory is not the one this app owns.',
      );
    }
    if (!(await this.installed())) {
      return {removed: false};
    }
    this.download?.controller.abort();
    this.download = undefined;
    await this.releaseLoaded();
    await rm(this.options.dir, {recursive: true, force: true});
    return {removed: true};
  }

  /**
   * Claims the microphone for one surface.
   *
   * The Settings test may claim it while voice input is off so somebody can see
   * whether their microphone works before downloading a model; the two chat
   * surfaces may not, because a recording that cannot be transcribed is a
   * button that appears to work and then does nothing.
   */
  async beginCapture(surface: ListenSurface): Promise<ListenCaptureGrant> {
    if (this.transcribing !== undefined) {
      return {granted: false, reason: 'transcribing'};
    }
    if (this.capture !== undefined) {
      return {
        granted: false,
        reason: 'in-use',
        holder: this.capture.surface,
      };
    }
    const settings = await this.options.readSettings();
    if (surface !== 'settings') {
      if (!settings.enabled) {
        return {granted: false, reason: 'disabled'};
      }
      if (!(await this.installed())) {
        return {granted: false, reason: 'not-installed'};
      }
    }
    const access =
      this.options.ensureAccess === undefined
        ? true
        : await this.options.ensureAccess();
    if (!access) {
      return {granted: false, reason: 'permission-denied'};
    }
    const token = randomUUID();
    const timer = setTimeout(() => {
      if (this.capture?.token !== token) {
        return;
      }
      this.clearCapture();
      this.emit({type: 'listen.capture', active: false, surface});
    }, CAPTURE_GRACE_MS);
    timer.unref?.();
    this.capture = {token, surface, timer};
    this.options.onCaptureStarted?.();
    this.emit({type: 'listen.capture', active: true, surface});
    return {granted: true, token};
  }

  /**
   * Transcribes one captured clip, or answers cancelled when its lease is gone.
   *
   * One at a time: two simultaneous transcriptions would be two copies of the
   * graphs and two CPU storms, and the lease means there is never a legitimate
   * second recording waiting behind this one.
   */
  async transcribe(input: {
    token: string;
    pcm: string;
    sampleRate: number;
    clipId: string;
  }): Promise<ListenTranscription> {
    const cancelled: ListenTranscription = {
      text: '',
      cancelled: true,
      truncated: false,
      ms: 0,
      clipId: input.clipId,
    };
    if (this.capture?.token !== input.token) {
      return cancelled;
    }
    if (this.transcribing !== undefined) {
      throw new Error('A voice-input transcription is already running.');
    }
    if (input.sampleRate !== 16_000) {
      throw new Error('The voice-input model needs 16 kHz audio.');
    }
    let bytes: Buffer;
    try {
      bytes = Buffer.from(input.pcm, 'base64');
    } catch (failure) {
      throw new Error(`The recording could not be read: ${describe(failure)}.`);
    }
    const pcm = pcmFromInt16(bytes);
    if (pcm.length < LISTEN_MIN_SECONDS * 16_000) {
      this.releaseCapture(input.token);
      throw new Error('The recording was too short to transcribe.');
    }
    const controller = new AbortController();
    this.transcribing = {
      controller,
      token: input.token,
      clipId: input.clipId,
    };
    try {
      const loaded = await this.ready();
      const result = await transcribePcm({
        pcm,
        sampleRate: input.sampleRate,
        config: loaded.config,
        tokenizer: loaded.tokenizer,
        graphs: loaded.graphs,
        maxSeconds: LISTEN_MAX_SECONDS,
        signal: controller.signal,
      });
      this.touch();
      return {
        text: result.text,
        cancelled: false,
        truncated: result.truncated,
        ms: result.ms,
        clipId: input.clipId,
      };
    } catch (failure) {
      if (failure instanceof ListenCancelledError) {
        return cancelled;
      }
      /*
       * A failed inference may have left a session in an unknown state. Dropping
       * the load makes the next press start clean rather than reuse it.
       */
      await this.releaseLoaded();
      throw new Error(describe(failure));
    } finally {
      this.transcribing = undefined;
      this.releaseCapture(input.token);
    }
  }

  /**
   * Releases a lease and aborts a transcription in flight.
   *
   * A token that no longer matches is the stale call from a surface that has
   * already been replaced, and must not cancel the current recording. No token
   * at all is the deliberate "cancel whatever is happening" from a window that
   * lost its token.
   */
  cancel(token?: string): {cancelled: boolean} {
    let cancelled = false;
    if (
      this.transcribing !== undefined &&
      (token === undefined || this.transcribing.token === token)
    ) {
      this.transcribing.controller.abort();
      cancelled = true;
    }
    if (
      this.capture !== undefined &&
      (token === undefined || this.capture.token === token)
    ) {
      const surface = this.capture.surface;
      this.clearCapture();
      this.emit({type: 'listen.capture', active: false, surface});
      cancelled = true;
    }
    return {cancelled};
  }

  /** Aborts any download and transcription and releases the sessions. */
  dispose(): void {
    this.disposed = true;
    this.download?.controller.abort();
    this.download = undefined;
    this.transcribing?.controller.abort();
    this.transcribing = undefined;
    this.clearCapture();
    this.idle = this.clearIdle(this.idle);
    void this.releaseLoaded();
  }

  private async installed(): Promise<boolean> {
    if (this.options.isInstalled !== undefined) {
      return await this.options.isInstalled();
    }
    return await isListenInstalled(this.options.dir);
  }

  /** The loaded model, or a sentence saying why it cannot be loaded. */
  private async ready(): Promise<Loaded> {
    if (this.disposed) {
      throw new Error('The voice-input model is shutting down.');
    }
    if (this.loaded !== undefined) {
      return this.loaded;
    }
    if (this.loading !== undefined) {
      return await this.loading;
    }
    const promise = (async (): Promise<Loaded> => {
      if (!(await this.installed())) {
        throw new Error(
          'The voice-input model has not been downloaded. Open Settings → ' +
            'Voice input to download it, then try again.',
        );
      }
      const assets = await readListenAssets(this.options.dir);
      const graphs = await this.createGraphs(this.options.dir, assets.config);
      if (this.disposed) {
        await graphs.release();
        throw new Error('The voice-input model is shutting down.');
      }
      const loaded: Loaded = {
        graphs,
        config: assets.config,
        tokenizer: assets.tokenizer,
      };
      this.loaded = loaded;
      return loaded;
    })();
    this.loading = promise;
    try {
      return await promise;
    } finally {
      if (this.loading === promise) {
        this.loading = undefined;
      }
    }
  }

  private async createGraphs(
    dir: string,
    config: ListenConfig,
  ): Promise<ListenGraphs> {
    if (this.options.createGraphs !== undefined) {
      return await this.options.createGraphs(dir, config);
    }
    const {createOrtGraphs} = await import('./listen-ort.js');
    return await createOrtGraphs(dir, config);
  }

  private releaseCapture(token: string): void {
    if (this.capture?.token !== token) {
      return;
    }
    const surface = this.capture.surface;
    this.clearCapture();
    this.emit({type: 'listen.capture', active: false, surface});
  }

  private clearCapture(): void {
    if (this.capture !== undefined) {
      clearTimeout(this.capture.timer);
      this.capture = undefined;
    }
  }

  private async releaseLoaded(): Promise<void> {
    const loaded = this.loaded;
    this.loaded = undefined;
    this.idle = this.clearIdle(this.idle);
    if (loaded !== undefined) {
      try {
        await loaded.graphs.release();
      } catch {
        // A released graph is already gone; a second failure is not a reason to
        // keep the app from quitting.
      }
    }
  }

  private touch(): void {
    this.idle = this.clearIdle(this.idle);
    this.idle = setTimeout(() => {
      this.idle = undefined;
      void this.releaseLoaded();
    }, IDLE_MS);
    this.idle.unref?.();
  }

  private clearIdle(timer: NodeJS.Timeout | undefined): undefined {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    return undefined;
  }

  private emit(event: AgentUiEvent): void {
    this.options.sendEvent(event);
  }
}

function describe(failure: unknown): string {
  return failure instanceof Error ? failure.message : String(failure);
}
