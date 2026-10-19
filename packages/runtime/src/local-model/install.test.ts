/**
 * Fetching gigabytes without leaving a mess.
 *
 * The failures this pins are all the same shape: a file that looks finished and is
 * not. A half-written model that the resolver counts as installed is a start that
 * dies with the engine complaining about a corrupt file, and the user has no way to
 * tell that from a bug. So most of these are about the `.part` file — that a
 * mismatch deletes it, that an interrupted download resumes rather than restarts,
 * and that the destination only ever appears once the digest has matched.
 *
 * Nothing here touches the network or spawns `tar`: both are injected, which is
 * what lets a test assert on a 555 MB download's *bookkeeping* in milliseconds.
 */
import {createHash} from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import {join} from 'node:path';

import {afterEach, beforeEach, describe, expect, it} from 'vitest';

import {parseEmbeddingManifest} from './manifest.js';
import type {EmbeddingManifest} from './manifest.js';
import {engineBinaryName, engineDir} from './files.js';
import {
  downloadVerified,
  engineIsPinned,
  InstallError,
  installEmbeddingPiece,
  installEngine,
  unpackEngine,
} from './install.js';

const BODY = 'the recall model, which is not really 310 MB';

function digestOf(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** A fetch that answers once with the given body, and records what it was asked. */
function fakeFetch(
  body: string | Uint8Array,
  options: {
    status?: number;
    headers?: Record<string, string>;
    calls?: Array<{url: string; headers: Record<string, string>}>;
    failure?: Error;
  } = {},
): typeof fetch {
  const payload =
    typeof body === 'string' ? new TextEncoder().encode(body) : body;
  return (async (url: unknown, init: RequestInit = {}) => {
    options.calls?.push({
      url: String(url),
      headers: (init.headers ?? {}) as Record<string, string>,
    });
    if (options.failure !== undefined) {
      throw options.failure;
    }
    return new Response(payload, {
      status: options.status ?? 200,
      headers: options.headers ?? {
        'content-length': String(payload.byteLength),
      },
    });
  }) as unknown as typeof fetch;
}

describe('downloadVerified', () => {
  let dir: string;
  let destination: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(process.cwd(), '.marimo-download-'));
    destination = join(dir, 'model.gguf');
  });

  afterEach(async () => {
    await rm(dir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 20,
    });
  });

  it('puts the file in place only once the digest matches', async () => {
    await downloadVerified({
      url: 'https://example.test/model.gguf',
      destination,
      sha256: digestOf(BODY),
      label: 'The recall model',
      fetchImpl: fakeFetch(BODY),
    });

    expect(await readFile(destination, 'utf8')).toBe(BODY);
    // And nothing left over beside it.
    await expect(stat(`${destination}.part`)).rejects.toThrow();
  });

  /*
   * The failure that matters most. A download that hashed wrong is deleted rather
   * than kept, because a part file that has already hashed wrong will hash wrong
   * again — leaving it would mean a resume that can never finish.
   */
  it('discards a download that does not match the pin, and writes nothing', async () => {
    await expect(
      downloadVerified({
        url: 'https://example.test/model.gguf',
        destination,
        sha256: digestOf('something else entirely'),
        label: 'The recall model',
        fetchImpl: fakeFetch(BODY),
      }),
    ).rejects.toThrow(/did not match the pinned digest/u);

    await expect(stat(destination)).rejects.toThrow();
    await expect(stat(`${destination}.part`)).rejects.toThrow();
  });

  it('resumes a part file with a range request and appends to it', async () => {
    const half = Math.floor(BODY.length / 2);
    await writeFile(`${destination}.part`, BODY.slice(0, half), 'utf8');

    const calls: Array<{url: string; headers: Record<string, string>}> = [];
    await downloadVerified({
      url: 'https://example.test/model.gguf',
      destination,
      sha256: digestOf(BODY),
      label: 'The recall model',
      fetchImpl: fakeFetch(BODY.slice(half), {
        status: 206,
        calls,
      }),
    });

    expect(calls[0]?.headers['Range']).toBe(`bytes=${String(half)}-`);
    expect(await readFile(destination, 'utf8')).toBe(BODY);
  });

  /*
   * A server that ignores the range answers 200 with the whole body. Appending
   * that to the part would produce a file that is the wrong length and hashes
   * wrong, so the part is truncated and the download starts again.
   */
  it('starts over when the server ignores the range', async () => {
    await writeFile(`${destination}.part`, 'stale half', 'utf8');

    await downloadVerified({
      url: 'https://example.test/model.gguf',
      destination,
      sha256: digestOf(BODY),
      label: 'The recall model',
      fetchImpl: fakeFetch(BODY, {status: 200}),
    });

    expect(await readFile(destination, 'utf8')).toBe(BODY);
  });

  /*
   * The moment where throwing away 555 MB would be most annoying: the download
   * finished, the digest matched, and the process died before the rename. The next
   * attempt gets a 416, and the part is promoted rather than discarded.
   */
  it('promotes a part file that is already the whole file', async () => {
    await writeFile(`${destination}.part`, BODY, 'utf8');

    await downloadVerified({
      url: 'https://example.test/model.gguf',
      destination,
      sha256: digestOf(BODY),
      label: 'The recall model',
      fetchImpl: fakeFetch('', {status: 416}),
    });

    expect(await readFile(destination, 'utf8')).toBe(BODY);
  });

  it('discards a part file that is complete but wrong', async () => {
    await writeFile(`${destination}.part`, 'not the pinned file', 'utf8');

    await expect(
      downloadVerified({
        url: 'https://example.test/model.gguf',
        destination,
        sha256: digestOf(BODY),
        label: 'The recall model',
        fetchImpl: fakeFetch('', {status: 416}),
      }),
    ).rejects.toThrow(/did not match the pinned digest/u);
    await expect(stat(`${destination}.part`)).rejects.toThrow();
  });

  it('names the status when the server refuses', async () => {
    await expect(
      downloadVerified({
        url: 'https://example.test/model.gguf',
        destination,
        sha256: digestOf(BODY),
        label: 'The projector',
        fetchImpl: fakeFetch('', {status: 503}),
      }),
    ).rejects.toThrow(/The projector could not be downloaded.*503/u);
  });

  /*
   * A network failure has to say that the part is kept, because otherwise the
   * reasonable thing to do is delete it and start again — which for the projector
   * costs half a gigabyte.
   */
  it('says the part is kept when the network fails', async () => {
    await expect(
      downloadVerified({
        url: 'https://example.test/model.gguf',
        destination,
        sha256: digestOf(BODY),
        label: 'The recall model',
        fetchImpl: fakeFetch('', {failure: new Error('getaddrinfo ENOTFOUND')}),
      }),
    ).rejects.toThrow(/part already downloaded is kept/u);
  });

  it('reports progress against the size the manifest pins', async () => {
    const seen: number[] = [];
    await downloadVerified({
      url: 'https://example.test/model.gguf',
      destination,
      sha256: digestOf(BODY),
      bytes: BODY.length,
      label: 'The recall model',
      // No content-length: the pinned size is the only thing that can say how far
      // along this is.
      fetchImpl: fakeFetch(BODY, {headers: {}}),
      onProgress: (progress) => {
        expect(progress.label).toBe('The recall model');
        expect(progress.totalBytes).toBe(BODY.length);
        if (progress.percent !== undefined) {
          seen.push(progress.percent);
        }
      },
    });

    expect(seen).toContain(100);
  });
});

