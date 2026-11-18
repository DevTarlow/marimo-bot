import {createHash} from 'node:crypto';
import {mkdtemp, readFile, rm, stat, writeFile} from 'node:fs/promises';
import {join} from 'node:path';

import {afterEach, beforeEach, describe, expect, it} from 'vitest';

import {installSpeech, isSpeechInstalled} from './install.js';
import {TTS_MARKER} from './files.js';
import type {TtsFile} from './types.js';

const sha256 = (text: string): string =>
  createHash('sha256').update(text).digest('hex');

const FILES: readonly TtsFile[] = [
  {
    name: 'model.bin',
    path: 'model.bin',
    label: 'The model',
    bytes: 5,
    sha256: sha256('model'),
  },
  {
    name: 'voices.bin',
    path: 'voices.bin',
    label: 'The voices',
    bytes: 6,
    sha256: sha256('voices'),
  },
];

const CONTENT: Record<string, string> = {
  'model.bin': 'model',
  'voices.bin': 'voices',
};

describe('the voice-model installer', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(process.cwd(), '.marimo-tts-install-'));
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

  it('downloads every file, verifies it and writes the marker', async () => {
    await installSpeech({
      dir,
      files: FILES,
      revision: 'test',
      fetchImpl: fetching(),
    });
    expect(await readFile(join(dir, 'model.bin'), 'utf8')).toBe('model');
    expect(await readFile(join(dir, 'voices.bin'), 'utf8')).toBe('voices');
    expect(JSON.parse(await readFile(join(dir, TTS_MARKER), 'utf8'))).toEqual({
      revision: 'test',
    });
    expect(await isSpeechInstalled(dir, FILES, 'test')).toBe(true);
  });

  it('calls it installed only for the pinned revision and sizes', async () => {
    await installSpeech({
      dir,
      files: FILES,
      revision: 'test',
      fetchImpl: fetching(),
    });
    expect(await isSpeechInstalled(dir, FILES, 'other')).toBe(false);
    await writeFile(join(dir, 'voices.bin'), 'longer voices');
    expect(await isSpeechInstalled(dir, FILES, 'test')).toBe(false);
  });

  it('repairs a file whose bytes changed without changing its size', async () => {
    await installSpeech({
      dir,
      files: FILES,
      revision: 'test',
      fetchImpl: fetching(),
    });
    await writeFile(join(dir, 'model.bin'), 'MODEL');
    expect(await isSpeechInstalled(dir, FILES, 'test')).toBe(true);

    await installSpeech({
      dir,
      files: FILES,
      revision: 'test',
      fetchImpl: fetching(),
    });
    expect(await readFile(join(dir, 'model.bin'), 'utf8')).toBe('model');
  });

  it('refuses a file whose digest does not match and leaves no marker', async () => {
    await expect(
      installSpeech({
        dir,
        files: FILES,
        revision: 'test',
        fetchImpl: fetching({'model.bin': 'wrong'}),
      }),
    ).rejects.toThrow(/did not match|digest|fingerprint/iu);
    expect(await isSpeechInstalled(dir, FILES, 'test')).toBe(false);
  });

  it('reports progress while it downloads', async () => {
    const seen: number[] = [];
    await installSpeech({
      dir,
      files: FILES,
      revision: 'test',
      fetchImpl: fetching(),
      onProgress: (progress) => {
        seen.push(progress.receivedBytes);
      },
    });
    expect(seen.length).toBeGreaterThan(0);
    expect(Math.max(...seen)).toBeGreaterThan(0);
  });

  it('leaves no partial file that looks installed', async () => {
    await writeFile(join(dir, 'model.bin.part'), 'mod', 'utf8');
    // No marker: the directory is not installed even though a part exists.
    expect(await isSpeechInstalled(dir, FILES, 'test')).toBe(false);
    expect((await stat(join(dir, 'model.bin.part'))).isFile()).toBe(true);
  });
});
