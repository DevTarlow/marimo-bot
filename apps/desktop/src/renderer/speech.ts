/**
 * Turning an answer written for the eye into one worth hearing.
 *
 * The model is asked to write plainly when a reply will be spoken, but it still
 * reaches for markdown: a fenced command becomes a minute of punctuation read
 * aloud, a link becomes a URL nobody can follow by ear, and a table becomes a
 * stream of numbers. This is the last gate before `/tts`, and it is a pure
 * function on purpose — the rules are testable without an engine, a microphone
 * or a window.
 *
 * `toSpeech` only removes what cannot be spoken. `speechChunks` then splits the
 * result at sentence boundaries so the first piece can be synthesized and
 * played while the rest is still being requested. The total is bounded by the
 * protocol's `SPEECH_MAX_CHARS`, the same number the host uses for one request,
 * so splitting cannot make the app speak more than it did before.
 */
import {SPEECH_MAX_CHARS} from '@marimo/protocol';

export function toSpeech(markdown: string): string {
  let text = markdown;
  /*
   * Fences first, before the inline rules can mistake their punctuation for
   * emphasis or a list. The replacement is a sentence rather than silence: a
   * listener who hears nothing after "here is the command" thinks the app
   * stopped.
   */
  const hadCode = /```[\s\S]*?```/u.test(text);
  text = text.replace(/```[\s\S]*?```/gu, ' ');
  text = text.replace(/`([^`]+)`/gu, '$1');
  // Images are a picture the listener cannot see; links keep their label.
  text = text.replace(/!\[[^\]]*\]\([^)]*\)/gu, ' ');
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/gu, '$1');
  // Bare URLs are not pronounceable as a rule.
  text = text.replace(/https?:\/\/\S+/gu, ' a link ');
  // Headings, block quotes and list markers are structure, not words.
  text = text.replace(/^#{1,6}\s+/gmu, '');
  text = text.replace(/^\s*>\s?/gmu, '');
  text = text.replace(/^\s*(?:[-*+]|\d+[.)])\s+/gmu, '');
  // Tables are rows of pipes; keep the cell words, drop the bars.
  text = text.replace(/^\s*\|.*\|\s*$/gmu, (row) =>
    row
      .split('|')
      .map((cell) => cell.trim())
      .filter((cell) => cell.length > 0 && !/^:?-{3,}:?$/u.test(cell))
      .join(', '),
  );
  text = text.replace(/\*\*([^*]+)\*\*/gu, '$1');
  text = text.replace(/__([^_]+)__/gu, '$1');
  text = text.replace(/(^|\s)\*([^*\n]+)\*(?=\s|$)/gu, '$1$2');
  text = text.replace(/(^|\s)_([^_\n]+)_(?=\s|$)/gu, '$1$2');
  text = text.replace(/<\/?[A-Za-z][^>]*>/gu, ' ');
  // A line of markdown punctuation is structure with nothing inside it.
  text = text.replace(/[*_~`>#]+/gu, ' ');
  text = text.replace(/\s+/gu, ' ').trim();

  if (hadCode && text.length > 0) {
    return `${text} The code is in the chat.`;
  }
  if (text.length === 0) {
    return hadCode ? 'The code is in the chat.' : 'The answer is in the chat.';
  }
  return text;
}

/**
 * How many characters one `/tts` request should carry.
 *
 * A sentence is usually shorter than this; the number matters for a long
 * sentence or a paragraph that arrived without punctuation. Small enough that
 * the first request finishes quickly, large enough that a short answer is not
 * chopped into single words and paid for with a request each.
 */
export const SPEECH_CHUNK_CHARS = 160;

export interface SpeechPlan {
  /** The pieces to synthesize, in order. Never contains an empty string. */
  chunks: string[];
  /** True when the reply was longer than the host would speak in one go. */
  truncated: boolean;
}

/**
 * Split a cleaned reply into the pieces the window synthesizes one at a time.
 *
 * Sentence boundaries are the natural cut: a pause between two sentences is
 * already there in speech, so hearing them as two files is not a seam. A
 * sentence longer than `chunkChars` is split at a space or comma before the
 * limit; only a single unbroken word longer than the limit is cut at the limit
 * itself.
 *
 * The total cap is applied after grouping, so a reply the host would have
 * truncated is still truncated — this changes *when* it starts speaking, not
 * how much of a too-long answer it reads.
 */
export function speechChunks(
  text: string,
  options: {maxChars?: number; chunkChars?: number} = {},
): SpeechPlan {
  const maxChars = options.maxChars ?? SPEECH_MAX_CHARS;
  const chunkChars = Math.max(
    40,
    Math.min(options.chunkChars ?? SPEECH_CHUNK_CHARS, maxChars),
  );
  const clean = text.trim();
  if (clean.length === 0) {
    return {chunks: [], truncated: false};
  }

  const pieces: string[] = [];
  for (const sentence of sentences(clean)) {
    pieces.push(...splitLong(sentence, chunkChars));
  }

  const chunks: string[] = [];
  let current = '';
  for (const piece of pieces) {
    if (current.length === 0) {
      current = piece;
    } else if (current.length + 1 + piece.length <= chunkChars) {
      current = `${current} ${piece}`;
    } else {
      chunks.push(current);
      current = piece;
    }
  }
  if (current.length > 0) {
    chunks.push(current);
  }

  const limited: string[] = [];
  let total = 0;
  let truncated = false;
  for (const chunk of chunks) {
    const width = chunk.length + (limited.length === 0 ? 0 : 1);
    if (total + width > maxChars) {
      truncated = true;
      break;
    }
    limited.push(chunk);
    total += width;
  }

  return {chunks: limited, truncated};
}

/**
 * The sentences a reply is made of.
 *
 * Scanning rather than matching is what keeps a decimal or a version number
 * whole: a full stop only ends a sentence when whitespace or the end of the
 * string follows it. A regex that demanded a boundary at every full stop could
 * fail to match across `3.5` and silently drop the words before it. Abbreviations
 * still split — "Mr. Smith" becomes two pieces — but that is a pause a listener
 * expects more than a number read as "three point five" in two pieces.
 */
function sentences(text: string): string[] {
  const output: string[] = [];
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char !== '.' && char !== '!' && char !== '?') {
      continue;
    }
    let end = index + 1;
    while (end < text.length && '.!?'.includes(text[end] ?? '')) {
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

/** Break one sentence at a space or comma before the limit, never past it. */
function splitLong(text: string, limit: number): string[] {
  const pieces: string[] = [];
  let rest = text.trim();
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    const boundary = Math.max(
      window.lastIndexOf(', '),
      window.lastIndexOf('; '),
      window.lastIndexOf(' '),
    );
    const cut = boundary > 40 ? boundary + 1 : limit;
    pieces.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest.length > 0) {
    pieces.push(rest);
  }
  return pieces;
}
