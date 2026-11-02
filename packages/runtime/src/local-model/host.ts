/**
 * The one model in memory, and the rules about when it is there.
 *
 * The app carries no backend any more: it downloads a small model and starts a
 * llama.cpp server on loopback, for as long as a turn (or a spoken reply) needs
 * it. This class is the part that makes that feel like a feature rather than a
 * process manager:
 *
 * - **One model at a time.** Four models exist, and the machine's memory is the
 *   scarce resource. A turn's model is resolved before it starts; a different
 *   one stops the warm engine and starts itself. The one deliberate exception is
 *   voice, which uses the audio model for the whole turn so listening, answering
 *   and speaking share one set of weights.
 * - **It wakes on use.** Sending a message, attaching an image or pressing the
 *   mic starts the model, and the window is told it is waking. Nothing is
 *   downloaded or started at launch.
 * - **It sleeps after a few idle minutes.** A 1.9GB model sitting in memory for
 *   a question asked yesterday is the failure this exists to prevent. The timer
 *   is unref'd so the headless runner can exit, and it re-arms rather than
 *   firing while a turn or a request is still using the engine.
 * - **It never stops under a request.** A swap waits for the active work to
 *   finish; the app's one-turn-at-a-time rule makes this true for turns, and the
 *   in-flight counter covers speech.
 *
 * The engine itself — spawn, health poll, pid file, reap, log tail — is
 * `LocalModelService`, which already runs the recall engine. This file adds the
 * model directory layout, the marker that says which copy is installed, the
 * download, and the task routing.
 */
import {spawn} from 'node:child_process';
import {rm} from 'node:fs/promises';
import {totalmem} from 'node:os';
import {join} from 'node:path';

import type {
  CudaEngineStatus,
  EngineBackend,
  LocalModelId,
  LocalModelPart,
  LocalModelStatus,
  LocalModelsStatus,
  LocalModelVariant,
  SpeechLanguage,
  SpeechVoice,
  StoredSettings,
} from '@marimo/protocol';
import {
  LOCAL_MODEL_IDS,
  LOCAL_MODELS,
  LOCAL_TASKS,
  modelSupportsTask,
} from '@marimo/protocol';

import {localModelArgs} from './args.js';
import {CHAT_PINS} from './chat-pins.js';
import {probeCuda} from './cuda.js';
import type {CudaSupport} from './cuda.js';
import {
  localModelDir,
  localModelSpec,
  modelDir,
} from './files.js';
import type {LocalModelFiles, LocalModelSpec} from './files.js';
import {installLocalModel} from './install.js';
import type {DownloadProgress} from './install.js';
import {localModelOnDisk} from './installed.js';
import {engineAssetFor, engineFilesFor} from './manifest.js';
import {LocalModelService} from './service.js';
import {
  SpeechError,
  synthesizeSpeech,
  transcribeAudio,
} from './speech.js';
import type {SpokenAudio} from './speech.js';

/** The model owner a task should reach for, or why it cannot. */
export type EnsureModelResult =
  | {ok: true; baseUrl: string; modelId: LocalModelId; variant: LocalModelVariant}
  | {ok: false; problem: string};

export interface LocalModelHostOptions {
  userData: string;
  env?: NodeJS.ProcessEnv;
  /** The settings, read per call so a task change applies to the next turn. */
  readSettings: () => Promise<Pick<StoredSettings, 'localModels'>>;
  /**
   * Whether a turn is using the engine right now.
   *
   * The host cannot see the ADK driver's HTTP requests, and the engine must not
   * be stopped between a tool call and its answer. The app's runtime answers
   * this from its own running-turn state.
   */
  isBusy?: () => boolean;
  onStatus?: (status: LocalModelsStatus) => void;
  onProgress?: (progress: DownloadProgress & {modelId: LocalModelId}) => void;
  onInstalled?: (modelId: LocalModelId) => void;
  onFailed?: (modelId: LocalModelId, message: string) => void;
  /** Injected for tests, which must not spawn or download. */
  spawnImpl?: typeof spawn;
  fetchImpl?: typeof fetch;
  /** Injected for tests; when absent the engine's pin decides. */
  platform?: NodeJS.Platform;
  arch?: string;
  /** Injected for tests; absent reads the machine. */
  totalMemoryMb?: number;
  /** Injected for tests; absent probes `nvidia-smi`. */
  cudaProbe?: () => Promise<CudaSupport>;
  /** Injected for tests; absent reads the settings' idle minutes. */
  idleMs?: number;
  log?: (line: string) => void;
}

