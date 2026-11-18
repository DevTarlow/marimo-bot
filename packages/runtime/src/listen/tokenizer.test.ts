import {describe, expect, it} from 'vitest';

import {decodeTokens, parseBinTokenizer} from './tokenizer.js';

/** Build the official length-prefixed table for a set of tokens. */
function table(tokens: readonly Uint8Array[]): Uint8Array {
  const parts: number[] = [];
  for (const token of tokens) {
    const length = token.length;
    if (length === 0) {
      parts.push(0);
      continue;
    }
    if (length < 128) {
      parts.push(length);
    } else {
      parts.push((length % 128) + 128, Math.floor(length / 128));
    }
    parts.push(...token);
  }
  return Uint8Array.from(parts);
}

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

describe('parseBinTokenizer', () => {
  it('reads short tokens, an empty entry and the word-boundary marker', () => {
    const tokenizer = parseBinTokenizer(
      table([
        bytes('hello'),
        bytes('\u2581'),
        bytes('<s>'),
        new Uint8Array(0),
        bytes('world'),
      ]),
    );
    expect(tokenizer.tokens).toHaveLength(5);
    expect(decodeTokens(tokenizer, [0, 1, 2, 3, 4])).toBe('hello world');
    // The special and the empty entry are skipped, not spelled.
    expect(decodeTokens(tokenizer, [2, 3])).toBe('');
  });

  it('reads a token whose length needs two bytes', () => {
    const long = new Uint8Array(130).fill(0x61);
    const tokenizer = parseBinTokenizer(table([long, bytes('x')]));
    expect(tokenizer.tokens).toHaveLength(2);
    expect(tokenizer.tokens[0]).toHaveLength(130);
    expect(decodeTokens(tokenizer, [0])).toBe('a'.repeat(130));
  });

  it('skips timestamp specials', () => {
    const tokenizer = parseBinTokenizer(
      table([bytes('hi'), bytes('<<ST_0>>'), bytes('\u2581'), bytes('there')]),
    );
    expect(decodeTokens(tokenizer, [0, 1, 2, 3])).toBe('hi there');
  });

  it('replaces an invalid byte rather than losing the transcript', () => {
    const tokenizer = parseBinTokenizer(
      table([bytes('a'), Uint8Array.from([0xff]), bytes('b')]),
    );
    expect(decodeTokens(tokenizer, [0, 1, 2])).toContain('\uFFFD');
  });

  it('refuses a truncated table', () => {
    expect(() => parseBinTokenizer(Uint8Array.from([5, 1, 2]))).toThrow(
      /truncated|malformed/u,
    );
    expect(() => parseBinTokenizer(Uint8Array.from([200]))).toThrow(
      /half-written|truncated|malformed/u,
    );
    expect(() => parseBinTokenizer(new Uint8Array(0))).toThrow(/empty/u);
  });
});