describe('the engine', () => {
  let dir: string;
  let manifest: EmbeddingManifest;

  beforeEach(async () => {
    dir = await mkdtemp(join(process.cwd(), '.marimo-engine-'));
    manifest = embeddingFixture();
  });

  afterEach(async () => {
    await rm(dir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 20,
    });
  });

  /**
   * Stands in for `tar`, by laying out what the archive contains.
   *
   * The real archives wrap their contents in a version directory and link their
   * libraries relatively, so the fake does both — that shape is what `unpackEngine`
   * has to survive.
   */
  function fakeTar(): (
    file: string,
    args: string[],
  ) => Promise<{stdout: string; stderr: string}> {
    return async (_file, args) => {
      const scratch = args[args.indexOf('-C') + 1]!;
      const inner = join(scratch, 'llama-b1');
      await mkdir(inner, {recursive: true});
      await writeFile(join(inner, engineBinaryName('linux')), 'binary', 'utf8');
      await writeFile(join(inner, 'libllama.so.0.6.0'), 'library', 'utf8');
      await symlink('libllama.so.0.6.0', join(inner, 'libllama.so.0'));
      return {stdout: '', stderr: ''};
    };
  }

  it('unpacks the binary and the libraries beside it', async () => {
    const archive = join(dir, 'engine.tar.gz');
    await writeFile(archive, 'archive', 'utf8');

    await unpackEngine(archive, dir, {
      platform: 'linux',
      execFileImpl: fakeTar(),
    });

    expect(await readFile(join(engineDir(dir), 'llama-server'), 'utf8')).toBe(
      'binary',
    );
    expect(
      await readFile(join(engineDir(dir), 'libllama.so.0.6.0'), 'utf8'),
    ).toBe('library');
  });

  /*
   * The bug this exists for: Node's `cp` resolves a relative symlink into an
   * absolute one unless told not to, so the copy points back at a scratch directory
   * that is deleted a line later — and the engine fails at run time with "error
   * while loading shared libraries" while every file it names is visibly present.
   */
  it('keeps a relative library link relative', async () => {
    const archive = join(dir, 'engine.tar.gz');
    await writeFile(archive, 'archive', 'utf8');

    await unpackEngine(archive, dir, {
      platform: 'linux',
      execFileImpl: fakeTar(),
    });

    const link = join(engineDir(dir), 'libllama.so.0');
    expect(await readlink(link)).toBe('libllama.so.0.6.0');
  });

  it('refuses an archive that does not contain the engine', async () => {
    const archive = join(dir, 'engine.tar.gz');
    await writeFile(archive, 'archive', 'utf8');

    await expect(
      unpackEngine(archive, dir, {
        platform: 'linux',
        execFileImpl: async (_file, args) => {
          await mkdir(args[args.indexOf('-C') + 1]!, {recursive: true});
          return {stdout: '', stderr: ''};
        },
      }),
    ).rejects.toThrow(/does not contain llama-server/u);
  });

  it('downloads, unpacks and marks the engine in one call', async () => {
    const result = await installEngine({
      dir,
      manifest,
      platform: 'linux',
      arch: 'x64',
      fetchImpl: fakeFetch('archive-bytes'),
      execFileImpl: fakeTar(),
    });

    expect(result.installed).toBe(true);
    expect(await readFile(join(engineDir(dir), 'llama-server'), 'utf8')).toBe(
      'binary',
    );
    // The archive is not kept: it is 32 MB of nothing once it is unpacked.
    await expect(stat(join(dir, '.engine-e.tar.gz.part'))).rejects.toThrow();
  });

  /*
   * An app update that moves to a new llama.cpp tag must not go on running the old
   * engine. The binary has no pinned size to compare, so the unpacked directory
   * carries a marker naming the asset it came from.
   */
  it('re-installs when the pin has changed, and not otherwise', async () => {
    await installEngine({
      dir,
      manifest,
      platform: 'linux',
      arch: 'x64',
      fetchImpl: fakeFetch('archive-bytes'),
      execFileImpl: fakeTar(),
    });

    const asset = manifest.engine.assets['linux-x64']!;
    expect(await engineIsPinned(dir, asset, 'linux')).toBe(true);

    // A different pin, as a later build would have.
    expect(
      await engineIsPinned(dir, {...asset, sha256: 'f'.repeat(64)}, 'linux'),
    ).toBe(false);

    const again = await installEngine({
      dir,
      manifest,
      platform: 'linux',
      arch: 'x64',
      fetchImpl: fakeFetch('archive-bytes'),
      execFileImpl: fakeTar(),
    });
    // The same pin means no second download.
    expect(again.installed).toBe(false);
  });

  it('says so when there is no engine build for this platform', async () => {
    await expect(
      installEngine({dir, manifest, platform: 'freebsd', arch: 'x64'}),
    ).rejects.toThrow(/no engine build for this platform/u);
  });

  it('is not pinned when nothing has been unpacked', async () => {
    expect(
      await engineIsPinned(dir, manifest.engine.assets['linux-x64']!, 'linux'),
    ).toBe(false);
  });
});

