/**
 * A conversation as text, and the watermark that decides how much of it is new.
 *
 * The two halves are tested together because they share the one rule that matters:
 * an event either contributes visible text or it does not. A renderer and a
 * watermark that disagreed about that would skip an exchange or embed it twice, and
 * because both outcomes are just "a search result you did not expect", nothing would
 * say so. So the tests here are not about formatting: they are that reasoning and
 * tool payloads are absent, that an event with nothing to say leaves nothing behind,
 * and that a slice stops where it claims to.
 */
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';

import {afterEach, beforeEach, describe, expect, it} from 'vitest';

import {
  CONVERSATION_SOURCE,
  ConversationWatermarkStore,
  MAX_CONVERSATION_CHARS,
  conversationSlice,
  renderConversationText,
} from './conversations.js';
import type {ConversationEvent} from './conversations.js';

/** One event of plain text, the shape most of the tests are about. */
function message(author: string, text: string): ConversationEvent {
  return {author, content: {parts: [{text}]}};
}

describe('renderConversationText', () => {
  /*
   * The three parts a session is full of and a search must not answer with: the
   * model's reasoning, its tool calls, and the tool results. Each is dropped for its
   * own reason, and the test that catches a regression is the one where they are all
   * present and only the spoken text survives.
   */
  it('keeps the spoken text and drops reasoning and tool payloads', () => {
    const events: ConversationEvent[] = [
      message('user', 'what is in a.ts?'),
      {
        author: 'assistant',
        content: {
          parts: [
            {text: 'I should read the file first.', thought: true},
            {functionCall: {id: 'c1', name: 'read_file', args: {path: 'a.ts'}}},
          ],
        },
      },
      {
        author: 'read_file',
        content: {
          parts: [
            {
              functionResponse: {
                id: 'c1',
                name: 'read_file',
                response: {result: 'export const a = 1;'},
              },
            },
          ],
        },
      },
      message('assistant', 'It exports one constant.'),
    ];

    expect(renderConversationText(events)).toBe(
      'USER: what is in a.ts?\n\nAGENT: It exports one constant.',
    );
  });

  it('labels the user and the agent, and leaves no line for a silent event', () => {
    const events: ConversationEvent[] = [
      message('user', 'hello'),
      {
        author: 'assistant',
        content: {parts: [{text: 'thinking', thought: true}]},
      },
      message('assistant', 'hi'),
    ];

    // The blank line is the only separator, and the thought-only event does not get
    // one of its own.
    expect(renderConversationText(events)).toBe('USER: hello\n\nAGENT: hi');
  });

  it('calls anyone who is not the user the agent', () => {
    expect(renderConversationText([message('helper', 'a note')])).toBe(
      'AGENT: a note',
    );
    expect(renderConversationText([message('assistant', 'a reply')])).toBe(
      'AGENT: a reply',
    );
  });

  /*
   * A part carrying a tool call is a tool payload even when it has text on it. The
   * text is a preamble to the call, and keeping it would make a call look like
   * something the agent chose to say.
   */
  it('drops a part that carries a tool call even when it also has text', () => {
    const events: ConversationEvent[] = [
      {
        author: 'assistant',
        content: {
          parts: [{text: 'calling', functionCall: {name: 'read_file'}}],
        },
      },
    ];

    expect(renderConversationText(events)).toBe('');
  });

  it('answers with nothing when nothing visible was said', () => {
    expect(renderConversationText([])).toBe('');
    expect(
      renderConversationText([
        {author: 'assistant', content: {parts: [{text: '   '}]}},
        {author: 'assistant', content: {parts: [{thought: true, text: 'hmm'}]}},
        {author: 'assistant'},
        {author: 'user', content: {}},
      ]),
    ).toBe('');
  });

  it('trims the text it embeds rather than the whitespace around it', () => {
    expect(renderConversationText([message('user', '  spaced out  ')])).toBe(
      'USER: spaced out',
    );
  });

  it('names a sentinel no resolver would mistake for a file', () => {
    expect(CONVERSATION_SOURCE).toBe('(conversation)');
  });
});