type Active = {
  modelId: LocalModelId;
  variant: LocalModelVariant;
};

export class LocalModelHost {
  private readonly root: string;
  private service: LocalModelService<LocalModelFiles, LocalModelSpec> | undefined;
  private active: Active | undefined;
  private state: LocalModelStatus['state'] = 'off';
  private detail: string | undefined;
  private baseUrl: string | undefined;
  private rootUrl: string | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private idle: NodeJS.Timeout | undefined;
  private readonly failures = new Map<LocalModelId, string>();
  private downloading:
    | {modelId: LocalModelId; controller: AbortController}
    | undefined;
  /** Requests the host itself is making (speech), so an idle stop waits. */
  private inFlight = 0;
  /** The NVIDIA probe, run once; the driver does not change under a launch. */
  private cudaSupport: Promise<CudaSupport> | undefined;

  constructor(private readonly options: LocalModelHostOptions) {
    this.root = modelDir({
      userData: options.userData,
      ...(options.env === undefined ? {} : {env: options.env}),
    });
  }

  /** Where the models and the shared engine live. For a card's path line. */
  get modelRoot(): string {
    return this.root;
  }

  /** The platform's engine asset, or undefined when this build has none. */
  get engineSupported(): boolean {
    return (
      engineAssetFor(CHAT_PINS, {
        platform: this.platform,
        arch: this.arch,
      }) !== undefined
    );
  }

  /**
   * Starts the model a turn needs, or says why it cannot.
   *
   * Called from the turn's preparation, after the task has been resolved and
   * before the first provider request. Concurrent callers share the start; a
   * caller asking for a different model while one is being used is refused
   * rather than allowed to pull the weights out from under a request.
   */
  async ensure(modelId: LocalModelId): Promise<EnsureModelResult> {
    return await this.withQueue(async () => await this.ensureNow(modelId));
  }

  private async ensureNow(modelId: LocalModelId): Promise<EnsureModelResult> {
    if (
      this.active?.modelId === modelId &&
      this.state === 'ready' &&
      this.baseUrl !== undefined
    ) {
      return {
        ok: true,
        baseUrl: this.baseUrl,
        modelId,
        variant: this.active.variant,
      };
    }

    if (this.active !== undefined && this.active.modelId !== modelId && this.isBusy()) {
      return {
        ok: false,
        problem:
          `${LOCAL_MODELS[this.active.modelId].label} is still answering. ` +
          'Finish that turn before switching models.',
      };
    }

    const settings = await this.options.readSettings();
    const {backend} = await this.selectedBackend(settings);
    const disk = await localModelOnDisk({
      root: this.root,
      manifest: CHAT_PINS,
      modelId,
      ...(this.platform === undefined ? {} : {platform: this.platform}),
      arch: this.arch,
      backend,
    });
    if (!disk.installed) {
      return {ok: false, problem: missingProblem(modelId, disk.missing)};
    }

    await this.stopEngine();
    this.active = {modelId, variant: disk.variant};
    this.state = 'starting';
    this.detail = undefined;
    this.failures.delete(modelId);
    await this.emitStatus();

    const specFor = () =>
      localModelSpec({
        root: this.root,
        manifest: CHAT_PINS,
        modelId,
        variant: disk.variant,
        ...(this.platform === undefined ? {} : {platform: this.platform}),
      });
    const service = new LocalModelService<LocalModelFiles, LocalModelSpec>({
      spec: specFor,
      args: (spec, port) => localModelArgs(spec, port),
      pidFile: join(this.root, 'local-model.pid'),
      ...(this.options.log === undefined ? {} : {log: this.options.log}),
      ...(this.options.spawnImpl === undefined
        ? {}
        : {spawnImpl: this.options.spawnImpl}),
      ...(this.options.fetchImpl === undefined
        ? {}
        : {fetchImpl: this.options.fetchImpl}),
    });

    this.service = service;
    const started = await service.ensureRunning();
    if (!started.ok) {
      this.state = 'failed';
      this.detail = started.problem;
      this.failures.set(modelId, started.problem);
      await this.emitStatus();
      return {ok: false, problem: started.problem};
    }
    this.baseUrl = started.baseUrl;
    this.rootUrl = started.baseUrl.replace(/\/v1$/u, '');
    this.state = 'ready';
    this.detail = undefined;
    void this.armIdle().catch((failure: unknown) => {
      this.options.log?.(`[marimo] the idle timer did not arm: ${describe(failure)}`);
    });
    await this.emitStatus();
    return {ok: true, baseUrl: started.baseUrl, modelId, variant: disk.variant};
  }

