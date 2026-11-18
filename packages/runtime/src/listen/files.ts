/**
 * Where the voice-input model lives.
 *
 * `model/listen/small/` beside `model/recall/` and `model/tts/`, under the
 * directory `modelDir` resolves. That is deliberate rather than tidy:
 * `MARIMO_MODEL_DIR` is what points a checkout, the live tests and the packaged
 * app at one model root, and a second concept beside it would be a second place
 * for the two processes to disagree.
 *
 * The `small` segment is the model size, not a user choice this build offers. It
 * is there so a later Tiny manifest can sit beside it without moving a file the
 * app already downloaded, and it is what the removal guard checks.
 */
import {basename, dirname, join} from 'node:path';

import {modelDir} from '../local-model/files.js';

/** The voice-input model's folder inside the model root. */
export const LISTEN_DIR_NAME = 'listen';

/** The one model size this build ships. */
export const LISTEN_MODEL_DIR_NAME = 'small';

/** The directory the voice-input model is downloaded into. */
export function listenDir(options: {
  userData: string;
  env?: NodeJS.ProcessEnv;
}): string {
  return join(listenRoot(options), LISTEN_MODEL_DIR_NAME);
}

/** The parent of every voice-input model size. */
export function listenRoot(options: {
  userData: string;
  env?: NodeJS.ProcessEnv;
}): string {
  return join(modelDir(options), LISTEN_DIR_NAME);
}

/** The marker that says the pinned revision was fully downloaded. */
export const LISTEN_MARKER = '.installed.json';

/** What the marker records; the revision is what makes a new pin re-download. */
export interface ListenInstalledMarker {
  revision: string;
}

/**
 * Whether a directory is one this app owns.
 *
 * The renderer never sends a path, and the host is constructed with one, but the
 * check is the second half of that: a mis-wired directory must be refused rather
 * than recursively deleted. The TTS guard checked one basename; this one checks
 * both segments because `small` is not unique on its own.
 */
export function isOwnedListenDir(dir: string): boolean {
  return (
    basename(dir) === LISTEN_MODEL_DIR_NAME &&
    basename(dirname(dir)) === LISTEN_DIR_NAME
  );
}
