/**
 * What the user said about the agent's answers.
 *
 * Two properties carry this store, and both are about not lying to somebody who
 * just pressed a button. A correction that was not stored must not be reported as
 * stored, and a correction recorded in one agent's conversation must not turn up
 * as a judgement about another agent's answer.
 */
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';

import {afterEach, beforeEach, describe, expect, it} from 'vitest';

import {MAX_FEEDBACK_ENTRIES} from '@marimo/protocol';

import {FeedbackStore} from './feedback.js';

describe('the feedback store', () => {
  let dir: string;
  let file: string;
  let store: FeedbackStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(process.cwd(), '.marimo-feedback-'));
    file = join(dir, 'feedback.json');
    store = new FeedbackStore({file});
  });

  afterEach(async () => {
    await rm(dir, {recursive: true, force: true});
  });

  it('starts empty', async () => {
    expect(await store.load()).toEqual({version: 1, entries: []});
    expect(await store.forProfile('default')).toEqual([]);
  });

  it('records one with an id and a time', async () => {
    await store.record({
      profileId: 'default',
      sessionId: 'session-1',
      messageId: 'message-1',
      excerpt: 'The parser lives in alpha.',
      correction: 'No, it moved to beta.',
    });

    const entries = await store.forProfile('default');
    expect(entries).toHaveLength(1);
    expect(entries[0]?.id).toBeTruthy();
    expect(entries[0]?.createdAt).toBeTruthy();
    expect(entries[0]?.excerpt).toBe('The parser lives in alpha.');
    expect(entries[0]?.correction).toBe('No, it moved to beta.');
  });

  it('keeps the turn, when it was given one', async () => {
    /*
     * The message id is what the window has on screen; the invocation is the
     * name the discovery log uses. Storing both is what lets the mark be read
     * back onto the answer it was about instead of floating free in a list.
     */
    await store.record({
      profileId: 'default',
      sessionId: 'session-1',
      messageId: 'message-1',
      invocationId: 'turn-1',
      excerpt: 'Something wrong.',
    });

    const [entry] = await store.forProfile('default');
    expect(entry?.invocationId).toBe('turn-1');
    // The message id survives, because an older reader has only that one.
    expect(entry?.messageId).toBe('message-1');
  });

  it('reads one conversation without dragging in another', async () => {
    await store.record({
      profileId: 'default',
      sessionId: 'session-1',
      messageId: 'message-1',
      excerpt: 'Wrong in one conversation.',
    });
    await store.record({
      profileId: 'default',
      sessionId: 'session-2',
      messageId: 'message-2',
      excerpt: 'Wrong in another.',
    });

    const entries = await store.forSession('session-1');
    expect(entries.map((entry) => entry.excerpt)).toEqual([
      'Wrong in one conversation.',
    ]);
  });

  it('survives a restart', async () => {
    await store.record({
      profileId: 'default',
      sessionId: 'session-1',
      messageId: 'message-1',
      excerpt: 'Something wrong.',
    });

    const reopened = await new FeedbackStore({file}).forProfile('default');
    expect(reopened).toHaveLength(1);
  });

  /*
   * A correction is optional and that is the point: "that was wrong" is worth
   * recording on its own, and a channel that demanded the user explain
   * themselves would be one they stop using.
   */
  it('records a correction with nothing typed', async () => {
    await store.record({
      profileId: 'default',
      sessionId: 'session-1',
      messageId: 'message-1',
      excerpt: 'Something wrong.',
    });

    expect((await store.forProfile('default'))[0]?.correction).toBe('');
  });

  /*
   * Scoped by profile: one agent being told it was wrong about a deployment is
   * not a fact about the other one, and a shared list would have every agent
   * apologising for something it never said.
   */
  it("keeps one agent's corrections away from another's", async () => {
    await store.record({
      profileId: 'work',
      sessionId: 'session-1',
      messageId: 'message-1',
      excerpt: 'Work answer.',
    });
    await store.record({
      profileId: 'home',
      sessionId: 'session-2',
      messageId: 'message-2',
      excerpt: 'Home answer.',
    });

    expect((await store.forProfile('work')).map((entry) => entry.excerpt)).toEqual(
      ['Work answer.'],
    );
    expect((await store.forProfile('home')).map((entry) => entry.excerpt)).toEqual(
      ['Home answer.'],
    );
  });

  it('caps the list by dropping the oldest', async () => {
    for (let index = 0; index < MAX_FEEDBACK_ENTRIES + 5; index += 1) {
      await store.record({
        profileId: 'default',
        sessionId: 'session-1',
        messageId: `message-${String(index)}`,
        excerpt: `answer ${String(index)}`,
      });
    }

    const entries = await store.forProfile('default');
    expect(entries).toHaveLength(MAX_FEEDBACK_ENTRIES);
    expect(entries[0]?.excerpt).toBe('answer 5');
  });

  it('clears everything', async () => {
    await store.record({
      profileId: 'default',
      sessionId: 'session-1',
      messageId: 'message-1',
      excerpt: 'Wrong.',
    });

    expect((await store.clear()).entries).toEqual([]);
    expect(await new FeedbackStore({file}).forProfile('default')).toEqual([]);
  });

  /*
   * Removing a bot is not a request to forget everybody's corrections: the
   * others are about conversations that still exist, and the Memory card would
   * look empty for a bot the user never touched.
   */
  it("forgets one bot's corrections and keeps the rest", async () => {
    await store.record({
      profileId: 'default',
      sessionId: 'session-1',
      messageId: 'message-1',
      excerpt: 'Wrong about the parser.',
    });
    await store.record({
      profileId: 'research',
      sessionId: 'session-2',
      messageId: 'message-2',
      excerpt: 'Wrong about the release date.',
    });

    expect((await store.forgetProfile('default')).entries.map((e) => e.profileId))
      .toEqual(['research']);
    expect(await store.forProfile('default')).toEqual([]);
    expect(await store.forProfile('research')).toHaveLength(1);
  });

  /*
   * A lenient read is what lets the window open with a corrupt file, and it is
   * also the reason the write path is strict — a lenient read plus a write is how
   * a user's data disappears.
   */
  it('answers as empty for a file it cannot parse', async () => {
    await writeFile(file, '{not json', 'utf8');
    expect(await store.load()).toEqual({version: 1, entries: []});
  });

  it('refuses to overwrite a corrupt file, and moves it aside', async () => {
    await writeFile(file, '{not json', 'utf8');

    await store.record({
      profileId: 'default',
      sessionId: 'session-1',
      messageId: 'message-1',
      excerpt: 'Wrong.',
    });

    // The unreadable file is kept, and the new one is written beside it.
    expect(await readFile(`${file}.unreadable`, 'utf8')).toBe('{not json');
    expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({
      version: 1,
    });
  });

  it('trims and caps what it stores', async () => {
    await store.record({
      profileId: 'default',
      sessionId: 'session-1',
      messageId: 'message-1',
      excerpt: `  ${'x'.repeat(500)}  `,
      correction: `  ${'y'.repeat(500)}  `,
    });

    const entry = (await store.forProfile('default'))[0];
    expect(entry?.excerpt).toHaveLength(400);
    expect(entry?.correction).toHaveLength(400);
    expect(entry?.excerpt.startsWith(' ')).toBe(false);
  });
});
