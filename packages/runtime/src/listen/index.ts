/**
 * Voice input's Electron-free half: where the model lives, how it is verified,
 * how a token table is decoded, how PCM is padded, and how the five graphs are
 * driven.
 *
 * The ONNX runtime is not here. It is a native package, and the main process
 * owns the processes this app runs; this package owns the arithmetic and the
 * text. That split is what lets the engine be tested with a fake graph, and what
 * keeps the headless runner from loading a 165 MB model it will never use.
 */
export {
  LISTEN_DIR_NAME,
  LISTEN_MARKER,
  LISTEN_MODEL_DIR_NAME,
  isOwnedListenDir,
  listenDir,
  listenRoot,
} from './files.js';
export type {ListenInstalledMarker} from './files.js';
export {
  LISTEN_FILES,
  LISTEN_REVISION,
  LISTEN_TOTAL_BYTES,
  listenFileUrl,
} from './pins.js';
export type {ListenFile} from './types.js';
export {installListen, isListenInstalled} from './install.js';
export type {ListenInstallOptions} from './install.js';
export {
  parseListenConfig,
  readBinTokenizer,
  readListenAssets,
  readListenConfig,
} from './config.js';
export {decodeTokens, parseBinTokenizer} from './tokenizer.js';
export {
  durationOf,
  LISTEN_FRAME_SAMPLES,
  LISTEN_SAMPLE_RATE,
  pcmFromInt16,
  preparePcm,
} from './audio.js';
export type {PreparedPcm} from './audio.js';
export {
  argmax,
  ListenCancelledError,
  transcribePcm,
} from './engine.js';
export type {TranscribePcmOptions} from './engine.js';
export type {
  ListenBinTokenizer,
  ListenConfig,
  ListenCross,
  ListenDecoderInput,
  ListenDecoderOutput,
  ListenFrontendInput,
  ListenFrontendOutput,
  ListenGraphs,
  ListenResult,
  ListenStateShapes,
} from './types.js';
