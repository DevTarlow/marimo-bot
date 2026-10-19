import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';

import {createEvent} from '@google/adk';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';

import {FileSessionService} from './file-session-service.js';

const APP = 'marimo';
const USER = 'local';

describe('FileSessionService', () => {
  let rootDir: string;
  let service: FileSessionService;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(process.cwd(), '.marimo-test-'));
    service = new FileSessionService({rootDir});
  });

  afterEach(async () => {
    await rm(rootDir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 20,
    });
  });

  async function newSession(sessionId = 'session-1') {
    return await service.createSession({
      appName: APP,
      userId: USER,
      sessionId,
    });
  }

  function userEvent(text: string) {
    return createEvent({
      author: 'user',
      content: {role: 'user', parts: [{text}]},
    });
  }

  function modelEvent(text: string) {
    return createEvent({
      author: 'marimo',
      content: {role: 'model', parts: [{text}]},
    });
  }

  it('creates a session with an empty event log and an index entry', async () => {
    const session = await newSession();
    expect(session.id).toBe('session-1');
    expect(session.events).toEqual([]);

    const entry = await service.getIndexEntry('session-1');
    expect(entry?.title).toBe('New chat');
    expect(entry?.messageCount).toBe(0);
    expect(await service.listEvents('session-1')).toEqual([]);
  });

  it('appends events, restores the event brand, and titles from the first user message', async () => {
    const session = await newSession();
    await service.appendEvent({
      session,
      event: userEvent('How do I read a file in Node?'),
    });
    await service.appendEvent({session, event: modelEvent('Use readFile.')});

    const events = await service.listEvents('session-1');
    expect(events).toHaveLength(2);
    expect(events[0]?.content?.parts?.[0]?.text).toBe(
      'How do I read a file in Node?',
    );
    // The brand is a global symbol that JSON cannot carry; it must be restored
    // so ADK code that type-guards a loaded event still recognises it.
    expect(
      (events[0] as unknown as Record<symbol, unknown>)[
        Symbol.for('google.adk.event')
      ],
    ).toBe(true);

    const entry = await service.getIndexEntry('session-1');
    expect(entry?.title).toBe('How do I read a file in Node?');
    expect(entry?.messageCount).toBe(2);
  });

  it('truncates a long first message when deriving the title', async () => {
    const session = await newSession();
    const long = 'x'.repeat(200);
    await service.appendEvent({session, event: userEvent(long)});

    const entry = await service.getIndexEntry('session-1');
    expect(entry?.title.length).toBe(60);
    expect(entry?.title.endsWith('…')).toBe(true);
  });

  it('reconstructs state and events for a session lookup', async () => {
    const session = await newSession();
    await service.appendEvent({session, event: userEvent('hello')});

    const loaded = await service.getSession({
      appName: APP,
      userId: USER,
      sessionId: 'session-1',
    });
    expect(loaded?.events).toHaveLength(1);
    expect(loaded?.appName).toBe(APP);
    expect(loaded?.lastUpdateTime).toBeGreaterThan(0);
  });

  it('returns undefined for an unknown session and an empty log for a missing file', async () => {
    expect(
      await service.getSession({
        appName: APP,
        userId: USER,
        sessionId: 'nope',
      }),
    ).toBeUndefined();
    expect(await service.listEvents('nope')).toEqual([]);
  });

  it('skips a corrupt line instead of losing the whole conversation', async () => {
    const session = await newSession();
    await service.appendEvent({session, event: userEvent('first')});
    await service.appendEvent({session, event: modelEvent('second')});

    // Simulate a truncated write, which is what a hard kill leaves behind.
    const file = join(rootDir, 'session-1.jsonl');
    await writeFile(
      file,
      `${await readFile(file, 'utf8')}{"broken":\n`,
      'utf8',
    );

    const events = await service.listEvents('session-1');
    expect(events).toHaveLength(2);
  });

  it('lists sessions newest first and honours a limit', async () => {
    await newSession('older');
    await new Promise((resolve) => setTimeout(resolve, 5));
    await newSession('newer');

    const listed = await service.listSessions({appName: APP, userId: USER});
    expect(listed.sessions.map((session) => session.id)).toEqual([
      'newer',
      'older',
    ]);
    expect(listed.totalItems).toBe(2);
    expect(listed.sessions[0]?.events).toEqual([]);

    const limited = await service.listSessions({
      appName: APP,
      userId: USER,
      limit: 1,
    });
    expect(limited.sessions).toHaveLength(1);
    expect(limited.totalPages).toBe(2);
  });

  it('deletes both the event log and the index entry', async () => {
    const session = await newSession();
    await service.appendEvent({session, event: userEvent('bye')});
    await service.deleteSession({
      appName: APP,
      userId: USER,
      sessionId: 'session-1',
    });

    expect(await service.getIndexEntry('session-1')).toBeUndefined();
    expect(await service.listEvents('session-1')).toEqual([]);
  });

  it('ignores a corrupt index file rather than throwing', async () => {
    await writeFile(join(rootDir, 'index.json'), 'not json', 'utf8');
    expect(await service.getIndex()).toEqual([]);
  });

  /*
   * And does not then *replace* it. The lenient read above is only safe because
   * the write refuses — without that, an unreadable index became an empty one on
   * the very next message and every conversation vanished from the sidebar,
   * which is the failure this project's document rule exists to prevent.
   */
  it('keeps the corrupt index rather than overwriting it', async () => {
    await writeFile(join(rootDir, 'index.json'), 'not json', 'utf8');
    await service.getIndex();

    const {readdir} = await import('node:fs/promises');
    const entries = await readdir(rootDir);
    const kept = entries.find((entry) => entry.includes('unreadable'));
    expect(kept).toBeDefined();
    expect(await readFile(join(rootDir, kept ?? ''), 'utf8')).toBe('not json');
  });

  it('accepts an index that is JSON but not an index, and keeps it', async () => {
    await writeFile(join(rootDir, 'index.json'), '{"hello":"world"}', 'utf8');
    expect(await service.getIndex()).toEqual([]);

    const {readdir} = await import('node:fs/promises');
    expect(
      (await readdir(rootDir)).some((entry) => entry.includes('unreadable')),
    ).toBe(true);
  });

  /*
   * Invariant 12 for the file that holds the conversation list. A future build's
   * index must be left exactly where it is: losing the list is bad, and writing
   * over it is worse.
   */
  it('refuses an index from a newer build, and leaves it alone', async () => {
    const future = JSON.stringify({version: 99, sessions: {}});
    await writeFile(join(rootDir, 'index.json'), future, 'utf8');

    await expect(service.getIndex()).rejects.toThrow(/newer version/u);
    expect(await readFile(join(rootDir, 'index.json'), 'utf8')).toBe(future);
  });

  it('refuses to write over an index from a newer build', async () => {
    const future = JSON.stringify({version: 99, sessions: {}});
    await writeFile(join(rootDir, 'index.json'), future, 'utf8');

    await expect(
      service.createSession({appName: APP, userId: USER, sessionId: 'x'}),
    ).rejects.toThrow(/newer version/u);
    expect(await readFile(join(rootDir, 'index.json'), 'utf8')).toBe(future);
  });

  it('reads a conversation an older build gave a model of its own', async () => {
    /*
     * A field whose shape changed under a document that did not.
     *
     * The build before this one recorded a conversation's model as a bare id and
     * this one records a pair, so the old value is dropped: an id means nothing
     * without the endpoint that served it, and nothing in the document says which
     * one that was. What must survive is the *entry*, and that is the failure
     * this guards — the schema is checked once for the whole index, so an entry
     * that failed it would take every conversation with it and the rail would
     * come back empty rather than missing one model.
     *
     * Written straight to the file rather than through `createSession`: what is
     * being tested is a document this build did not write.
     */
    await writeFile(
      join(rootDir, 'index.json'),
      `${JSON.stringify(
        {
          version: 1,
          sessions: {
            'from-the-provider-era': {
              id: 'from-the-provider-era',
              title: 'An older chat',
              createdAt: '2025-01-01T00:00:00.000Z',
              updatedAt: '2025-01-01T00:00:00.000Z',
              messageCount: 2,
              appName: APP,
              userId: USER,
              model: 'deepseek-v4-pro',
              workspaceId: 'workspace-a',
            },
          },
        },
        null,
        2,
      )}\n`,
      'utf8',
    );

    const entry = await service.getIndexEntry('from-the-provider-era');
    expect(entry?.title).toBe('An older chat');
    expect(entry?.workspaceId).toBe('workspace-a');
    // Dropped rather than guessed at, for the reason above.
    expect(entry?.model).toBeUndefined();
    expect(await service.getIndex()).toHaveLength(1);
  });

  /*
   * The other half of that tolerance, and the half a document-level rule would
   * get wrong: a stale id in one entry must not make the reader lenient about
   * the entry beside it, which carries a pair this build wrote and has to keep.
   * Two entries in one file is what makes that per-entry rather than a property
   * of the document.
   */
  it('keeps a model this build wrote beside a stale one it drops', async () => {
    const entry = (id: string, model: unknown): Record<string, unknown> => ({
      id,
      title: id,
      createdAt: '2025-01-01T00:00:00.000Z',
      updatedAt: '2025-01-01T00:00:00.000Z',
      messageCount: 2,
      appName: APP,
      userId: USER,
      ...(model === undefined ? {} : {model}),
    });

    await writeFile(
      join(rootDir, 'index.json'),
      `${JSON.stringify(
        {
          version: 1,
          sessions: {
            'from-the-provider-era': entry(
              'from-the-provider-era',
              'deepseek-v4-pro',
            ),
            'from-this-build': entry('from-this-build', {
              provider: 'deepseek',
              model: 'deepseek-flash',
            }),
          },
        },
        null,
        2,
      )}\n`,
      'utf8',
    );

    expect(await service.getIndex()).toHaveLength(2);
    expect(
      (await service.getIndexEntry('from-the-provider-era'))?.model,
    ).toBeUndefined();
    expect((await service.getIndexEntry('from-this-build'))?.model).toEqual({
      provider: 'deepseek',
      model: 'deepseek-flash',
    });
  });

  it('never resurrects a deleted session from a late event', async () => {
    await newSession('doomed');
    await service.deleteSession({
      appName: APP,
      userId: USER,
      sessionId: 'doomed',
    });

    // The turn that was in flight can still emit one last event after the
    // delete. It must not re-register the conversation, least of all without a
    // profile, which the next launch would adopt into whichever agent was active.
    await service.appendEvent({
      session: {
        id: 'doomed',
        appName: APP,
        userId: USER,
        state: {},
        events: [],
        lastUpdateTime: 0,
      },
      event: userEvent('one last thing'),
    });

    expect(await service.getIndexEntry('doomed')).toBeUndefined();
    expect(await service.getIndex()).toEqual([]);
  });

  it('stamps the profile that created a conversation', async () => {
    await service.createSession({
      appName: APP,
      userId: USER,
      sessionId: 'owned',
      state: {profileId: 'profile-a'},
    });
    expect((await service.getIndexEntry('owned'))?.profileId).toBe('profile-a');
  });

  it('stamps the folder a conversation was started in', async () => {
    await service.createSession({
      appName: APP,
      userId: USER,
      sessionId: 'filed',
      state: {workspaceId: 'workspace-a'},
    });
    expect((await service.getIndexEntry('filed'))?.workspaceId).toBe(
      'workspace-a',
    );
  });

  it('leaves the folder unset when there was none to record', async () => {
    await newSession('unfiled');
    expect(
      (await service.getIndexEntry('unfiled'))?.workspaceId,
    ).toBeUndefined();
  });

  /**
   * The sidebar nests conversations by this id and shows anything with an
   * unknown one under "Other chats", so adopting a legacy conversation must not
   * disturb it either way.
   */
  it('keeps the folder stamp through adoption and later writes', async () => {
    await service.createSession({
      appName: APP,
      userId: USER,
      sessionId: 'filed',
      state: {workspaceId: 'workspace-a'},
    });
    await service.adoptUnownedSessions('profile-a');
    await service.renameSession('filed', 'Renamed after adoption');

    const entry = await service.getIndexEntry('filed');
    expect(entry?.workspaceId).toBe('workspace-a');
    expect(entry?.profileId).toBe('profile-a');
  });

  it('re-files a conversation under another folder', async () => {
    await service.createSession({
      appName: APP,
      userId: USER,
      sessionId: 'filed',
      state: {workspaceId: 'workspace-a'},
    });

    await service.setSessionWorkspace('filed', 'workspace-b');
    expect((await service.getIndexEntry('filed'))?.workspaceId).toBe(
      'workspace-b',
    );
  });

  it('unfiles a conversation, which is how it reaches Other chats', async () => {
    await service.createSession({
      appName: APP,
      userId: USER,
      sessionId: 'filed',
      state: {workspaceId: 'workspace-a'},
    });

    await service.setSessionWorkspace('filed', undefined);
    const entry = await service.getIndexEntry('filed');
    expect(entry?.workspaceId).toBeUndefined();
    // Absent rather than a sentinel: a conversation that was never filed and
    // one that was moved out of every folder have to look identical.
    expect(Object.hasOwn(entry ?? {}, 'workspaceId')).toBe(false);
  });

  /**
   * `updatedAt` is what the sidebar sorts on and what "3h ago" reports, and both
   * mean when something last happened *in* the conversation. Moving a chat is
   * filing, so it must not touch either.
   */
  it('leaves the conversation timestamps alone when it moves', async () => {
    await service.createSession({
      appName: APP,
      userId: USER,
      sessionId: 'filed',
      state: {workspaceId: 'workspace-a'},
    });
    const before = await service.getIndexEntry('filed');

    await service.setSessionWorkspace('filed', 'workspace-b');

    const after = await service.getIndexEntry('filed');
    expect(after?.updatedAt).toBe(before?.updatedAt);
    expect(after?.createdAt).toBe(before?.createdAt);
  });

  it('reports an unknown conversation rather than inventing an entry', async () => {
    expect(
      await service.setSessionWorkspace('no-such-session', 'workspace-a'),
    ).toBeUndefined();
    expect(await service.getIndex()).toEqual([]);
  });

  describe('who is in a conversation', () => {
    it('round-trips the members, lead first', async () => {
      await newSession('group');

      const entry = await service.setSessionParticipants('group', [
        'profile-lead',
        'profile-helper',
      ]);

      expect(entry?.agentIds).toEqual(['profile-lead', 'profile-helper']);
      // Through a second read, which is what the window does when it reloads.
      expect((await service.getIndexEntry('group'))?.agentIds).toEqual([
        'profile-lead',
        'profile-helper',
      ]);
    });

    /*
     * Absent rather than an empty array, exactly as the model and the folder
     * are: "just the agent that owns this chat" is the state every conversation
     * starts in, and a sentinel would be a second way to say it.
     */
    it('removes the field when the list is empty', async () => {
      await newSession('group');
      await service.setSessionParticipants('group', ['profile-lead']);

      const entry = await service.setSessionParticipants('group', []);

      expect(entry?.agentIds).toBeUndefined();
      expect(Object.hasOwn(entry ?? {}, 'agentIds')).toBe(false);
    });

    /*
     * The failure the schema declaration exists to prevent: a field that parses
     * through `.passthrough()` and is then dropped by the next write, so a group
     * chat would quietly lose its members the first time anything else about it
     * changed.
     */
    it('survives another write to the same conversation', async () => {
      await newSession('group');
      await service.setSessionParticipants('group', ['profile-lead']);

      await service.renameSession('group', 'Release prep');

      const entry = await service.getIndexEntry('group');
      expect(entry?.title).toBe('Release prep');
      expect(entry?.agentIds).toEqual(['profile-lead']);
    });

    it('leaves the timestamps alone', async () => {
      await newSession('group');
      const before = await service.getIndexEntry('group');

      await service.setSessionParticipants('group', ['profile-lead']);

      const after = await service.getIndexEntry('group');
      expect(after?.updatedAt).toBe(before?.updatedAt);
      expect(after?.createdAt).toBe(before?.createdAt);
    });

    it('reports an unknown conversation rather than inventing an entry', async () => {
      expect(
        await service.setSessionParticipants('no-such-session', ['profile-a']),
      ).toBeUndefined();
      expect(await service.getIndex()).toEqual([]);
    });

    it('reads a conversation written before the field existed', async () => {
      await newSession('old');
      expect((await service.getIndexEntry('old'))?.agentIds).toBeUndefined();
    });
  });

  describe('renaming a conversation', () => {
    it('replaces the title the first message produced', async () => {
      const session = await newSession();
      await service.appendEvent({session, event: userEvent('fix the build')});
      expect((await service.getIndexEntry('session-1'))?.title).toBe(
        'fix the build',
      );

      const renamed = await service.renameSession('session-1', 'Release prep');
      expect(renamed?.title).toBe('Release prep');
      expect((await service.getIndexEntry('session-1'))?.title).toBe(
        'Release prep',
      );
    });

    /**
     * The derived title is a guess at what a conversation is about, and the one
     * case where it must not win is a chat the user named before saying
     * anything in it — otherwise the name they chose is thrown away by the first
     * message that arrives.
     */
    it('survives the first message of a chat named before it was used', async () => {
      const session = await newSession();
      await service.renameSession('session-1', 'Tax paperwork');
      await service.appendEvent({session, event: userEvent('what do I owe?')});

      expect((await service.getIndexEntry('session-1'))?.title).toBe(
        'Tax paperwork',
      );
    });

    /**
     * `updatedAt` is what the sidebar sorts on and what "3h ago" reports, and
     * both mean when something last happened *in* the conversation. Naming a
     * chat is not a turn, exactly as moving it is not.
     */
    it('leaves the timestamps alone', async () => {
      await newSession();
      const before = await service.getIndexEntry('session-1');

      await service.renameSession('session-1', 'Named later');

      const after = await service.getIndexEntry('session-1');
      expect(after?.updatedAt).toBe(before?.updatedAt);
      expect(after?.createdAt).toBe(before?.createdAt);
    });

    it('reports an unknown conversation rather than inventing an entry', async () => {
      expect(
        await service.renameSession('no-such-session', 'Anything'),
      ).toBeUndefined();
      expect(await service.getIndex()).toEqual([]);
    });
  });

  /**
   * The source is what files a conversation the app started under its own
   * sidebar heading, so it has to survive the index round trip and mean nothing
   * when it is a value this app does not know.
   */
  describe('a conversation the app started', () => {
    it('records the source it was created with', async () => {
      await service.createSession({
        appName: APP,
        userId: USER,
        sessionId: 'from-discord',
        state: {source: 'discord'},
      });

      expect((await service.getIndexEntry('from-discord'))?.source).toBe(
        'discord',
      );
    });

    it('leaves it unset for a conversation the user started', async () => {
      await newSession('typed');
      expect((await service.getIndexEntry('typed'))?.source).toBeUndefined();
    });

    it('ignores a source this app does not know', async () => {
      await service.createSession({
        appName: APP,
        userId: USER,
        sessionId: 'mystery',
        state: {source: 'telepathy'},
      });

      // Stored absent rather than as-is: an unknown value would reach the
      // sidebar as a heading it has no name for.
      const entry = await service.getIndexEntry('mystery');
      expect(entry?.source).toBeUndefined();
      expect(Object.hasOwn(entry ?? {}, 'source')).toBe(false);
    });
  });

  it('adopts unowned conversations once, then leaves them alone', async () => {
    await newSession('legacy');
    expect(await service.adoptUnownedSessions('profile-a')).toBe(1);
    expect((await service.getIndexEntry('legacy'))?.profileId).toBe(
      'profile-a',
    );
    // A second launch has nothing left to claim.
    expect(await service.adoptUnownedSessions('profile-b')).toBe(0);
    expect((await service.getIndexEntry('legacy'))?.profileId).toBe(
      'profile-a',
    );
  });

  it('deletes only the conversations a profile owns', async () => {
    await service.createSession({
      appName: APP,
      userId: USER,
      sessionId: 'a-1',
      state: {profileId: 'profile-a'},
    });
    await service.createSession({
      appName: APP,
      userId: USER,
      sessionId: 'b-1',
      state: {profileId: 'profile-b'},
    });

    expect(await service.deleteSessionsForProfile('profile-a')).toEqual([
      'a-1',
    ]);
    expect(await service.getIndexEntry('a-1')).toBeUndefined();
    expect(await service.getIndexEntry('b-1')).toBeDefined();
  });
});
