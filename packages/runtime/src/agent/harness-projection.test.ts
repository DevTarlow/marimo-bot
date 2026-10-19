import {describe, expect, it} from 'vitest';

import type {EngineUpdate, SessionEvent} from '@marimo/agent';

import {
  projectPendingGates,
  projectTurn,
  textOfResult,
  transcriptFromEvents,
} from './harness-projection.js';

function event(
  base: {type: SessionEvent['type']} & Record<string, unknown>,
): SessionEvent {
  return {
    id: 'e1',
    sessionId: 's1',
    at: '2026-01-01T00:00:00.000Z',
    ...base,
  } as SessionEvent;
}

async function collect(stream: AsyncIterable<unknown>): Promise<unknown[]> {
  const updates: unknown[] = [];
  for await (const update of stream) {
    updates.push(update);
  }
  return updates;
}

async function* updates(items: EngineUpdate[]): AsyncGenerator<EngineUpdate> {
  for (const item of items) {
    yield item;
  }
}

describe('projectTurn', () => {
  it('turns deltas, tool calls and completion into the window events', async () => {
    const list: EngineUpdate[] = [
      {
        type: 'event',
        event: event({
          type: 'turn.started',
          turnId: 't1',
          profileId: 'writer',
          harnessVersion: 1,
          harnessHash: 'hash',
          model: {provider: 'deepseek', model: 'deepseek-chat'},
        }),
      },
      {type: 'delta', channel: 'text', text: 'Hel'},
      {type: 'delta', channel: 'text', text: 'lo'},
      {
        type: 'event',
        event: event({
          type: 'assistant.message',
          turnId: 't1',
          author: 'Writer',
          text: 'Hello',
        }),
      },
      {
        type: 'event',
        event: event({
          type: 'tool.call',
          turnId: 't1',
          callId: 'call_1',
          tool: 'read_file',
          args: {path: 'a.md'},
          author: 'Writer',
        }),
      },
      {
        type: 'event',
        event: event({
          type: 'tool.result',
          turnId: 't1',
          callId: 'call_1',
          tool: 'read_file',
          ok: true,
          result: 'body',
        }),
      },
      {
        type: 'event',
        event: event({
          type: 'turn.completed',
          turnId: 't1',
          usage: {promptTokens: 1, completionTokens: 2, totalTokens: 3},
        }),
      },
    ];
    const projected = (await collect(
      projectTurn(updates(list), 's1'),
    )) as Array<{
      type: string;
      text?: string;
      usage?: unknown;
    }>;
    expect(projected.map((entry) => entry.type)).toEqual([
      'turn.started',
      'text.delta',
      'text.delta',
      'tool.started',
      'tool.finished',
      'turn.completed',
      'session.changed',
    ]);
    expect(projected[1]?.text).toBe('Hel');
    expect(projected[5]?.usage).toEqual({
      promptTokens: 1,
      completionTokens: 2,
      totalTokens: 3,
    });
  });

  it('hands the window a whole message when the provider did not stream', async () => {
    const list: EngineUpdate[] = [
      {
        type: 'event',
        event: event({
          type: 'turn.started',
          turnId: 't1',
          profileId: 'writer',
          harnessVersion: 1,
          harnessHash: 'hash',
          model: {provider: 'deepseek', model: 'deepseek-chat'},
        }),
      },
      {
        type: 'event',
        event: event({
          type: 'assistant.message',
          turnId: 't1',
          author: 'Writer',
          text: 'Whole answer',
        }),
      },
      {type: 'event', event: event({type: 'turn.completed', turnId: 't1'})},
    ];
    const projected = (await collect(
      projectTurn(updates(list), 's1'),
    )) as Array<{
      type: string;
      text?: string;
    }>;
    expect(projected.filter((entry) => entry.type === 'text.delta')).toEqual([
      expect.objectContaining({text: 'Whole answer'}),
    ]);
  });
});

describe('projectPendingGates', () => {
  it('answers the protocol shape with the question time', () => {
    const gates = projectPendingGates([
      event({
        type: 'turn.started',
        turnId: 't1',
        profileId: 'writer',
        harnessVersion: 1,
        harnessHash: 'hash',
        model: {provider: 'deepseek', model: 'deepseek-chat'},
      }),
      event({
        type: 'approval.requested',
        turnId: 't1',
        callId: 'call_1',
        tool: 'write_file',
        args: {path: 'a.md'},
        hint: 'Replace it',
        author: 'Writer',
        at: '2026-01-01T00:00:05.000Z',
      }),
    ]);
    expect(gates).toEqual([
      {
        callId: 'call_1',
        tool: 'write_file',
        args: {path: 'a.md'},
        hint: 'Replace it',
        askedAt: '2026-01-01T00:00:05.000Z',
      },
    ]);
  });
});

describe('transcriptFromEvents', () => {
  it('keeps the user and assistant messages and folds tool rows under their reply', () => {
    const transcript = transcriptFromEvents([
      event({id: 'u1', type: 'user.message', turnId: 't1', text: 'Read it'}),
      event({
        id: 'a1',
        type: 'assistant.message',
        turnId: 't1',
        author: 'Writer',
        text: 'Reading.',
        reasoning: 'I should look.',
      }),
      event({
        id: 'c1',
        type: 'tool.call',
        turnId: 't1',
        callId: 'call_1',
        tool: 'read_file',
        args: {path: 'a.md'},
        author: 'Writer',
      }),
      event({
        id: 'r1',
        type: 'tool.result',
        turnId: 't1',
        callId: 'call_1',
        tool: 'read_file',
        ok: true,
        result: 'body',
      }),
      event({
        id: 'f1',
        type: 'turn.failed',
        turnId: 't1',
        message: 'The model failed.',
      }),
    ]);
    expect(transcript).toHaveLength(3);
    expect(transcript[0]).toMatchObject({role: 'user', text: 'Read it'});
    expect(transcript[1]).toMatchObject({
      role: 'assistant',
      text: 'Reading.',
      reasoning: 'I should look.',
      toolCalls: [
        {callId: 'call_1', tool: 'read_file', ok: true, result: 'body'},
      ],
    });
    expect(transcript[2]).toMatchObject({error: 'The model failed.'});
  });
});

describe('textOfResult', () => {
  it('keeps a string as itself and stringifies an object', () => {
    expect(textOfResult('body')).toBe('body');
    expect(textOfResult({ok: true})).toBe('{"ok":true}');
    expect(textOfResult(undefined)).toBe('');
  });
});