  /** The whole model situation, as a payload the window can draw. */
  async status(): Promise<LocalModelsStatus> {
    const settings = await this.options.readSettings();
    const {backend, cuda} = await this.selectedBackend(settings);
    const models = {} as Record<LocalModelId, LocalModelStatus>;
    for (const modelId of LOCAL_MODEL_IDS) {
      const disk = await localModelOnDisk({
        root: this.root,
        manifest: CHAT_PINS,
        modelId,
        ...(this.platform === undefined ? {} : {platform: this.platform}),
        arch: this.arch,
        backend,
      });
      const active =
        this.active?.modelId === modelId ? this.state : undefined;
      const failure = this.failures.get(modelId);
      const state: LocalModelStatus['state'] =
        active ?? (failure === undefined ? 'off' : 'failed');
      const detail =
        this.active?.modelId === modelId ? this.detail : failure;
      models[modelId] = {
        id: modelId,
        installed: disk.installed,
        // The weights can be installed while the shared engine is not: a
        // backend switch is exactly that. Keeping the variant here is what lets
        // the Download button fetch the new engine without also downloading the
        // other quantization.
        ...(disk.weightsPresent ? {installedVariant: disk.variant} : {}),
        missing: disk.missing,
        state,
        ...(detail === undefined ? {} : {detail}),
        ...(this.active?.modelId === modelId && this.service !== undefined
          ? {log: (await this.service.status()).log}
          : {}),
        usedFor: LOCAL_TASKS.filter(
          (task) => settings.localModels.tasks[task] === modelId,
        ),
      };
    }

    const active =
      this.active === undefined
        ? undefined
        : {
            id: this.active.modelId,
            state: this.state,
            ...(this.detail === undefined ? {} : {detail: this.detail}),
            ...(this.service === undefined
              ? {}
              : {log: (await this.service.status()).log}),
          };

    return {
      engine: {
        present: (await this.engineStatus(backend)).present,
        platformSupported: this.engineSupported,
        tag: CHAT_PINS.engine.tag,
        backend,
        cuda,
      },
      models,
      ...(active === undefined ? {} : {active}),
      tasks: settings.localModels.tasks,
      idleMinutes: settings.localModels.idleMinutes,
      engineBackend: settings.localModels.engineBackend,
      recommendedVariant: this.recommendedVariant(),
    };
  }

  /** Starts the engine now and proves it loads. Used by a first run. */
  async warm(modelId: LocalModelId): Promise<{
    ok: boolean;
    problem?: string;
    status: LocalModelsStatus;
  }> {
    const result = await this.ensure(modelId);
    return {
      ok: result.ok,
      ...(result.ok ? {} : {problem: result.problem}),
      status: await this.status(),
    };
  }