describe('conversationSlice', () => {
  const events: ConversationEvent[] = [
    message('user', 'first'),
    message('user', 'second'),
    message('user', 'third'),
  ];

  /*
   * The blank line is part of the text that gets embedded, so it is part of the
   * budget. 'USER: first' is 11 characters and 'USER: second' is 12; with a two
   * character separator the pair is exactly 25, which fits, and one character less
   * does not.
   */
  it('counts the separator between events against the cap', () => {
    expect(conversationSlice(events, 0, 25)).toEqual({
      text: 'USER: first\n\nUSER: second',
      endEvent: 2,
    });
    expect(conversationSlice(events, 0, 24)).toEqual({
      text: 'USER: first',
      endEvent: 1,
    });
  });

  it('reports the exclusive index just past the last event it included', () => {
    expect(conversationSlice(events, 0, MAX_CONVERSATION_CHARS).endEvent).toBe(
      3,
    );
    expect(conversationSlice(events, 1, MAX_CONVERSATION_CHARS)).toEqual({
      text: 'USER: second\n\nUSER: third',
      endEvent: 3,
    });
  });

  /*
   * One long message is the only thing said, so it is embedded over budget rather
   * than dropped. The event after it waits for the next slice, where it becomes the
   * first event and gets the same treatment.
   */
  it('always includes one event, even when it is longer than the cap', () => {
    const long = message('user', 'x'.repeat(100));
    const slice = conversationSlice([long, message('user', 'after')], 0, 10);

    expect(slice.text).toBe(`USER: ${'x'.repeat(100)}`);
    expect(slice.endEvent).toBe(1);
  });

  it('resumes where the previous slice stopped', () => {
    const first = conversationSlice(events, 0, 11);
    const second = conversationSlice(
      events,
      first.endEvent,
      MAX_CONVERSATION_CHARS,
    );

    expect(first).toEqual({text: 'USER: first', endEvent: 1});
    expect(second).toEqual({text: 'USER: second\n\nUSER: third', endEvent: 3});
  });

  /*
   * Tool calls and thoughts are events too, and the watermark is per event. A run of
   * them is stepped over with no text and no embedding, which is the difference
   * between a refresh moving forward and one that stops on a tool call forever.
   */
  it('advances over a run of invisible events and embeds nothing', () => {
    const invisible: ConversationEvent[] = [
      {
        author: 'assistant',
        content: {parts: [{text: 'thinking', thought: true}]},
      },
      {
        author: 'assistant',
        content: {parts: [{functionCall: {name: 'read_file'}}]},
      },
      {
        author: 'read_file',
        content: {parts: [{functionResponse: {name: 'read_file'}}]},
      },
    ];

    expect(conversationSlice(invisible, 0, 10)).toEqual({
      text: '',
      endEvent: invisible.length,
    });
  });

  it('does not leave a blank line where an invisible event was skipped', () => {
    const mixed: ConversationEvent[] = [
      {
        author: 'assistant',
        content: {parts: [{text: 'thinking', thought: true}]},
      },
      message('user', 'one'),
      {
        author: 'assistant',
        content: {parts: [{functionCall: {name: 'read_file'}}]},
      },
      message('assistant', 'two'),
    ];

    expect(conversationSlice(mixed, 0, MAX_CONVERSATION_CHARS)).toEqual({
      text: 'USER: one\n\nAGENT: two',
      endEvent: 4,
    });
  });

  it('says there is nothing left at or past the end', () => {
    expect(conversationSlice(events, 3, MAX_CONVERSATION_CHARS)).toEqual({
      text: '',
      endEvent: 3,
    });
    expect(conversationSlice(events, 99, MAX_CONVERSATION_CHARS)).toEqual({
      text: '',
      endEvent: 3,
    });
  });

  it('carries the budget the indexer passes', () => {
    expect(MAX_CONVERSATION_CHARS).toBe(6000);
  });
});

