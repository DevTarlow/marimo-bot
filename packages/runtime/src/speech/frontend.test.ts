import {describe, expect, it} from 'vitest';

import {
  chunkPhonemes,
  cmuWord,
  createPhonemizer,
  foldPhonemes,
  MAX_PHONEMES_PER_CHUNK,
  styleRow,
  tokenIds,
} from './frontend.js';

describe('the phoneme front end', () => {
  it('folds the symbols the model has no row for', () => {
    expect(foldPhonemes('həlˈO (test)')).toBe('həlˈO ,test,');
    expect(foldPhonemes('a\u0329b')).toBe('ab');
    expect(foldPhonemes('gɔd')).toBe('\u0261ɔd');
  });

  it('reads a CMU word, its possessive and its hyphen parts', () => {
    const cmu = {
      hello: 'həlˈO',
      paul: 'pˈɔl',
      smith: 'smˈɪθ',
      well: 'wˈɛl',
    };
    expect(cmuWord(cmu, 'Hello')).toBe('həlˈO');
    expect(cmuWord(cmu, "Paul's")).toBe('pˈɔlz');
    expect(cmuWord(cmu, 'well-known')).toBe('wˈɛl');
    expect(cmuWord(cmu, 'unknown')).toBeNull();
    expect(cmuWord(cmu, '...')).toBeNull();
  });

  it('chunks at sentence and space boundaries under the model limit', () => {
    const long = Array.from({length: 80}, (_, index) => `wˈɜːd${index}`).join(
      ' ',
    );
    const chunks = chunkPhonemes(`${long}. Another sentence.`);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(MAX_PHONEMES_PER_CHUNK);
      expect(chunk.length).toBeGreaterThan(0);
    }
  });

  it('turns a chunk into the model token sequence', () => {
    const vocab = {a: 1, b: 2, ' ': 16};
    expect(tokenIds('a b', vocab)).toEqual({
      ids: [0, 1, 16, 2, 10, 0],
      dropped: 0,
    });
    expect(tokenIds('a?b', vocab)).toEqual({ids: [0, 1, 2, 10, 0], dropped: 1});
  });

  it('builds a phonemiser from the real misaki port', async () => {
    const {misakiEnglish} = await import('@titan-design/speech-g2p');
    const raw = misakiEnglish().phonemize('Hello there.').phonemes;
    const vocab = Object.fromEntries(
      [...new Set([...foldPhonemes(raw), ' '])].map((char, index) => [
        char,
        index + 1,
      ]),
    );
    const phonemize = await createPhonemizer({vocab, cmu: {}});
    const result = await phonemize('Hello there.');
    expect(result.phonemes.length).toBeGreaterThan(0);
    expect(result.dropped).toBe(0);
  });

  it('selects the style row by token count and clamps a long one', () => {
    const width = 4;
    const pack = Float32Array.from({length: 3 * width}, (_, index) => index);
    expect([...styleRow(pack, 2, width)]).toEqual([4, 5, 6, 7]);
    expect([...styleRow(pack, 999, width)]).toEqual([8, 9, 10, 11]);
    expect([...styleRow(pack, 0, width)]).toEqual([0, 1, 2, 3]);
  });
});
