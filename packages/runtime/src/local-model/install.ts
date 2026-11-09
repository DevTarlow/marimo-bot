/**
 * Fetching recall's engine and weights, verified and resumable.
 *
 * It was a packaging script once, run on a build machine; it is a download the
 * person performs when they turn recall on, which is the change that shapes
 * everything below. (The chat model is no longer downloaded: it is a server the
 * person runs.) Four things about it change what the code has to do:
 *
 * - **It runs on somebody else's machine, on their network, once.** So a failure
 *   has to be a sentence rather than a stack trace, and an interrupted download
 *   has to be resumable: 555 MB restarted from zero because a laptop slept is the
 *   kind of thing that makes somebody give up.
 * - **It must never leave a file that looks finished.** Every write goes to a
 *   `.part` beside the destination and is renamed only after the digest matches.
 *   A half-written 555 MB file that the resolver counts as installed is a start
 *   that fails with the engine complaining about a corrupt model.
 * - **A pin that changes has to be noticed.** The weights are checked by size
 *   against the manifest, so replacing the model in a later build re-downloads it
 *   — but the engine binary has no pinned size, so its directory carries a marker
 *   naming the asset it was unpacked from. Without that, an app update that moved
 *   to a new engine would go on running the old one.
 * - **The digest is the whole point.** A downloaded binary that is quietly not the
 *   one that was tested shows up as "the app is broken on some machines", so the
 *   pin is checked before anything is put in place, and a mismatch deletes what it
 *   downloaded rather than leaving it to be retried forever.
 */
import {createHash} from 'node:crypto';
import {createReadStream, createWriteStream} from 'node:fs';
import {
  cp,
  mkdir,
  readdir,
  rename,
  rm,
  stat,
} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {pipeline} from 'node:stream/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

import type {
  EmbeddingManifest,
  EmbeddingPieceName,
  EngineManifest,
} from './manifest.js';
import {embeddingUrl, engineFilesFor, engineUrl} from './manifest.js';
import {engineBinaryName, engineDir} from './files.js';
import {engineIsPinned, writeEngineMarker} from './installed.js';

export {engineIsPinned};

const run = promisify(execFile);

/** How far along a download is, in the terms a progress bar needs. */
export interface DownloadProgress {
  /** What is being fetched, in words: `The model engine`, `The Low model`. */
  label: string;
  receivedBytes: number;
  totalBytes: number;
  /** `0`–`100`, or absent when the server did not say how large it is. */
  percent?: number;
}

/**
 * What every installer here needs: where, and how to reach the network.
 *
 * The manifest is deliberately *not* in here. There are two installers and they
 * read two different documents — the engine, which needs only the engine block,
 * and a recall piece, which needs the piece table. A single `InstallOptions`
 * carrying a whole manifest would have made the engine installer's type claim it
 * needs a `weights.pieces` it never reads, and that is exactly the sort of claim
 * that lets a caller pass the wrong manifest and find out at run time.
 */
export interface InstallOptions {
  /** The model directory, as `modelDir` resolves it. */
  dir: string;
  platform?: NodeJS.Platform;
  arch?: string;
  onProgress?: (progress: DownloadProgress) => void;
  /** Injectable for tests, which must not touch the network. */
  fetchImpl?: typeof fetch;
  /** Injectable for tests, which must not spawn `tar`. */
  execFileImpl?: (
    file: string,
    args: string[],
  ) => Promise<{stdout: string; stderr: string}>;
  /** Cancels an install in flight, which is what closing the app does. */
  signal?: AbortSignal;
}

/** Anything with an engine block: the recall manifest is the one caller. */
export interface EngineInstallOptions extends InstallOptions {
  manifest: {engine: EngineManifest};
}

/** One piece of the recall model. */
export interface EmbeddingInstallOptions extends InstallOptions {
  manifest: EmbeddingManifest;
  piece: EmbeddingPieceName;
}

/** Raised when a download cannot be completed, with a sentence for the user. */
export class InstallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InstallError';
  }
}

/**
 * Fetches the engine unless the pinned one is already unpacked.
 *
 * The engine goes first and on its own, so a platform this build has no engine
 * for is refused before the weights are fetched. One archive per platform is
 * unpacked, and the marker is written after the binary is in place.
 */
