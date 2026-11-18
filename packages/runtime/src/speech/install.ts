/**
 * Fetching the voice model, verified and resumable.
 *
 * The download has the same four obligations recall's has, and for the same
 * reasons: it runs on somebody else's machine, once, so a failure is a sentence
 * rather than a stack trace; a `.part` beside the destination is continued with
 * a range so a 92 MB download does not restart from zero after a laptop sleeps;
 * a file is renamed into place only after its digest matches; and a marker is
 * written only when every file is in place at its pinned size.
 *
 * The marker is not a hint. It names the revision, so a build that moves the pin
 * re-downloads rather than trusting a marker written for different files, and
 * `isSpeechInstalled` still checks every file's size before answering yes.
 */
import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {mkdir, readFile, rename, rm, stat, writeFile} from 'node:fs/promises';
import {join} from 'node:path';

import {
  downloadVerified,
  type DownloadProgress,
} from '../local-model/install.js';
import {TTS_MARKER} from './files.js';
import {TTS_FILES, TTS_REVISION, ttsFileUrl} from './pins.js';
import type {TtsFile} from './types.js';

export interface SpeechInstallOptions {
  /** The `model/tts` directory. */
  dir: string;
  onProgress?: (progress: DownloadProgress) => void;
  signal?: AbortSignal;
  /** Injectable for tests, which must not touch the network. */
  fetchImpl?: typeof fetch;
  /** Injectable for tests: a small set of files instead of the pinned five. */
  files?: readonly TtsFile[];
  /** The revision the marker records. Defaults to the pinned one. */
  revision?: string;
}

/**
 * Downloads every pinned file and writes the marker.
 *
 * A file already on disk with the right digest is skipped: that is what makes a
 * retry after a failure cheap, and it is also the check that stops a damaged
 * copy from being trusted because it happens to have the right length.
 */
export async function installSpeech(
  options: SpeechInstallOptions,
): Promise<void> {
  const {dir} = options;
  const files = options.files ?? TTS_FILES;
  const revision = options.revision ?? TTS_REVISION;
  await mkdir(dir, {recursive: true});
  for (const file of files) {
    const destination = join(dir, file.name);
    if (await fileMatches(destination, file)) {
      continue;
    }
    await rm(destination, {force: true});
    await downloadVerified({
      url: ttsFileUrl(file),
      destination,
      sha256: file.sha256,
      bytes: file.bytes,
      label: file.label,
      ...(options.onProgress === undefined
        ? {}
        : {onProgress: options.onProgress}),
      ...(options.signal === undefined ? {} : {signal: options.signal}),
      ...(options.fetchImpl === undefined
        ? {}
        : {fetchImpl: options.fetchImpl}),
    });
  }
  /*
   * The marker is written last and through a `.part`, so a crash between two
   * files leaves files that are individually verifiable but no claim that the
   * set is complete.
   */
  const marker = join(dir, TTS_MARKER);
  const part = `${marker}.part`;
  await writeFile(part, `${JSON.stringify({revision}, null, 2)}\n`, 'utf8');
  await rename(part, marker);
}

/**
 * Whether the installed copy is the pinned one, without hashing it again.
 *
 * The marker answers for the revision and each file is checked against its
 * pinned length. Hashing 82 MB on every Settings open would make the card slow
 * for no answer the marker and the sizes do not already give; the digest is
 * checked when the file is written, which is the moment it could be wrong.
 */
export async function isSpeechInstalled(
  dir: string,
  files: readonly TtsFile[] = TTS_FILES,
  revision: string = TTS_REVISION,
): Promise<boolean> {
  let marker: unknown;
  try {
    marker = JSON.parse(await readFile(join(dir, TTS_MARKER), 'utf8'));
  } catch {
    return false;
  }
  if (
    marker === null ||
    typeof marker !== 'object' ||
    (marker as {revision?: unknown}).revision !== revision
  ) {
    return false;
  }
  for (const file of files) {
    try {
      const info = await stat(join(dir, file.name));
      if (!info.isFile() || info.size !== file.bytes) {
        return false;
      }
    } catch {
      return false;
    }
  }
  return true;
}

/** Whether one existing file is the pinned one, by size and digest. */
async function fileMatches(path: string, file: TtsFile): Promise<boolean> {
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size !== file.bytes) {
      return false;
    }
    return (await sha256Of(path)) === file.sha256;
  } catch {
    return false;
  }
}

async function sha256Of(path: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return hash.digest('hex');
}
