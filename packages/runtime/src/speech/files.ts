/**
 * Where the voice model lives.
 *
 * `model/tts/` beside `model/recall/`, under the directory `modelDir` resolves.
 * That is deliberate rather than tidy: `MARIMO_MODEL_DIR` is what points a
 * checkout, the live tests and the packaged app at one model root, and a second
 * concept beside it would be a second place for the two processes to disagree.
 * The layout differs from recall's only in which files it holds — recall has an
 * engine and a GGUF, this has one ONNX graph and a handful of small files.
 */
import {join} from 'node:path';

import {modelDir} from '../local-model/files.js';

/** The voice model's folder inside the model root. */
export const TTS_DIR_NAME = 'tts';

/** The directory the voice model is downloaded into. */
export function ttsDir(options: {
  userData: string;
  env?: NodeJS.ProcessEnv;
}): string {
  return join(modelDir(options), TTS_DIR_NAME);
}

/** The marker that says the pinned revision was fully downloaded. */
export const TTS_MARKER = '.installed.json';

/** What the marker records; the revision is what makes a new pin re-download. */
export interface TtsInstalledMarker {
  revision: string;
}
