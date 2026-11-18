/**
 * Fetching the voice-input model, verified and resumable.
 *
 * The download has the same four obligations recall's and the voice model's
 * have, and for the same reasons: it runs on somebody else's machine, once, so a
 * failure is a sentence rather than a stack trace; a `.part` beside the
 * destination is continued with a range so a 158 MB download does not restart
 * from zero after a laptop sleeps; a file is renamed into place only after its
 * digest matches; and a marker is written only when every file is in place at
 * its pinned size.
 *
 * The marker is not a hint. It names the revision, so a build that moves the pin
 * re-downloads rather than trusting a marker written for different files, and
 * `isListenInstalled` still checks every file's size before answering yes. A
 * digest is checked when a file is written, which is the moment it could be
 * wrong; hashing 165 MB on every Settings open would buy no answer the marker and
 * the sizes do not already give.
 */
import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {mkdir, readFile, rename, rm, stat, writeFile} from 'node:fs/promises';
import {join} from 'node:path';

import {
  downloadVerified,
  type DownloadProgress,
} from '../local-model/install.js';
import {LISTEN_MARKER} from './files.js';
import {LISTEN_FILES, LISTEN_REVISION, listenFileUrl} from './pins.js';
import type {ListenFile} from './types.js';

export interface ListenInstallOptions {
  /** The `model/listen/small` directory. */
  dir: string;
  onProgress?: (progress: DownloadProgress) => void;
  signal?: AbortSignal;
  /** Injectable for tests, which must not touch the network. */
  fetchImpl?: typeof fetch;
  /** Injectable for tests: a small set of files instead of the pinned seven. */
  files?: readonly ListenFile[];
  /** The revision the marker records. Defaults to the pinned one. */
  revision?: string;
  /** Injectable for tests, so a fake file table can build its own URLs. */
  urlFor?: (file: ListenFile) => string;
}

/**
 * Downloads every pinned file and writes the marker.
 *
 * A file already on disk with the right digest is skipped: that is what makes a
 * retry after a failure cheap, and it is also the check that stops a damaged
 * copy from being trusted because it happens to have the right length.
 */
export async function installListen(
  options: ListenInstallOptions,
): Promise<void> {
  const {dir} = options;
  const files = options.files ?? LISTEN_FILES;
  const revision = options.revision ?? LISTEN_REVISION;
  const urlFor = options.urlFor ?? listenFileUrl;
  await mkdir(dir, {recursive: true});
  for (const file of files) {
    const destination = join(dir, file.name);
    if (await fileMatches(destination, file)) {
      continue;
    }
    await rm(destination, {force: true});
    await downloadVerified({
      url: urlFor(file),
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
  const marker = join(dir, LISTEN_MARKER);
  const part = `${marker}.part`;
  await writeFile(part, `${JSON.stringify({revision}, null, 2)}\n`, 'utf8');
  await rename(part, marker);
}

/**
 * Whether the installed copy is the pinned one, without hashing it again.
 *
 * The marker answers for the revision and each file is checked against its
 * pinned length.
 */
export async function isListenInstalled(
  dir: string,
  files: readonly ListenFile[] = LISTEN_FILES,
  revision: string = LISTEN_REVISION,
): Promise<boolean> {
  let marker: unknown;
  try {
    marker = JSON.parse(await readFile(join(dir, LISTEN_MARKER), 'utf8'));
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
async function fileMatches(path: string, file: ListenFile): Promise<boolean> {
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
