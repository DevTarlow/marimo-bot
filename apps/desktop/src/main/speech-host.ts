/**
 * The voice model in the main process: its download, its ONNX session and the
 * one queue every reply and sample goes through.
 *
 * The split with `@marimo/runtime` is deliberate. That package owns the
 * arithmetic — normalisation, G2P, tokenising, trimming, WAV — and knows
 * nothing about a native module. This file owns the process-shaped facts: the
 * model directory, the download's events, an ORT session that is lazily loaded
 * and released when nobody has spoken for a while, and one request at a time so
 * two windows cannot load two copies of an 82 MB graph.
 *
 * **A reply is a stream of sentences.** The text is split once, then each
 * sentence is synthesised in order and emitted as a `speech.audio` event. The
 * renderer plays the first while the host works on the next, so the wait is one
 * sentence rather than one reply. A stop marks the utterance and no further
 * chunk for it is emitted; the renderer ignores anything that was already in
 * flight. ONNX itself cannot be interrupted mid-run, so the boundary is the
 * sentence, which is the shortest unit the person can hear anyway.
 *
 * **The session is not a preference.** `status()` reads the files and reports
 * what is there; only a reply or a sample loads the graph. A Settings card that
 * loaded 250 MB to draw a dot would be the app's largest side effect on a read.
 *
 * **A failure is a sentence.** Every error this class raises is meant for the
 * card or the quiet failure path of a spoken reply; none of them is a stack
 * trace, and none of them leaves a half-loaded session behind.
 */
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
import {readFile, rm} from 'node:fs/promises';
import {basename, join} from 'node:path';
import {cpus} from 'node:os';

import type {
  AgentUiEvent,
  SpeechDownloadProgress,
  SpeechOverride,
  SpeechSettings,
  SpeechStatus,
  SpeechVoice,
  SpokenAudio,
} from '@marimo/protocol';
import {SPEECH_MAX_CHARS, SPEECH_SAMPLE_TEXT} from '@marimo/protocol';
import {
  createPhonemizer,
  installSpeech,
  isSpeechInstalled,
  readVoiceCatalogue,
  readVoicePacks,
  resolveVoice,
  splitSpeechSentences,
  synthesize,
  trimForSpeech,
  voicePack,
  type NpyArray,
  type Phonemize,
  type SpeechSession,
} from '@marimo/runtime';

const require = createRequire(import.meta.url);

/** The model file's stored name, as the pins write it. */
const MODEL_FILE = 'kitten_tts_2_mini.onnx';

/** How long a loaded session is kept after the last reply, in milliseconds. */
const IDLE_MS = 5 * 60_000;

export interface SpeechHostOptions {
  /** The `model/tts` directory, from `ttsDir`. */
  dir: string;
  /** The stored preference, read per call so a change applies at once. */
  readSettings: () => Promise<SpeechSettings>;
  /** A bot's own voice/speed, or `{}` when it has none. */
  resolveOverride?: (agentId?: string) => Promise<SpeechOverride>;
  sendEvent: (event: AgentUiEvent) => void;
}

interface Loaded {
  session: SpeechSession;
  /** Released when the session is unloaded; ORT keeps native memory. */
  release: () => Promise<void>;
  phonemize: Phonemize;
  vocab: Record<string, number>;
  packs: Map<string, NpyArray>;
  voices: SpeechVoice[];
  sampleRate: number;
}

interface DownloadState {
  controller: AbortController;
  progress?: SpeechDownloadProgress;
}

interface Utterance {
  cancelled: boolean;
}

export class SpeechHost {
  private loaded: Loaded | undefined;
  private loading: Promise<Loaded> | undefined;
  private download: DownloadState | undefined;
  private idle: NodeJS.Timeout | undefined;
  /** Serialises synthesis; a sample and a reply must not share the graph. */
  private queue: Promise<unknown> = Promise.resolve();
  /** The replies currently being synthesised, by the renderer's utterance id. */
  private readonly utterances = new Map<string, Utterance>();
  private disposed = false;

  constructor(private readonly options: SpeechHostOptions) {}

