/**
 * Where the recall engine and its weights are.
 *
 * This file used to be the app's *other* invariant-13 problem. The model was
 * bundled inside the installer, so the window had to ask Electron for
 * `process.resourcesPath` while the headless runner — the same binary as plain
 * Node, with no `app` at all — derived the same directory from its own executable.
 * When the two disagreed nothing errored: the window answered questions while a
 * scheduled job reported the model as not installed.
 *
 * That whole class of failure is gone, because the model is no longer shipped. It
 * is downloaded into the user-data directory, which both processes already resolve
 * through `resolveAppPaths` and which invariant 13 is about. There is one
 * derivation now instead of two, and it is the one that already had a test.
 *
 * What survives is `MARIMO_MODEL_DIR`: a development checkout and the smoke check
 * both point at a directory of their own, and it wins over the default rather than
 * the other way round — a directory a shipped path can silently outrank is one
 * that does not work.
 */
import {statSync} from 'node:fs';
import {dirname, join} from 'node:path';

import type {
  LocalModelId,
  LocalModelVariant,
} from '@marimo/protocol';
import {LOCAL_MODELS} from '@marimo/protocol';

import {EMBEDDING_PIECES} from './manifest.js';
import type {
  ChatModelManifest,
  EmbeddingManifest,
  EmbeddingPieceName,
  EmbeddingPooling,
} from './manifest.js';
import type {EngineFiles, EngineRunSpec} from './service.js';

/**
 * Points both processes at a directory of their own.
 *
 * What a development checkout uses — the recall weights are not in the
 * repository, and a live run is pointed at a directory assembled by hand. It is
 * also what the smoke check sets, so a run that has no model says so rather than
 * starting a search. The chat weights this used to fetch with `pnpm model:fetch`
 * are gone with the engine that served them.
 */
export const MODEL_DIR_ENV = 'MARIMO_MODEL_DIR';

/** The directory the app owns, under the user-data directory it already has. */
export const MODEL_DIR_NAME = 'model';

/**
 * The directory the model lives in.
 *
 * `MARIMO_MODEL_DIR` first, because it is what a checkout and the smoke check set,
 * then the app's own directory under user data. No `resourcesPath` argument any
 * more: there is nothing to find inside the app.
 */
export function modelDir(options: {
  userData: string;
  env?: NodeJS.ProcessEnv;
}): string {
  const env = options.env ?? process.env;
  const override = env[MODEL_DIR_ENV];
  return override !== undefined && override.length > 0
    ? override
    : join(options.userData, MODEL_DIR_NAME);
}

/** The engine binary's name, which is the one thing Windows spells differently. */
export function engineBinaryName(
  platform: NodeJS.Platform = process.platform,
): string {
  return platform === 'win32' ? 'llama-server.exe' : 'llama-server';
}

/** Where the engine is unpacked inside the model directory. */
export function engineDir(dir: string): string {
  return join(dir, 'engine');
}

function sizeOf(path: string): number {
  try {
    const stats = statSync(path);
    return stats.isFile() ? stats.size : -1;
  } catch {
    return -1;
  }
}

/**
 * The recall model lives in a subdirectory of the model directory.
 *
 * `model/recall/` rather than a second concept beside it, and that is the whole
 * design of this block: the engine directory above and the binary's name are both
 * written in terms of a directory, so pointing them at `model/recall` reuses the
 * same layout. A second one would be a second place for the two processes to
 * disagree about where a file is, which is the failure this file's history is
 * entirely about.
 *
 * What differs is only *which* files: an engine build pinned for this model in
 * particular (`pins.ts` says why), one GGUF for text, and one projector that may
 * not be there at all.
 */
export const RECALL_DIR_NAME = 'recall';

/** Where the recall model is unpacked and downloaded. */
export function recallDir(options: {
  userData: string;
  env?: NodeJS.ProcessEnv;
}): string {
  return join(modelDir(options), RECALL_DIR_NAME);
}

export interface RecallFiles {
  dir: string;
  /** The `llama-server` build the recall engine was pinned to. */
  engine: string;
  /**
   * The directory holding the engine's shared libraries.
   *
   * The released archives unpack `libllama.so`, `libggml*.so` and friends beside
   * the binary and expect to be run from there, so the child is spawned with this
   * as its working directory *and* on `LD_LIBRARY_PATH` — the rpath in the shipped
   * build is not something this app should assume.
   */
  libraryDir: string;
  /** The text backbone's GGUF. */
  model: string;
  /**
   * The projector's path, or `''` when this install is not using media.
   *
   * `''` rather than a path plus a flag, because the two answers would have to
   * be kept in step at every call site and only one of them is what the engine
   * is handed. What decides `--mmproj` is whether this names a file that is
   * there.
   */
  projector: string;
  enginePresent: boolean;
  modelPresent: boolean;
  projectorPresent: boolean;
}

/**
 * What the recall engine would be started with.
 *
 * `media` is the user's switch, not a fact about the disk: asked for but not
 * downloaded resolves to no projector, and the args builder then leaves
 * `--mmproj` off rather than handing the engine a path that is not there. The
 * status card reads the two apart, because "you asked for images and the encoder
 * has not been downloaded" and "you have not asked for images" are different
 * sentences.
 */
export function resolveRecallFiles(options: {
  dir: string;
  manifest: EmbeddingManifest;
  media: boolean;
  platform?: NodeJS.Platform;
}): RecallFiles {
  const {dir} = options;
  const engine =
    dir.length > 0
      ? join(engineDir(dir), engineBinaryName(options.platform))
      : '';
  const model =
    dir.length > 0 ? join(dir, options.manifest.weights.pieces.text.file) : '';
  const projector =
    options.media && dir.length > 0
      ? join(dir, options.manifest.weights.pieces.media.file)
      : '';

  return {
    dir,
    engine,
    libraryDir: engine.length > 0 ? dirname(engine) : '',
    model,
    projector,
    enginePresent: isFile(engine),
    modelPresent: isFile(model),
    projectorPresent: isFile(projector),
  };
}

