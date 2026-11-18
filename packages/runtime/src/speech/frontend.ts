/**
 * From a written answer to the phoneme tokens the voice model was trained on.
 *
 * The model's own English frontend is misaki's lexicon, then CMUdict, then a
 * small BART for the words neither knows. This build uses the first two: the
 * misaki lexicon is available as a pure-TypeScript port (MIT, with misaki's
 * Apache-2.0 data), and CMU is the file the model repository ships for exactly
 * this fallback. No espeak-ng is involved — it is GPLv3 and would change what
 * this application's licence can be.
 *
 * The port does not have the BART stage, so this build supplies a small
 * rule-based fallback instead. A word neither lexicon knows is phonetically
 * approximated rather than dropped: technical terms, filenames and proper nouns
 * are exactly the words an assistant writes that a general lexicon misses.
 * Before the lexicon sees a code-shaped token, `expandSpeakable` splits it into
 * ordinary words and spells short abbreviations.
 */
import type {G2pToken} from '@titan-design/speech-g2p';

import {expandSpeakable} from './expand.js';
import {normalizeEnglish} from './normalize.js';
import {ruleBasedPhonemes} from './rule-g2p.js';

/**
 * The model's measured folds, from its `phonemize_v1.py` and `phonemize_v2.py`.
 *
 * Each entry is a symbol espeak or a G2P can emit that the model's 178-row
 * vocabulary has no embedding for. A diacritic is dropped; a consonant with a
 * near neighbour is folded onto it. Folding something with a real contrast (the
 * Arabic pharyngeals, the Russian sibilants) is deliberately not here: those
 * were given their own rows.
 */
const FOLDS: Readonly<Record<string, string>> = {
  '\u032a': '', // dental mark
  '\u0329': '', // syllabic
  '\u030d': '', // vertical line above
  '\u032f': '', // non-syllabic
  '\u026d': 'l', // retroflex l
  '\u026b': 'l', // velarised l
  '\u0275': '\u00f8', // close-mid central rounded
  '\u03b5': '\u025b', // Greek epsilon for the IPA one
  '\u00bf': '',
  '\u00a1': '',
  '\u202f': ' ', // narrow no-break space
  '"': '',
  '\u201c': '',
  '\u201d': '',
  '\u2018': '',
  '\u2019': '',
  "'": '',
  '~': '',
  '\u00b7': '',
  '#': '',
  g: '\u0261', // ASCII g to IPA script g
};

/** One phoneme chunk the model can speak, and what was dropped from it. */
export interface PhonemeResult {
  phonemes: string;
  dropped: number;
}

/** A function that turns one sentence into model phonemes. */
export type Phonemize = (text: string) => Promise<PhonemeResult>;

/** Apply the model's fold table to a raw G2P string. */
export function foldPhonemes(phonemes: string): string {
  let out = phonemes;
  for (const [from, to] of Object.entries(FOLDS)) {
    if (out.includes(from)) {
      out = out.replaceAll(from, to);
    }
  }
  // The model maps a parenthesised aside onto a comma: the same pause, and the
  // vocabulary has a row for a comma but not for a bracket.
  return out.replaceAll('(', ',').replaceAll(')', ',');
}

/**
 * One word from the CMU dictionary, converted to the model's alphabet.
 *
 * Mirrors the model's own fallback: the whole word first, then a possessive,
 * then the hyphen-separated parts. A word with nothing sayable returns null so
 * the caller can drop it rather than substitute a guess.
 */
