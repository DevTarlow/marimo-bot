import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';

import {afterEach, beforeEach, describe, expect, it} from 'vitest';

import {npyFloat32, zip} from '../../test-fixtures/npz.js';
import {
  readVoiceCatalogue,
  readVoicePacks,
  resolveVoice,
  voicePack,
} from './voices.js';

describe('the voice catalogue', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(process.cwd(), '.marimo-voices-'));
  });

  afterEach(async () => {
    await rm(dir, {recursive: true, force: true, maxRetries: 5});
  });

  async function writeModel(
    options: {
      voices?: unknown;
      sampleRate?: unknown;
      packs?: string[];
    } = {},
  ): Promise<void> {
    await writeFile(
      join(dir, 'config.json'),
      JSON.stringify({
        sample_rate: options.sampleRate ?? 24_000,
        voices: {
          en: options.voices ?? [
            {key: 'eleanor', name: 'Eleanor', description: 'Somber historian'},
            {key: 'martha', name: 'Martha', description: 'Radio journalist'},
          ],
        },
      }),
      'utf8',
    );
    const entries = (options.packs ?? ['eleanor', 'martha']).map((name) => ({
      name: `${name}.npy`,
      data: npyFloat32([1, 2, 3, 4], [2, 2]),
    }));
    await writeFile(join(dir, 'voices_en.npz'), zip(entries));
  }

  it('reads the model’s own English voices and sample rate', async () => {
    await writeModel();
    const catalogue = await readVoiceCatalogue(dir);
    expect(catalogue.sampleRate).toBe(24_000);
    expect(catalogue.voices).toEqual([
      {
        key: 'eleanor',
        name: 'Eleanor',
        description: 'Somber historian',
        language: 'en',
      },
      {
        key: 'martha',
        name: 'Martha',
        description: 'Radio journalist',
        language: 'en',
      },
    ]);
  });

  it('resolves a stale key to the first voice', async () => {
    await writeModel();
    const {voices} = await readVoiceCatalogue(dir);
    expect(resolveVoice(voices, 'missing').key).toBe('eleanor');
    expect(resolveVoice(voices, 'martha').key).toBe('martha');
  });

  it('refuses a catalogue with no English voices', async () => {
    await writeModel({voices: []});
    await expect(readVoiceCatalogue(dir)).rejects.toThrow(/no English voices/u);
  });

  it('reads voice packs and refuses a voice the pack lacks', async () => {
    await writeModel({packs: ['eleanor']});
    const {voices} = await readVoiceCatalogue(dir);
    const packs = await readVoicePacks(dir);
    const eleanor = resolveVoice(voices, 'eleanor');
    expect([...voicePack(packs, eleanor)]).toEqual([1, 2, 3, 4]);
    expect(() => voicePack(packs, resolveVoice(voices, 'martha'))).toThrow(
      /not in the downloaded pack/u,
    );
  });
});