/**
 * The recall model's manifest, small enough to write in a test.
 *
 * One fixture for both installers, because they read the same document: the
 * engine asset is pinned to the digest the engine tests fetch, and the two pieces
 * are strings a test can write to disk.
 */
function embeddingFixture(): EmbeddingManifest {
  return parseEmbeddingManifest({
    engine: {
      tag: 'b2',
      baseUrl: 'https://example.test/dl',
      assets: {
        'linux-x64': {file: 'e.tar.gz', sha256: digestOf('archive-bytes')},
      },
    },
    weights: {
      repo: 'unsloth/embeddinggemma-2-GGUF',
      revision: 'rev2',
      license: 'Apache-2.0',
      dims: 768,
      contextSize: 8192,
      pooling: 'mean',
      pieces: {
        text: {
          label: 'The recall model',
          file: 'text.gguf',
          sha256: digestOf('the backbone'),
          bytes: 'the backbone'.length,
        },
        media: {
          label: 'The encoder',
          file: 'mmproj.gguf',
          sha256: digestOf('the encoders'),
          bytes: 'the encoders'.length,
        },
      },
    },
  });
}

describe('InstallError', () => {
  it('is the type a caller can catch to show a sentence', () => {
    expect(new InstallError('nope')).toBeInstanceOf(Error);
    expect(new InstallError('nope').name).toBe('InstallError');
  });
});

