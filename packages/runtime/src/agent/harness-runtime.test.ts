import {mkdtemp, rm} from 'node:fs/promises';
import {join} from 'node:path';

import {afterEach, describe, expect, it} from 'vitest';

import {
  MemoryEventStore,
  type DriverEvent,
  type DriverResume,
  type DriverRun,
  type TurnDriver,
} from '@marimo/agent';
import type {AgentUiEvent} from '@marimo/protocol';

import {ProfileStore} from '../profiles.js';
import {SettingsStore} from '../settings.js';
import {WorkspaceStore} from '../workspaces.js';
import {HarnessRuntime} from './harness-runtime.js';

const roots: string[] = [];

async function root(): Promise<string> {
  const dir = await mkdtemp(join(process.cwd(), '.marimo-harness-runtime-'));
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

class ScriptedDriver implements TurnDriver {
  readonly runs: DriverEvent[][];
  readonly resumes: DriverEvent[][];
  runCalls = 0;
  resumeCalls = 0;

  constructor(runs: DriverEvent[][], resumes: DriverEvent[][] = []) {
    this.runs = runs;
    this.resumes = resumes;
  }

  async *run(_input: DriverRun): AsyncIterable<DriverEvent> {
    this.runCalls += 1;
    for (const event of this.runs.shift() ?? []) {
      yield event;
    }
  }

  async *resume(_input: DriverResume): AsyncIterable<DriverEvent> {
    this.resumeCalls += 1;
    for (const event of this.resumes.shift() ?? []) {
      yield event;
    }
  }
}

interface RuntimeDeps {
  paths: ReturnType<typeof import('../paths.js').resolveAppPaths>;
  settings: SettingsStore;
  profiles: ProfileStore;
  workspaces: WorkspaceStore;
  store: MemoryEventStore;
  readSecret: () => Promise<{state: 'present'; value: string}>;
  now: () => Date;
  createId: () => string;
}

async function setup(): Promise<{deps: RuntimeDeps; profileId: string}> {
  const dir = await root();
  const paths = (await import('../paths.js')).resolveAppPaths(dir);
  const settings = new SettingsStore(paths.settings);
  const profiles = new ProfileStore({
    file: paths.profiles,
    defaultRole: 'Help the person.',
    defaultPersona: 'Dry and direct.',
    defaultTools: ['current_time'],
    defaultSkills: [],
  });
  const profileFile = await profiles.load();
  const workspaces = new WorkspaceStore({
    file: paths.workspaces,
    defaultWorkspaceRoot: join(dir, 'space'),
  });
  await workspaces.load();
  let counter = 0;
  return {
    deps: {
      paths,
      settings,
      profiles,
      workspaces,
      store: new MemoryEventStore(),
      readSecret: async () => ({state: 'present', value: 'test-key'}),
      now: () => new Date('2026-01-01T00:00:00.000Z'),
      createId: () => `id-${(counter += 1)}`,
    },
    profileId: profileFile.activeProfileId,
  };
}

function runtimeFrom(
  deps: RuntimeDeps,
  driverFactory: () => TurnDriver,
): HarnessRuntime {
  return new HarnessRuntime({
    ...deps,
    driverFactory,
  });
}

async function runtimeFor(
  driver: TurnDriver,
): Promise<{runtime: HarnessRuntime; profileId: string}> {
  const {deps, profileId} = await setup();
  return {runtime: runtimeFrom(deps, () => driver), profileId};
}

async function collect(
  stream: AsyncIterable<AgentUiEvent>,
): Promise<AgentUiEvent[]> {
  const events: AgentUiEvent[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

describe('HarnessRuntime', () => {
  it('runs a turn and projects it to the window events', async () => {
    const driver = new ScriptedDriver([
      [
        {type: 'step'},
        {type: 'text', text: 'Hel', partial: true},
        {type: 'text', text: 'lo', partial: true},
        {type: 'message', text: 'Hello'},
        {type: 'done'},
      ],
    ]);
    const {runtime, profileId} = await runtimeFor(driver);
    const events = await collect(runtime.run(profileId, 's1', 'Hi'));
    expect(events.map((event) => event.type)).toEqual([
      'turn.started',
      'text.delta',
      'text.delta',
      'turn.completed',
      'session.changed',
    ]);
    expect(
      events
        .filter((event) => event.type === 'text.delta')
        .map((event) => (event.type === 'text.delta' ? event.text : ''))
        .join(''),
    ).toBe('Hello');

    const transcript = await runtime.transcript('s1');
    expect(transcript).toHaveLength(2);
    expect(transcript[0]).toMatchObject({role: 'user', text: 'Hi'});
    expect(transcript[1]).toMatchObject({role: 'assistant', text: 'Hello'});
  });

  it('refuses to read a conversation as another bot', async () => {
    const driver = new ScriptedDriver([
      [{type: 'step'}, {type: 'message', text: 'Hello'}, {type: 'done'}],
    ]);
    const {runtime, profileId} = await runtimeFor(driver);
    await collect(runtime.run(profileId, 's1', 'Hi'));
    await expect(runtime.transcript('s1', 'somebody-else')).rejects.toThrow(
      /another bot/,
    );
  });

  it('reports a missing profile as a failed turn rather than throwing', async () => {
    const driver = new ScriptedDriver([]);
    const {runtime} = await runtimeFor(driver);
    const events = await collect(runtime.run('missing', 's1', 'Hi'));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({type: 'turn.failed'});
  });

  it('asks for approval and resumes the call when it is decided', async () => {
    const driver = new ScriptedDriver(
      [
        [
          {type: 'step'},
          {type: 'message', text: 'I can write that.'},
          {
            type: 'approval.request',
            callId: 'call_1',
            confirmationId: 'confirm_1',
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
            callId: 'call_1',
            tool: 'write_file',
            ok: true,
            result: 'wrote a.md',
          },
          {type: 'message', text: 'Done.'},
          {type: 'done'},
        ],
      ],
    );
    const {runtime, profileId} = await runtimeFor(driver);
    await collect(runtime.run(profileId, 's1', 'Write a.md'));

    const gates = await runtime.pendingGates('s1');
    expect(gates).toHaveLength(1);
    expect(gates[0]).toMatchObject({
      callId: 'call_1',
      tool: 'write_file',
      hint: 'Replace a.md',
    });

    const resumed = await collect(
      runtime.approve(profileId, {
        sessionId: 's1',
        callId: 'call_1',
        confirmed: true,
      }),
    );
    expect(driver.resumeCalls).toBe(1);
    expect(resumed.map((event) => event.type)).toEqual([
      'tool.finished',
      'text.delta',
      'turn.completed',
      'session.changed',
    ]);
    expect(await runtime.pendingGates('s1')).toEqual([]);
  });

  it('records a denial as a failed tool result and clears the card', async () => {
    const driver = new ScriptedDriver(
      [
        [
          {type: 'step'},
          {
            type: 'approval.request',
            callId: 'call_1',
            confirmationId: 'confirm_1',
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
            callId: 'call_1',
            tool: 'write_file',
            ok: false,
            result: 'The tool call was rejected.',
          },
          {type: 'message', text: 'I did not replace it.'},
          {type: 'done'},
        ],
      ],
    );
    const {runtime, profileId} = await runtimeFor(driver);
    await collect(runtime.run(profileId, 's1', 'Write a.md'));
    const resumed = await collect(
      runtime.approve(profileId, {
        sessionId: 's1',
        callId: 'call_1',
        confirmed: false,
      }),
    );
    expect(resumed.find((event) => event.type === 'tool.finished')).toMatchObject({
      ok: false,
    });
    expect(await runtime.pendingGates('s1')).toEqual([]);
  });

  it('keeps a pending card across a restart and resumes it', async () => {
    const gateDriver = new ScriptedDriver([
      [
        {type: 'step'},
        {type: 'message', text: 'I need to write.'},
        {
          type: 'approval.request',
          callId: 'call_1',
          confirmationId: 'confirm_1',
          tool: 'write_file',
          args: {path: 'a.md'},
          hint: 'Replace a.md',
        },
        {type: 'done'},
      ],
    ]);
    const {deps, profileId} = await setup();
    const first = runtimeFrom(deps, () => gateDriver);
    await collect(first.run(profileId, 's1', 'Write a.md'));
    first.dispose();

    const resumeDriver = new ScriptedDriver(
      [],
      [
        [
          {type: 'step'},
          {
            type: 'tool.result',
            callId: 'call_1',
            tool: 'write_file',
            ok: true,
            result: 'wrote a.md',
          },
          {type: 'message', text: 'Done.'},
          {type: 'done'},
        ],
      ],
    );
    const second = runtimeFrom(deps, () => resumeDriver);
    expect(await second.pendingGates('s1')).toHaveLength(1);
    await collect(
      second.approve(profileId, {
        sessionId: 's1',
        callId: 'call_1',
        confirmed: true,
      }),
    );
    expect(resumeDriver.resumeCalls).toBe(1);
    expect(await second.pendingGates('s1')).toEqual([]);
  });

  it('runs two conversations at once', async () => {
    let started = 0;
    let release!: () => void;
    const both = new Promise<void>((resolve) => {
      release = resolve;
    });
    const factory = (): TurnDriver => ({
      async *run() {
        started += 1;
        if (started === 2) {
          release();
        }
        await both;
        yield {type: 'message', text: 'done'};
      },
      async *resume() {
        // unused
      },
    });
    const {deps, profileId} = await setup();
    const runtime = runtimeFrom(deps, factory);
    const first = collect(runtime.run(profileId, 's1', 'one'));
    const second = collect(runtime.run(profileId, 's2', 'two'));
    await both;
    const [one, two] = await Promise.all([first, second]);
    expect(started).toBe(2);
    expect(one.map((event) => event.type)).toContain('turn.completed');
    expect(two.map((event) => event.type)).toContain('turn.completed');
  });

  it('stops a turn through the facade', async () => {
    let announce!: () => void;
    const started = new Promise<void>((resolve) => {
      announce = resolve;
    });
    const driver: TurnDriver = {
      async *run(input) {
        yield {type: 'step'};
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
    const {runtime, profileId} = await runtimeFor(driver);
    const collecting = (async () => {
      for await (const _ of runtime.run(profileId, 's1', 'Wait')) {
        // drain
      }
    })();
    await started;
    expect(runtime.abort('s1')).toBe(true);
    await collecting;
    const events = await runtime.transcript('s1');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({role: 'user', text: 'Wait'});
  });
});
