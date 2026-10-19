import {describe, expect, it} from 'vitest';

import type {AgentUiEvent} from '@marimo/protocol';

import type {AgentRuntime} from './runtime.js';
import type {HarnessRuntime} from './harness-runtime.js';
import {createJobRunner} from './job-runner.js';
import type {JobStore} from '../jobs.js';

async function collect(stream: AsyncGenerator<AgentUiEvent>): Promise<AgentUiEvent[]> {
  const events: AgentUiEvent[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

describe('createJobRunner', () => {
  it('runs a job whose conversation has a v2 log through the v2 engine', async () => {
    let ran = '';
    const runtime = {
      isBusy: () => false,
      listSessions: async () => [{id: 's1'}],
      createSession: async () => ({id: 's1'}),
      run: async function* () {
        yield {type: 'turn.failed', sessionId: 's1', messageId: '', message: 'v1 used'};
      },
    } as unknown as AgentRuntime;
    const harness = {
      hasLog: async () => true,
      run: async function* (
        _profileId: string,
        _sessionId: string,
        prompt: string,
      ) {
        ran = prompt;
        yield {
          type: 'turn.completed',
          sessionId: 's1',
          messageId: 't1',
        } satisfies AgentUiEvent;
      },
    } as unknown as HarnessRuntime;
    const jobs = {
      setSession: async () => undefined,
    } as unknown as JobStore;

    const runner = createJobRunner({runtime, harness, jobs});
    const result = await runner.run({
      jobId: 'job-1',
      profileId: 'writer',
      sessionId: 's1',
      onSession: () => undefined,
      prompt: 'Do the thing.',
      title: 'A job',
    });
    const events = await collect(result.events);
    expect(ran).toBe('Do the thing.');
    expect(events.map((event) => event.type)).toEqual(['turn.completed']);
  });

  it('leaves a v1 conversation on the old path', async () => {
    let v1 = 0;
    const runtime = {
      isBusy: () => false,
      listSessions: async () => [{id: 's1'}],
      createSession: async () => ({id: 's1'}),
      run: async function* () {
        v1 += 1;
        yield {type: 'turn.completed', sessionId: 's1', messageId: 't1'};
      },
    } as unknown as AgentRuntime;
    const harness = {
      hasLog: async () => false,
      run: async function* () {
        yield {type: 'turn.failed', sessionId: 's1', messageId: '', message: 'v2 used'};
      },
    } as unknown as HarnessRuntime;
    const jobs = {setSession: async () => undefined} as unknown as JobStore;
    const runner = createJobRunner({runtime, harness, jobs});
    const result = await runner.run({
      jobId: 'job-1',
      profileId: 'writer',
      sessionId: 's1',
      onSession: () => undefined,
      prompt: 'Do it.',
      title: 'A job',
    });
    await collect(result.events);
    expect(v1).toBe(1);
  });
});
