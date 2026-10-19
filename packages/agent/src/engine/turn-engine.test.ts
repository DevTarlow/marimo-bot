import {describe, expect, it} from 'vitest';

import {resolveHarness} from '../harness/resolve.js';
import type {
  HarnessAppDefaults,
  HarnessProfile,
  HarnessSpec,
} from '../harness/spec.js';
import type {
  DriverEvent,
  DriverResume,
  DriverRun,
  TurnDriver,
} from './driver.js';
import {MemoryEventStore} from './event-store.js';
import {GateNotFoundError, TurnBusyError, TurnEngine} from './turn-engine.js';
import type {EngineUpdate} from './turn-engine.js';

const app: HarnessAppDefaults = {
  model: {provider: 'deepseek', model: 'deepseek-chat'},
  allowPrivateNetworkFetch: false,
  learning: {mode: 'propose', retainTraces: false},
};

const profile: HarnessProfile = {
  id: 'writer',
  name: 'Writer',
  role: 'Write for the person.',
  enabledTools: ['read_file', 'write_file'],
  enabledSkills: [],
};

function harness(overrides: Partial<HarnessAppDefaults> = {}): HarnessSpec {
  return resolveHarness({
    profile,
    app: {...app, ...overrides},
    version: 1,
  });
}

class ScriptedDriver implements TurnDriver {
  readonly runs: DriverEvent[][];
  readonly resumes: DriverEvent[][];
  runCalls = 0;
  resumeCalls = 0;
  lastDecisions: DriverResume['decisions'] = [];
  lastRunInstruction: string | undefined;
  lastResumeInstruction: string | undefined;

  constructor(runs: DriverEvent[][], resumes: DriverEvent[][] = []) {
    this.runs = runs;
    this.resumes = resumes;
  }

  async *run(input: DriverRun): AsyncIterable<DriverEvent> {
    this.runCalls += 1;
    this.lastRunInstruction = input.instruction;
    for (const event of this.runs.shift() ?? []) {
      yield event;
    }
  }

  async *resume(input: DriverResume): AsyncIterable<DriverEvent> {
    this.resumeCalls += 1;
    this.lastDecisions = input.decisions;
    this.lastResumeInstruction = input.instruction;
    for (const event of this.resumes.shift() ?? []) {
      yield event;
    }
  }
}

function engineFor(driver: TurnDriver): {
  engine: TurnEngine;
  store: MemoryEventStore;
} {
  const store = new MemoryEventStore();
  let counter = 0;
  const engine = new TurnEngine({
    store,
    driver,
    now: () => new Date('2026-01-01T00:00:00.000Z'),
    createId: () => `id-${(counter += 1)}`,
  });
  return {engine, store};
}

async function collect(
  stream: AsyncIterable<EngineUpdate>,
): Promise<EngineUpdate[]> {
  const updates: EngineUpdate[] = [];
  for await (const update of stream) {
    updates.push(update);
  }
  return updates;
}

