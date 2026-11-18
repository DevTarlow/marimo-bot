/**
 * The voice-input tokenizer, in TypeScript.
 *
 * `tokenizer.bin` is not a BPE merges file: it is the official runtime's byte
 * table, one entry per token id, in the order the model emits them. An entry is
 * a length-prefixed sequence of bytes — `0` for an empty/special entry, one byte
 * below 128 for a short token, two bytes for a long one — followed by the token's
 * bytes. Decoding is therefore a table lookup and a UTF-8 decode, not a
 * sentencepiece model, which is why the app can use the small file and keep the
 * whole text path in TypeScript.
 *
 * The table is 32,768 entries and about 250 KB. It is read from the pinned file,
 * never generated, and a truncated file is an error rather than a table that
 * decodes half of every answer.
 */
import type {ListenBinTokenizer} from './types.js';

/**
 * Parse the official binary token table.
 *
 * The first byte is the length, except that `0` means an empty entry and a byte
 * at or above 128 is the low half of a two-byte length (`second * 128 + first -
 * 128`). Bounds are checked at every step: a file that ends mid-token is refused
 * rather than decoded into a prefix of the transcript.
 */
export function parseBinTokenizer(buffer: Uint8Array): ListenBinTokenizer {
  const tokens: Uint8Array[] = [];
  let at = 0;
  while (at < buffer.length) {
    const first = buffer[at] ?? 0;
    at += 1;
    if (first === 0) {
      tokens.push(new Uint8Array(0));
      continue;
    }
    let length = first;
    if (first >= 128) {
      if (at >= buffer.length) {
        throw new Error(
          'The voice-input tokenizer ends in a half-written token.',
        );
      }
      const second = buffer[at] ?? 0;
      at += 1;
      length = second * 128 + first - 128;
    }
    if (length === 0 || at + length > buffer.length) {
      throw new Error('The voice-input tokenizer is truncated or malformed.');
    }
    tokens.push(buffer.subarray(at, at + length));
    at += length;
  }
  if (tokens.length === 0) {
    throw new Error('The voice-input tokenizer is empty.');
  }
  return {tokens};
}

/**
 * Turn emitted token ids into the text a person reads.
 *
 * Empty entries and `<...>` specials are skipped; the model's word-boundary
 * marker `▁` becomes a space; whitespace is collapsed and the ends trimmed. An
 * invalid UTF-8 sequence becomes the replacement character rather than throwing,
 * because a token boundary can split a multi-byte character and losing one
 * syllable is better than losing the transcript.
 */
export function decodeTokens(
  tokenizer: ListenBinTokenizer,
  ids: readonly number[],
): string {
  const chunks: Uint8Array[] = [];
  for (const id of ids) {
    const token = tokenizer.tokens[id];
    if (token === undefined || token.length === 0) {
      continue;
    }
    if (
      token.length > 2 &&
      token[0] === 0x3c &&
      token[token.length - 1] === 0x3e
    ) {
      // `<s>`, `</s>`, `<unk>` and the timestamp specials are not words.
      continue;
    }
    chunks.push(token);
  }
  const bytes = concat(chunks);
  const text = new TextDecoder('utf-8', {fatal: false}).decode(bytes);
  return text
    .replace(/\u2581/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}