/**
 * The recall model's two pieces.
 *
 * The same downloader the engine uses, so what is asserted here is only what
 * differs: a piece is fetched from the recall repository at the pinned revision,
 * and the projector is a separate download that can be present or absent entirely
 * without the backbone being re-fetched.
 */
describe('installEmbeddingPiece', () => {
  let dir: string;
  let manifest: EmbeddingManifest;

  beforeEach(async () => {
    dir = await mkdtemp(join(process.cwd(), '.marimo-install-recall-'));
    manifest = embeddingFixture();
  });

  afterEach(async () => {
    await rm(dir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 20,
    });
  });

  it('downloads the text model from the pinned revision', async () => {
    const calls: Array<{url: string; headers: Record<string, string>}> = [];
    const result = await installEmbeddingPiece({
      dir,
      manifest,
      piece: 'text',
      fetchImpl: fakeFetch('the backbone', {calls}),
    });

    expect(result.installed).toBe(true);
    expect(calls[0]?.url).toBe(
      'https://huggingface.co/unsloth/embeddinggemma-2-GGUF/resolve/rev2/text.gguf',
    );
    expect(await readFile(join(dir, 'text.gguf'), 'utf8')).toBe('the backbone');
  });

  it('downloads the projector separately', async () => {
    const result = await installEmbeddingPiece({
      dir,
      manifest,
      piece: 'media',
      fetchImpl: fakeFetch('the encoders'),
    });

    expect(result.installed).toBe(true);
    expect(await readFile(join(dir, 'mmproj.gguf'), 'utf8')).toBe(
      'the encoders',
    );
  });

  it('leaves a piece that is already the pinned size alone', async () => {
    const piece = manifest.weights.pieces.text;
    await writeFile(join(dir, piece.file), '', 'utf8');
    const {truncate} = await import('node:fs/promises');
    await truncate(join(dir, piece.file), piece.bytes);

    let called = false;
    const result = await installEmbeddingPiece({
      dir,
      manifest,
      piece: 'text',
      fetchImpl: (async () => {
        called = true;
        return new Response('');
      }) as unknown as typeof fetch,
    });

    expect(called).toBe(false);
    expect(result.installed).toBe(false);
  });

  /*
   * A file with the right name and the wrong length is what an interrupted
   * download leaves behind, and counting it as installed is an engine that fails
   * to load a model the card says is there.
   */
  it('re-fetches a piece that is the wrong size', async () => {
    const piece = manifest.weights.pieces.text;
    await writeFile(join(dir, piece.file), 'half of it', 'utf8');

    const result = await installEmbeddingPiece({
      dir,
      manifest,
      piece: 'text',
      fetchImpl: fakeFetch('the backbone'),
    });

    expect(result.installed).toBe(true);
    expect(await readFile(join(dir, piece.file), 'utf8')).toBe('the backbone');
  });
});
