/**
 * Cutting a reply into the sentences that become one utterance's chunks.
 *
 * The host synthesises one chunk while the previous one plays, so the split is
 * the thing that decides when the first sound arrives. It must not cut inside a
 * decimal, a version number, an abbreviation, or a filename: a listener hearing
 * "Version one. Point two" is the failure this file exists to prevent.
 *
 * This runs on the text `toSpeech` cleaned, before the normaliser. Splitting
 * after normalisation would be easier but would also split on the commas and
 * periods the normaliser introduces for spoken form, and the point is to keep
 * the separator in the text it was written in.
 */

/** Words ending in a period that are not the end of a sentence. */
const ABBREVIATIONS = new Set([
  'dr',
  'mr',
  'mrs',
  'ms',
  'prof',
  'rev',
  'hon',
  'st',
  'no',
  'nos',
  'vs',
  'etc',
  'e.g',
  'i.e',
  'a.m',
  'p.m',
  'u.s',
  'u.k',
  'jr',
  'sr',
  'inc',
  'ltd',
  'co',
  'approx',
  'dept',
  'est',
  'fig',
  'vol',
]);

const TERMINATORS = new Set(['.', '!', '?', '…']);

/**
 * Split one reply into speakable sentences, each at most `maxChars` long.
 *
 * A long sentence is split at a semicolon, comma, dash or space before the
 * limit, so the first chunk is never a whole paragraph. Whitespace-only pieces
 * never come back.
 */
export function splitSpeechSentences(text: string, maxChars = 320): string[] {
  const clean = text.replace(/\r\n/gu, '\n').trim();
  if (clean.length === 0) {
    return [];
  }
  const raw: string[] = [];
  let start = 0;
  let index = 0;
  while (index < clean.length) {
    const char = clean[index] ?? '';
    if (char === '\n') {
      push(raw, clean.slice(start, index));
      start = index + 1;
      index += 1;
      continue;
    }
    if (!TERMINATORS.has(char)) {
      index += 1;
      continue;
    }
    let end = index + 1;
    while (end < clean.length && TERMINATORS.has(clean[end] ?? '')) {
      end += 1;
    }
    const next = clean[end];
    if (!isBoundary(clean, start, index, next, char)) {
      index = end;
      continue;
    }
    push(raw, clean.slice(start, end));
    start = end;
    index = end;
  }
  push(raw, clean.slice(start));

  const sentences: string[] = [];
  for (const sentence of raw) {
    sentences.push(...splitLong(sentence, maxChars));
  }
  return sentences;
}

function isBoundary(
  text: string,
  start: number,
  index: number,
  next: string | undefined,
  terminator: string,
): boolean {
  if (next !== undefined && !/\s/u.test(next)) {
    /*
     * A terminator with no whitespace after it is inside a token or is the
     * middle of an ellipsis. `3.5`, `v1.2.3`, `speech-host.ts` and `...` all
     * reach here.
     */
    return false;
  }
  if (
    terminator === '.' &&
    /\d/u.test(text[index - 1] ?? '') &&
    /\d/u.test(next ?? '')
  ) {
    return false;
  }
  const before = text.slice(start, index);
  const word = (/([A-Za-z][A-Za-z.]*)$/u.exec(before)?.[1] ?? '').toLowerCase();
  if (word.length > 0 && ABBREVIATIONS.has(word)) {
    return false;
  }
  if (/^[A-Za-z]$/u.test(word) && terminator === '.') {
    // An initial: "J. Smith" is one sentence.
    return false;
  }
  return true;
}

/** Break one over-long sentence at the last clause or space before the limit. */
function splitLong(text: string, maxChars: number): string[] {
  const limit = Math.max(40, maxChars);
  const pieces: string[] = [];
  let rest = text.trim();
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    const boundary = Math.max(
      window.lastIndexOf('; '),
      window.lastIndexOf(', '),
      window.lastIndexOf(' — '),
      window.lastIndexOf(' - '),
      window.lastIndexOf(' '),
    );
    const cut = boundary > 40 ? boundary + 1 : limit;
    pieces.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest.length > 0) {
    pieces.push(rest);
  }
  return pieces.filter((piece) => piece.length > 0);
}

function push(output: string[], value: string): void {
  const clean = value.trim();
  if (clean.length > 0) {
    output.push(clean);
  }
}
