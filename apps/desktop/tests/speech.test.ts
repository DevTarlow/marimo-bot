/**
 * What a spoken answer actually says.
 *
 * The rules are all "remove what cannot be heard": fences, links, tables,
 * headings, emphasis. The failure this prevents is not cosmetic — a model that
 * formats a reply by habit turns a two-sentence answer into a minute of
 * punctuation when it is read aloud.
 */
import {describe, expect, it} from 'vitest';

import {toSpeech} from '../src/renderer/speech.js';

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
    expect(toSpeech('Here it is:\n\n```sh\npnpm test\n```\n\nThat passes.')).toBe(
      'Here it is: That passes. The code is in the chat.',
    );
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