  /** What the card draws, without loading the graph. */
  async status(): Promise<SpeechStatus> {
    const installed = await isSpeechInstalled(this.options.dir);
    const progress = this.download?.progress;
    const engine =
      this.loading !== undefined
        ? 'loading'
        : this.loaded !== undefined
          ? 'ready'
          : 'idle';
    if (!installed) {
      return {
        installed: false,
        voices: [],
        engine,
        ...(progress === undefined ? {} : {downloading: progress}),
      };
    }
    try {
      const catalogue =
        this.loaded === undefined
          ? await readVoiceCatalogue(this.options.dir)
          : {
              voices: this.loaded.voices,
              sampleRate: this.loaded.sampleRate,
            };
      return {
        installed: true,
        voices: catalogue.voices,
        engine,
        ...(progress === undefined ? {} : {downloading: progress}),
      };
    } catch (failure) {
      return {
        installed: true,
        voices: [],
        engine,
        error: describe(failure),
        ...(progress === undefined ? {} : {downloading: progress}),
      };
    }
  }

  /**
   * Starts the download and answers as soon as it has started.
   *
   * The promise is not the caller's: a Settings card is closed long before
   * 92 MB arrive, and the events are how it finds out. A second press while one
   * is running is the same download, not a second one. A press when the model
   * is already installed is a repair: the installer hashes what is there and
   * re-fetches only what does not match.
   */
  async install(): Promise<{started: boolean}> {
    if (this.download !== undefined) {
      return {started: true};
    }
    const state: DownloadState = {controller: new AbortController()};
    this.download = state;
    void installSpeech({
      dir: this.options.dir,
      signal: state.controller.signal,
      onProgress: (progress) => {
        state.progress = progress;
        this.emit({
          type: 'speech.progress',
          label: progress.label,
          receivedBytes: progress.receivedBytes,
          totalBytes: progress.totalBytes,
          ...(progress.percent === undefined
            ? {}
            : {percent: progress.percent}),
        });
      },
    })
      .then(() => {
        this.unload();
        this.emit({type: 'speech.installed'});
      })
      .catch((failure: unknown) => {
        if (!state.controller.signal.aborted) {
          this.emit({
            type: 'speech.failed',
            message: describe(failure),
          });
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
  cancel(): {cancelled: boolean} {
    if (this.download === undefined) {
      return {cancelled: false};
    }
    this.download.controller.abort();
    this.download = undefined;
    return {cancelled: true};
  }

  /**
   * Deletes the cached model, and refuses while spoken replies are on.
   *
   * The renderer sends no path. The only directory this can remove is the one
   * it was constructed with, and the basename check is the second half of that:
   * a mis-wired directory is refused rather than recursively deleted.
   */
  async remove(): Promise<{removed: boolean}> {
    const settings = await this.options.readSettings();
    if (settings.enabled) {
      throw new Error(
        'Turn spoken replies off before removing the voice model, so the ' +
          'next answer does not fail silently.',
      );
    }
    if (basename(this.options.dir) !== 'tts') {
      throw new Error(
        'The voice-model directory is not the one this app owns.',
      );
    }
    if (!(await isSpeechInstalled(this.options.dir))) {
      return {removed: false};
    }
    this.download?.controller.abort();
    this.download = undefined;
    for (const utterance of this.utterances.values()) {
      utterance.cancelled = true;
    }
    this.unload();
    await rm(this.options.dir, {recursive: true, force: true});
    return {removed: true};
  }

  /** One fixed sentence in the chosen voice, for the picker's audition. */
  async sample(voice?: string, speed?: number): Promise<SpokenAudio> {
    const settings = await this.options.readSettings();
    const loaded = await this.ready();
    const chosen = resolveVoice(loaded.voices, voice ?? settings.voice);
    const chosenSpeed = speed ?? settings.speed;
    const result = await this.renderOne(
      loaded,
      chosen,
      chosenSpeed,
      SPEECH_SAMPLE_TEXT,
    );
    this.touch();
    return result;
  }

  /**
   * Starts one reply and answers immediately.
   *
   * The renderer supplies the utterance id it will listen for, so a first
   * sentence that is ready before the invoke reply cannot be missed. Every
   * chunk after this is a `speech.audio` event.
   */
  speak(
    text: string,
    agentId?: string,
    utteranceId?: string,
  ): {utteranceId: string} {
    const id = utteranceId ?? randomUUID();
    const utterance: Utterance = {cancelled: false};
    this.utterances.set(id, utterance);
    void this.runUtterance(id, utterance, text, agentId);
    return {utteranceId: id};
  }

  /** Cancels the rest of one utterance; the current ONNX run is not aborted. */
  stop(utteranceId: string): {stopped: boolean} {
    const utterance = this.utterances.get(utteranceId);
    if (utterance === undefined) {
      return {stopped: false};
    }
    utterance.cancelled = true;
    return {stopped: true};
  }

  /**
   * Cancels every utterance, for the microphone's barge-in.
   *
   * The renderer stops its own player when the lease event arrives; this is the
   * host half, so no further sentence is synthesised or emitted. A run already
   * inside ONNX finishes, as it must, but its result is not sent.
   */
  stopAll(): number {
    let cancelled = 0;
    for (const utterance of this.utterances.values()) {
      utterance.cancelled = true;
      cancelled += 1;
    }
    return cancelled;
  }

  /** Aborts any download and releases the session; called on quit and reset. */
  dispose(): void {
    this.disposed = true;
    this.download?.controller.abort();
    this.download = undefined;
    for (const utterance of this.utterances.values()) {
      utterance.cancelled = true;
    }
    this.utterances.clear();
    this.idle = this.clearIdle(this.idle);
    this.unload();
  }

  private async runUtterance(
    id: string,
    utterance: Utterance,
    text: string,
    agentId: string | undefined,
  ): Promise<void> {
    try {
      if (utterance.cancelled) {
        return;
      }
      const loaded = await this.ready();
      const settings = await this.options.readSettings();
      const override = (await this.options.resolveOverride?.(agentId)) ?? {};
      const voice = resolveVoice(
        loaded.voices,
        override.voice ?? settings.voice,
      );
      const speed = override.speed ?? settings.speed;
      const {text: trimmed, truncated} = trimForSpeech(text, SPEECH_MAX_CHARS);
      const sentences = splitSpeechSentences(trimmed);
      if (sentences.length === 0) {
        throw new Error('There were no words to speak.');
      }
      for (const [index, sentence] of sentences.entries()) {
        if (utterance.cancelled || this.disposed) {
          return;
        }
        const final = index === sentences.length - 1;
        const result = await this.enqueue(async () =>
          synthesize({
            text: sentence,
            vocab: loaded.vocab,
            voicePack: voicePack(loaded.packs, voice),
            session: loaded.session,
            phonemize: loaded.phonemize,
            sampleRate: loaded.sampleRate,
            speed,
          }),
        );
        if (utterance.cancelled || this.disposed) {
          return;
        }
        this.emit({
          type: 'speech.audio',
          utteranceId: id,
          index,
          final,
          wavBase64: Buffer.from(result.wav).toString('base64'),
          sampleRate: result.sampleRate,
          ...(final ? {truncated: truncated || result.truncated} : {}),
        });
      }
      this.touch();
    } catch (failure) {
      if (!utterance.cancelled && !this.disposed) {
        this.emit({
          type: 'speech.audio',
          utteranceId: id,
          index: 0,
          final: true,
          error: describe(failure),
        });
      }
    } finally {
      this.utterances.delete(id);
    }
  }

  /** One WAV for the sample, with the voice and speed the card chose. */
  private async renderOne(
    loaded: Loaded,
    voice: SpeechVoice,
    speed: number,
    text: string,
  ): Promise<SpokenAudio> {
    const result = await this.enqueue(async () =>
      synthesize({
        text,
        vocab: loaded.vocab,
        voicePack: voicePack(loaded.packs, voice),
        session: loaded.session,
        phonemize: loaded.phonemize,
        sampleRate: loaded.sampleRate,
        speed,
      }),
    );
    return {
      wavBase64: Buffer.from(result.wav).toString('base64'),
      sampleRate: result.sampleRate,
      truncated: result.truncated,
    };
  }

  /** The loaded model, or a sentence saying why it cannot be loaded. */
  private async ready(): Promise<Loaded> {
    if (this.disposed) {
      throw new Error('The voice model is shutting down.');
    }
    if (this.loaded !== undefined) {
      return this.loaded;
    }
    if (this.loading !== undefined) {
      return await this.loading;
    }
    const promise = (async (): Promise<Loaded> => {
      if (!(await isSpeechInstalled(this.options.dir))) {
        throw new Error(
          'The voice model has not been downloaded. Open Settings → Spoken ' +
            'replies to download it, then try again.',
        );
      }
      const loaded = await this.load();
      if (this.disposed) {
        await loaded.release();
        throw new Error('The voice model is shutting down.');
      }
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

  private async load(): Promise<Loaded> {
    const catalogue = await readVoiceCatalogue(this.options.dir);
    const packs = await readVoicePacks(this.options.dir);
    const vocab = await readJson<Record<string, number>>(
      join(this.options.dir, 'vocab.json'),
      'The phoneme list',
    );
    const cmu = await readJson<Record<string, string>>(
      join(this.options.dir, 'cmu_misaki_us.json'),
      'The pronunciation dictionary',
    );
    const phonemize = await createPhonemizer({vocab, cmu});
    let ort: typeof import('onnxruntime-node');
    try {
      ort = require('onnxruntime-node') as typeof import('onnxruntime-node');
    } catch (failure) {
      throw new Error(
        `The speech runtime is missing from this build: ${describe(failure)}.`,
      );
    }
    let session: import('onnxruntime-node').InferenceSession;
    try {
      session = await ort.InferenceSession.create(
        join(this.options.dir, MODEL_FILE),
        {
          executionProviders: ['cpu'],
          graphOptimizationLevel: 'all',
          intraOpNumThreads: Math.max(1, Math.min(4, cpus().length)),
        },
      );
    } catch (failure) {
      throw new Error(
        `The voice model could not be loaded: ${describe(failure)}. Download ` +
          'it again from Settings → Spoken replies.',
      );
    }
    const outputNames = session.outputNames;
    const speechSession: SpeechSession = {
      async run({inputIds, style, speed}) {
        const outputs = await session.run({
          input_ids: new ort.Tensor('int64', inputIds, [1, inputIds.length]),
          style: new ort.Tensor('float32', style, [1, style.length]),
          speed: new ort.Tensor('float32', Float32Array.from([speed]), [1]),
        });
        const waveform = outputs[outputNames[0] ?? '']?.data;
        const durations = outputs[outputNames[1] ?? '']?.data;
        if (!(waveform instanceof Float32Array) || durations === undefined) {
          throw new Error(
            'The voice model answered without a waveform or durations.',
          );
        }
        return {
          waveform,
          durations: durations as unknown as ArrayLike<number>,
        };
      },
    };
    let released = false;
    return {
      session: speechSession,
      release: async () => {
        if (released) {
          return;
        }
        released = true;
        try {
          await session.release();
        } catch {
          // A released session is already gone; a second failure is not a
          // reason to keep the app from quitting.
        }
      },
      phonemize,
      vocab,
      packs,
      voices: catalogue.voices,
      sampleRate: catalogue.sampleRate,
    };
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private touch(): void {
    this.idle = this.clearIdle(this.idle);
    this.idle = setTimeout(() => {
      this.idle = undefined;
      this.unload();
    }, IDLE_MS);
    this.idle.unref?.();
  }

  private unload(): void {
    const loaded = this.loaded;
    this.loaded = undefined;
    if (loaded !== undefined) {
      void loaded.release();
    }
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

async function readJson<T>(path: string, label: string): Promise<T> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch (failure) {
    throw new Error(
      `${label} could not be read: ${describe(failure)}. Download the voice ` +
        'model again from Settings → Spoken replies.',
    );
  }
}

function describe(failure: unknown): string {
  return failure instanceof Error ? failure.message : String(failure);
}