  /** Stops the engine now rather than when the idle timer would. */
  async sleep(): Promise<LocalModelsStatus> {
    /*
     * A person can press this while a turn is still running. The idle timer is
     * careful about that; the button has to be too, or the answer the model is
     * halfway through writing dies with the process.
     */
    if (this.isBusy() || this.inFlight > 0) {
      if (this.active !== undefined) {
        this.options.onFailed?.(
          this.active.modelId,
          `${LOCAL_MODELS[this.active.modelId].label} is still answering. ` +
            'Wait for the turn to finish before putting it to sleep.',
        );
      }
      return await this.status();
    }
    await this.withQueue(async () => {
      await this.stopEngine();
      await this.emitStatus();
    });
    return await this.status();
  }

  cancel(): {cancelled: boolean} {
    if (this.downloading === undefined) {
      return {cancelled: false};
    }
    this.downloading.controller.abort();
    return {cancelled: true};
  }

  /**
   * Starts a download and answers as soon as it has *started*.
   *
   * A model that is currently loaded is stopped first: replacing a file under a
   * running engine is safe on one platform and a locked file on another, and
   * the next ensure should read the copy that was just verified.
   */
  async install(
    modelId: LocalModelId,
    variant: LocalModelVariant,
  ): Promise<{started: boolean}> {
    if (this.downloading !== undefined) {
      return {started: false};
    }
    if (this.active?.modelId === modelId && this.isBusy()) {
      this.options.onFailed?.(
        modelId,
        `${LOCAL_MODELS[modelId].label} is in use. Finish the turn before ` +
          'changing which copy is installed.',
      );
      return {started: false};
    }
    const controller = new AbortController();
    this.downloading = {modelId, controller};
    void this.fetchModel(modelId, variant, controller);
    return {started: true};
  }

  private async fetchModel(
    modelId: LocalModelId,
    variant: LocalModelVariant,
    controller: AbortController,
  ): Promise<void> {
    try {
      if (this.active?.modelId === modelId) {
        await this.withQueue(async () => {
          await this.stopEngine();
          await this.emitStatus();
        });
      }
      const settings = await this.options.readSettings();
      const {backend} = await this.selectedBackend(settings);
      await installLocalModel({
        dir: this.root,
        manifest: CHAT_PINS,
        modelId,
        variant,
        backend,
        ...(this.platform === undefined ? {} : {platform: this.platform}),
        ...(this.arch === undefined ? {} : {arch: this.arch}),
        signal: controller.signal,
        onProgress: (progress) => {
          this.options.onProgress?.({...progress, modelId});
        },
        ...(this.options.fetchImpl === undefined
          ? {}
          : {fetchImpl: this.options.fetchImpl}),
      });
      this.failures.delete(modelId);
      this.options.onInstalled?.(modelId);
      await this.emitStatus();
    } catch (failure) {
      if (!controller.signal.aborted) {
        const message = describe(failure);
        this.failures.set(modelId, message);
        this.options.onFailed?.(modelId, message);
        await this.emitStatus();
      }
    } finally {
      if (this.downloading?.controller === controller) {
        this.downloading = undefined;
      }
    }
  }

  /** Deletes one model's files. The shared engine stays for the others. */
  async remove(modelId: LocalModelId): Promise<LocalModelsStatus> {
    if (this.active?.modelId === modelId && (this.isBusy() || this.inFlight > 0)) {
      this.options.onFailed?.(
        modelId,
        `${LOCAL_MODELS[modelId].label} is still answering. ` +
          'Wait for the turn to finish before removing it.',
      );
      return await this.status();
    }
    return await this.withQueue(async () => {
      if (this.downloading?.modelId === modelId) {
        this.downloading.controller.abort();
      }
      if (this.active?.modelId === modelId) {
        await this.stopEngine();
      }
      await rm(localModelDir(this.root, modelId), {
        recursive: true,
        force: true,
      });
      this.failures.delete(modelId);
      await this.emitStatus();
      return await this.status();
    });
  }

  /** Re-arms the idle timer after the setting changed. */
  async rearm(): Promise<void> {
    this.clearIdle();
    if (this.state === 'ready') {
      await this.armIdle();
    }
  }

