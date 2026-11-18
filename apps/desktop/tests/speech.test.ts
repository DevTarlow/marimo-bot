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
import {isBargeIn} from '../src/renderer/barge-in.js';

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

  it('summarises a table instead of reading the cells', () => {
    expect(toSpeech('| Name | Value |\n| --- | --- |\n| one | two |')).toBe(
      'A table is in the chat.',
    );
    expect(toSpeech('Here:\n\n| a | b |\n| --- | --- |\n| 1 | 2 |')).toBe(
      'Here: A table is in the chat.',
    );
  });

  it('summarises a JSON payload in a fence', () => {
    expect(
      toSpeech('The response is:\n\n```json\n{"ok": true, "count": 2}\n```'),
    ).toBe('The response is: A JSON payload is in the chat.');
  });

  it('summarises raw JSON that was never fenced', () => {
    expect(toSpeech('The response is:\n{"ok": true, "count": 2}')).toBe(
      'The response is: A JSON payload is in the chat.',
    );
  });

  it('summarises a stack trace in a fence and in raw form', () => {
    expect(
      toSpeech('It failed:\n\n```\nError: no\n    at run (agent.ts:10:4)\n```'),
    ).toBe('It failed: A stack trace is in the chat.');
    expect(toSpeech('It failed:\n    at run (agent.ts:10:4)')).toBe(
      'It failed: A stack trace is in the chat.',
    );
  });

  it('keeps only the base name of a long path', () => {
    expect(
      toSpeech('Open /home/sam/project/src/main/agent.ts, then edit it.'),
    ).toBe('Open agent.ts, then edit it.');
    expect(toSpeech('Open src/main/agent.ts now.')).toBe('Open agent.ts now.');
    // A slash in ordinary prose is not a path.
    expect(toSpeech('Use and/or.')).toBe('Use and/or.');
  });

  it('drops a checkbox and a horizontal rule', () => {
    expect(toSpeech('- [x] finished\n- [ ] waiting\n\n---')).toBe(
      'finished waiting',
    );
  });

  it('drops emoji', () => {
    expect(toSpeech('Done 🎉 and ready.')).toBe('Done and ready.');
  });

  it('never returns an empty answer', () => {
    expect(toSpeech('**')).toBe('The answer is in the chat.');
    expect(toSpeech('```\ncode\n```')).toBe('The code is in the chat.');
  });
});

describe('isBargeIn', () => {
  it('stops the voice when a microphone starts, and only then', () => {
    expect(
      isBargeIn({type: 'listen.capture', active: true, surface: 'pet'}),
    ).toBe(true);
    expect(
      isBargeIn({type: 'listen.capture', active: false, surface: 'pet'}),
    ).toBe(false);
    expect(isBargeIn({type: 'todos.changed'})).toBe(false);
  });
});
