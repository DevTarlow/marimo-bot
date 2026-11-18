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
 * **The session is not a preference.** `status()` reads the files and reports
 * what is there; only a reply or a sample loads the graph. A Settings card that
 * loaded 250 MB to draw a dot would be the app's largest side effect on a read.
 *
 * **A failure is a sentence.** Every error this class raises is meant for the
 * card or the quiet failure path of a spoken reply; none of them is a stack
 * trace, and none of them leaves a half-loaded session behind.
 */
import {createRequire} from 'node:module';
import {readFile} from 'node:fs/promises';
import {cpus} from 'node:os';
import {join} from 'node:path';

import type {
  AgentUiEvent,
  SpeechDownloadProgress,
  SpeechSettings,
  SpeechStatus,
  SpeechVoice,
  SpokenAudio,
} from '@marimo/protocol';
import {SPEECH_SAMPLE_TEXT} from '@marimo/protocol';
import {
  createPhonemizer,
  installSpeech,
  isSpeechInstalled,
  readVoiceCatalogue,
  readVoicePacks,
  resolveVoice,
  synthesize,
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
  /** The stored preference, read per call so a voice change applies at once. */
  readSettings: () => Promise<SpeechSettings>;
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

export class SpeechHost {
  private loaded: Loaded | undefined;
  private loading: Promise<Loaded> | undefined;
  private download: DownloadState | undefined;
  private idle: NodeJS.Timeout | undefined;
  /** Serialises synthesis; a sample and a reply must not share the graph. */
  private queue: Promise<unknown> = Promise.resolve();
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
   * is running is the same download, not a second one.
   */
  async install(): Promise<{started: boolean}> {
    /*
     * A press while a download runs is the same download. A press when the
     * model is already installed is a repair: `installSpeech` hashes what is
     * there and re-fetches only what does not match, which is also what makes
     * the card's "Repair" button meaningful after a damaged file.
     */
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

  /** One fixed sentence in the chosen voice, for the picker's audition. */
  async sample(voice?: string): Promise<SpokenAudio> {
    return await this.render(SPEECH_SAMPLE_TEXT, voice);
  }

  /** One finished turn's answer. */
  async speak(text: string): Promise<SpokenAudio> {
    return await this.render(text, undefined);
  }

  /** Aborts any download and releases the session; called on quit and reset. */
  dispose(): void {
    this.disposed = true;
    this.download?.controller.abort();
    this.download = undefined;
    this.idle = this.clearIdle(this.idle);
    this.unload();
  }

  private async render(
    text: string,
    requestedVoice: string | undefined,
  ): Promise<SpokenAudio> {
    const loaded = await this.ready();
    const settings = await this.options.readSettings();
    const voice = resolveVoice(loaded.voices, requestedVoice ?? settings.voice);
    const pack = voicePack(loaded.packs, voice);
    const result = await this.enqueue(async () =>
      synthesize({
        text,
        vocab: loaded.vocab,
        voicePack: pack,
        session: loaded.session,
        phonemize: loaded.phonemize,
        sampleRate: loaded.sampleRate,
      }),
    );
    this.touch();
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