  /** Stops the engine and any download. Called as the process goes away. */
  async stop(): Promise<void> {
    this.clearIdle();
    this.downloading?.controller.abort();
    this.downloading = undefined;
    await this.withQueue(async () => {
      await this.stopEngine();
    });
  }

  /** Speech in: one WAV, one transcript. Throws `SpeechError`. */
  async transcribe(options: {
    wav: Buffer;
    language?: SpeechLanguage;
  }): Promise<string> {
    return await this.withSpeech(async (baseUrl, modelId) => {
      return await transcribeAudio({
        baseUrl,
        model: modelId,
        wav: options.wav,
        ...(options.language === undefined ? {} : {language: options.language}),
        ...(this.options.fetchImpl === undefined
          ? {}
          : {fetchImpl: this.options.fetchImpl}),
      });
    });
  }

  /** Speech out: text to a 24kHz WAV. Throws `SpeechError`. */
  async speak(options: {
    text: string;
    language?: SpeechLanguage;
    voice?: SpeechVoice;
  }): Promise<SpokenAudio> {
    return await this.withSpeech(async (baseUrl) => {
      return await synthesizeSpeech({
        baseUrl,
        text: options.text,
        ...(options.language === undefined ? {} : {language: options.language}),
        ...(options.voice === undefined ? {} : {voice: options.voice}),
        ...(this.options.fetchImpl === undefined
          ? {}
          : {fetchImpl: this.options.fetchImpl}),
      });
    });
  }

  private async withSpeech<T>(
    work: (baseUrl: string, modelId: LocalModelId) => Promise<T>,
  ): Promise<T> {
    const settings = await this.options.readSettings();
    const modelId = settings.localModels.tasks.voice;
    if (!modelSupportsTask(modelId, 'voice')) {
      throw new SpeechError(
        `The voice task is assigned to ${modelId}, which cannot listen and ` +
          'speak. Choose another model in Settings → Models.',
      );
    }
    const started = await this.ensure(modelId);
    if (!started.ok) {
      throw new SpeechError(started.problem);
    }
    if (this.rootUrl === undefined) {
      throw new SpeechError('The voice model did not report an address.');
    }
    this.inFlight += 1;
    try {
      const result = await work(this.rootUrl, modelId);
      await this.armIdle();
      return result;
    } finally {
      this.inFlight -= 1;
    }
  }

  private async stopEngine(): Promise<void> {
    this.clearIdle();
    const service = this.service;
    this.service = undefined;
    this.active = undefined;
    this.baseUrl = undefined;
    this.rootUrl = undefined;
    this.state = 'off';
    this.detail = undefined;
    if (service !== undefined) {
      await service.stop();
    }
  }

  /**
   * Wakes the engine after a quiet spell, then lets it go.
   *
   * The check is inside the timer rather than before it because the interesting
   * case is work that started while the timer was running: a turn is a stream of
   * requests, and the gap between a tool result and the next request must not be
   * long enough to kill the engine under it. A busy host re-arms for another
   * minute instead of firing.
   */
  private async armIdle(): Promise<void> {
    this.clearIdle();
    if (this.state !== 'ready') {
      return;
    }
    const ms = await this.idleMs();
    const timer = setTimeout(() => {
      void (async () => {
        if (this.isBusy() || this.inFlight > 0) {
          await this.armIdle();
          return;
        }
        await this.withQueue(async () => {
          await this.stopEngine();
          await this.emitStatus();
        });
      })().catch((failure: unknown) => {
        this.options.log?.(`[marimo] the idle stop failed: ${describe(failure)}`);
      });
    }, ms);
    timer.unref?.();
    this.idle = timer;
  }

  private async idleMs(): Promise<number> {
    if (this.options.idleMs !== undefined) {
      return this.options.idleMs;
    }
    const settings = await this.options.readSettings();
    return settings.localModels.idleMinutes * 60_000;
  }

  private clearIdle(): void {
    if (this.idle !== undefined) {
      clearTimeout(this.idle);
      this.idle = undefined;
    }
  }

  private isBusy(): boolean {
    return this.options.isBusy?.() ?? false;
  }

