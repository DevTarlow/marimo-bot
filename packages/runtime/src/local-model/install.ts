/**
 * Fetching the engine and the weights, verified and resumable.
 *
 * It was a packaging script once, run on a build machine; it is a download a
 * user's first run performs, which is the change that shapes everything below.
 * Four things about it change what the code has to do:
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
import {createReadStream, createWriteStream, statSync} from 'node:fs';
import {
  cp,
  mkdir,
  readdir,
  rename,
  rm,
  stat,
  statfs,
} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {pipeline} from 'node:stream/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

import type {LocalModelId, LocalModelVariant} from '@marimo/protocol';
import {LOCAL_MODELS} from '@marimo/protocol';

import type {
  ChatModelManifest,
  EmbeddingManifest,
  EmbeddingPieceName,
  EngineManifest,
} from './manifest.js';
import {
  chatModelParts,
  chatModelUrl,
  embeddingUrl,
  engineAssetFor,
  engineUrl,
} from './manifest.js';
import {engineBinaryName, engineDir, localModelDir} from './files.js';
import {
  engineIsPinned,
  readLocalModelMarker,
  writeEngineMarker,
  writeLocalModelMarker,
} from './installed.js';

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

/** Anything with an engine block: either model manifest will do. */
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
 * The engine goes first and on its own: it is the cheap half — 32 MB against
 * 310 MB for the backbone and 555 MB for the projector — and a platform this
 * build has no engine for should be refused before either is fetched.
 */
