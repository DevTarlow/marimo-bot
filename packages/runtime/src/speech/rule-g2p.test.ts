import {readFileSync} from 'node:fs';
import {join} from 'node:path';

import {describe, expect, it} from 'vitest';

import {createPhonemizer} from './frontend.js';
import {ruleBasedPhonemes} from './rule-g2p.js';

/** The model's real alphabet, so a fallback symbol outside it is caught. */
const vocab = JSON.parse(
  readFileSync(join(process.cwd(), 'test-fixtures', 'vocab.json'), 'utf8'),
) as Record<string, number>;

describe('the stage-3 fallback', () => {
  it('approximates a word neither lexicon knows', () => {
    const phonemes = ruleBasedPhonemes('kubernetes');
    expect(phonemes).toBeTruthy();
    expect(phonemes).toMatch(/[aeiouyæɛɪiɑɔʊuʌəɜɚAIO]/u);
  });

  it('uses only symbols the model has a row for', () => {
    for (const word of [
      'Kubernetes',
      'foobarbaz',
      'qwen',
      'speechify',
      'AsyncLocalStorage',
      'x86',
    ]) {
      const phonemes = ruleBasedPhonemes(word) ?? '';
      for (const symbol of phonemes) {
        expect(vocab[symbol], `${word}: ${symbol}`).toBeTypeOf('number');
      }
    }
  });

  it('says digit tokens and refuses a token with nothing in it', () => {
    expect(ruleBasedPhonemes('42')).toBe('four two');
    expect(ruleBasedPhonemes('...')).toBeNull();
  });
});

describe('the front end with no CMU fallback', () => {
  it('drops no word from code-shaped technical text', async () => {
    const phonemize = await createPhonemizer({vocab, cmu: {}});
    const text =
      'Kubernetes and speech-host.ts use ONNX; src/renderer/speech.ts ' +
      'handles API calls at v0.1.0.';
    const result = await phonemize(text);
    expect(result.dropped).toBe(0);
    expect(result.phonemes.length).toBeGreaterThan(0);
  });

  it('drops no word from a proper noun and an invented term', async () => {
    const phonemize = await createPhonemizer({vocab, cmu: {}});
    for (const word of [
      'Kubernetes',
      'foobarbaz',
      'qwen',
      'AsyncLocalStorage',
      'speechify',
    ]) {
      const result = await phonemize(word);
      expect(result.dropped, word).toBe(0);
      expect(result.phonemes.length, word).toBeGreaterThan(0);
    }
  });
});
