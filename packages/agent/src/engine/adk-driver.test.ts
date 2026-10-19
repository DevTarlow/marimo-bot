import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';

import {BaseLlm} from '@google/adk';
import type {LlmRequest, LlmResponse} from '@google/adk';
import {afterEach, describe, expect, it} from 'vitest';

import {MemoryStore} from '../memory/memory-store.js';
import {resolveHarness} from '../harness/resolve.js';
import type {
  HarnessAppDefaults,
  HarnessProfile,
  HarnessSpec,
} from '../harness/spec.js';
import {AdkDriver, type HelperTarget} from './adk-driver.js';
import type {DriverEvent} from './driver.js';
import type {SessionEvent} from './events.js';

const app: HarnessAppDefaults = {
  model: {provider: 'deepseek', model: 'deepseek-chat'},
  allowPrivateNetworkFetch: false,
  learning: {mode: 'propose', retainTraces: false},
};

const profile: HarnessProfile = {
  id: 'writer',
  name: 'Writer',
  role: 'Write for the person.',
  enabledTools: [
    'current_time',
    'read_file',
    'list_dir',
    'write_file',
    'run_shell',
  ],
  enabledSkills: [],
};

class ScriptedLlm extends BaseLlm {
  readonly requests: LlmRequest[] = [];
  private readonly scripts: Array<LlmResponse[]>;

  constructor(scripts: LlmResponse[][]) {
    super({model: 'scripted'});
    this.scripts = scripts;
  }

  async *generateContentAsync(
    request: LlmRequest,
    _stream?: boolean,
  ): AsyncGenerator<LlmResponse> {
    this.requests.push(request);
    for (const response of this.scripts.shift() ?? []) {
      yield response;
    }
  }

  async connect(): Promise<never> {
    throw new Error('The scripted model has no live connection.');
  }
}

function text(value: string): LlmResponse {
  return {
    content: {role: 'model', parts: [{text: value}]},
    turnComplete: true,
  };
}

function call(
  name: string,
  args: Record<string, unknown>,
  id = 'call_1',
): LlmResponse {
  return {
    content: {
      role: 'model',
      parts: [{functionCall: {id, name, args}}],
    },
    turnComplete: true,
  };
}

