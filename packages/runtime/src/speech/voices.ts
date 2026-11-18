/**
 * The model's voice catalogue and its style packs.
 *
 * `config.json` is the repository's own list: the key `voices_en.npz` stores the
 * style vectors under, the name a person picks, and the one-line description the
 * model card gives it. Reading it from the downloaded copy rather than keeping a
 * second list in the app is what makes the picker and the weights one fact: a
 * voice the model cannot load cannot appear in the list.
 *
 * A stored voice that the installed model no longer has is resolved to the
 * first voice instead of failing the card. The settings file outlives one model
 * download, and a stale key is a preference to repair, not a broken app.
 */
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';

import type {SpeechVoice} from '@marimo/protocol';

import {readNpz, type NpyArray} from './npz.js';

/** The English half of the model's own catalogue. */
export interface VoiceCatalogue {
  sampleRate: number;
  voices: SpeechVoice[];
}

/** What `config.json` must say for this build to use it. */
interface ModelConfig {
  sample_rate?: unknown;
  voices?: {
    en?: Array<{key?: unknown; name?: unknown; description?: unknown}>;
  };
}

/** Read the catalogue from an installed model, with a sentence on failure. */
export async function readVoiceCatalogue(dir: string): Promise<VoiceCatalogue> {
  let parsed: ModelConfig;
  try {
    parsed = JSON.parse(
      await readFile(join(dir, 'config.json'), 'utf8'),
    ) as ModelConfig;
  } catch (failure) {
    throw new Error(
      `The voice model's catalogue could not be read: ${describe(failure)}. ` +
        'Download it again from Settings → Spoken replies.',
    );
  }
  const sampleRate = parsed.sample_rate;
  if (
    typeof sampleRate !== 'number' ||
    !Number.isInteger(sampleRate) ||
    sampleRate <= 0
  ) {
    throw new Error(
      'The voice model has no sample rate. Download it again from Settings → ' +
        'Spoken replies.',
    );
  }
  const english = parsed.voices?.en;
  if (!Array.isArray(english) || english.length === 0) {
    throw new Error(
      'The voice model has no English voices. Download it again from Settings ' +
        '→ Spoken replies.',
    );
  }
  const voices: SpeechVoice[] = [];
  for (const entry of english) {
    const key = entry.key;
    const name = entry.name;
    const description = entry.description;
    if (
      typeof key !== 'string' ||
      key.length === 0 ||
      typeof name !== 'string' ||
      typeof description !== 'string'
    ) {
      throw new Error(
        'The voice model has a voice it cannot describe. Download it again ' +
          'from Settings → Spoken replies.',
      );
    }
    voices.push({key, name, description, language: 'en'});
  }
  return {sampleRate, voices};
}

/**
 * The style vectors, keyed by voice.
 *
 * A pack is `[510, 256]` float32: one style vector per input length. Parsing it
 * once and keeping it for the session is what makes switching voices free; the
 * file is 5.7 MB and reading it per reply would be the larger cost.
 */
export async function readVoicePacks(
  dir: string,
): Promise<Map<string, NpyArray>> {
  let bytes: Buffer;
  try {
    bytes = await readFile(join(dir, 'voices_en.npz'));
  } catch (failure) {
    throw new Error(
      `The voice packs could not be read: ${describe(failure)}. Download them ` +
        'again from Settings → Spoken replies.',
    );
  }
  try {
    return readNpz(bytes);
  } catch (failure) {
    throw new Error(
      `The voice packs are damaged: ${describe(failure)}. Download them again ` +
        'from Settings → Spoken replies.',
    );
  }
}

/** The voice a stored key names, or the first one when it is gone. */
export function resolveVoice(
  voices: readonly SpeechVoice[],
  key: string,
): SpeechVoice {
  const found = voices.find((voice) => voice.key === key);
  if (found !== undefined) {
    return found;
  }
  const first = voices[0];
  if (first === undefined) {
    throw new Error('The voice model has no voices.');
  }
  return first;
}

/** The style table for one voice, with a sentence when it is missing. */
export function voicePack(
  packs: ReadonlyMap<string, NpyArray>,
  voice: SpeechVoice,
): Float32Array {
  const pack = packs.get(voice.key);
  if (pack === undefined) {
    throw new Error(
      `The ${voice.name} voice is not in the downloaded pack. Choose another ` +
        'voice in Settings → Spoken replies.',
    );
  }
  return pack.data;
}

function describe(failure: unknown): string {
  return failure instanceof Error ? failure.message : String(failure);
}
