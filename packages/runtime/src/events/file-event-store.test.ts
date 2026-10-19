import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';

import {afterEach, describe, expect, it} from 'vitest';

import type {SessionEvent} from '@marimo/agent';

import {EventLogError, FileEventStore} from './file-event-store.js';

const roots: string[] = [];

async function root(): Promise<string> {
  const dir = await mkdtemp(join(process.cwd(), '.marimo-events-'));
  roots.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((dir) =>
        rm(dir, {recursive: true, force: true, maxRetries: 5, retryDelay: 20}),
      ),
  );
});

function created(
  sessionId: string,
): Extract<SessionEvent, {type: 'session.created'}> {
  return {
    id: 'e1',
    sessionId,
    at: '2026-01-01T00:00:00.000Z',
    type: 'session.created',
    profileId: 'writer',
    title: 'A chat',
  };
}

function message(
  sessionId: string,
  turnId = 't1',
): Extract<SessionEvent, {type: 'user.message'}> {
  return {
    id: 'e2',
    sessionId,
    at: '2026-01-01T00:00:01.000Z',
    turnId,
    type: 'user.message',
    text: 'Hello',
  };
}

describe('FileEventStore', () => {
  it('appends and reads a conversation in order', async () => {
    const dir = await root();
    const store = new FileEventStore({rootDir: dir});
    await store.append('s1', [created('s1'), message('s1')]);
    expect(await store.read('s1')).toEqual([created('s1'), message('s1')]);
  });

  it('answers an empty list for a conversation that was never written', async () => {
    const dir = await root();
    const store = new FileEventStore({rootDir: dir});
    expect(await store.read('s1')).toEqual([]);
  });

  it('keeps conversations in separate files', async () => {
    const dir = await root();
    const store = new FileEventStore({rootDir: dir});
    await store.append('s1', [created('s1')]);
    await store.append('s2', [created('s2')]);
    expect(await store.read('s1')).toEqual([created('s1')]);
    expect(await store.read('s2')).toEqual([created('s2')]);
  });

  it('serialises concurrent appends to one conversation', async () => {
    const dir = await root();
    const store = new FileEventStore({rootDir: dir});
    const second: SessionEvent = {
      ...message('s1'),
      id: 'e3',
      text: 'Second',
    };
    await Promise.all([
      store.append('s1', [created('s1')]),
      store.append('s1', [message('s1')]),
      store.append('s1', [second]),
    ]);
    const events = await store.read('s1');
    expect(events.map((event) => event.id)).toEqual(['e1', 'e2', 'e3']);
  });

  it('refuses a session id that would escape the directory', async () => {
    const dir = await root();
    const store = new FileEventStore({rootDir: dir});
    await expect(
      store.append('../escape', [created('s1')]),
    ).rejects.toBeInstanceOf(EventLogError);
  });

  it('refuses an event for another conversation', async () => {
    const dir = await root();
    const store = new FileEventStore({rootDir: dir});
    await expect(store.append('s1', [created('s2')])).rejects.toThrow(
      /belongs to s2/,
    );
  });

  it('refuses a malformed line and names it', async () => {
    const dir = await root();
    await writeFile(join(dir, 's1.jsonl'), '{"type":"nonsense"}\n', 'utf8');
    const store = new FileEventStore({rootDir: dir});
    await expect(store.read('s1')).rejects.toMatchObject({
      name: 'EventLogError',
      line: 1,
    });
  });

  it('refuses a partial trailing line rather than dropping it', async () => {
    const dir = await root();
    await writeFile(join(dir, 's1.jsonl'), '{"type":"nope"}', 'utf8');
    const store = new FileEventStore({rootDir: dir});
    await expect(store.read('s1')).rejects.toThrow(/partial line/);
  });

  it('writes one JSON object per line', async () => {
    const dir = await root();
    const store = new FileEventStore({rootDir: dir});
    await store.append('s1', [created('s1'), message('s1')]);
    const text = await readFile(join(dir, 's1.jsonl'), 'utf8');
    expect(text.endsWith('\n')).toBe(true);
    expect(text.trim().split('\n')).toHaveLength(2);
  });
});
