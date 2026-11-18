/**
 * What the Spoken replies card is told before anything is loaded.
 *
 * `status()` is a read: it stats the five pinned files, reads the model's
 * catalogue, and reports the engine as idle. It must not load an 82 MB graph to
 * draw a dot, and it must not claim a download is installed because a marker
 * exists without the files. The ONNX session itself is exercised by the live
 * check, which is the only place a real graph is available.
 */
import {mkdtemp, rm, truncate, writeFile} from 'node:fs/promises';
import {join} from 'node:path';

import {afterEach, beforeEach, describe, expect, it} from 'vitest';

import {defaultSpeechSettings} from '@marimo/protocol';
import {TTS_FILES, TTS_MARKER, TTS_REVISION} from '@marimo/runtime';

import {SpeechHost} from '../src/main/speech-host.js';

describe('SpeechHost.status', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(process.cwd(), '.marimo-tts-host-'));
  });

  afterEach(async () => {
    await rm(dir, {recursive: true, force: true, maxRetries: 5});
  });

  function host(): SpeechHost {
    return new SpeechHost({
      dir,
      readSettings: async () => defaultSpeechSettings(),
      sendEvent: () => undefined,
    });
  }

  async function install(): Promise<void> {
    for (const file of TTS_FILES) {
      const path = join(dir, file.name);
      await writeFile(path, '');
      await truncate(path, file.bytes);
    }
    // The catalogue is read, so it has to be valid JSON padded to its pinned
    // length; the rest are only stat-ed by status.
    const config = JSON.stringify({
      sample_rate: 24_000,
      voices: {
        en: [
          {
            key: 'eleanor',
            name: 'Eleanor',
            description: 'Somber historian',
          },
        ],
      },
    });
    await writeFile(
      join(dir, 'config.json'),
      config.padEnd(
        TTS_FILES.find((file) => file.name === 'config.json')?.bytes ?? 0,
        ' ',
      ),
    );
    await writeFile(
      join(dir, TTS_MARKER),
      JSON.stringify({revision: TTS_REVISION}),
    );
  }

  it('says not installed, with no voices and an idle engine, for an empty folder', async () => {
    const status = await host().status();
    expect(status.installed).toBe(false);
    expect(status.voices).toEqual([]);
    expect(status.engine).toBe('idle');
    expect(status.error).toBeUndefined();
  });

  it('reads the catalogue from an installed model', async () => {
    await install();
    const status = await host().status();
    expect(status.installed).toBe(true);
    expect(status.engine).toBe('idle');
    expect(status.voices).toEqual([
      {
        key: 'eleanor',
        name: 'Eleanor',
        description: 'Somber historian',
        language: 'en',
      },
    ]);
  });

  it('refuses a marker written for another revision', async () => {
    await install();
    await writeFile(join(dir, TTS_MARKER), JSON.stringify({revision: 'other'}));
    expect((await host().status()).installed).toBe(false);
  });

  it('reports a catalogue it cannot read rather than claiming voices', async () => {
    await install();
    await writeFile(
      join(dir, 'config.json'),
      'not json'.padEnd(
        TTS_FILES.find((file) => file.name === 'config.json')?.bytes ?? 0,
        ' ',
      ),
    );
    const status = await host().status();
    expect(status.installed).toBe(true);
    expect(status.voices).toEqual([]);
    expect(status.error).toMatch(/catalogue could not be read/u);
  });
});
