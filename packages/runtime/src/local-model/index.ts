/**
 * Recall's engine: its pins, its download, and the process that serves it.
 *
 * The chat model is not here any more. It is a server the person runs, probed by
 * `model-server.ts` in the package root; there are no chat weights to fetch and
 * no chat engine to spawn. What remains under this directory is the one child
 * process the app still owns: recall's embedding engine, started on demand and
 * stopped after it has been idle.
 *
 * The pieces are deliberately separate, and the seams are where the testing is:
 * `pins.ts` is the shipped pin as data, `manifest.ts` is the reader that decides
 * whether it is usable, `install.ts` fetches it, `files.ts` answers where it
 * lives, `args.ts` is the command line as an array, and `service.ts` runs one
 * process.
 *
 * It lives in this package rather than in the app because both processes need
 * it: the window starts the engine when somebody searches, and the headless
 * runner reads an index a scheduled job's tool is given. Neither can reach into
 * the other, and a second copy in `apps/desktop` would be the half that drifts.
 */
export {
  engineBinaryName,
  engineDir,
  MODEL_DIR_ENV,
  MODEL_DIR_NAME,
  modelDir,
  RECALL_DIR_NAME,
  recallDir,
  recallPiecesInstalled,
  recallSpec,
  resolveRecallFiles,
} from './files.js';
export type {RecallFiles, RecallSpec} from './files.js';

export {
  EMBEDDING_PIECES,
  EMBEDDING_POOLINGS,
  embeddingUrl,
  engineAssetFor,
  engineFilesFor,
  engineUrl,
  ManifestError,
  parseEmbeddingManifest,
  platformKey,
} from './manifest.js';
export type {
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
  InstallError,
  unpackEngine,
} from './install.js';
export type {
  DownloadProgress,
  EmbeddingInstallOptions,
  EngineInstallOptions,
  InstallOptions,
} from './install.js';

export {writeEngineMarker} from './installed.js';

export {EMBEDDING_PINS} from './pins.js';

export {EMBEDDING_ALIAS, embeddingArgs} from './args.js';
export type {EmbeddingSpec} from './args.js';

export {freePort, embeddingPidFile, LocalModelService} from './service.js';
export type {
  EngineFiles,
  EngineRunSpec,
  EngineStatus,
  LocalModelOptions,
} from './service.js';
