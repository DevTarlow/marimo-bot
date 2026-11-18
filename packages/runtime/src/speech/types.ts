/**
 * The shapes the voice model's files, pins and engine share.
 *
 * Kept apart from `pins.ts` so a test can build a manifest without importing
 * the pinned table, and so the installer's options name a file without naming
 * every pinned one.
 */

/** One file the voice model needs, and the digest it must have. */
export interface TtsFile {
  /** The name it is stored under in `model/tts/`. */
  name: string;
  /** The path in the model repository, which is not always the stored name. */
  path: string;
  /** What a progress bar calls it. */
  label: string;
  bytes: number;
  sha256: string;
}