describe('ConversationWatermarkStore', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(process.cwd(), '.marimo-recall-conversations-'));
  });

  afterEach(async () => {
    await rm(dir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 20,
    });
  });

  function file(): string {
    return join(dir, 'conversations.json');
  }

  it('round-trips the counts it was given', async () => {
    const store = new ConversationWatermarkStore({file: file()});
    await store.save({sessionA: 3, sessionB: 1});

    // A second store, so what is asserted is the file rather than the cache.
    const reopened = new ConversationWatermarkStore({file: file()});
    expect(await reopened.load()).toEqual({sessionA: 3, sessionB: 1});
    expect(await reopened.embeddedUpTo('sessionA')).toBe(3);
  });

  it('answers 0 for a conversation it has never embedded', async () => {
    const store = new ConversationWatermarkStore({file: file()});

    expect(await store.embeddedUpTo('never-seen')).toBe(0);
    expect(await store.load()).toEqual({});
  });

  it('forgets the sessions it is told about and keeps the rest', async () => {
    const store = new ConversationWatermarkStore({file: file()});
    await store.save({sessionA: 1, sessionB: 2, sessionC: 3});
    await store.forget(['sessionB', 'sessionC']);

    const reopened = new ConversationWatermarkStore({file: file()});
    expect(await reopened.load()).toEqual({sessionA: 1});
  });

  /*
   * `save` replaces the map rather than merging into it, which is how a conversation
   * that has been deleted loses its count: the caller walks the sessions that exist
   * and the missing one is simply not in the map it passes.
   */
  it('prunes a session that is no longer in the map it is given', async () => {
    const store = new ConversationWatermarkStore({file: file()});
    await store.save({sessionA: 1, sessionB: 2});
    await store.save({sessionA: 1});

    const reopened = new ConversationWatermarkStore({file: file()});
    expect(await reopened.load()).toEqual({sessionA: 1});
  });

  it('creates the directory the document lives in', async () => {
    const nested = join(dir, 'workspace', 'recall', 'conversations.json');
    const store = new ConversationWatermarkStore({file: nested});
    await store.save({sessionA: 2});

    const reopened = new ConversationWatermarkStore({file: nested});
    expect(await reopened.embeddedUpTo('sessionA')).toBe(2);
  });

  /*
   * The one place this document is not version-guarded: it is a cache of vectors
   * that can be rebuilt, so a file this build cannot read is a reason to start over
   * rather than a reason to refuse. It answers empty, and the next write replaces it.
   */
  it('reads a corrupt file as empty rather than refusing', async () => {
    await writeFile(file(), '{not json', 'utf8');
    const store = new ConversationWatermarkStore({file: file()});

    expect(await store.load()).toEqual({});
    expect(await store.embeddedUpTo('sessionA')).toBe(0);
  });

  it('rewrites a corrupt or newer file on the next save', async () => {
    await writeFile(file(), '{not json', 'utf8');
    const corrupt = new ConversationWatermarkStore({file: file()});
    await corrupt.save({sessionA: 2});
    expect(JSON.parse(await readFile(file(), 'utf8'))).toEqual({
      version: 1,
      embedded: {sessionA: 2},
    });

    await writeFile(
      file(),
      JSON.stringify({version: 99, embedded: {sessionA: 9}}),
      'utf8',
    );
    const newer = new ConversationWatermarkStore({file: file()});
    expect(await newer.load()).toEqual({});
    await newer.save({sessionA: 3});
    expect(JSON.parse(await readFile(file(), 'utf8'))).toEqual({
      version: 1,
      embedded: {sessionA: 3},
    });
  });

  /*
   * A count that is zero or negative means "nothing embedded", and a NaN that
   * reached the file would compare false against every event index — a conversation
   * re-embedded from the start on every refresh, forever, with the file looking fine.
   */
  it('ignores counts that are not a positive finite number', async () => {
    await writeFile(
      file(),
      JSON.stringify({version: 1, embedded: {a: -1, b: 0, c: 2, d: null}}),
      'utf8',
    );
    const store = new ConversationWatermarkStore({file: file()});

    expect(await store.load()).toEqual({c: 2});
  });

  it('answers empty for a document that is not shaped like one', async () => {
    await writeFile(file(), JSON.stringify({embedded: {a: 4}}), 'utf8');
    expect(await new ConversationWatermarkStore({file: file()}).load()).toEqual(
      {},
    );

    await writeFile(file(), JSON.stringify(['a']), 'utf8');
    expect(await new ConversationWatermarkStore({file: file()}).load()).toEqual(
      {},
    );
  });
});