export async function installEngine(
  options: EngineInstallOptions,
): Promise<{installed: boolean}> {
  const found = engineAssetFor(options.manifest, {
    ...(options.platform === undefined ? {} : {platform: options.platform}),
    ...(options.arch === undefined ? {} : {arch: options.arch}),
  });
  if (found === undefined) {
    throw new InstallError(
      'There is no engine build for this platform, so the model cannot run here.',
    );
  }

  if (await engineIsPinned(options.dir, found.asset, options.platform)) {
    return {installed: false};
  }

  const archive = join(options.dir, `.engine-${found.asset.file}.part`);
  await downloadVerified({
    url: engineUrl(options.manifest, found.asset),
    destination: archive,
    sha256: found.asset.sha256,
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
  await writeEngineMarker(options.dir, found.asset);

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
 * Unpacks the engine archive and puts the binary where the app looks for it.
 *
 * The archives differ between platforms — tar.gz for Linux and macOS, zip for
 * Windows — and each may or may not wrap its contents in a version directory.
 * Rather than encode that, the archive is unpacked into a scratch directory and
 * the binary is found; whatever sits beside it (the shared libraries) is what gets
 * moved, because that is what the engine needs at run time.
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
    try {
      await exec('tar', ['-xf', archive, '-C', scratch]);
    } catch (failure) {
      // GNU tar does not read zip, and the Windows archive is one. `unzip` may not
      // be installed at all, in which case the failure above is the useful one.
      try {
        await exec('unzip', ['-o', '-q', archive, '-d', scratch]);
      } catch {
        throw new InstallError(
          `The engine archive could not be unpacked: ${describe(failure)}. ` +
            'This machine needs `tar` or `unzip` on its PATH.',
        );
      }
    }

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

/* -------------------------------------------------------------------------- */
/* The LFM3 chat models                                                        */
/* -------------------------------------------------------------------------- */

/** One model copy, and the engine it shares with the rest. */
export interface LocalModelInstallOptions extends InstallOptions {
  manifest: ChatModelManifest;
  modelId: LocalModelId;
  variant: LocalModelVariant;
}

/**
 * Fetches the engine and one model copy, verified and resumable.
 *
 * The order is the one the engine's own install established: the cheap half
 * first, so a platform with no build is refused before 1.9GB is spent. Every
 * file goes through `downloadVerified`, which writes a `.part`, checks the
 * digest and renames only then — a file that looks installed but is not is worse
 * than a missing one, because the engine's failure arrives much later and says
 * nothing about the download.
 *
 * The marker is written last and names the exact revision and files. That is
 * what makes a later build's changed pin replace yesterday's weights, and what
 * makes a size-only check sufficient on every subsequent read.
 */
export async function installLocalModel(
  options: LocalModelInstallOptions,
): Promise<{installed: boolean}> {
  const {manifest, modelId, variant} = options;
  const model = LOCAL_MODELS[modelId];
  const engine = await installEngine({
    dir: options.dir,
    manifest,
    ...(options.platform === undefined ? {} : {platform: options.platform}),
    ...(options.arch === undefined ? {} : {arch: options.arch}),
    ...(options.onProgress === undefined
      ? {}
      : {onProgress: options.onProgress}),
    ...(options.fetchImpl === undefined
      ? {}
      : {fetchImpl: options.fetchImpl}),
    ...(options.execFileImpl === undefined
      ? {}
      : {execFileImpl: options.execFileImpl}),
    ...(options.signal === undefined ? {} : {signal: options.signal}),
  });

  const dir = localModelDir(options.dir, modelId);
  await mkdir(dir, {recursive: true});

  const parts = chatModelParts(manifest, modelId, variant);
  const missing = parts.filter(
    (part) => sizeOfSync(join(dir, part.pin.file)) !== part.pin.bytes,
  );

  /*
   * Asked before the first byte, with a little room to finish rather than fill
   * the disk exactly. A user who has to delete something should be told which
   * number is wrong while the button can still explain itself.
   */
  const needed = missing.reduce((total, part) => total + part.pin.bytes, 0);
  if (needed > 0) {
    await assertDiskSpace(dir, needed);
  }

  for (const part of missing) {
    await downloadVerified({
      url: chatModelUrl(manifest, modelId, variant, part.part),
      destination: join(dir, part.pin.file),
      sha256: part.pin.sha256,
      bytes: part.pin.bytes,
      label:
        part.part === 'weights'
          ? model.label
          : modelId === 'lfm3-vl-2b'
            ? 'The vision encoder'
            : 'The audio encoder',
      ...(options.onProgress === undefined
        ? {}
        : {onProgress: options.onProgress}),
      ...(options.fetchImpl === undefined
        ? {}
        : {fetchImpl: options.fetchImpl}),
      ...(options.signal === undefined ? {} : {signal: options.signal}),
    });
  }

  /*
   * A variant change leaves the old quantization's file in the directory
   * unless it is removed here. Both names end in `.gguf` and both are large;
   * leaving one behind would double the disk cost of a choice the user made to
   * save space.
   */
  const keep = new Set(parts.map((part) => part.pin.file));
  for (const name of await readdir(dir)) {
    if (name.endsWith('.gguf') && !keep.has(name)) {
      await rm(join(dir, name), {force: true});
    }
  }

  const files = parts.map((part) => ({
    name: part.pin.file,
    sha256: part.pin.sha256,
    bytes: part.pin.bytes,
  }));
  const marker = await readLocalModelMarker(dir);
  const markerCurrent =
    marker !== undefined &&
    marker.modelId === modelId &&
    marker.variant === variant &&
    marker.revision === manifest.models[modelId].revision &&
    marker.files.length === files.length &&
    marker.files.every((file) =>
      files.some(
        (expected) =>
          expected.name === file.name &&
          expected.sha256 === file.sha256 &&
          expected.bytes === file.bytes,
      ),
    );

  if (!markerCurrent) {
    await writeLocalModelMarker(dir, {
      modelId,
      variant,
      revision: manifest.models[modelId].revision,
      files,
    });
  }

  return {installed: engine.installed || missing.length > 0 || !markerCurrent};
}

/** The size of a file without awaiting it; `-1` when it is not there. */
function sizeOfSync(file: string): number {
  try {
    // `statSync` is safe here: the path is one this process just constructed,
    // and the check is a single metadata read.
    return statSync(file).size;
  } catch {
    return -1;
  }
}

/** Refuses a download that would fill the disk, in a sentence. */
async function assertDiskSpace(dir: string, needed: number): Promise<void> {
  const headroom = 256 * 1024 * 1024;
  let free: number;
  try {
    const stats = await statfs(dir);
    free = Number(stats.bavail) * Number(stats.bsize);
  } catch {
    // A filesystem that cannot answer is not evidence that it is full. The
    // download's own failure is the honest one.
    return;
  }
  if (free < needed + headroom) {
    throw new InstallError(
      `There is not enough room for this model. It needs about ` +
        `${formatBytes(needed + headroom)} free, and this disk has ` +
        `${formatBytes(free)}.`,
    );
  }
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  }
  return `${Math.ceil(bytes / (1024 * 1024))} MB`;
}