/** The recall spec: the files, and the two numbers an index depends on. */
export function recallSpec(options: {
  dir: string;
  manifest: EmbeddingManifest;
  media: boolean;
  platform?: NodeJS.Platform;
}): RecallSpec {
  return {
    files: resolveRecallFiles(options),
    contextSize: options.manifest.weights.contextSize,
    pooling: options.manifest.weights.pooling,
    media: options.media,
  };
}

export interface RecallSpec {
  files: RecallFiles;
  contextSize: number;
  pooling: EmbeddingPooling;
  media: boolean;
}

/**
 * Which pieces of the recall model are on disk, by exact size.
 *
 * Size rather than a digest: hashing 310 MB on every launch is not an option, and
 * a size check still catches the failure that matters — a download that was
 * interrupted and left a file that looks present.
 */
export function recallPiecesInstalled(options: {
  dir: string;
  manifest: EmbeddingManifest;
}): EmbeddingPieceName[] {
  const {dir, manifest} = options;
  if (dir.length === 0) {
    return [];
  }
  return EMBEDDING_PIECES.filter((name) => {
    const piece = manifest.weights.pieces[name];
    return sizeOf(join(dir, piece.file)) === piece.bytes;
  });
}

/**
 * Whether a path is a file rather than nothing, a directory, or a broken link.
 *
 * `statSync` rather than `existsSync` alone: a *directory* named like the model
 * file would pass an existence check and then fail somewhere far less clear, with
 * the engine complaining about a file it cannot open.
 */
function isFile(path: string): boolean {
  return sizeOf(path) >= 0;
}

/** Where one model's files live, under the shared model directory. */
export function localModelDir(root: string, modelId: LocalModelId): string {
  return join(root, modelId);
}

/**
 * The marker that records which copy was installed.
 *
 * It lives beside the weights rather than in settings because the files are the
 * fact: a user who deletes a directory by hand, or a build that changes the
 * variant, must not be described by a preference written weeks ago.
 */
export function localModelMarkerFile(dir: string): string {
  return join(dir, 'local-model.json');
}

/**
 * What the chat engine would be started with.
 *
 * The engine is shared by both copies, so it is resolved from the root while
 * the weights come from the model's own directory. `projector` is `''` for the
 * text model and for an install that has not finished downloading the encoder;
 * the args builder then leaves `--mmproj` off rather than handing the engine a
 * path that is not there.
 */
export interface LocalModelFiles extends EngineFiles {
  dir: string;
  modelId: LocalModelId;
  variant: LocalModelVariant;
  projector: string;
  projectorPresent: boolean;
}

/** The files one model variant resolves to, and whether each is on disk. */
export function resolveLocalModelFiles(options: {
  root: string;
  manifest: ChatModelManifest;
  modelId: LocalModelId;
  variant: LocalModelVariant;
  platform?: NodeJS.Platform;
}): LocalModelFiles {
  const {root, manifest, modelId, variant} = options;
  const dir = localModelDir(root, modelId);
  const engine =
    root.length > 0
      ? join(engineDir(root), engineBinaryName(options.platform))
      : '';
  const variantPin = manifest.models[modelId].variants[variant];
  const model = join(dir, variantPin.weights.file);
  const projector =
    variantPin.projector === undefined
      ? ''
      : join(dir, variantPin.projector.file);

  return {
    dir,
    modelId,
    variant,
    engine,
    libraryDir: engine.length > 0 ? dirname(engine) : '',
    model,
    projector,
    enginePresent: isFile(engine),
    modelPresent: isFile(model),
    projectorPresent: projector.length > 0 && isFile(projector),
  };
}

/** How a model's sampling is started. The values are the model card's. */
export interface LocalModelSampling {
  temperature: number;
  topK: number;
  topP?: number;
  repeatPenalty: number;
}

/**
 * The command-line facts the engine needs, beyond the files.
 *
 * The sampling is the model card's, and it is written down rather than defaulted
 * so a turn with no settings of its own still gets the same recipe as every
 * other. The chat template is a fact about the engine, not a preference: see
 * `args.ts`.
 */
export interface LocalModelSpec extends EngineRunSpec<LocalModelFiles> {
  modelId: LocalModelId;
  variant: LocalModelVariant;
  alias: string;
  sampling: LocalModelSampling;
}

/**
 * The spec for one model.
 *
 * The alias is the model id, never the file name: the request names the alias,
 * and a quantization in the id would be a second place the variant is written
 * down.
 */
export function localModelSpec(options: {
  root: string;
  manifest: ChatModelManifest;
  modelId: LocalModelId;
  variant: LocalModelVariant;
  platform?: NodeJS.Platform;
}): LocalModelSpec {
  return {
    files: resolveLocalModelFiles(options),
    contextSize: LOCAL_MODELS[options.modelId].contextTokens,
    modelId: options.modelId,
    variant: options.variant,
    alias: options.modelId,
    sampling: samplingFor(),
  };
}

/**
 * The model card's sampling, in one place.
 *
 * Temperature 0.2 and top-k 50 are the recipe the app was pointed at for this
 * family: low enough that a tool call is repeatable, not greedy. The repeat
 * penalty is Qwen's own generation setting; the app's older 1.1 was chosen for
 * a different model.
 */
function samplingFor(): LocalModelSampling {
  return {temperature: 0.2, topK: 50, repeatPenalty: 1.05};
}

