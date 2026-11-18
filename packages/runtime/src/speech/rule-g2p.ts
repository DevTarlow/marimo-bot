/**
 * The stage-3 English fallback: a small rule-based letter-to-sound G2P.
 *
 * The model's own English front end ends with a 0.75 M-parameter BART for the
 * words misaki and CMU do not know. This build does not ship that model, so a
 * word neither lexicon knows used to be dropped — a hole in the sentence that is
 * especially likely to land on the names, filenames and technical terms an
 * assistant writes.
 *
 * This is the replacement, and it is deliberately small: digraphs and common
 * spelling patterns mapped to symbols of the model's own 178-row alphabet, with
 * a primary stress on the first vowel. It is not a dictionary and does not claim
 * to be one. It is a phonetic approximation that keeps the word audible, which
 * is strictly better than silence.
 *
 * The symbols used are all rows of the model's vocabulary. The caller still
 * filters unknown symbols, so a future alphabet change cannot make this throw.
 */

/** Letter names for a token made only of digits. */
const DIGITS = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
];

/** Single-letter consonants, in the model's alphabet. */
const CONSONANTS: Readonly<Record<string, string>> = {
  b: 'b',
  c: 'k',
  d: 'd',
  f: 'f',
  g: '\u0261',
  h: 'h',
  j: '\u02a4',
  k: 'k',
  l: 'l',
  m: 'm',
  n: 'n',
  p: 'p',
  q: 'k',
  r: '\u0279',
  s: 's',
  t: 't',
  v: 'v',
  w: 'w',
  x: 'ks',
  y: 'j',
  z: 'z',
};

/** Short vowels, used when no long-vowel pattern applies. */
const SHORT_VOWELS: Readonly<Record<string, string>> = {
  a: '\u00e6',
  e: '\u025b',
  i: '\u026a',
  o: '\u0251',
  u: '\u028c',
  y: '\u026a',
};

/** Long vowels, for a magic-e or a vowel digraph. */
const LONG_VOWELS: Readonly<Record<string, string>> = {
  a: 'A',
  e: 'i',
  i: 'I',
  o: 'O',
  u: 'u',
  y: 'I',
};

/** Digraphs and trigraphs, checked longest first. */
const CLUSTERS: ReadonlyArray<readonly [string, string]> = [
  ['eigh', 'A'],
  ['ough', 'O'],
  ['augh', '\u0254'],
  ['tch', '\u02a7'],
  ['sch', 'sk'],
  ['dge', '\u02a4'],
  ['igh', 'I'],
  ['tion', '\u0283\u0259n'],
  ['sion', '\u0292\u0259n'],
  ['cious', '\u0283\u0259s'],
  ['tious', '\u0283\u0259s'],
  ['ture', '\u02a7\u025a'],
  ['sure', '\u0292\u025a'],
  ['air', '\u025b\u0279'],
  ['ear', '\u026a\u0279'],
  ['ar', '\u0251\u0279'],
  ['er', '\u025c\u0279'],
  ['ir', '\u025c\u0279'],
  ['ur', '\u025c\u0279'],
  ['or', '\u0254\u0279'],
  ['ee', 'i'],
  ['ea', 'i'],
  ['oo', 'u'],
  ['ou', 'W'],
  ['ow', 'W'],
  ['oi', 'Y'],
  ['oy', 'Y'],
  ['ai', 'A'],
  ['ay', 'A'],
  ['au', '\u0254'],
  ['aw', '\u0254'],
  ['ei', 'A'],
  ['ey', 'A'],
  ['ie', 'i'],
  ['oa', 'O'],
  ['ue', 'u'],
  ['ew', 'u'],
  ['ui', 'u'],
  ['th', '\u03b8'],
  ['sh', '\u0283'],
  ['ch', '\u02a7'],
  ['ph', 'f'],
  ['wh', 'w'],
  ['ck', 'k'],
  ['ng', '\u014b'],
  ['qu', 'kw'],
  ['gh', ''],
  ['kn', 'n'],
  ['wr', 'r'],
  ['mb', 'm'],
];

const VOWELS = new Set(['a', 'e', 'i', 'o', 'u', 'y']);

/**
 * The phonemes for one word, or null when it has nothing sayable.
 *
 * Digits inside a mixed token are spoken as their names (`x86` → "x eight
 * six") rather than skipped. A token with no letters and no digits has no
 * pronunciation and returns null so the caller can report the drop rather than
 * inventing one.
 */
export function ruleBasedPhonemes(word: string): string | null {
  const lowered = word
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/gu, '')
    .replace(/[^a-z0-9]/gu, '');
  if (lowered.length === 0) {
    return null;
  }
  if (/^\d+$/u.test(lowered)) {
    return [...lowered].map((digit) => DIGITS[Number(digit)] ?? '').join(' ');
  }

  let text = '';
  for (const char of lowered) {
    if (/\d/u.test(char)) {
      // A digit in a mixed token keeps its spoken name.
      text += DIGITS[Number(char)] ?? '';
      continue;
    }
    text += char;
  }

  const phonemes: string[] = [];
  let stress = false;
  let index = 0;

  const add = (value: string): void => {
    if (value.length === 0) {
      return;
    }
    // A primary stress before the first vowel is what makes the model read the
    // approximation as a word rather than a run of sounds.
    if (!stress && /[aeiouy]/u.test(text[index] ?? '')) {
      phonemes.push('\u02c8');
      stress = true;
    }
    phonemes.push(value);
  };

  while (index < text.length) {
    const char = text[index] ?? '';
    if (char === 'e' && index === text.length - 1 && index > 1) {
      // A silent final e that already made the vowel long is not pronounced.
      const previous = text[index - 1] ?? '';
      const before = text[index - 2] ?? '';
      if (!VOWELS.has(previous) && VOWELS.has(before)) {
        index += 1;
        continue;
      }
    }

    let matched = false;
    for (const [cluster, value] of CLUSTERS) {
      if (!text.startsWith(cluster, index)) {
        continue;
      }
      if (cluster === 'mb' && index + 2 !== text.length) {
        continue;
      }
      if ((cluster === 'kn' || cluster === 'wr') && index !== 0) {
        continue;
      }
      if (cluster === 'gh') {
        add('');
        index += 2;
        matched = true;
        break;
      }
      add(value);
      index += cluster.length;
      matched = true;
      break;
    }
    if (matched) {
      continue;
    }

    if (VOWELS.has(char)) {
      const next = text[index + 1] ?? '';
      const after = text[index + 2] ?? '';
      const magic =
        index + 2 === text.length - 1 &&
        after === 'e' &&
        !VOWELS.has(next) &&
        next.length > 0;
      if (magic) {
        add(LONG_VOWELS[char] ?? SHORT_VOWELS[char] ?? '');
        index += 3;
        continue;
      }
      add(SHORT_VOWELS[char] ?? '');
      index += 1;
      continue;
    }

    // Double consonants are one sound.
    if (text[index + 1] === char && !VOWELS.has(char)) {
      add(CONSONANTS[char] ?? '');
      index += 2;
      continue;
    }

    // `c` and `g` soften before a front vowel, the common English rule.
    if (
      (char === 'c' || char === 'g') &&
      'eiy'.includes(text[index + 1] ?? '')
    ) {
      add(char === 'c' ? 's' : '\u02a4');
      index += 1;
      continue;
    }

    add(CONSONANTS[char] ?? '');
    index += 1;
  }

  return phonemes.length === 0 ? null : phonemes.join('');
}