describe('TurnEngine', () => {
  it('persists the opening, the reply and the completion', async () => {
    const driver = new ScriptedDriver([
      [
        {type: 'step'},
        {type: 'text', text: 'Hel', partial: true},
        {type: 'text', text: 'lo', partial: true},
        {type: 'message', text: 'Hello'},
        {
          type: 'usage',
          usage: {promptTokens: 3, completionTokens: 2, totalTokens: 5},
        },
        {type: 'done'},
      ],
    ]);
    const {engine, store} = engineFor(driver);

    const updates = await collect(
      engine.run({
        sessionId: 's1',
        profileId: 'writer',
        text: 'Hi',
        harness: harness(),
      }),
    );

    expect(
      updates
        .filter((update) => update.type === 'delta')
        .map((update) => (update.type === 'delta' ? update.text : '')),
    ).toEqual(['Hel', 'lo']);

    const events = await store.read('s1');
    expect(events.map((event) => event.type)).toEqual([
      'session.created',
      'user.message',
      'turn.started',
      'assistant.message',
      'turn.completed',
    ]);
    const assistant = events.find(
      (event) => event.type === 'assistant.message',
    );
    expect(assistant).toMatchObject({text: 'Hello', author: 'Writer'});
    const started = events.find((event) => event.type === 'turn.started');
    expect(started).toMatchObject({
      profileId: 'writer',
      harnessVersion: 1,
      model: {provider: 'deepseek', model: 'deepseek-chat'},
    });
  });

  it('stores the turn instruction and replays it on resume', async () => {
    const driver = new ScriptedDriver(
      [
        [
          {type: 'step'},
          {type: 'message', text: 'I need to write.'},
          {
            type: 'approval.request',
            callId: 'call-1',
            tool: 'write_file',
            args: {path: 'a.md'},
          },
          {type: 'done'},
        ],
      ],
      [[{type: 'step'}, {type: 'message', text: 'Done.'}, {type: 'done'}]],
    );
    const {engine, store} = engineFor(driver);
    const spec = harness();
    await collect(
      engine.run({
        sessionId: 's1',
        profileId: 'writer',
        text: 'Write it briefly',
        harness: spec,
        instruction: 'Answer in two sentences.',
      }),
    );
    expect(driver.lastRunInstruction).toBe('Answer in two sentences.');
    const started = (await store.read('s1')).find(
      (event) => event.type === 'turn.started',
    );
    expect(started).toMatchObject({instruction: 'Answer in two sentences.'});

    await collect(
      engine.approve({
        sessionId: 's1',
        callId: 'call-1',
        confirmed: true,
        harness: spec,
      }),
    );
    expect(driver.lastResumeInstruction).toBe('Answer in two sentences.');
  });

  it('allows a new turn after the previous one completed', async () => {
    const driver = new ScriptedDriver([
      [{type: 'step'}, {type: 'message', text: 'One'}, {type: 'done'}],
    ]);
    const {engine} = engineFor(driver);
    await collect(
      engine.run({
        sessionId: 's1',
        profileId: 'writer',
        text: 'First',
        harness: harness(),
      }),
    );
    await collect(
      engine.run({
        sessionId: 's1',
        profileId: 'writer',
        text: 'Second',
        harness: harness(),
      }),
    );
    expect(driver.runCalls).toBe(2);
  });

  it('leaves a gated turn waiting and resumes it after the click', async () => {
    const driver = new ScriptedDriver(
      [
        [
          {type: 'step'},
          {type: 'text', text: 'I can write that.', partial: true},
          {type: 'message', text: 'I can write that.'},
          {
            type: 'approval.request',
            callId: 'call-1',
            tool: 'write_file',
            args: {path: 'a.md'},
            hint: 'Replace a.md',
          },
          {type: 'done'},
        ],
      ],
      [
        [
          {type: 'step'},
          {
            type: 'tool.result',
            callId: 'call-1',
            tool: 'write_file',
            ok: true,
            result: 'wrote a.md',
          },
          {type: 'message', text: 'Done.'},
          {type: 'done'},
        ],
      ],
    );
    const {engine, store} = engineFor(driver);
    const spec = harness();
    await collect(
      engine.run({
        sessionId: 's1',
        profileId: 'writer',
        text: 'Write a.md',
        harness: spec,
      }),
    );

    const gates = await engine.pendingGates('s1');
    expect(gates).toHaveLength(1);
    expect(gates[0]).toMatchObject({
      callId: 'call-1',
      tool: 'write_file',
      hint: 'Replace a.md',
    });
    const before = await store.read('s1');
    expect(before.map((event) => event.type)).not.toContain('turn.completed');

    await collect(
      engine.approve({
        sessionId: 's1',
        callId: 'call-1',
        confirmed: true,
        harness: spec,
      }),
    );

    expect(driver.resumeCalls).toBe(1);
    expect(driver.lastDecisions).toEqual([{callId: 'call-1', confirmed: true}]);
    const after = await store.read('s1');
    expect(after.map((event) => event.type)).toEqual([
      'session.created',
      'user.message',
      'turn.started',
      'assistant.message',
      'approval.requested',
      'approval.decided',
      'tool.result',
      'assistant.message',
      'turn.completed',
    ]);
    expect(await engine.pendingGates('s1')).toEqual([]);
  });

  it('waits for every card in a round before resuming', async () => {
    const driver = new ScriptedDriver(
      [
        [
          {type: 'step'},
          {
            type: 'approval.request',
            callId: 'call-1',
            tool: 'write_file',
            args: {path: 'a.md'},
          },
          {
            type: 'approval.request',
            callId: 'call-2',
            tool: 'write_file',
            args: {path: 'b.md'},
          },
          {type: 'done'},
        ],
      ],
      [
        [
          {type: 'step'},
          {
            type: 'tool.result',
            callId: 'call-1',
            tool: 'write_file',
            ok: true,
            result: 'wrote a.md',
          },
          {
            type: 'tool.result',
            callId: 'call-2',
            tool: 'write_file',
            ok: true,
            result: 'wrote b.md',
          },
          {type: 'message', text: 'Both done.'},
          {type: 'done'},
        ],
      ],
    );
    const {engine, store} = engineFor(driver);
    const spec = harness();
    await collect(
      engine.run({
        sessionId: 's1',
        profileId: 'writer',
        text: 'Write both',
        harness: spec,
      }),
    );
    expect(await engine.pendingGates('s1')).toHaveLength(2);

    await collect(
      engine.approve({
        sessionId: 's1',
        callId: 'call-1',
        confirmed: true,
        harness: spec,
      }),
    );
    expect(driver.resumeCalls).toBe(0);
    expect(await engine.pendingGates('s1')).toHaveLength(1);

    await collect(
      engine.approve({
        sessionId: 's1',
        callId: 'call-2',
        confirmed: false,
        harness: spec,
      }),
    );
    expect(driver.resumeCalls).toBe(1);
    expect(driver.lastDecisions).toEqual([
      {callId: 'call-1', confirmed: true},
      {callId: 'call-2', confirmed: false},
    ]);
    const events = await store.read('s1');
    expect(events.map((event) => event.type)).toContain('turn.completed');
  });

  it('abandons the previous card when a new turn starts', async () => {
    const driver = new ScriptedDriver([
      [
        {type: 'step'},
        {type: 'message', text: 'I need to write.'},
        {
          type: 'approval.request',
          callId: 'call-1',
          tool: 'write_file',
          args: {path: 'a.md'},
        },
        {type: 'done'},
      ],
      [
        {type: 'step'},
        {type: 'message', text: 'Something else.'},
        {type: 'done'},
      ],
    ]);
    const {engine, store} = engineFor(driver);
    const spec = harness();
    await collect(
      engine.run({
        sessionId: 's1',
        profileId: 'writer',
        text: 'Write a.md',
        harness: spec,
      }),
    );
    await collect(
      engine.run({
        sessionId: 's1',
        profileId: 'writer',
        text: 'Never mind',
        harness: spec,
      }),
    );

    const events = await store.read('s1');
    const synthetic = events.filter(
      (event) => event.type === 'tool.result' && event.synthetic === true,
    );
    expect(synthetic).toHaveLength(1);
    expect(synthetic[0]).toMatchObject({
      callId: 'call-1',
      ok: false,
      synthetic: true,
    });
    expect(await engine.pendingGates('s1')).toEqual([]);
  });

  it('refuses an approval for a call that is not waiting', async () => {
    const driver = new ScriptedDriver([]);
    const {engine} = engineFor(driver);
    await expect(
      (async () => {
        for await (const _ of engine.approve({
          sessionId: 's1',
          callId: 'nope',
          confirmed: true,
          harness: harness(),
        })) {
          // drain
        }
      })(),
    ).rejects.toBeInstanceOf(GateNotFoundError);
  });

  it('stops a running turn and answers its dangling call', async () => {
    let announce!: () => void;
    const started = new Promise<void>((resolve) => {
      announce = resolve;
    });
    const driver: TurnDriver = {
      async *run(input) {
        yield {type: 'step'};
        yield {
          type: 'tool.call',
          callId: 'call-1',
          tool: 'read_file',
          args: {path: 'a.md'},
        };
        announce();
        await new Promise<void>((resolve) => {
          if (input.signal.aborted) {
            resolve();
            return;
          }
          input.signal.addEventListener('abort', () => resolve(), {once: true});
        });
      },
      async *resume() {
        // unused
      },
    };
    const {engine, store} = engineFor(driver);
    const updates: EngineUpdate[] = [];
    const running = (async () => {
      for await (const update of engine.run({
        sessionId: 's1',
        profileId: 'writer',
        text: 'Read it',
        harness: harness(),
      })) {
        updates.push(update);
      }
    })();
    await started;
    expect(engine.abort('s1')).toBe(true);
    await running;

    const events = await store.read('s1');
    expect(events.map((event) => event.type)).toEqual([
      'session.created',
      'user.message',
      'turn.started',
      'tool.call',
      'tool.result',
      'turn.aborted',
    ]);
    expect(events.find((event) => event.type === 'tool.result')).toMatchObject({
      synthetic: true,
      ok: false,
    });
    expect(engine.isRunning('s1')).toBe(false);
  });

  it('fails a turn that exceeds its step budget', async () => {
    const driver = new ScriptedDriver([
      [
        {type: 'step'},
        {type: 'step'},
        {type: 'message', text: 'Too late.'},
        {type: 'done'},
      ],
    ]);
    const {engine, store} = engineFor(driver);
    const spec = resolveHarness({
      profile: {...profile, harness: {tools: {budgets: {maxSteps: 1}}}},
      app,
      version: 1,
    });
    await collect(
      engine.run({
        sessionId: 's1',
        profileId: 'writer',
        text: 'Go',
        harness: spec,
      }),
    );
    const events = await store.read('s1');
    const failed = events.find((event) => event.type === 'turn.failed');
    expect(failed).toMatchObject({code: 'steps'});
    expect(events.map((event) => event.type)).not.toContain('turn.completed');
  });

  it('fails a turn that produced no visible reply', async () => {
    const driver = new ScriptedDriver([
      [
        {type: 'step'},
        {type: 'reasoning', text: 'thinking', partial: true},
        {type: 'done'},
      ],
    ]);
    const {engine, store} = engineFor(driver);
    await collect(
      engine.run({
        sessionId: 's1',
        profileId: 'writer',
        text: 'Hello',
        harness: harness(),
      }),
    );
    const events = await store.read('s1');
    expect(events.find((event) => event.type === 'turn.failed')).toMatchObject({
      code: 'silent',
    });
  });

  it('answers a tool call the driver never answered', async () => {
    const driver = new ScriptedDriver([
      [
        {type: 'step'},
        {
          type: 'tool.call',
          callId: 'call-1',
          tool: 'read_file',
          args: {path: 'a.md'},
        },
        {type: 'message', text: 'I looked.'},
        {type: 'done'},
      ],
    ]);
    const {engine, store} = engineFor(driver);
    await collect(
      engine.run({
        sessionId: 's1',
        profileId: 'writer',
        text: 'Read it',
        harness: harness(),
      }),
    );
    const events = await store.read('s1');
    expect(events.find((event) => event.type === 'tool.result')).toMatchObject({
      callId: 'call-1',
      synthetic: true,
      ok: false,
    });
    expect(events.map((event) => event.type)).toContain('turn.completed');
  });

  it('refuses a concurrent turn while one is streaming', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let announce!: () => void;
    const started = new Promise<void>((resolve) => {
      announce = resolve;
    });
    const driver: TurnDriver = {
      async *run() {
        yield {type: 'step'};
        announce();
        await gate;
        yield {type: 'message', text: 'Done.'};
      },
      async *resume() {
        // unused
      },
    };
    const {engine} = engineFor(driver);
    const running = (async () => {
      for await (const _ of engine.run({
        sessionId: 's1',
        profileId: 'writer',
        text: 'One',
        harness: harness(),
      })) {
        // drain
      }
    })();
    await started;
    await expect(
      (async () => {
        for await (const _ of engine.run({
          sessionId: 's1',
          profileId: 'writer',
          text: 'Two',
          harness: harness(),
        })) {
          // drain
        }
      })(),
    ).rejects.toBeInstanceOf(TurnBusyError);
    release();
    await running;
  });

  it('keeps events of two conversations independent', async () => {
    const driver = new ScriptedDriver([
      [{type: 'step'}, {type: 'message', text: 'One'}, {type: 'done'}],
      [{type: 'step'}, {type: 'message', text: 'Two'}, {type: 'done'}],
    ]);
    const {engine, store} = engineFor(driver);
    await collect(
      engine.run({
        sessionId: 's1',
        profileId: 'writer',
        text: 'First',
        harness: harness(),
      }),
    );
    await collect(
      engine.run({
        sessionId: 's2',
        profileId: 'writer',
        text: 'Second',
        harness: harness(),
      }),
    );
    const first = await store.read('s1');
    const second = await store.read('s2');
    expect(first.every((event) => event.sessionId === 's1')).toBe(true);
    expect(second.every((event) => event.sessionId === 's2')).toBe(true);
  });
});