  private get platform(): NodeJS.Platform {
    return this.options.platform ?? process.platform;
  }

  private get arch(): string {
    return this.options.arch ?? process.arch;
  }

  private recommendedVariant(): LocalModelVariant {
    const memory =
      this.options.totalMemoryMb ?? Math.round(totalmem() / (1024 * 1024));
    return memory < 8 * 1024 ? 'q4' : 'q8';
  }

  /**
   * What the machine offers for CUDA, and how much the pinned bundle costs.
   *
   * The probe is cached: `nvidia-smi` is a process, and the card is not swapped
   * during a launch. The byte count comes from the pins, so the Models card can
   * say what the switch will download before it is pressed.
   */
  private async cudaInfo(): Promise<CudaEngineStatus> {
    const files = engineFilesFor(CHAT_PINS, {
      backend: 'cuda',
      platform: this.platform,
      arch: this.arch,
    });
    const bytes =
      files?.reduce((total, asset) => total + (asset.bytes ?? 0), 0) ?? 0;
    const support = await (this.cudaSupport ??= (
      this.options.cudaProbe ??
      (() => probeCuda({platform: this.platform, arch: this.arch}))
    )());
    if (files === undefined) {
      return {
        ...support,
        available: false,
        bytes,
        ...(support.available
          ? {reason: 'No CUDA engine is pinned for this platform.'}
          : {}),
      };
    }
    return {...support, bytes};
  }

  /**
   * The engine the settings ask for, and what is actually available.
   *
   * A CUDA request on a machine with no usable NVIDIA driver runs Vulkan. That
   * is a fallback rather than a refusal: the app's promise is that it answers,
   * and the Models card says why the faster build was not used.
   */
  private async selectedBackend(
    settings: Pick<StoredSettings, 'localModels'>,
  ): Promise<{backend: EngineBackend; cuda: CudaEngineStatus}> {
    const cuda = await this.cudaInfo();
    return {
      backend:
        settings.localModels.engineBackend === 'cuda' && cuda.available
          ? 'cuda'
          : 'vulkan',
      cuda,
    };
  }

  private async engineStatus(
    backend: EngineBackend,
  ): Promise<{present: boolean}> {
    const service = this.service;
    if (service !== undefined) {
      const status = await service.status();
      return {present: status.enginePresent};
    }
    // No service has been created yet, and creating one just to ask would read
    // the spec for a model this host may not have been asked about. The answer
    // is one stat of the shared engine binary.
    const status = await this.statuslessEngine(backend);
    return status;
  }

  private async statuslessEngine(
    backend: EngineBackend,
  ): Promise<{present: boolean}> {
    const {enginePresent} = await localModelOnDisk({
      root: this.root,
      manifest: CHAT_PINS,
      modelId: 'lfm3-1.7b',
      ...(this.platform === undefined ? {} : {platform: this.platform}),
      arch: this.arch,
      backend,
    });
    return {present: enginePresent};
  }

  private async emitStatus(): Promise<void> {
    if (this.options.onStatus === undefined) {
      return;
    }
    try {
      this.options.onStatus(await this.status());
    } catch (failure) {
      this.options.log?.(
        `[marimo] could not describe the local models: ${describe(failure)}`,
      );
    }
  }

  private withQueue<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

/** The sentence a missing download earns, naming the parts and the way out. */
export function missingProblem(
  modelId: LocalModelId,
  missing: readonly LocalModelPart[],
): string {
  const label = LOCAL_MODELS[modelId].label;
  if (missing.length === 0) {
    return `${label} is not ready. Open Settings → Models to download it.`;
  }
  const what = missing.map((part) =>
    part === 'engine'
      ? 'the model engine'
      : part === 'weights'
        ? 'the model file'
        : 'its encoder',
  );
  return (
    `${label} is not ready: ${what.join(' and ')} ` +
    `${missing.length === 1 ? 'is' : 'are'} not downloaded. ` +
    'Open Settings → Models to download it.'
  );
}

function describe(failure: unknown): string {
  return failure instanceof Error ? failure.message : String(failure);
}
