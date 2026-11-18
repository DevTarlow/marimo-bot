import {createHash} from 'node:crypto';
import {mkdtemp, readFile, rm, stat, writeFile} from 'node:fs/promises';
import {join} from 'node:path';

import {afterEach, beforeEach, describe, expect, it} from 'vitest';

import {LISTEN_MARKER} from './files.js';
import {installListen, isListenInstalled} from './install.js';
import type {ListenFile} from './types.js';

const sha256 = (text: string): string =>
  createHash('sha256').update(text).digest('hex');

const FILES: readonly ListenFile[] = [
  {
    name: 'frontend.ort',
    path: 'model/small/frontend.ort',
    label: 'The front end',
    bytes: 5,
    sha256: sha256('front'),
  },
  {
    name: 'tokenizer.bin',
    path: 'model/small/tokenizer.bin',
    label: 'The tokenizer',
    bytes: 6,
    sha256: sha256('tokens'),
  },
];

const CONTENT: Record<string, string> = {
  'frontend.ort': 'front',
  'tokenizer.bin': 'tokens',
};

describe('the voice-input installer', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(process.cwd(), '.marimo-listen-install-'));
  });

  afterEach(async () => {
    await rm(dir, {recursive: true, force: true, maxRetries: 5});
  });

  function fetching(overrides: Record<string, string> = {}): typeof fetch {
    return (async (input: string | URL | Request) => {
      const url = String(input);
      const name = Object.keys(CONTENT).find((candidate) =>
        url.endsWith(candidate),
      );
      if (name === undefined) {
        return new Response('not found', {status: 404});
      }
      return new Response(overrides[name] ?? CONTENT[name]);
    }) as typeof fetch;
  }

  function urlFor(file: ListenFile): string {
    return `https://example.test/${file.path}`;
  }

  it('downloads every file, verifies it and writes the marker', async () => {
    await installListen({
      dir,
      files: FILES,
      revision: 'test',
      fetchImpl: fetching(),
      urlFor,
    });
    expect(await readFile(join(dir, 'frontend.ort'), 'utf8')).toBe('front');
    expect(await readFile(join(dir, 'tokenizer.bin'), 'utf8')).toBe('tokens');
    expect(JSON.parse(await readFile(join(dir, LISTEN_MARKER), 'utf8'))).toEqual(
      {revision: 'test'},
    );
    expect(await isListenInstalled(dir, FILES, 'test')).toBe(true);
  });

  it('calls it installed only for the pinned revision and sizes', async () => {
    await installListen({
      dir,
      files: FILES,
      revision: 'test',
      fetchImpl: fetching(),
      urlFor,
    });
    expect(await isListenInstalled(dir, FILES, 'other')).toBe(false);
    await writeFile(join(dir, 'tokenizer.bin'), 'longer tokens');
    expect(await isListenInstalled(dir, FILES, 'test')).toBe(false);
  });

  it('repairs a file whose bytes changed without changing its size', async () => {
    await installListen({
      dir,
      files: FILES,
      revision: 'test',
      fetchImpl: fetching(),
      urlFor,
    });
    await writeFile(join(dir, 'frontend.ort'), 'FRONT');
    // The marker and sizes still say installed; opening the card is a cheap
    // read. Verify is the button that hashes and repairs.
    expect(await isListenInstalled(dir, FILES, 'test')).toBe(true);

    await installListen({
      dir,
      files: FILES,
      revision: 'test',
      fetchImpl: fetching(),
      urlFor,
    });
    expect(await readFile(join(dir, 'frontend.ort'), 'utf8')).toBe('front');
  });

  it('refuses a file whose digest does not match and leaves no marker', async () => {
    await expect(
      installListen({
        dir,
        files: FILES,
        revision: 'test',
        fetchImpl: fetching({'frontend.ort': 'wrong'}),
        urlFor,
      }),
    ).rejects.toThrow(/did not match|digest|fingerprint/iu);
    expect(await isListenInstalled(dir, FILES, 'test')).toBe(false);
  });

  it('reports progress while it downloads', async () => {
    const seen: number[] = [];
    await installListen({
      dir,
      files: FILES,
      revision: 'test',
      fetchImpl: fetching(),
      urlFor,
      onProgress: (progress) => {
        seen.push(progress.receivedBytes);
      },
    });
    expect(seen.length).toBeGreaterThan(0);
    expect(Math.max(...seen)).toBeGreaterThan(0);
  });

  it('leaves no partial file that looks installed', async () => {
    await writeFile(join(dir, 'frontend.ort.part'), 'fro', 'utf8');
    expect(await isListenInstalled(dir, FILES, 'test')).toBe(false);
    expect((await stat(join(dir, 'frontend.ort.part'))).isFile()).toBe(true);
  });
});
