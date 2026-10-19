import {mkdtemp, rm} from 'node:fs/promises';
import {join} from 'node:path';

import {afterEach, describe, expect, it} from 'vitest';

import {
  MemoryEventStore,
  MemoryStore,
  resolveHarness,
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
import {HarnessVersionStore} from '../harness-versions.js';

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
  reviewer?: (prompt: string) => Promise<string>,
  answerer?: (prompt: string) => Promise<string>,
): HarnessRuntime {
  return new HarnessRuntime({
    ...deps,
    driverFactory,
    versions: new HarnessVersionStore({
      rootDir: deps.paths.harnessVersions,
    }),
    ...(reviewer === undefined ? {} : {reviewer}),
    ...(answerer === undefined ? {} : {answerer}),
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

  it('lets an addressed participant answer in the same conversation', async () => {
    const driver = new ScriptedDriver([
      [
        {type: 'step'},
        {type: 'message', text: 'The reader answers.'},
        {type: 'done'},
      ],
    ]);
    const {deps, profileId} = await setup();
    const other = await deps.profiles.create({
      name: 'Reader',
      role: (name) => `You are ${name}.`,
      tools: ['current_time'],
    });
    const runtime = runtimeFrom(deps, () => driver);
    const members = await runtime.setParticipants(profileId, 's1', [
      profileId,
      other.id,
    ]);
    expect(members).toEqual([profileId, other.id]);

    await collect(runtime.run(profileId, 's1', 'Reader, look.', other.id));
    const transcript = await runtime.transcript('s1', profileId);
    expect(
      transcript.find((message) => message.role === 'assistant'),
    ).toMatchObject({
      text: 'The reader answers.',
      agentId: other.id,
    });
  });

  it('refuses an address for an agent that is not in the conversation', async () => {
    const driver = new ScriptedDriver([]);
    const {deps, profileId} = await setup();
    const other = await deps.profiles.create({
      name: 'Reader',
      role: (name) => `You are ${name}.`,
      tools: ['current_time'],
    });
    const runtime = runtimeFrom(deps, () => driver);
    await collect(runtime.run(profileId, 's1', 'Hello'));
    const events = await collect(
      runtime.run(profileId, 's1', 'Reader?', other.id),
    );
    expect(events[0]).toMatchObject({type: 'turn.failed'});
    expect(
      String(events[0]?.type === 'turn.failed' ? events[0].message : ''),
    ).toContain('not in this conversation');
  });

  it('answers the sidebar with a v2 title, count and membership', async () => {
    const driver = new ScriptedDriver([
      [{type: 'step'}, {type: 'message', text: 'Hello'}, {type: 'done'}],
    ]);
    const {deps, profileId} = await setup();
    const other = await deps.profiles.create({
      name: 'Reader',
      role: (name) => `You are ${name}.`,
      tools: [],
    });
    const runtime = runtimeFrom(deps, () => driver);
    await runtime.setParticipants(profileId, 's1', [profileId, other.id]);
    await collect(runtime.run(profileId, 's1', 'A first question'));

    expect(await runtime.sessionInfo('s1')).toMatchObject({
      title: 'A first question',
      messageCount: 1,
      agentIds: [profileId, other.id],
    });
  });

  it('renames and deletes a v2 conversation', async () => {
    const driver = new ScriptedDriver([
      [{type: 'step'}, {type: 'message', text: 'Hello'}, {type: 'done'}],
    ]);
    const {runtime, profileId} = await runtimeFor(driver);
    await collect(runtime.run(profileId, 's1', 'A first question'));
    await runtime.renameSession(profileId, 's1', 'A better title');
    expect(await runtime.sessionInfo('s1')).toMatchObject({
      title: 'A better title',
    });

    await runtime.deleteSession(profileId, 's1');
    expect(await runtime.hasLog('s1')).toBe(false);
    expect(await runtime.transcript('s1')).toEqual([]);
  });

  it('runs a conversation on its own model when it has one', async () => {
    const driver = new ScriptedDriver([
      [{type: 'step'}, {type: 'message', text: 'Hello'}, {type: 'done'}],
    ]);
    let seen: {provider: string; model: string} | undefined;
    const {deps, profileId} = await setup();
    const runtime = new HarnessRuntime({
      ...deps,
      driverFactory: (config) => {
        seen = {provider: config.provider, model: config.model};
        return driver;
      },
    });
    await runtime.setSessionModel(profileId, 's1', {
      provider: 'gemini',
      model: 'gemini-flash',
    });
    await collect(runtime.run(profileId, 's1', 'Hello'));
    expect(seen).toEqual({provider: 'gemini', model: 'gemini-flash'});
  });

  it('asks another bot with its own instructions and memory', async () => {
    const {deps, profileId} = await setup();
    const other = await deps.profiles.create({
      name: 'Reader',
      role: (name) => `You are ${name}.`,
      tools: [],
    });
    let seen = '';
    const runtime = runtimeFrom(
      deps,
      () => new ScriptedDriver([]),
      undefined,
      async (prompt) => {
        seen = prompt;
        return 'Tabs are better.';
      },
    );
    const answer = await runtime.askAgent(profileId, 'Reader', 'Tabs or spaces?');
    expect(answer).toEqual({ok: true, result: 'Tabs are better.'});
    expect(seen).toContain('You are Reader.');
    expect(seen).toContain('Tabs or spaces?');

    const missing = await runtime.askAgent(profileId, 'Nobody', 'Hello?');
    expect(missing.ok).toBe(false);
    expect(missing.result).toContain('Nobody');
    expect(other.id).not.toBe(profileId);
  });

  it('records the harness a turn ran under', async () => {
    const driver = new ScriptedDriver([
      [{type: 'step'}, {type: 'message', text: 'Hello'}, {type: 'done'}],
    ]);
    const {deps, profileId} = await setup();
    const runtime = runtimeFrom(deps, () => driver);
    await collect(runtime.run(profileId, 's1', 'Hello'));
    const records = await new HarnessVersionStore({
      rootDir: deps.paths.harnessVersions,
    }).list();
    expect(records).toHaveLength(1);
    expect(records[0]?.spec.id).toBe(profileId);
    expect(records[0]?.spec.version).toBe(1);
  });

  it('counts conversations, turns and the usage the provider reported', async () => {
    const driver = new ScriptedDriver([
      [
        {type: 'step'},
        {type: 'message', text: 'One'},
        {type: 'usage', usage: {promptTokens: 10, completionTokens: 4, totalTokens: 14}},
        {type: 'done'},
      ],
      [
        {type: 'step'},
        {type: 'message', text: 'Two'},
        {type: 'usage', usage: {promptTokens: 20, completionTokens: 6, totalTokens: 26}},
        {type: 'done'},
      ],
    ]);
    const {deps, profileId} = await setup();
    const runtime = runtimeFrom(deps, () => driver);
    await collect(runtime.run(profileId, 's1', 'First'));
    await collect(runtime.run(profileId, 's2', 'Second'));

    const report = await runtime.report(profileId);
    expect(report.conversations.v2).toBe(2);
    expect(report.turns).toBe(2);
    expect(report.usage).toEqual({
      promptTokens: 30,
      completionTokens: 10,
      totalTokens: 40,
    });
    expect(report.harnessVersions).toBe(1);
    expect(report.versions).toHaveLength(1);
    expect(report.versions[0]?.hash).toBeTruthy();
    expect(report.pendingProposals).toBe(0);
    expect(report.dismissedProposals).toBe(0);
    expect(report.reviewedConversations).toBe(0);
    expect(report.skillVersions).toBe(0);
    expect(report.unreadableLogs).toBe(0);
    expect(report.outcomes).toEqual({
      completed: 2,
      failed: 0,
      aborted: 0,
      toolCalls: 0,
      toolErrors: 0,
      steps: 2,
      approvals: 0,
      corrections: 0,
    });
    expect(report.paths.harnessSessions).toContain('harness');
  });

  it('gives a changed harness a new chained version', async () => {
    const driver = new ScriptedDriver([
      [{type: 'step'}, {type: 'message', text: 'One'}, {type: 'done'}],
      [{type: 'step'}, {type: 'message', text: 'Two'}, {type: 'done'}],
    ]);
    const {deps, profileId} = await setup();
    const runtime = runtimeFrom(deps, () => driver);
    await collect(runtime.run(profileId, 's1', 'First'));
    await deps.profiles.update(profileId, {name: 'Renamed'});
    await collect(runtime.run(profileId, 's1', 'Second'));

    const report = await runtime.report(profileId);
    expect(report.harnessVersions).toBe(2);
    expect(report.versions.map((version) => version.harnessVersion)).toEqual([
      2, 1,
    ]);
    const started = (await deps.store.read('s1')).filter(
      (event) => event.type === 'turn.started',
    );
    expect(started.map((event) => event.harnessVersion)).toEqual([1, 2]);
  });

  it('answers one conversation’s usage from its own log', async () => {
    const driver = new ScriptedDriver([
      [
        {type: 'step'},
        {type: 'message', text: 'One'},
        {type: 'usage', usage: {promptTokens: 7, completionTokens: 3, totalTokens: 10}},
        {type: 'done'},
      ],
    ]);
    const {deps, profileId} = await setup();
    const runtime = runtimeFrom(deps, () => driver);
    await collect(runtime.run(profileId, 's1', 'First'));
    expect(await runtime.sessionUsage(profileId, 's1')).toEqual({
      turns: 1,
      usage: {promptTokens: 7, completionTokens: 3, totalTokens: 10},
    });
  });

  it('starts a task in its own conversation and returns immediately', async () => {
    const driver = new ScriptedDriver([
      [{type: 'step'}, {type: 'message', text: 'Starting.'}, {type: 'done'}],
      [{type: 'step'}, {type: 'message', text: 'The task is done.'}, {type: 'done'}],
    ]);
    const {deps, profileId} = await setup();
    const other = await deps.profiles.create({
      name: 'Reader',
      role: (name) => `You are ${name}.`,
      tools: ['current_time'],
    });
    let openedFor = '';
    const runtime = new HarnessRuntime({
      ...deps,
      driverFactory: () => driver,
      createSession: async (targetId, title) => {
        openedFor = targetId;
        return {id: 'task-1', title};
      },
    });
    await collect(runtime.run(profileId, 's1', 'Start.'));
    const started = await runtime.startTask(
      profileId,
      'Reader',
      'Read the folder.',
      's1',
    );
    expect(started.ok).toBe(true);
    expect(started.result).toContain('Read the folder.');
    expect(openedFor).toBe(other.id);

    let posted = '';
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const transcript = await runtime.transcript('s1', profileId);
      posted =
        transcript.find(
          (message) => message.agentId === other.id,
        )?.text ?? '';
      if (posted.length > 0) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(posted).toBe('The task is done.');
  });

  it('restores identity, grants and model from a recorded harness', async () => {
    const {deps, profileId} = await setup();
    const versions = new HarnessVersionStore({
      rootDir: deps.paths.harnessVersions,
    });
    const snapshot = resolveHarness({
      profile: {
        id: profileId,
        name: 'Old Name',
        role: 'Old role.',
        persona: 'Old persona.',
        enabledTools: ['current_time', 'read_file'],
        enabledSkills: ['triage'],
      },
      app: {
        model: {provider: 'gemini', model: 'gemini-flash'},
        allowPrivateNetworkFetch: false,
        learning: {mode: 'propose', retainTraces: false},
      },
      version: 4,
      workspaceRoot: deps.paths.harnessSessions,
    });
    const recorded = await versions.record(snapshot);
    await deps.profiles.update(profileId, {
      name: 'New Name',
      identity: 'New role.',
      persona: 'New persona.',
      enabledTools: [],
      enabledSkills: [],
    });
    const runtime = runtimeFrom(deps, () => new ScriptedDriver([]));
    await runtime.restoreHarness(profileId, recorded.record.hash);

    const profile = (await deps.profiles.profiles()).find(
      (entry) => entry.id === profileId,
    );
    expect(profile).toMatchObject({
      name: 'Old Name',
      identity: 'Old role.',
      persona: 'Old persona.',
      enabledTools: ['current_time', 'read_file'],
      enabledSkills: ['triage'],
      model: {provider: 'gemini', model: 'gemini-flash'},
    });
  });

  it('refuses a harness recorded for another bot', async () => {
    const {deps, profileId} = await setup();
    const versions = new HarnessVersionStore({
      rootDir: deps.paths.harnessVersions,
    });
    const other = resolveHarness({
      profile: {
        id: 'someone-else',
        name: 'Other',
        role: 'Other.',
        enabledTools: [],
        enabledSkills: [],
      },
      app: {
        model: {provider: 'deepseek', model: 'deepseek-chat'},
        allowPrivateNetworkFetch: false,
        learning: {mode: 'propose', retainTraces: false},
      },
      version: 1,
    });
    const recorded = await versions.record(other);
    const runtime = runtimeFrom(deps, () => new ScriptedDriver([]));
    await expect(
      runtime.restoreHarness(profileId, recorded.record.hash),
    ).rejects.toThrow('does not belong');
  });

  it('compacts a v2 conversation into a summary that covers the old events', async () => {
    const driver = new ScriptedDriver([
      [{type: 'step'}, {type: 'message', text: 'First answer.'}, {type: 'done'}],
      [{type: 'step'}, {type: 'message', text: 'Second answer.'}, {type: 'done'}],
    ]);
    const {deps, profileId} = await setup();
    const runtime = runtimeFrom(
      deps,
      () => driver,
      undefined,
      async () => 'They discussed two questions.',
    );
    await collect(runtime.run(profileId, 's1', 'First question.'));
    await collect(runtime.run(profileId, 's1', 'Second question.'));

    const result = await runtime.compactSession(profileId, 's1');
    expect(result).toEqual({compacted: true});
    const events = await deps.store.read('s1');
    const summary = events.find((event) => event.type === 'summary');
    expect(summary).toMatchObject({
      type: 'summary',
      text: 'They discussed two questions.',
      coversThrough: events.at(-2)?.id,
    });
    expect(await runtime.transcript('s1', profileId)).toHaveLength(4);
  });

  it('gives the recall indexer a v2 conversation', async () => {
    const driver = new ScriptedDriver([
      [{type: 'step'}, {type: 'message', text: 'Hi there.'}, {type: 'done'}],
    ]);
    const {deps, profileId} = await setup();
    const runtime = runtimeFrom(deps, () => driver);
    await collect(runtime.run(profileId, 's1', 'Hello.'));
    const conversation = await runtime.conversationFor(profileId, 's1');
    expect(conversation.title).toBe('Hello.');
    expect(conversation.events).toHaveLength(2);
    expect(conversation.events[0]).toMatchObject({
      author: 'user',
      content: {parts: [{text: 'Hello.'}]},
    });
    expect(conversation.events[1]?.author).toBe('Marimo Bot');
    expect(conversation.events[1]?.content.parts[0]?.text).toBe('Hi there.');
  });

  it('keeps a builder session’s purpose in its own log', async () => {
    const driver = new ScriptedDriver([
      [{type: 'step'}, {type: 'message', text: 'What should it do?'}, {type: 'done'}],
    ]);
    const {deps, profileId} = await setup();
    const runtime = runtimeFrom(deps, () => driver);
    await collect(
      runtime.run(
        profileId,
        'builder-1',
        'Make me a bot.',
        undefined,
        'Builder instruction.',
        'bot-builder',
      ),
    );
    expect(await runtime.sessionInfo('builder-1')).toMatchObject({
      purpose: 'bot-builder',
    });
  });

  it('proposes a memory from a conversation and remembers it was read', async () => {
    const driver = new ScriptedDriver([
      [
        {type: 'step'},
        {type: 'message', text: 'I will remember that.'},
        {type: 'done'},
      ],
    ]);
    const reviewer = async (): Promise<string> =>
      JSON.stringify({
        proposals: [
          {
            section: 'Preferences and tone',
            text: '- prefers tabs',
            reason: 'They said so.',
            replaces: '',
          },
        ],
      });
    const {deps, profileId} = await setup();
    const runtime = runtimeFrom(deps, () => driver, reviewer);
    await collect(runtime.run(profileId, 's1', 'I prefer tabs.'));

    const first = await runtime.reviewMemory('s1');
    expect(first.proposals).toHaveLength(1);
    expect(first.proposals[0]).toMatchObject({
      section: 'Preferences and tone',
      text: '- prefers tabs',
      profileId,
    });

    const second = await runtime.reviewMemory('s1');
    expect(second.proposals).toEqual([]);
    expect(second.events).toBe(0);

    const proposed = first.proposals[0];
    if (proposed === undefined) {
      throw new Error('expected a proposal');
    }
    const accepted = await runtime.resolveMemoryProposal(proposed.id, true);
    expect(accepted).toMatchObject({ok: true});
    const active = await deps.workspaces.active();
    if (active === undefined) {
      throw new Error('expected a workspace');
    }
    const memory = new MemoryStore({
      workspaceRoot: active.path,
      personMemoryRoot: deps.paths.personMemoryDir,
      profileId,
    });
    expect(await memory.read()).toContain('prefers tabs');
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
    expect(
      resumed.find((event) => event.type === 'tool.finished'),
    ).toMatchObject({
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