export async function installEngine(
  options: EngineInstallOptions,
): Promise<{installed: boolean}> {
  const files = engineFilesFor(options.manifest, {
    ...(options.platform === undefined ? {} : {platform: options.platform}),
    ...(options.arch === undefined ? {} : {arch: options.arch}),
  });
  const asset = files?.[0];
  if (asset === undefined) {
    throw new InstallError(
      'There is no engine build for this platform, so the model cannot run here.',
    );
  }

  if (await engineIsPinned(options.dir, asset, options.platform)) {
    return {installed: false};
  }

  const archive = join(options.dir, `.engine-${asset.file}.part`);
  await downloadVerified({
    url: engineUrl(options.manifest, asset),
    destination: archive,
    sha256: asset.sha256,
    ...(asset.bytes === undefined ? {} : {bytes: asset.bytes}),
    label: 'The model engine',
    ...(options.onProgress === undefined
      ? {}
      : {onProgress: options.onProgress}),
    ...(options.fetchImpl === undefined ? {} : {fetchImpl: options.fetchImpl}),
    ...(options.signal === undefined ? {} : {signal: options.signal}),
  });

  await unpackEngine(archive, options.dir, {
    ...(options.platform === undefined ? {} : {platform: options.platform}),
    ...(options.execFileImpl === undefined
      ? {}
      : {execFileImpl: options.execFileImpl}),
  });
  await rm(archive, {force: true});
  await writeEngineMarker(options.dir, asset);

  return {installed: true};
}

/**
 * Fetches one piece of the recall model, unless it is already there.
 *
 * The size check is the point: an interrupted 555 MB download that left a file
 * behind is not an install, and counting it as one is a start that dies with the
 * engine complaining about a corrupt model.
 *
 * The engine is *not* fetched here. It goes first and on its own, for the reason
 * above: it is the cheap half, and a build that cannot run on this platform should
 * be refused before 310 MB is spent on the backbone.
 */
export async function installEmbeddingPiece(
  options: EmbeddingInstallOptions,
): Promise<{installed: boolean}> {
  const piece = options.manifest.weights.pieces[options.piece];
  const destination = join(options.dir, piece.file);

  if ((await sizeOf(destination)) === piece.bytes) {
    return {installed: false};
  }

  await downloadVerified({
    url: embeddingUrl(options.manifest, piece),
    destination,
    sha256: piece.sha256,
    label: piece.label,
    ...(options.onProgress === undefined
      ? {}
      : {onProgress: options.onProgress}),
    ...(options.fetchImpl === undefined ? {} : {fetchImpl: options.fetchImpl}),
    ...(options.signal === undefined ? {} : {signal: options.signal}),
  });

  return {installed: true};
}

/**
 * Downloads a file and puts it in place only once it is the pinned one.
 *
 * Resumable: a `.part` left by an interrupted attempt is continued with a `Range`
 * request rather than discarded, which for the weights is the difference between
 * losing a few seconds and losing half a gigabyte. A server that ignores the range
 * is not a problem — the response is a 200 with the whole body, and the part is
 * truncated and started again.
 */
export async function downloadVerified(options: {
  url: string;
  destination: string;
  sha256: string;
  bytes?: number;
  label: string;
  onProgress?: (progress: DownloadProgress) => void;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}): Promise<void> {
  const {destination, label} = options;
  await mkdir(dirname(destination), {recursive: true});

  const part = `${destination}.part`;
  const already = await sizeOf(part);
  const resuming = already > 0;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;

  const response = await request(fetchImpl, options.url, resuming ? already : 0, {
    label,
    ...(options.signal === undefined ? {} : {signal: options.signal}),
  });

  /*
   * 416 means the part is already as long as the file. That happens when a
   * previous run verified the digest and died before the rename — the one moment
   * where throwing away 555 MB would be most annoying. So it is hashed, and
   * promoted if it is in fact the file we wanted.
   */
  if (response.status === 416) {
    if ((await sha256Of(part)) === options.sha256) {
      await rm(destination, {force: true});
      await rename(part, destination);
      return;
    }
    await rm(part, {force: true});
    throw new InstallError(
      `${label} was already part-downloaded but did not match the pinned ` +
        'digest, so it was discarded. Try again.',
    );
  }

  // A 200 to a ranged request means the range was ignored, so the body is the
  // whole file and appending it to the part would corrupt it.
  const appended = resuming && response.status === 206;
  const start = appended ? already : 0;
  if (!appended) {
    await rm(part, {force: true});
  }

  /*
   * Checked after the 416, which is also not `ok` and has its own answer. Without
   * this the body of a refusal — an empty one — would be written and then fail the
   * digest check, which tells the user the app is broken when in fact the server
   * said no.
   */
  if (!response.ok) {
    throw new InstallError(
      `${label} could not be downloaded: the server answered ` +
        `${String(response.status)}. Try again in a moment.`,
    );
  }

  const length = Number(response.headers.get('content-length') ?? 0);
  const total = options.bytes ?? (length > 0 ? start + length : 0);
  let received = start;
  let lastReported = -1;

  const progress = (): void => {
    if (options.onProgress === undefined) {
      return;
    }
    const percent = total > 0 ? Math.floor((received / total) * 100) : undefined;
    // Once per percent: a callback per chunk would be thousands of messages for
    // one download.
    if (percent !== undefined && percent === lastReported) {
      return;
    }
    lastReported = percent ?? -1;
    options.onProgress({
      label,
      receivedBytes: received,
      totalBytes: total,
      ...(percent === undefined ? {} : {percent}),
    });
  };
  progress();

  if (response.body === null) {
    throw new InstallError(`${label} answered with no body to download.`);
  }

  const counter = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      received += chunk.byteLength;
      progress();
      controller.enqueue(chunk);
    },
  });

  await pipeline(
    response.body.pipeThrough(counter),
    createWriteStream(part, appended ? {flags: 'a'} : {}),
  );

  const actual = await sha256Of(part);
  if (actual !== options.sha256) {
    /*
     * Deleted rather than kept, so the next attempt starts clean: a part file
     * that has already hashed wrong will hash wrong again, and leaving it would
     * mean a resume that can never finish.
     */
    await rm(part, {force: true});
    throw new InstallError(
      `${label} did not match the pinned digest, so it was discarded.\n` +
        `  expected ${options.sha256}\n  got      ${actual}\n` +
        'This is a bug in the app rather than in your machine — please report it.',
    );
  }

  await rm(destination, {force: true});
  await rename(part, destination);
}