export function cmuWord(
  cmu: Readonly<Record<string, string>>,
  word: string,
): string | null {
  const clean = word
    .toLowerCase()
    .replace(/^['\-".]+/u, '')
    .replace(/['\-".]+$/u, '');
  if (clean.length === 0) {
    return null;
  }
  const whole = cmu[clean];
  if (whole !== undefined) {
    return whole;
  }
  if (clean.endsWith("'s") && cmu[clean.slice(0, -2)] !== undefined) {
    const stem = cmu[clean.slice(0, -2)] ?? '';
    const last = stem.at(-1) ?? '';
    if ('ptkfθ'.includes(last)) {
      return `${stem}s`;
    }
    if ('szʃʒʧʤ'.includes(last)) {
      return `${stem}ᵻz`;
    }
    return `${stem}z`;
  }
  if (clean.includes('-')) {
    const parts = clean
      .split('-')
      .map((part) => cmu[part])
      .filter((part): part is string => part !== undefined);
    return parts.length > 0 ? parts.join(' ') : null;
  }
  return null;
}

/**
 * Build the phonemiser.
 *
 * The G2P package is imported here rather than at module load: the package
 * carries misaki's lexicon, and the headless runner imports the runtime but must
 * not pay for a voice model it will never use. By the time this resolves the
 * person has already asked for a reply or a sample.
 */
export async function createPhonemizer(options: {
  vocab: Readonly<Record<string, number>>;
  cmu: Readonly<Record<string, string>>;
}): Promise<Phonemize> {
  const {misakiEnglish} = await import('@titan-design/speech-g2p');
  const g2p = misakiEnglish({
    unk: '',
    fallback: (token: G2pToken) =>
      cmuWord(options.cmu, token.text) ?? ruleBasedPhonemes(token.text),
  });
  return async (text: string): Promise<PhonemeResult> => {
    /*
     * Expand before normalise: the normaliser inserts a space after a full stop
     * that has no space after it, which is right for `Hello.World` and wrong
     * for `speech-host.ts`. Expanding first turns the identifier into words, so
     * by the time the normaliser runs there is no dot inside a word left to
     * mistake for a sentence end.
     */
    const {phonemes} = g2p.phonemize(normalizeEnglish(expandSpeakable(text)));
    const folded = foldPhonemes(phonemes);
    let kept = '';
    let dropped = 0;
    for (const char of folded) {
      if (char in options.vocab) {
        kept += char;
      } else if (char !== ' ') {
        dropped += 1;
      }
    }
    return {phonemes: kept, dropped};
  };
}

/**
 * Split model phonemes into the chunks one ONNX run carries.
 *
 * The model was trained on chunks of at most 350 phonemes. Cuts happen at a
 * sentence end first, then at a space, and only a single unbroken token longer
 * than the limit is cut at the limit itself. Pieces are packed greedily, so a
 * short reply is one run rather than one per sentence.
 */
export const MAX_PHONEMES_PER_CHUNK = 350;

export function chunkPhonemes(
  phonemes: string,
  limit = MAX_PHONEMES_PER_CHUNK,
): string[] {
  const clean = phonemes.trim();
  if (clean.length === 0) {
    return [];
  }
  const pieces: string[] = [];
  for (const sentence of sentences(clean)) {
    pieces.push(...splitLong(sentence, limit));
  }
  const chunks: string[] = [];
  let current = '';
  for (const piece of pieces) {
    if (current.length === 0) {
      current = piece;
    } else if (current.length + 1 + piece.length <= limit) {
      current = `${current} ${piece}`;
    } else {
      chunks.push(current);
      current = piece;
    }
  }
  if (current.length > 0) {
    chunks.push(current);
  }
  return chunks;
}

/**
 * The sentences of a phoneme string.
 *
 * A full stop only ends a sentence when whitespace or the end follows it, which
 * is what keeps a decimal or a version number whole.
 */
function sentences(text: string): string[] {
  const output: string[] = [];
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char !== '.' && char !== '!' && char !== '?' && char !== '…') {
      continue;
    }
    let end = index + 1;
    while (end < text.length && '.!?…'.includes(text[end] ?? '')) {
      end += 1;
    }
    const next = text[end];
    if (end === text.length || (next !== undefined && /\s/u.test(next))) {
      const sentence = text.slice(start, end).trim();
      if (sentence.length > 0) {
        output.push(sentence);
      }
      start = end;
      index = end - 1;
    }
  }
  const tail = text.slice(start).trim();
  if (tail.length > 0) {
    output.push(tail);
  }
  return output.length === 0 ? [text] : output;
}

/** Break one over-long sentence at a space before the limit, never past it. */
function splitLong(text: string, limit: number): string[] {
  const pieces: string[] = [];
  let rest = text.trim();
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    const boundary = window.lastIndexOf(' ');
    const cut = boundary > 40 ? boundary : limit;
    pieces.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest.length > 0) {
    pieces.push(rest);
  }
  return pieces;
}

/**
 * The model's token sequence for one phoneme chunk.
 *
 * Start token, the phonemes' ids, the end token and a trailing zero, exactly as
 * the model repository's Python does. Unknown symbols are dropped; a bracket is
 * already a comma by the fold above.
 */
export function tokenIds(
  phonemes: string,
  vocab: Readonly<Record<string, number>>,
): {ids: number[]; dropped: number} {
  const ids: number[] = [];
  let dropped = 0;
  for (const char of phonemes) {
    const id = vocab[char];
    if (id === undefined) {
      if (char !== ' ') {
        dropped += 1;
      }
      continue;
    }
    ids.push(id);
  }
  return {ids: [0, ...ids, 10, 0], dropped};
}

/**
 * The style row for a token sequence.
 *
 * A voice pack holds one 256-float style vector per input length, up to 510.
 * The row is the token count minus one, which is what the model repository's
 * Python selects; a longer chunk uses the last row rather than borrowing one.
 */
export function styleRow(
  pack: Float32Array,
  tokenCount: number,
  width = 256,
): Float32Array {
  const rows = Math.max(1, Math.floor(pack.length / width));
  const row = Math.min(Math.max(tokenCount - 1, 0), rows - 1);
  return pack.slice(row * width, (row + 1) * width);
}
