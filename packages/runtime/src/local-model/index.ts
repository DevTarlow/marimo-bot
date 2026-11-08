/**
 * The local models: their pins, their download, the engine that serves them.
 *
 * The pieces are deliberately separate, and the seams are where the testing is:
 * `manifest.ts` is the shipped pins as data, `install.ts` fetches them,
 * `files.ts` answers where it all lives, `args.ts` is the command line as an
 * array, and `service.ts` runs one process. `host.ts` adds the model directory,
 * the one-model-at-a-time rule and the idle timer on top of that engine.
 *
 * It lives in this package rather than in the app because both processes need
 * it: the window starts a model to answer a question, and the headless runner
 * starts one to run a scheduled job while the window is closed. Neither can
 * reach into the other, and a second copy of this in `apps/desktop` would be the
 * half that drifts.
 *
 * The recall model is still here too. It is a different download with a
 * different engine pin and a different lifecycle, and its files sit beside the
 * chat models under the same root.
 */
export {
  engineBinaryName,
  engineDir,
  localModelDir,
  localModelMarkerFile,
  localModelSpec,
  MODEL_DIR_ENV,
  MODEL_DIR_NAME,
  modelDir,
  RECALL_DIR_NAME,
  recallDir,
  recallPiecesInstalled,
  recallSpec,
  resolveLocalModelFiles,
  resolveRecallFiles,
} from './files.js';
export type {
  LocalModelFiles,
  LocalModelSampling,
  LocalModelSpec,
  RecallFiles,
  RecallSpec,
} from './files.js';

export {
  chatModelParts,
  chatModelUrl,
  EMBEDDING_PIECES,
  EMBEDDING_POOLINGS,
  embeddingUrl,
  engineAssetFor,
  engineFilesFor,
  engineUrl,
  ManifestError,
  parseChatModelManifest,
  parseEmbeddingManifest,
  platformKey,
} from './manifest.js';
export type {
  ChatModelFilePin,
  ChatModelManifest,
  ChatModelPin,
  ChatModelVariantPin,
  EmbeddingManifest,
  EmbeddingPiece,
  EmbeddingPieceName,
  EmbeddingPooling,
  EngineAsset,
  EngineManifest,
} from './manifest.js';

export {
  downloadVerified,
  engineIsPinned,
  installEmbeddingPiece,
  installEngine,
  installLocalModel,
  InstallError,
  unpackEngine,
  unpackEngineBundle,
} from './install.js';
export type {
  DownloadProgress,
  EmbeddingInstallOptions,
  EngineInstallOptions,
  InstallOptions,
  LocalModelInstallOptions,
} from './install.js';

export {
  localModelOnDisk,
  readLocalModelMarker,
  writeLocalModelMarker,
} from './installed.js';
export type {
  LocalModelDiskState,
  LocalModelMarker,
  LocalModelMarkerFile,
} from './installed.js';

export {CHAT_PINS, CHAT_PIN_KEYS, defaultVariantFor} from './chat-pins.js';
export {EMBEDDING_PINS} from './pins.js';

export {
  EMBEDDING_ALIAS,
  embeddingArgs,
  localModelArgs,
} from './args.js';
export type {EmbeddingSpec} from './args.js';

export {
  freePort,
  embeddingPidFile,
  LocalModelService,
} from './service.js';
export type {
  EngineFiles,
  EngineRunSpec,
  EngineStatus,
  LocalModelOptions,
} from './service.js';

export {LocalModelHost, missingProblem} from './host.js';
export type {
  EnsureModelResult,
  LocalModelHostOptions,
} from './host.js';

export {QWEN_VL_CHAT_TEMPLATE} from './qwen-vl-template.js';