async function request(
  fetchImpl: typeof fetch,
  url: string,
  from: number,
  options: {label: string; signal?: AbortSignal},
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (from > 0) {
    headers['Range'] = `bytes=${String(from)}-`;
  }
  try {
    return await fetchImpl(url, {
      redirect: 'follow',
      headers,
      ...(options.signal === undefined ? {} : {signal: options.signal}),
    });
  } catch (failure) {
    throw new InstallError(
      `Could not reach the download for ${options.label.toLowerCase()}: ` +
        `${describe(failure)}. Check the connection and try again — the part ` +
        'already downloaded is kept.',
    );
  }
}

/**
 * Unpacks one engine archive into the directory the engine runs from.
 *
 * The archives differ between platforms — tar.gz for Linux and macOS, zip for
 * Windows — and each may or may not wrap its contents in a version directory.
 * Rather than encode that, the archive is unpacked into a scratch directory and
 * the binary is found; whatever sits beside it (the shared libraries) is what
 * gets moved, because that is what the engine needs at run time.
 *
 * `verbatimSymlinks` is load-bearing and was learned the hard way. The archives
 * link their libraries with *relative* names — `libllama-common.so.0` →
 * `libllama-common.so.0.6.0` — and Node's `cp` resolves a relative link into an
 * absolute one unless told not to. The copy then points back at the scratch
 * directory, which is deleted a line later, and the engine fails at run time with
 * "error while loading shared libraries" while every file it names is visibly
 * present.
 */
export async function unpackEngine(
  archive: string,
  dir: string,
  options: {
    platform?: NodeJS.Platform;
    execFileImpl?: (
      file: string,
      args: string[],
    ) => Promise<{stdout: string; stderr: string}>;
  } = {},
): Promise<void> {
  const exec = options.execFileImpl ?? run;
  const scratch = join(dir, '.unpack');
  await rm(scratch, {recursive: true, force: true});
  await mkdir(scratch, {recursive: true});

  try {
    await extractArchive(archive, scratch, exec);
    const binary = engineBinaryName(options.platform);
    const found = await findFile(scratch, binary);
    if (found === undefined) {
      throw new InstallError(
        `The engine archive does not contain ${binary}, so it is not the build ` +
          'this app pinned.',
      );
    }

    const target = engineDir(dir);
    await rm(target, {recursive: true, force: true});
    await mkdir(target, {recursive: true});
    await cp(dirname(found), target, {
      recursive: true,
      verbatimSymlinks: true,
    });
  } finally {
    await rm(scratch, {recursive: true, force: true});
  }
}

async function extractArchive(
  archive: string,
  target: string,
  exec: (
    file: string,
    args: string[],
  ) => Promise<{stdout: string; stderr: string}>,
): Promise<void> {
  try {
    await exec('tar', ['-xf', archive, '-C', target]);
  } catch (failure) {
    // GNU tar does not read zip, and the Windows archive is one. `unzip` may not
    // be installed at all, in which case the failure above is the useful one.
    try {
      await exec('unzip', ['-o', '-q', archive, '-d', target]);
    } catch {
      throw new InstallError(
        `The engine archive could not be unpacked: ${describe(failure)}. ` +
          'This machine needs `tar` or `unzip` on its PATH.',
      );
    }
  }
}

async function findFile(root: string, name: string): Promise<string | undefined> {
  const entries = await readdir(root, {withFileTypes: true});
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      const found = await findFile(path, name);
      if (found !== undefined) {
        return found;
      }
    } else if (entry.name === name) {
      return path;
    }
  }
  return undefined;
}

async function sha256Of(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

async function sizeOf(file: string): Promise<number> {
  try {
    return (await stat(file)).size;
  } catch {
    return -1;
  }
}

function describe(failure: unknown): string {
  return failure instanceof Error ? failure.message : String(failure);
}
