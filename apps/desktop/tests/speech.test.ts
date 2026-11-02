/**
 * What a spoken answer actually says.
 *
 * The rules are all "remove what cannot be heard": fences, links, tables,
 * headings, emphasis. The failure this prevents is not cosmetic — a model that
 * formats a reply by habit turns a two-sentence answer into a minute of
 * punctuation when it is read aloud.
 */
import {describe, expect, it} from 'vitest';

import {
  SPEECH_CHUNK_CHARS,
  speechChunks,
  toSpeech,
} from '../src/renderer/speech.js';

describe('toSpeech', () => {
  it('leaves plain prose alone', () => {
    expect(toSpeech('The build passed. Nothing to do.')).toBe(
      'The build passed. Nothing to do.',
    );
  });

  it('drops markdown emphasis, headings and list markers', () => {
    expect(
      toSpeech(
        '## Result\n\n- **One** thing\n- _Another_ thing\n\n> quoted\n\n1. first\n2. second',
      ),
    ).toBe('Result One thing Another thing quoted first second');
  });

  it('keeps a link label and drops the URL', () => {
    expect(
      toSpeech('See [the guide](https://example.com/a/very/long/path).'),
    ).toBe('See the guide.');
  });

  it('does not read a bare URL', () => {
    expect(toSpeech('Open https://example.com/thing now.')).toBe(
      'Open a link now.',
    );
  });

  it('does not read code, and says where it is', () => {
    expect(
      toSpeech('Here it is:\n\n```sh\npnpm test\n```\n\nThat passes.'),
    ).toBe('Here it is: That passes. The code is in the chat.');
  });

  it('keeps inline code as words', () => {
    expect(toSpeech('Run `pnpm test` first.')).toBe('Run pnpm test first.');
  });

  it('turns a table into the words in it', () => {
    expect(toSpeech('| Name | Value |\n| --- | --- |\n| one | two |')).toBe(
      'Name, Value one, two',
    );
  });

  it('never returns an empty answer', () => {
    expect(toSpeech('**')).toBe('The answer is in the chat.');
    expect(toSpeech('```\ncode\n```')).toBe('The code is in the chat.');
  });
});

describe('splitting a spoken answer for playback', () => {
  it('keeps a short answer as one piece', () => {
    expect(speechChunks('The build passed.')).toEqual({
      chunks: ['The build passed.'],
      truncated: false,
    });
  });

  it('splits at sentence boundaries, not at every word', () => {
    const text = Array.from(
      {length: 12},
      (_, index) => `Sentence ${String(index + 1)} is short enough.`,
    ).join(' ');
    const plan = speechChunks(text);
    expect(plan.truncated).toBe(false);
    expect(plan.chunks.length).toBeGreaterThan(1);
    expect(
      plan.chunks.every((chunk) => chunk.length <= SPEECH_CHUNK_CHARS),
    ).toBe(true);
    expect(plan.chunks.join(' ')).toBe(text);
  });

  it('splits one long sentence at a space before the limit', () => {
    const text = `${'word '.repeat(50).trim()}.`;
    const plan = speechChunks(text, {chunkChars: 60});
    expect(plan.chunks.every((chunk) => chunk.length <= 60)).toBe(true);
    expect(plan.chunks.join(' ')).toBe(text);
  });

  it('does not split a decimal number in two', () => {
    const plan = speechChunks(
      'It costs 3.5 dollars for the first one and 4.25 for the second.',
      {chunkChars: 40},
    );
    expect(plan.chunks.join(' ')).toContain('3.5');
    expect(plan.chunks.join(' ')).toContain('4.25');
    expect(plan.chunks.some((chunk) => chunk.endsWith('3.'))).toBe(false);
    expect(plan.chunks.some((chunk) => chunk.startsWith('5 dollars'))).toBe(
      false,
    );
  });

  it('keeps the total under the host cap and says it stopped', () => {
    const text = 'This is a sentence that goes on. '.repeat(20).trim();
    const plan = speechChunks(text, {maxChars: 200, chunkChars: 60});
    expect(plan.truncated).toBe(true);
    expect(plan.chunks.join(' ').length).toBeLessThanOrEqual(200);
    expect(plan.chunks.every((chunk) => chunk.length > 0)).toBe(true);
  });

  it('has nothing to say for an empty answer', () => {
    expect(speechChunks('')).toEqual({chunks: [], truncated: false});
  });
});