async function collect(
  stream: AsyncIterable<DriverEvent>,
): Promise<DriverEvent[]> {
  const events: DriverEvent[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

const roots: string[] = [];

async function workDir(): Promise<string> {
  const dir = await mkdtemp(join(process.cwd(), '.marimo-adk-driver-'));
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

function harness(workspaceRoot?: string, grants?: string[]): HarnessSpec {
  return resolveHarness({
    profile:
      grants === undefined ? profile : {...profile, enabledTools: grants},
    app,
    version: 1,
    ...(workspaceRoot === undefined ? {} : {workspaceRoot}),
  });
}

function userMessage(turnId: string, text: string): SessionEvent {
  return {
    id: `u-${turnId}`,
    sessionId: 's1',
    at: '2026-01-01T00:00:00.000Z',
    turnId,
    type: 'user.message',
    text,
  };
}

function toolCall(
  turnId: string,
  callId: string,
  tool: string,
  args: Record<string, unknown>,
): SessionEvent {
  return {
    id: `c-${callId}`,
    sessionId: 's1',
    at: '2026-01-01T00:00:00.000Z',
    turnId,
    type: 'tool.call',
    callId,
    tool,
    args,
    author: 'Writer',
  };
}

function gate(
  turnId: string,
  callId: string,
  confirmationId: string,
  tool: string,
  args: Record<string, unknown>,
): SessionEvent {
  return {
    id: `g-${callId}`,
    sessionId: 's1',
    at: '2026-01-01T00:00:00.000Z',
    turnId,
    type: 'approval.requested',
    callId,
    confirmationId,
    tool,
    args,
    author: 'Writer',
  };
}

function decision(
  turnId: string,
  callId: string,
  confirmationId: string,
): SessionEvent {
  return {
    id: `d-${callId}`,
    sessionId: 's1',
    at: '2026-01-01T00:00:00.000Z',
    turnId,
    type: 'approval.decided',
    callId,
    confirmationId,
    confirmed: true,
  };
}

function history(...events: SessionEvent[]): SessionEvent[] {
  return events;
}

describe('AdkDriver', () => {
  it('streams a text reply and records one step', async () => {
    const model = new ScriptedLlm([[text('Hello.')]]);
    const driver = new AdkDriver({resolveModel: () => model});
    const updates = await collect(
      driver.run({
        sessionId: 's1',
        turnId: 't1',
        profileId: 'writer',
        text: 'Hi',
        harness: harness(),
        history: [],
        signal: new AbortController().signal,
      }),
    );
    expect(updates.map((update) => update.type)).toEqual(['step', 'message']);
    expect(updates.find((update) => update.type === 'message')).toMatchObject({
      text: 'Hello.',
    });
    expect(model.requests).toHaveLength(1);
  });

  /*
   * A connector's tools are part of the same offer, not a second menu. The
   * caller that owns the connection supplies them, and the driver's only job is
   * to put them beside the built-ins and answer a call to one.
   */
  it('offers a connector tool beside the built-ins and runs it', async () => {
    const model = new ScriptedLlm([
      [call('mcp_notes_search', {q: 'x'})],
      [text('Found it.')],
    ]);
    const calls: unknown[] = [];
    const driver = new AdkDriver({
      resolveModel: () => model,
      mcpTools: () => [
        {
          name: 'mcp_notes_search',
          description: 'Search the notes connector.',
          parameters: {} as never,
          gate: 'never',
          execute: async (args) => {
            calls.push(args);
            return {ok: true, result: 'a note'};
          },
        },
      ],
    });
    const updates = await collect(
      driver.run({
        sessionId: 's1',
        turnId: 't1',
        profileId: 'writer',
        text: 'Search the notes.',
        harness: harness(),
        history: [],
        signal: new AbortController().signal,
      }),
    );

    expect(model.requests[0]?.toolsDict).toHaveProperty('mcp_notes_search');
    expect(calls).toEqual([{q: 'x'}]);
    expect(
      updates.find((update) => update.type === 'tool.result'),
    ).toMatchObject({ok: true});
  });

  it('runs a non-gated tool and feeds its result back to the model', async () => {
    const model = new ScriptedLlm([
      [call('current_time', {})],
      [text('It is now.')],
    ]);
    const driver = new AdkDriver({resolveModel: () => model});
    const updates = await collect(
      driver.run({
        sessionId: 's1',
        turnId: 't1',
        profileId: 'writer',
        text: 'What time is it?',
        harness: harness(),
        history: [],
        signal: new AbortController().signal,
      }),
    );
    const types = updates.map((update) => update.type);
    expect(types).toContain('tool.call');
    expect(types).toContain('tool.result');
    expect(types).toContain('message');
    const result = updates.find((update) => update.type === 'tool.result');
    expect(result).toMatchObject({ok: true});
    expect(model.requests).toHaveLength(2);
  });

  it('offers a memory tool only when the turn has a memory store', async () => {
    const dir = await workDir();
    const memory = new MemoryStore({
      workspaceRoot: dir,
      personMemoryRoot: join(dir, 'person'),
      profileId: 'writer',
    });
    await memory.update({
      content: '- prefers tabs',
      section: 'Preferences and tone',
    });

    const model = new ScriptedLlm([
      [call('read_memory', {})],
      [text('I remember.')],
    ]);
    const driver = new AdkDriver({
      resolveModel: () => model,
      toolContext: () => ({
        workspaceRoot: dir,
        signal: new AbortController().signal,
        memory,
      }),
    });
    const updates = await collect(
      driver.run({
        sessionId: 's1',
        turnId: 't1',
        profileId: 'writer',
        text: 'What do you remember?',
        harness: harness(dir, ['current_time', 'read_memory']),
        history: [],
        signal: new AbortController().signal,
      }),
    );
    const result = updates.find((update) => update.type === 'tool.result');
    expect(result).toMatchObject({ok: true, tool: 'read_memory'});
    expect(
      result !== undefined && result.type === 'tool.result'
        ? String(result.result)
        : '',
    ).toContain('prefers tabs');
  });

  it('caps an over-long history and says it was omitted', async () => {
    const model = new ScriptedLlm([[text('Recent answer.')]]);
    const driver = new AdkDriver({resolveModel: () => model});
    const history: SessionEvent[] = [];
    for (let index = 0; index < 700; index += 1) {
      history.push({
        id: `u-${index}`,
        sessionId: 's1',
        at: '2026-01-01T00:00:00.000Z',
        turnId: `t-${index}`,
        type: 'user.message',
        text: `question ${index}`,
      });
      history.push({
        id: `a-${index}`,
        sessionId: 's1',
        at: '2026-01-01T00:00:00.000Z',
        turnId: `t-${index}`,
        type: 'assistant.message',
        author: 'Writer',
        text: `answer ${index}`,
      });
    }
    await collect(
      driver.run({
        sessionId: 's1',
        turnId: 't-now',
        profileId: 'writer',
        text: 'Now.',
        harness: harness(),
        history,
        signal: new AbortController().signal,
      }),
    );
    const contents = model.requests[0]?.contents ?? [];
    expect(contents.length).toBeLessThan(650);
    const first = contents[0]?.parts?.[0]?.text ?? '';
    expect(first).toContain('omitted from the prompt');
  });

  it('refuses a path that leaves the Space without asking the user', async () => {
    const dir = await workDir();
    const model = new ScriptedLlm([
      [call('read_file', {path: '../outside.txt'})],
      [text('I could not read it.')],
    ]);
    const driver = new AdkDriver({resolveModel: () => model});
    const updates = await collect(
      driver.run({
        sessionId: 's1',
        turnId: 't1',
        profileId: 'writer',
        text: 'Read outside',
        harness: harness(dir),
        history: [],
        signal: new AbortController().signal,
      }),
    );
    const result = updates.find((update) => update.type === 'tool.result');
    expect(result).toMatchObject({ok: false});
    expect(
      result !== undefined && result.type === 'tool.result'
        ? String(result.result)
        : '',
    ).toContain('outside the workspace');
  });

  it('does not gate creating a file, and gates replacing one', async () => {
    const dir = await workDir();
    await writeFile(join(dir, 'existing.md'), 'old', 'utf8');

    const create = new ScriptedLlm([
      [call('write_file', {path: 'new.md', content: 'new'})],
      [text('Created.')],
    ]);
    const createDriver = new AdkDriver({resolveModel: () => create});
    const created = await collect(
      createDriver.run({
        sessionId: 's1',
        turnId: 't1',
        profileId: 'writer',
        text: 'Create it',
        harness: harness(dir),
        history: [],
        signal: new AbortController().signal,
      }),
    );
    expect(created.map((update) => update.type)).not.toContain(
      'approval.request',
    );
    expect(
      created.find((update) => update.type === 'tool.result'),
    ).toMatchObject({
      ok: true,
    });

    const replace = new ScriptedLlm([
      [call('write_file', {path: 'existing.md', content: 'new'})],
    ]);
    const replaceDriver = new AdkDriver({resolveModel: () => replace});
    const gated = await collect(
      replaceDriver.run({
        sessionId: 's1',
        turnId: 't1',
        profileId: 'writer',
        text: 'Replace it',
        harness: harness(dir),
        history: [],
        signal: new AbortController().signal,
      }),
    );
    const approval = gated.find((update) => update.type === 'approval.request');
    expect(approval).toMatchObject({
      tool: 'write_file',
      args: {path: 'existing.md'},
    });
    expect(gated.map((update) => update.type)).toContain('tool.call');
    expect(gated.map((update) => update.type)).not.toContain('tool.result');
  });

  it('runs a helper with tools in the parent session', async () => {
    const dir = await workDir();
    await writeFile(join(dir, 'existing.md'), 'old', 'utf8');
    const parent = new ScriptedLlm([
      [call('ask_agent', {agent: 'Reader', task: 'What is in existing.md?'}, 'a1')],
      [text('The helper answered.')],
    ]);
    const helper = new ScriptedLlm([
      [call('read_file', {path: 'existing.md'}, 'h1')],
      [text('It says old.')],
    ]);
    const helperHarness = resolveHarness({
      profile: {
        id: 'reader',
        name: 'Reader',
        role: 'Read files.',
        enabledTools: ['read_file'],
        enabledSkills: [],
      },
      app,
      version: 1,
      workspaceRoot: dir,
    });
    const target: HelperTarget = {
      harness: helperHarness,
      model: helper,
      name: 'Reader',
      promptContext: {memory: '', skills: []},
      toolContext: {workspaceRoot: dir, signal: new AbortController().signal},
    };
    const driver = new AdkDriver({
      resolveModel: () => parent,
      resolveHelper: async () => target,
      promptContext: () => ({memory: '', skills: []}),
      toolContext: (_harness, signal) => ({
        workspaceRoot: dir,
        signal,
        delegate: async () => ({ok: false, result: 'no'}),
      }),
    });
    const eventList = await collect(
      driver.run({
        sessionId: 's1',
        turnId: 't1',
        profileId: 'writer',
        text: 'Ask the reader.',
        harness: harness(dir, ['ask_agent']),
        history: [],
        signal: new AbortController().signal,
      }),
    );
    expect(
      eventList.find((event) => event.type === 'tool.result'),
    ).toMatchObject({ok: true, result: 'It says old.'});
    expect(
      eventList.find((event) => event.type === 'message'),
    ).toMatchObject({text: 'The helper answered.'});
  });

  it('raises a parent card for a helper gate, then wakes the helper', async () => {
    const dir = await workDir();
    await writeFile(join(dir, 'existing.md'), 'old', 'utf8');
    const cached = new Map<string, unknown>();
    const parent = new ScriptedLlm([
      [call('ask_agent', {agent: 'Reader', task: 'Replace existing.md'}, 'a1')],
      [text('The helper replaced it.')],
    ]);
    const helper = new ScriptedLlm([
      [call('write_file', {path: 'existing.md', content: 'new'}, 'h1')],
      [text('Replaced.')],
    ]);
    const helperHarness = resolveHarness({
      profile: {
        id: 'reader',
        name: 'Reader',
        role: 'Read files.',
        enabledTools: ['write_file'],
        enabledSkills: [],
      },
      app,
      version: 1,
      workspaceRoot: dir,
    });
    const target: HelperTarget = {
      harness: helperHarness,
      model: helper,
      name: 'Reader',
      promptContext: {memory: '', skills: []},
      toolContext: {workspaceRoot: dir, signal: new AbortController().signal},
    };
    const driver = new AdkDriver({
      resolveModel: (harness) => (harness.id === 'reader' ? helper : parent),
      resolveHelper: async () => target,
      promptContext: () => ({memory: '', skills: []}),
      toolContext: (_harness, signal) => ({
        workspaceRoot: dir,
        signal,
        delegate: async () => ({ok: false, result: 'no'}),
      }),
      resumeSessions: (id) => cached.get(id),
      rememberSessions: (id, sessions) => cached.set(id, sessions),
    });
    const first = await collect(
      driver.run({
        sessionId: 's1',
        turnId: 't1',
        profileId: 'writer',
        text: 'Ask the reader.',
        harness: harness(dir, ['ask_agent']),
        history: [],
        signal: new AbortController().signal,
      }),
    );
    const approval = first.find(
      (event): event is Extract<DriverEvent, {type: 'approval.request'}> =>
        event.type === 'approval.request',
    );
    expect(approval).toMatchObject({tool: 'ask_agent', callId: 'a1'});

    const prior = history(
      userMessage('t1', 'Ask the reader.'),
      toolCall('t1', 'a1', 'ask_agent', {
        agent: 'Reader',
        task: 'Replace existing.md',
      }),
      gate('t1', 'a1', approval?.confirmationId ?? '', 'ask_agent', {
        agent: 'Reader',
        task: 'Replace existing.md',
      }),
      decision('t1', 'a1', approval?.confirmationId ?? ''),
    );
    const resumed = await collect(
      driver.resume({
        sessionId: 's1',
        turnId: 't1',
        profileId: 'writer',
        harness: harness(dir, ['ask_agent']),
        history: prior,
        decisions: [{callId: 'a1', confirmed: true}],
        signal: new AbortController().signal,
      }),
    );
    expect(
      resumed.find((event) => event.type === 'message'),
    ).toMatchObject({text: 'The helper replaced it.'});
    expect(
      await import('node:fs/promises').then((fs) =>
        fs.readFile(join(dir, 'existing.md'), 'utf8'),
      ),
    ).toBe('new');
  });

  it('resumes an approved call and records the tool result', async () => {
    const dir = await workDir();
    await writeFile(join(dir, 'existing.md'), 'old', 'utf8');

    const first = new ScriptedLlm([
      [call('write_file', {path: 'existing.md', content: 'new'})],
    ]);
    const driver = new AdkDriver({resolveModel: () => first});
    const paused = await collect(
      driver.run({
        sessionId: 's1',
        turnId: 't1',
        profileId: 'writer',
        text: 'Replace it',
        harness: harness(dir),
        history: [],
        signal: new AbortController().signal,
      }),
    );
    const approval = paused.find(
      (update): update is Extract<DriverEvent, {type: 'approval.request'}> =>
        update.type === 'approval.request',
    );
    expect(approval).toBeDefined();

    const gateEvent = gate(
      't1',
      approval?.callId ?? '',
      approval?.confirmationId ?? '',
      'write_file',
      {path: 'existing.md', content: 'new'},
    );
    const prior = history(
      userMessage('t1', 'Replace it'),
      toolCall('t1', approval?.callId ?? '', 'write_file', {
        path: 'existing.md',
        content: 'new',
      }),
      gateEvent,
      decision('t1', approval?.callId ?? '', approval?.confirmationId ?? ''),
    );

    const second = new ScriptedLlm([[text('Replaced.')]]);
    const resumeDriver = new AdkDriver({resolveModel: () => second});
    const resumed = await collect(
      resumeDriver.resume({
        sessionId: 's1',
        turnId: 't1',
        profileId: 'writer',
        harness: harness(dir),
        history: prior,
        decisions: [
          {
            callId: approval?.callId ?? '',
            confirmed: true,
          },
        ],
        signal: new AbortController().signal,
      }),
    );
    const result = resumed.find((update) => update.type === 'tool.result');
    expect(result).toMatchObject({ok: true, callId: approval?.callId});
    expect(resumed.find((update) => update.type === 'message')).toMatchObject({
      text: 'Replaced.',
    });
    const written = await import('node:fs/promises').then((fs) =>
      fs.readFile(join(dir, 'existing.md'), 'utf8'),
    );
    expect(written).toBe('new');
  });

  it('resumes an imported card that has no turn.started', async () => {
    const dir = await workDir();
    await writeFile(join(dir, 'imported.md'), 'old', 'utf8');
    const callId = 'legacy-confirm-1';
    const prior = history(
      userMessage('legacy-0', 'Replace it'),
      toolCall('legacy-0', callId, 'write_file', {
        path: 'imported.md',
        content: 'new',
      }),
      gate('legacy-0', callId, 'confirm-1', 'write_file', {
        path: 'imported.md',
        content: 'new',
      }),
      decision('legacy-0', callId, 'confirm-1'),
    );
    const model = new ScriptedLlm([[text('Imported.')]]);
    const driver = new AdkDriver({resolveModel: () => model});
    const resumed = await collect(
      driver.resume({
        sessionId: 's1',
        turnId: 'legacy-0',
        profileId: 'writer',
        harness: harness(dir),
        history: prior,
        decisions: [{callId, confirmed: true}],
        signal: new AbortController().signal,
      }),
    );
    expect(resumed.find((update) => update.type === 'tool.result')).toMatchObject({
      ok: true,
      callId,
    });
    expect(
      await import('node:fs/promises').then((fs) =>
        fs.readFile(join(dir, 'imported.md'), 'utf8'),
      ),
    ).toBe('new');
  });

  it('maps a denial to a failed tool result', async () => {
    const dir = await workDir();
    await writeFile(join(dir, 'existing.md'), 'old', 'utf8');
    const model = new ScriptedLlm([[text('I did not replace it.')]]);
    const driver = new AdkDriver({resolveModel: () => model});
    const prior = history(
      userMessage('t1', 'Replace it'),
      toolCall('t1', 'call_1', 'write_file', {
        path: 'existing.md',
        content: 'new',
      }),
      gate('t1', 'call_1', 'confirm_1', 'write_file', {
        path: 'existing.md',
        content: 'new',
      }),
      decision('t1', 'call_1', 'confirm_1'),
    );
    const updates = await collect(
      driver.resume({
        sessionId: 's1',
        turnId: 't1',
        profileId: 'writer',
        harness: harness(dir),
        history: prior,
        decisions: [{callId: 'call_1', confirmed: false}],
        signal: new AbortController().signal,
      }),
    );
    expect(
      updates.find((update) => update.type === 'tool.result'),
    ).toMatchObject({
      ok: false,
    });
  });

  it('replays reasoning on a history that carried a tool call', async () => {
    const model = new ScriptedLlm([[text('Again.')]]);
    const driver = new AdkDriver({resolveModel: () => model});
    const prior = history(
      userMessage('t0', 'First'),
      {
        id: 'a-0',
        sessionId: 's1',
        at: '2026-01-01T00:00:00.000Z',
        turnId: 't0',
        type: 'assistant.message',
        author: 'Writer',
        text: 'It was then.',
        reasoning: 'I checked the clock.',
      },
      userMessage('t1', 'Second'),
    );
    await collect(
      driver.run({
        sessionId: 's1',
        turnId: 't1',
        profileId: 'writer',
        text: 'Second',
        harness: harness(),
        history: prior,
        signal: new AbortController().signal,
      }),
    );
    const parts = (model.requests[0]?.contents ?? []).flatMap(
      (content) => content.parts ?? [],
    );
    expect(parts).toContainEqual({
      text: 'I checked the clock.',
      thought: true,
    });
  });

  it('replays a summary instead of the events it covers', async () => {
    const model = new ScriptedLlm([[text('Okay.')]]);
    const driver = new AdkDriver({resolveModel: () => model});
    const prior = history(
      userMessage('t0', 'The old question.'),
      {
        id: 'a-0',
        sessionId: 's1',
        at: '2026-01-01T00:00:00.000Z',
        turnId: 't0',
        type: 'assistant.message',
        author: 'Writer',
        text: 'The old answer.',
      },
      {
        id: 'sum-1',
        sessionId: 's1',
        at: '2026-01-01T00:00:01.000Z',
        type: 'summary',
        text: 'They discussed the old question.',
        coversThrough: 'a-0',
      },
      userMessage('t1', 'The newer question.'),
    );
    await collect(
      driver.run({
        sessionId: 's1',
        turnId: 't2',
        profileId: 'writer',
        text: 'Now.',
        harness: harness(),
        history: prior,
        signal: new AbortController().signal,
      }),
    );
    const texts = (model.requests[0]?.contents ?? [])
      .flatMap((content) => content.parts ?? [])
      .map((part) => part.text ?? '')
      .filter((value) => value.length > 0);
    expect(texts.some((value) => value.includes('They discussed the old question.'))).toBe(
      true,
    );
    expect(texts).toContain('The newer question.');
    expect(texts).not.toContain('The old question.');
    expect(texts).not.toContain('The old answer.');
  });

  it('replays a task result as the other bot’s message', async () => {
    const model = new ScriptedLlm([[text('Noted.')]]);
    const driver = new AdkDriver({resolveModel: () => model});
    const prior = history(
      userMessage('t0', 'Check the folder.'),
      {
        id: 'task-1',
        sessionId: 's1',
        at: '2026-01-01T00:00:00.000Z',
        type: 'task.result',
        taskSessionId: 'task-session',
        agentId: 'reader',
        agentName: 'Reader',
        ok: true,
        text: 'The folder has three notes.',
      },
      userMessage('t1', 'And now?'),
    );
    await collect(
      driver.run({
        sessionId: 's1',
        turnId: 't2',
        profileId: 'writer',
        text: 'Now.',
        harness: harness(),
        history: prior,
        signal: new AbortController().signal,
      }),
    );
    const texts = (model.requests[0]?.contents ?? [])
      .flatMap((content) => content.parts ?? [])
      .map((part) => part.text ?? '');
    expect(
      texts.some((value) =>
        value.includes('Task result from Reader'),
      ),
    ).toBe(true);
    expect(texts.some((value) => value.includes('three notes'))).toBe(true);
  });

  it('rebuilds prior tool history without duplicating the current message', async () => {
    const model = new ScriptedLlm([[text('Again.')]]);
    const driver = new AdkDriver({resolveModel: () => model});
    const prior = history(
      userMessage('t0', 'First'),
      toolCall('t0', 'call_0', 'current_time', {}),
      {
        id: 'r-0',
        sessionId: 's1',
        at: '2026-01-01T00:00:00.000Z',
        turnId: 't0',
        type: 'tool.result',
        callId: 'call_0',
        tool: 'current_time',
        ok: true,
        result: 'now',
      },
      {
        id: 'a-0',
        sessionId: 's1',
        at: '2026-01-01T00:00:00.000Z',
        turnId: 't0',
        type: 'assistant.message',
        author: 'Writer',
        text: 'It was then.',
      },
      userMessage('t1', 'Second'),
    );
    await collect(
      driver.run({
        sessionId: 's1',
        turnId: 't1',
        profileId: 'writer',
        text: 'Second',
        harness: harness(),
        history: prior,
        signal: new AbortController().signal,
      }),
    );
    const contents = model.requests[0]?.contents ?? [];
    const texts = contents
      .flatMap((content) => content.parts ?? [])
      .map((part) => part.text ?? '')
      .filter((value) => value.length > 0);
    expect(texts.filter((value) => value === 'Second')).toHaveLength(1);
    expect(texts).toContain('First');
    expect(texts).toContain('It was then.');
    const responses = contents
      .flatMap((content) => content.parts ?? [])
      .filter((part) => part.functionResponse !== undefined);
    expect(responses).toHaveLength(1);
  });
});
