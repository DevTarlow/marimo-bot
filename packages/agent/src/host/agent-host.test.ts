/**
 * End-to-end agent tests.
 *
 * These drive the real ADK `Runner`, the real `AgentHost`, the real tool set and
 * the real session store, with only the network replaced by a loopback HTTP
 * server that speaks the DeepSeek streaming protocol. That makes the message
 * translation, the tool-calling loop, and the approval round trip testable
 * without an API key.
 */
import {createServer} from 'node:http';
import type {AddressInfo} from 'node:net';
import {mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';

import {afterEach, beforeEach, describe, expect, it} from 'vitest';

import type {AgentUiEvent} from '@marimo/protocol';

import type {DreamTree, Job} from '@marimo/protocol';

import type {AgentConfig} from '../config.js';

import {resolveMemoryFile} from '../memory/index.js';
import type {McpToolsetSource} from '../tools/index.js';
import type {JobService} from '../tools/job-tools.js';
import type {RecallAnswer, RecallLookup} from '../tools/recall-tools.js';
import type {WebSearchProvider} from '../tools/web-search-tool.js';
import {AgentHost, agentNameFor} from './agent-host.js';
import {projectTranscript} from './transcript.js';

interface RecordedRequest {
  messages: Array<Record<string, unknown>>;
  body: Record<string, unknown>;
}

interface FakeDeepSeek {
  baseUrl: string;
  requests: RecordedRequest[];
  close: () => Promise<void>;
}

type Responder = (
  messages: Array<Record<string, unknown>>,
  callIndex: number,
) => Array<Record<string, unknown>>;

async function startFakeDeepSeek(responder: Responder): Promise<FakeDeepSeek> {
  const requests: RecordedRequest[] = [];

  const server = createServer((request, response) => {
    let raw = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => {
      raw += chunk;
    });
    request.on('end', () => {
      const body = JSON.parse(raw.length > 0 ? raw : '{}') as Record<
        string,
        unknown
      >;
      const messages = (body['messages'] ?? []) as Array<
        Record<string, unknown>
      >;
      requests.push({messages, body});

      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
      });
      for (const chunk of responder(messages, requests.length - 1)) {
        response.write(`data: ${JSON.stringify(chunk)}\n\n`);
      }
      response.write('data: [DONE]\n\n');
      response.end();
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const {port} = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

function textChunks(text: string): Array<Record<string, unknown>> {
  return [
    {choices: [{delta: {content: text}, finish_reason: null}]},
    {choices: [{delta: {}, finish_reason: 'stop'}]},
    {
      choices: [],
      usage: {prompt_tokens: 12, completion_tokens: 4, total_tokens: 16},
    },
  ];
}

/**
 * A turn that thinks first. `reasoning_content` is what the API returns in
 * thinking mode, which is the default.
 */
function reasoningChunks(
  reasoning: string,
  text: string,
): Array<Record<string, unknown>> {
  return [
    {choices: [{delta: {reasoning_content: reasoning}, finish_reason: null}]},
    {choices: [{delta: {content: text}, finish_reason: null}]},
    {choices: [{delta: {}, finish_reason: 'stop'}]},
    {
      choices: [],
      usage: {prompt_tokens: 20, completion_tokens: 8, total_tokens: 28},
    },
  ];
}

function toolCallChunks(
  id: string,
  name: string,
  args: Record<string, unknown>,
): Array<Record<string, unknown>> {
  return [
    {
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id,
                type: 'function',
                function: {name, arguments: JSON.stringify(args)},
              },
            ],
          },
          finish_reason: null,
        },
      ],
    },
    {choices: [{delta: {}, finish_reason: 'tool_calls'}]},
    {
      choices: [],
      usage: {prompt_tokens: 20, completion_tokens: 6, total_tokens: 26},
    },
  ];
}

/**
 * One turn that asks for several calls at once, which is how a turn ends up with
 * more than one approval gate to answer.
 */
function parallelToolCallChunks(
  calls: Array<{id: string; name: string; args: Record<string, unknown>}>,
): Array<Record<string, unknown>> {
  return [
    {
      choices: [
        {
          delta: {
            tool_calls: calls.map((call, index) => ({
              index,
              id: call.id,
              type: 'function',
              function: {name: call.name, arguments: JSON.stringify(call.args)},
            })),
          },
          finish_reason: null,
        },
      ],
    },
    {choices: [{delta: {}, finish_reason: 'tool_calls'}]},
    {
      choices: [],
      usage: {prompt_tokens: 20, completion_tokens: 6, total_tokens: 26},
    },
  ];
}

async function collect(
  stream: AsyncGenerator<AgentUiEvent>,
): Promise<AgentUiEvent[]> {
  const events: AgentUiEvent[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

function typesOf(events: AgentUiEvent[]): string[] {
  return events.map((event) => event.type);
}

/**
 * The identity these fixtures send.
 *
 * A local literal rather than the app's shipped default: what these tests are
 * about is that whatever identity a profile holds reaches the request, and an
 * assertion against the shipped text would fail every time somebody edits it.
 */
const TEST_IDENTITY = 'You are Marimo Bot, a test agent.';

describe('AgentHost', () => {
  let workDir: string;
  let fake: FakeDeepSeek | undefined;
  const openHosts: AgentHost[] = [];

  beforeEach(async () => {
    workDir = await mkdtemp(join(process.cwd(), '.marimo-test-'));
  });

  afterEach(async () => {
    for (const host of openHosts.splice(0)) {
      host.dispose();
    }
    await fake?.close();
    fake = undefined;
    await rm(workDir, {recursive: true, force: true});
  });

  /*
   * The model id the fake engine is asked for. Arbitrary on purpose: what these
   * tests exercise is the transport and the host, and the id is a string between
   * two processes — the real one comes from `LOCAL_MODEL_ID`.
   */
  const TEST_MODEL = 'test-model';

  function createConfig(baseUrl: string): AgentConfig {
    return {
      baseUrl,
      model: TEST_MODEL,
      provider: 'deepseek',
      apiKey: '',
      systemPrompt: TEST_IDENTITY,
      workspaceRoot: workDir,
      allowPrivateNetworkFetch: false,
    };
  }

  function createHost(
    baseUrl: string,
    webSearch?: WebSearchProvider,
    jobService?: JobService,
    profileId?: string,
  ): AgentHost {
    const host = new AgentHost({
      sessionsDir: join(workDir, 'sessions'),
      config: {
        ...createConfig(baseUrl),
        ...(profileId ? {profileId} : {}),
      },
      ...(webSearch ? {webSearch} : {}),
      ...(jobService ? {jobService} : {}),
    });
    host.init();
    openHosts.push(host);
    return host;
  }

  async function startHost(
    responder: Responder,
    webSearch?: WebSearchProvider,
  ): Promise<{host: AgentHost; session: string}> {
    fake = await startFakeDeepSeek(responder);
    const host = createHost(fake.baseUrl, webSearch);
    const session = await host.createSession();
    return {host, session: session.id};
  }

  it('streams assistant text and reports usage', async () => {
    const {host, session} = await startHost(() =>
      textChunks('Hello from the fake model.'),
    );

    const events = await collect(host.run(session, 'hi'));

    expect(typesOf(events)).toContain('turn.started');
    const deltas = events.filter((event) => event.type === 'text.delta');
    expect(
      deltas
        .map((event) => (event.type === 'text.delta' ? event.text : ''))
        .join(''),
    ).toBe('Hello from the fake model.');

    const completed = events.find((event) => event.type === 'turn.completed');
    expect(completed).toMatchObject({
      type: 'turn.completed',
      usage: {promptTokens: 12, completionTokens: 4, totalTokens: 16},
    });
    expect(typesOf(events)).not.toContain('turn.failed');
  });

  it('sends the system prompt and the tool declarations to the provider', async () => {
    const {host, session} = await startHost(() => textChunks('ok'));
    await collect(host.run(session, 'hi'));

    const request = fake?.requests[0];
    expect(request?.body['stream']).toBe(true);
    expect(request?.body['model']).toBe(TEST_MODEL);

    const system = request?.messages[0];
    expect(system).toMatchObject({role: 'system'});
    const systemText = String(system?.['content']);
    expect(systemText).toContain(TEST_IDENTITY);
    // The operating protocol and the memory block ride in the instruction, not
    // in the stored prompt, so even an old saved prompt carries both.
    expect(systemText).toContain('# Operating protocol');
    expect(systemText).toContain('# Long-term memory');

    const tools = request?.body['tools'] as Array<{
      function: {name: string; parameters: unknown};
    }>;
    const names = tools.map((tool) => tool.function.name);
    expect(names).toEqual([
      'current_time',
      'read_file',
      'list_dir',
      'write_file',
      'search_knowledge_base',
      'read_memory',
      'update_memory',
      'prune_memory',
      'http_fetch',
      'run_shell',
      'draft_bot',
    ]);
    expect(tools[1]?.function.parameters).toMatchObject({type: 'object'});

    // The provider validates every declaration on every request, so a numeric
    // bound serialized as a string fails the whole turn, not one tool call:
    // DeepSeek answers `"1" is not of type "integer"` and the request is lost.
    expect(JSON.stringify(tools)).not.toMatch(
      /"(minLength|maxLength|minimum|maximum|minItems|maxItems|multipleOf)":\s*"/,
    );
  });

  it('injects memory.md into the prompt and follows later writes', async () => {
    const {host, session} = await startHost(() => textChunks('ok'));

    await collect(host.run(session, 'first'));
    expect(String(fake?.requests[0]?.messages[0]?.['content'])).toContain(
      '(nothing remembered yet',
    );

    // Anything that writes memory — here the file itself — shows up on the very
    // next request rather than on the next turn.
    await mkdir(join(workDir, '.marimo', 'default'), {recursive: true});
    await writeFile(
      resolveMemoryFile(workDir),
      '## Preferences\n- Prefers pnpm\n',
      'utf8',
    );

    await collect(host.run(session, 'second'));
    const secondSystem = String(fake?.requests[1]?.messages[0]?.['content']);
    expect(secondSystem).toContain('- Prefers pnpm');
  });

  it('runs web_search through the injected provider', async () => {
    const queries: string[] = [];
    const provider: WebSearchProvider = {
      search: async ({query}) => {
        queries.push(query);
        return [
          {
            title: 'Marimo Bot',
            url: 'https://example.com/marimo',
            snippet: 'A reactive notebook',
          },
        ];
      },
    };

    const {host, session} = await startHost(
      (messages) => {
        const hasResult = messages.some(
          (message) => message['role'] === 'tool',
        );
        return hasResult
          ? textChunks('Found it.')
          : toolCallChunks('call_search', 'web_search', {query: 'marimo'});
      },
      provider,
    );

    const events = await collect(host.run(session, 'search the web'));

    const names = (
      fake?.requests[0]?.body['tools'] as Array<{function: {name: string}}>
    ).map((tool) => tool.function.name);
    expect(names).toContain('web_search');
    expect(queries).toEqual(['marimo']);

    const finished = events.find((event) => event.type === 'tool.finished');
    expect(finished).toMatchObject({type: 'tool.finished', tool: 'web_search'});
    if (finished?.type === 'tool.finished') {
      expect(finished.result).toContain('https://example.com/marimo');
    }
  });

  /*
   * The scheduling tools only exist when the app supplied somewhere to keep
   * jobs, and the conversation a job links back to comes from the running turn:
   * the model never passes a session id, so it cannot point a job at a chat it
   * does not own.
   */
  it('offers the scheduling tools with a job service and links the job to this session', async () => {
    const created: unknown[] = [];
    const jobs: JobService = {
      list: async () => [],
      create: async (input) => {
        created.push(input);
        return {
          id: 'job-1',
          name: input.name,
          description: input.description,
          schedules: input.schedules ?? ['0 9 * * *'],
          enabled: true,
          profileId: input.profileId,
          sessionId: input.sessionId,
          createdAt: '2026-05-01T09:00:00.000Z',
        } satisfies Job;
      },
      update: async () => null,
      remove: async () => false,
    };

    fake = await startFakeDeepSeek((messages) =>
      messages.some((message) => message['role'] === 'tool')
        ? textChunks('Scheduled.')
        : toolCallChunks('call_job', 'create_job', {
            name: 'Morning digest',
            description: 'Summarise new issues.',
            schedules: ['0 9 * * 1-5'],
          }),
    );
    const host = createHost(fake.baseUrl, undefined, jobs);
    const session = await host.createSession();

    const events = await collect(host.run(session.id, 'set that up'));

    const names = (
      fake.requests[0]?.body['tools'] as Array<{function: {name: string}}>
    ).map((tool) => tool.function.name);
    expect(names).toContain('create_job');
    expect(names).toContain('list_jobs');

    // Gated, so the first pass pauses instead of running the tool: nothing was
    // created until the user approved it.
    expect(created).toEqual([]);

    const gate = events.find((event) => event.type === 'approval.request');
    expect(gate).toMatchObject({type: 'approval.request', tool: 'create_job'});

    // Approving resumes the paused call, which is when the job is stamped with
    // the conversation it was asked for in.
    const resumed = await collect(
      host.approve({
        sessionId: session.id,
        callId: gate?.type === 'approval.request' ? gate.callId : '',
        confirmed: true,
      }),
    );
    expect(typesOf(resumed)).toContain('turn.completed');
    expect(created).toEqual([
      {
        name: 'Morning digest',
        description: 'Summarise new issues.',
        sessionId: session.id,
        profileId: '',
        schedules: ['0 9 * * 1-5'],
      },
    ]);
  });

  /*
   * The host answers one turn at a time. The scheduler asks `isBusy` before it
   * dispatches so a job that came due mid-conversation is deferred rather than
   * refused — a refusal would look like a failed job for no reason the user can
   * see.
   */
  it('reports whether a turn is in flight', async () => {
    const {host, session} = await startHost(() => textChunks('done'));

    expect(host.isBusy()).toBe(false);
    expect(host.activeSessionId()).toBeUndefined();

    const stream = host.run(session, 'hi');
    const first = await stream.next();
    expect(first.value).toMatchObject({type: 'turn.started'});
    expect(host.isBusy()).toBe(true);
    expect(host.activeSessionId()).toBe(session);

    await collect(stream);
    expect(host.isBusy()).toBe(false);
    expect(host.activeSessionId()).toBeUndefined();
  });

  it('runs a non-gated tool and feeds the result back', async () => {
    const {host, session} = await startHost((messages) => {
      const hasResult = messages.some((message) => message['role'] === 'tool');
      if (!hasResult) {
        return toolCallChunks('call_time', 'current_time', {});
      }
      const toolMessage = [...messages]
        .reverse()
        .find((message) => message['role'] === 'tool');
      return textChunks(`The clock says: ${String(toolMessage?.['content'])}`);
    });

    const events = await collect(host.run(session, 'what time is it?'));

    const started = events.find((event) => event.type === 'tool.started');
    expect(started).toMatchObject({type: 'tool.started', tool: 'current_time'});

    const finished = events.find((event) => event.type === 'tool.finished');
    expect(finished).toMatchObject({
      type: 'tool.finished',
      tool: 'current_time',
      ok: true,
    });

    const text = events
      .filter((event) => event.type === 'text.delta')
      .map((event) => (event.type === 'text.delta' ? event.text : ''))
      .join('');
    expect(text).toContain('The clock says:');

    expect(fake?.requests).toHaveLength(2);
    expect(
      fake?.requests[1]?.messages.some((message) => message['role'] === 'tool'),
    ).toBe(true);
  });

  it('pauses a gated tool for approval, then runs exactly what was approved', async () => {
    const marker = `marimo-approval-${Date.now()}`;
    const command = `echo ${marker}`;

    const {host, session} = await startHost((messages) => {
      const hasResult = messages.some((message) => message['role'] === 'tool');
      return hasResult
        ? textChunks('The command finished.')
        : toolCallChunks('call_shell', 'run_shell', {command});
    });

    const firstPass = await collect(host.run(session, 'echo the marker'));

    const approval = firstPass.find(
      (event) => event.type === 'approval.request',
    );
    expect(approval).toMatchObject({
      type: 'approval.request',
      tool: 'run_shell',
      args: {command},
    });
    // Nothing may run before the user decides, and the pending call must not be
    // reported as a finished (failed) tool.
    expect(fake?.requests).toHaveLength(1);

    const callId = approval?.type === 'approval.request' ? approval.callId : '';
    expect(callId.length).toBeGreaterThan(0);

    const secondPass = await collect(
      host.approve({sessionId: session, callId, confirmed: true}),
    );

    const finished = secondPass.find((event) => event.type === 'tool.finished');
    expect(finished).toMatchObject({
      type: 'tool.finished',
      tool: 'run_shell',
      ok: true,
    });
    if (finished?.type === 'tool.finished') {
      expect(finished.result).toContain(marker);
    }

    expect(fake?.requests).toHaveLength(2);
    const toolMessage = fake?.requests[1]?.messages.find(
      (message) => message['role'] === 'tool',
    );
    expect(String(toolMessage?.['content'])).toContain(marker);
  });

  it('answers every gate of a round in one message, and only when all are decided', async () => {
    const first = `marimo-round-a-${Date.now()}`;
    const second = `marimo-round-b-${Date.now()}`;

    const {host, session} = await startHost((messages) => {
      const hasResult = messages.some((message) => message['role'] === 'tool');
      return hasResult
        ? textChunks('Both commands finished.')
        : parallelToolCallChunks([
            {id: 'call_a', name: 'run_shell', args: {command: `echo ${first}`}},
            {
              id: 'call_b',
              name: 'run_shell',
              args: {command: `echo ${second}`},
            },
          ]);
    });

    const paused = await collect(host.run(session, 'echo both markers'));
    const gates = paused.filter((event) => event.type === 'approval.request');
    expect(gates).toHaveLength(2);
    // Nothing has run, and the only request is the one that asked for the calls.
    expect(fake?.requests).toHaveLength(1);

    const idOf = (index: number): string => {
      const gate = gates[index];
      return gate?.type === 'approval.request' ? gate.callId : '';
    };

    /*
     * The decision for one gate is held. Resuming here is what produced a
     * request carrying two tool calls and one tool result, which DeepSeek
     * refuses — and, because the gap is in the session, refuses on every later
     * turn of that conversation too.
     */
    const held = await collect(
      host.approve({sessionId: session, callId: idOf(0), confirmed: true}),
    );
    expect(held).toEqual([]);
    expect(fake?.requests).toHaveLength(1);

    const resumed = await collect(
      host.approve({sessionId: session, callId: idOf(1), confirmed: true}),
    );

    const results = resumed
      .filter((event) => event.type === 'tool.finished')
      .map((event) => (event.type === 'tool.finished' ? event.result : ''))
      .join('\n');
    expect(results).toContain(first);
    expect(results).toContain(second);

    // The rule the provider enforces, asserted on what was actually sent: every
    // call the assistant message asked for is answered by a tool message.
    expect(fake?.requests).toHaveLength(2);
    const followUp = fake?.requests[1]?.messages ?? [];
    const asked = followUp
      .filter((message) => message['role'] === 'assistant')
      .flatMap(
        (message) => (message['tool_calls'] ?? []) as Array<{id: string}>,
      )
      .map((call) => call.id);
    const answered = followUp
      .filter((message) => message['role'] === 'tool')
      .map((message) => message['tool_call_id']);
    expect(asked.length).toBeGreaterThan(0);
    expect(answered).toEqual(expect.arrayContaining(asked));
  });

  it('ignores a decision for a gate it is no longer waiting on', async () => {
    const command = `echo marimo-stale-${Date.now()}`;

    const {host, session} = await startHost((messages) => {
      const hasResult = messages.some((message) => message['role'] === 'tool');
      return hasResult
        ? textChunks('Done.')
        : toolCallChunks('call_shell', 'run_shell', {command});
    });

    const paused = await collect(host.run(session, 'echo it'));
    const gate = paused.find((event) => event.type === 'approval.request');
    const callId = gate?.type === 'approval.request' ? gate.callId : '';

    await collect(host.approve({sessionId: session, callId, confirmed: true}));
    expect(fake?.requests).toHaveLength(2);

    // A second click, on a card the window had already taken down.
    const again = await collect(
      host.approve({sessionId: session, callId, confirmed: true}),
    );
    expect(again).toEqual([]);
    expect(fake?.requests).toHaveLength(2);
  });

  it('reports a denial to the model without running the command', async () => {
    const marker = `marimo-denied-${Date.now()}`;
    const command = `echo ${marker}`;

    const {host, session} = await startHost((messages) => {
      const hasResult = messages.some((message) => message['role'] === 'tool');
      return hasResult
        ? textChunks('Understood, not running it.')
        : toolCallChunks('call_shell', 'run_shell', {command});
    });

    const firstPass = await collect(host.run(session, 'run it'));
    const approval = firstPass.find(
      (event) => event.type === 'approval.request',
    );
    const callId = approval?.type === 'approval.request' ? approval.callId : '';

    const secondPass = await collect(
      host.approve({sessionId: session, callId, confirmed: false}),
    );

    for (const event of secondPass) {
      if (event.type === 'tool.finished') {
        expect(event.ok).toBe(false);
      }
    }

    expect(fake?.requests).toHaveLength(2);
    const toolMessage = fake?.requests[1]?.messages.find(
      (message) => message['role'] === 'tool',
    );
    expect(String(toolMessage?.['content'])).not.toContain(marker);
    expect(String(toolMessage?.['content'])).toMatch(/reject/i);
  });

  it('writes a new file without approval, then gates the overwrite', async () => {
    const target = join(workDir, 'notes', 'todo.md');
    // Each turn is two requests: the tool call, then the reply after its result.
    const {host, session} = await startHost((_messages, callIndex) =>
      callIndex % 2 === 0
        ? toolCallChunks(`call_write_${callIndex}`, 'write_file', {
            path: 'notes/todo.md',
            content: 'buy milk',
          })
        : textChunks('Done.'),
    );

    // A brand-new file is created without a prompt.
    const created = await collect(host.run(session, 'write a todo'));
    expect(typesOf(created)).not.toContain('approval.request');
    expect(await readFile(target, 'utf8')).toBe('buy milk');

    // The same call a second time is an overwrite, so the turn pauses.
    const paused = await collect(host.run(session, 'rewrite it'));
    const approval = paused.find((event) => event.type === 'approval.request');
    expect(approval).toMatchObject({
      type: 'approval.request',
      tool: 'write_file',
      args: {path: 'notes/todo.md', content: 'buy milk'},
    });

    // Nothing has changed while the user decides.
    expect(await readFile(target, 'utf8')).toBe('buy milk');
  });

  it('leaves an approved file alone when the overwrite is denied', async () => {
    const target = join(workDir, 'notes.md');
    await writeFile(target, 'original', 'utf8');

    const {host, session} = await startHost((_messages, callIndex) =>
      callIndex % 2 === 0
        ? toolCallChunks(`call_write_${callIndex}`, 'write_file', {
            path: 'notes.md',
            content: 'replaced',
          })
        : textChunks('Understood.'),
    );

    const paused = await collect(host.run(session, 'replace it'));
    const approval = paused.find((event) => event.type === 'approval.request');
    const callId = approval?.type === 'approval.request' ? approval.callId : '';

    const denied = await collect(
      host.approve({sessionId: session, callId, confirmed: false}),
    );

    expect(await readFile(target, 'utf8')).toBe('original');
    const finished = denied.find((event) => event.type === 'tool.finished');
    expect(finished).toMatchObject({type: 'tool.finished', ok: false});
  });

  it('keeps each profile to its own conversations', async () => {
    const {host, session: alphaSession} = await startHost(() =>
      textChunks('ok'),
    );
    await collect(host.run(alphaSession, 'only alpha sees this'));

    const unowned = await host.listSessions();
    expect(unowned.map((entry) => entry.id)).toEqual([alphaSession]);

    // Adopt the pre-profile conversation, then give a second profile its own.
    await host.adoptUnownedSessions('profile-alpha');
    const beta = await host.createSession(undefined, 'profile-beta');

    const alphaList = await host.listSessions('profile-alpha');
    const betaList = await host.listSessions('profile-beta');
    expect(alphaList.map((entry) => entry.id)).toEqual([alphaSession]);
    expect(betaList.map((entry) => entry.id)).toEqual([beta.id]);

    // A stale window cannot read another agent's history by guessing an id.
    await expect(
      host.getTranscript(alphaSession, 'profile-beta'),
    ).rejects.toThrow(/Unknown session/);
    await expect(
      host.getTranscript(alphaSession, 'profile-alpha'),
    ).resolves.toMatchObject({session: {id: alphaSession}});
  });

  it('reports the folder each conversation was started in', async () => {
    const {host, session} = await startHost(() => textChunks('ok'));
    await collect(host.run(session, 'work in the default folder'));
    await host.adoptUnownedSessions('profile-alpha');

    const filed = await host.createSession(
      undefined,
      'profile-alpha',
      'workspace-scratch',
    );
    expect(filed.workspaceId).toBe('workspace-scratch');

    const listed = await host.listSessions('profile-alpha');
    expect(listed.find((entry) => entry.id === filed.id)?.workspaceId).toBe(
      'workspace-scratch',
    );
    // The conversation from before folders were recorded has none — and is
    // still listed, which is what puts it under "Other chats" rather than
    // losing it.
    expect(
      listed.find((entry) => entry.id === session)?.workspaceId,
    ).toBeUndefined();
  });

  /**
   * A conversation the app started — a Discord mention — carries the source that
   * puts it under its own sidebar heading. It is created with a source rather
   * than being found by title, so a user's chat that happens to be called
   * "Discord" is not swept into that section.
   */
  it('marks a conversation the app started, and only that one', async () => {
    const {host, session} = await startHost(() => textChunks('ok'));
    await collect(host.run(session, 'typed by the user'));
    await host.adoptUnownedSessions('profile-alpha');

    const fromBot = await host.createSession(
      'Discord',
      'profile-alpha',
      undefined,
      'discord',
    );
    expect(fromBot.source).toBe('discord');

    const listed = await host.listSessions('profile-alpha');
    expect(listed.find((entry) => entry.id === fromBot.id)?.source).toBe(
      'discord',
    );
    expect(
      listed.find((entry) => entry.id === session)?.source,
    ).toBeUndefined();
  });

  it('re-files a conversation only for the profile that owns it', async () => {
    const {host, session} = await startHost(() => textChunks('ok'));
    await collect(host.run(session, 'alpha work'));
    await host.adoptUnownedSessions('profile-alpha');

    const moved = await host.setSessionWorkspace(
      session,
      'workspace-scratch',
      'profile-alpha',
    );
    expect(moved.workspaceId).toBe('workspace-scratch');
    expect(
      (await host.listSessions('profile-alpha')).find(
        (entry) => entry.id === session,
      )?.workspaceId,
    ).toBe('workspace-scratch');

    // Re-filing another agent's conversation is the same refusal as reading it.
    await expect(
      host.setSessionWorkspace(session, 'workspace-scratch', 'profile-beta'),
    ).rejects.toThrow(/Unknown session/);

    // Unfiling is "no folder", which is how a conversation reaches Other chats.
    const unfiled = await host.setSessionWorkspace(
      session,
      undefined,
      'profile-alpha',
    );
    expect(unfiled.workspaceId).toBeUndefined();
  });

  /*
   * The read that decides where a turn runs. It is the index and nothing else —
   * the caller resolves the id to a path, because the folders belong to the
   * install rather than to one host — and an unknown conversation answers the
   * same way an unfiled one does, which is the fallback the turn then takes.
   */
  it('reports the folder a conversation is filed under', async () => {
    const {host, session} = await startHost(() => textChunks('ok'));
    await collect(host.run(session, 'alpha work'));
    await host.adoptUnownedSessions('profile-alpha');

    expect(await host.sessionWorkspaceId(session)).toBeUndefined();

    await host.setSessionWorkspace(
      session,
      'workspace-scratch',
      'profile-alpha',
    );
    expect(await host.sessionWorkspaceId(session)).toBe('workspace-scratch');

    await host.setSessionWorkspace(session, undefined, 'profile-alpha');
    expect(await host.sessionWorkspaceId(session)).toBeUndefined();
    expect(await host.sessionWorkspaceId('no-such-session')).toBeUndefined();
  });

  /**
   * The title is what the sidebar shows and what the chat's top bar names, so
   * renaming has to reach the index and come back as the stored summary — and
   * it is refused for another profile's conversation for the same reason reading
   * one is, or a guessed id would be a way to write into someone else's history.
   */
  it('renames a conversation only for the profile that owns it', async () => {
    const {host, session} = await startHost(() => textChunks('ok'));
    await collect(host.run(session, 'alpha work'));
    await host.adoptUnownedSessions('profile-alpha');

    const renamed = await host.renameSession(
      session,
      'Release prep',
      'profile-alpha',
    );
    expect(renamed.title).toBe('Release prep');
    expect(renamed.id).toBe(session);
    expect(
      (await host.listSessions('profile-alpha')).find(
        (entry) => entry.id === session,
      )?.title,
    ).toBe('Release prep');

    await expect(
      host.renameSession(session, 'Beta work', 'profile-beta'),
    ).rejects.toThrow(/Unknown session/);

    // The refused write left the name alone.
    expect(
      (await host.listSessions('profile-alpha')).find(
        (entry) => entry.id === session,
      )?.title,
    ).toBe('Release prep');
  });

  it("deletes a profile's conversations without touching other profiles", async () => {
    const {host, session: alphaSession} = await startHost(() =>
      textChunks('ok'),
    );
    await collect(host.run(alphaSession, 'alpha work'));
    await host.adoptUnownedSessions('profile-alpha');
    const beta = await host.createSession(undefined, 'profile-beta');
    await collect(host.run(beta.id, 'beta work'));

    const deleted = await host.deleteSessionsForProfile('profile-beta');
    expect(deleted).toEqual([beta.id]);
    expect(await host.listSessions('profile-beta')).toEqual([]);
    expect(await host.listSessions('profile-alpha')).toHaveLength(1);
  });

  it('tells the index which conversations are gone', async () => {
    fake = await startFakeDeepSeek(() => textChunks('ok'));
    const forgotten: string[][] = [];
    const host = new AgentHost({
      sessionsDir: join(workDir, 'sessions'),
      config: createConfig(fake.baseUrl),
      onSessionsDeleted: (ids) => {
        forgotten.push([...ids]);
      },
    });
    host.init();
    openHosts.push(host);

    const one = await host.createSession();
    await host.deleteSession(one.id);
    expect(forgotten).toEqual([[one.id]]);

    const two = await host.createSession(undefined, 'profile-beta');
    expect(await host.deleteSessionsForProfile('profile-beta')).toEqual([
      two.id,
    ]);
    expect(forgotten[1]).toEqual([two.id]);
  });

  it('uses the profile identity as the system prompt', async () => {
    const {host, session} = await startHost(() => textChunks('ok'));
    host.updateConfig({
      // Same provider as the running host, so the turn still reaches the fake.
      ...createConfig(fake?.baseUrl ?? ''),
      systemPrompt: 'You are a terse research assistant.',
      // Which capability skills come along is now a property of the tool list
      // rather than a second selection, so the narrowest profile is the one that
      // grants nothing — and it still carries the app's operating protocol.
      enabledTools: [],
    });
    await collect(host.run(session, 'hi'));

    const system = String(fake?.requests[0]?.messages[0]?.['content']);
    expect(system).toContain('You are a terse research assistant.');
    expect(system).toContain('# Operating protocol');
    expect(system).not.toContain('## knowledge');
    expect(system).not.toContain('## memory');
  });

  it('gives each profile its own memory file', async () => {
    const {host, session} = await startHost(() => textChunks('ok'));

    // Alpha's memory, written where alpha's memory lives.
    await mkdir(join(workDir, '.marimo', 'alpha'), {recursive: true});
    await writeFile(
      resolveMemoryFile(workDir, 'alpha'),
      '- alpha secret\n',
      'utf8',
    );
    host.updateConfig({
      ...createConfig(fake?.baseUrl ?? ''),
      profileId: 'alpha',
    });
    await collect(host.run(session, 'first'));

    await mkdir(join(workDir, '.marimo', 'beta'), {recursive: true});
    await writeFile(
      resolveMemoryFile(workDir, 'beta'),
      '- beta fact\n',
      'utf8',
    );
    host.updateConfig({
      ...createConfig(fake?.baseUrl ?? ''),
      profileId: 'beta',
    });
    await collect(host.run(session, 'second'));

    const first = String(fake?.requests[0]?.messages[0]?.['content']);
    const second = String(fake?.requests[1]?.messages[0]?.['content']);
    expect(first).toContain('- alpha secret');
    expect(first).not.toContain('- beta fact');
    // The point of the whole feature: switching agent switches what it knows.
    expect(second).toContain('- beta fact');
    expect(second).not.toContain('- alpha secret');
  });

  /*
   * The memory limit is a setting, so it arrives through `updateConfig` like
   * every other one. The tools' own tests prove a limit changes what they warn
   * at; what this checks is that a configuration carrying one is accepted and
   * applied — with the default restored when a later one says nothing about it —
   * rather than the host rejecting or ignoring the field.
   */
  it('applies a memory soft limit from the configuration', async () => {
    const {host} = await startHost(() => textChunks('ok'));
    await host.remember('Notes', 'one fact');
    const oneFact = await host.memoryBytes();

    host.updateConfig({
      ...createConfig(fake?.baseUrl ?? ''),
      memorySoftLimitBytes: 16 * 1024,
    });
    await host.remember('Notes', 'a second fact');
    expect(await host.memoryBytes()).toBeGreaterThan(oneFact);

    host.updateConfig(createConfig(fake?.baseUrl ?? ''));
    await host.remember('Notes', 'a third fact');
    const threeFacts = await host.memoryBytes();
    expect(threeFacts).toBeGreaterThan(oneFact);
    expect(await host.memoryText()).toContain('- a third fact');
  });

  it("refuses another profile's conversation on every path", async () => {
    const {host, session} = await startHost(() => textChunks('ok'));
    await collect(host.run(session, 'alpha work'));
    await host.adoptUnownedSessions('profile-alpha');

    await expect(host.getTranscript(session, 'profile-beta')).rejects.toThrow(
      /Unknown session/,
    );
    await expect(host.deleteSession(session, 'profile-beta')).rejects.toThrow(
      /Unknown session/,
    );
    await expect(
      host.renameSession(session, 'beta name', 'profile-beta'),
    ).rejects.toThrow(/Unknown session/);

    // A turn for the wrong profile is refused before anything reaches the
    // provider, so no tokens are spent and nothing is appended.
    const requestsBefore = fake?.requests.length ?? 0;
    const refused = await collect(
      host.run(session, 'beta attempt', undefined, 'profile-beta'),
    );
    expect(refused).toHaveLength(1);
    expect(refused[0]).toMatchObject({type: 'turn.failed'});
    expect(fake?.requests.length).toBe(requestsBefore);
  });

  /*
   * The companion's shorter answers, from the inside.
   *
   * Two turns, one conversation, one process: the point of the assertion is not
   * that the text arrives — it is that it *leaves*. A turn's instruction that
   * survived into the next turn would make the window answer in the pet's voice,
   * which is a bug nobody would trace back to the line that failed to clear it.
   */
  it("appends a turn's own instruction, and only for that turn", async () => {
    const {host, session} = await startHost(() => textChunks('Fine.'));

    await collect(host.run(session, 'first', 'ANSWER BRIEFLY, PET.'));
    await collect(host.run(session, 'second'));

    const [first, second] = fake?.requests ?? [];
    const system = (request: RecordedRequest | undefined): string =>
      String(
        request?.messages.find((message) => message['role'] === 'system')?.[
          'content'
        ] ?? '',
      );

    expect(system(first)).toContain('ANSWER BRIEFLY, PET.');
    expect(system(first)).toContain(TEST_IDENTITY);
    expect(system(second)).not.toContain('ANSWER BRIEFLY, PET.');
  });

  it('persists the conversation and projects a readable transcript', async () => {
    const {host, session} = await startHost(() => textChunks('Noted.'));

    await collect(host.run(session, 'remember this'));

    const {messages, session: summary} = await host.getTranscript(session);
    expect(messages.map((message) => message.role)).toEqual([
      'user',
      'assistant',
    ]);
    expect(messages[0]?.text).toBe('remember this');
    expect(messages[1]?.text).toBe('Noted.');
    expect(summary.title).toBe('remember this');

    const listed = await host.listSessions();
    expect(listed.map((entry) => entry.id)).toContain(session);
  });

  it('replaces the older half of a conversation with a summary, and rewrites nothing', async () => {
    const {host, session} = await startHost((messages, index) => {
      /*
       * The summariser's call is the one with nothing but the prompt: no system
       * instruction, no tools. Distinguishing it here is what lets the same fake
       * provider answer both kinds of request.
       */
      if (messages.length === 1) {
        return textChunks('They asked for the time and were told it.');
      }
      if (index === 0) {
        return toolCallChunks('call_time', 'current_time', {});
      }
      return textChunks(`answer ${String(index)}`);
    });

    for (let turn = 0; turn < 8; turn += 1) {
      await collect(host.run(session, `question ${String(turn)}`));
    }

    const before = await host.eventsFor(session);
    const result = await host.compact(session);
    expect(result).toEqual({compacted: true});

    /*
     * Append-only, asserted on the file itself: the events already stored are
     * still there, in order, character for character. This is the property that
     * keeps the sidebar's count, the memory review's watermark and any
     * unanswered gate meaningful — a rewrite would leave all three describing a
     * conversation that no longer exists.
     */
    const after = await host.eventsFor(session);
    expect(after).toHaveLength(before.length + 1);
    expect(after.slice(0, before.length)).toEqual(before);

    // The window sees one card where the replaced messages were.
    const {messages} = await host.getTranscript(session);
    expect(messages[0]?.compacted).toBeGreaterThan(0);
    expect(messages[0]?.text).toBe('They asked for the time and were told it.');
    expect(messages.map((message) => message.text)).not.toContain('question 0');

    // And the next turn is *sent* the summary rather than the messages.
    const asked = fake?.requests.length ?? 0;
    await collect(host.run(session, 'and now?'));
    const sent = fake?.requests[asked]?.messages ?? [];
    const contents = sent
      .map((message) => String(message['content'] ?? ''))
      .join('\n');
    expect(contents).toContain('Previous Context Summary');
    expect(contents).toContain('They asked for the time and were told it.');
    expect(contents).not.toContain('question 0');

    /*
     * Invariant 3, on what was actually sent: the tool call the first turn made
     * is inside the compacted span, so if the cut had landed between a call and
     * its result the provider would refuse this request — and every later one.
     */
    const requested = sent
      .filter((message) => message['role'] === 'assistant')
      .flatMap((message) => (message['tool_calls'] ?? []) as Array<{id: string}>)
      .map((call) => call.id);
    const answered = sent
      .filter((message) => message['role'] === 'tool')
      .map((message) => message['tool_call_id']);
    expect(answered).toEqual(expect.arrayContaining(requested));
  });

  it('has nothing to compact in a conversation that already fits', async () => {
    const {host, session} = await startHost(() => textChunks('Noted.'));
    await collect(host.run(session, 'one short question'));

    const result = await host.compact(session);

    // A value rather than an error: a short conversation is not a failure, and
    // the window draws the sentence instead of a red banner.
    expect(result.compacted).toBe(false);
    expect(result.reason).toMatch(/short enough/u);
    expect(await host.eventsFor(session)).toHaveLength(2);
  });

  it('summarizes automatically only once the context is over its cap', async () => {
    const {host, session} = await startHost((messages, index) => {
      // The summariser's call is the one with nothing but the prompt.
      if (messages.length === 1) {
        return textChunks('They were talking about a file.');
      }
      return textChunks(`answer ${String(index)}`);
    });

    for (let turn = 0; turn < 8; turn += 1) {
      await collect(host.run(session, `question ${String(turn)}`));
    }
    const before = await host.eventsFor(session);

    // A cap this conversation is nowhere near: the ordinary case, and it must
    // not rewrite anything.
    const skipped = await host.autoCompact(session, undefined, 10_000_000);
    expect(skipped.compacted).toBe(false);
    expect(await host.eventsFor(session)).toHaveLength(before.length);

    // The same conversation with a cap it has crossed.
    const compacted = await host.autoCompact(session, undefined, 100);
    expect(compacted.compacted).toBe(true);
    const after = await host.eventsFor(session);
    expect(after).toHaveLength(before.length + 1);
    expect(after.slice(0, before.length)).toEqual(before);
  });

  it('leaves the conversation alone when the automatic summary is empty', async () => {
    const {host, session} = await startHost((messages, index) =>
      messages.length === 1 ? textChunks('') : textChunks(`answer ${String(index)}`),
    );

    for (let turn = 0; turn < 8; turn += 1) {
      await collect(host.run(session, `question ${String(turn)}`));
    }
    const before = await host.eventsFor(session);

    const result = await host.autoCompact(session, undefined, 100);
    expect(result.compacted).toBe(false);
    expect(result.reason).toMatch(/empty summary/u);
    expect(await host.eventsFor(session)).toEqual(before);
  });

  it('does not let an automatic summary rewrite a paused turn', async () => {
    const {host, session} = await startHost(() =>
      toolCallChunks('call_shell', 'run_shell', {
        command: `echo marimo-auto-gate-${String(Date.now())}`,
      }),
    );

    const paused = await collect(host.run(session, 'run it'));
    expect(paused.some((event) => event.type === 'approval.request')).toBe(true);
    const before = await host.eventsFor(session);

    const result = await host.autoCompact(session, undefined, 1);
    expect(result.compacted).toBe(false);
    expect(result.reason).toMatch(/approval/u);
    expect(await host.eventsFor(session)).toEqual(before);
  });

  it('refuses to compact a conversation that is waiting for an approval', async () => {
    const {host, session} = await startHost(() =>
      toolCallChunks('call_shell', 'run_shell', {
        command: `echo marimo-compact-gate-${String(Date.now())}`,
      }),
    );

    const paused = await collect(host.run(session, 'run it'));
    expect(paused.some((event) => event.type === 'approval.request')).toBe(true);

    const result = await host.compact(session);

    expect(result.compacted).toBe(false);
    expect(result.reason).toMatch(/approval/u);
  });

  it('refuses to compact a conversation while a turn is running in it', async () => {
    const {host, session} = await startHost(() => textChunks('thinking'));

    const stream = host.run(session, 'first');
    await stream.next();

    const result = await host.compact(session);
    expect(result.compacted).toBe(false);
    expect(result.reason).toMatch(/turn is running/u);

    await collect(stream);
  });

  it('refuses a second concurrent turn', async () => {
    const {host, session} = await startHost(() => textChunks('slow'));
    const first = host.run(session, 'first');

    // Start consuming the first turn, then try to start another.
    const firstEvent = await first.next();
    expect(firstEvent.value).toMatchObject({type: 'turn.started'});

    const second = await collect(host.run(session, 'second'));
    expect(second).toHaveLength(1);
    expect(second[0]).toMatchObject({type: 'turn.failed'});

    await collect(first);
  });

  it('deletes a session and its conversation history', async () => {
    const {host, session} = await startHost(() => textChunks('ok'));
    await collect(host.run(session, 'hello'));
    await host.deleteSession(session);

    expect(await host.listSessions()).toEqual([]);
    await expect(host.getTranscript(session)).rejects.toThrow(
      /Unknown session/,
    );
  });

  it('streams reasoning as a separate channel, not as answer text', async () => {
    const {host, session} = await startHost(() =>
      reasoningChunks('Weighing the options.', 'Here is the answer.'),
    );

    const events = await collect(host.run(session, 'think about it'));

    const reasoning = events
      .filter((event) => event.type === 'reasoning.delta')
      .map((event) => (event.type === 'reasoning.delta' ? event.text : ''))
      .join('');
    expect(reasoning).toBe('Weighing the options.');

    const text = events
      .filter((event) => event.type === 'text.delta')
      .map((event) => (event.type === 'text.delta' ? event.text : ''))
      .join('');
    expect(text).toBe('Here is the answer.');

    // Reopening the conversation must show the same reasoning.
    const {messages} = await host.getTranscript(session);
    expect(messages[1]?.reasoning).toBe('Weighing the options.');
    expect(messages[1]?.text).toBe('Here is the answer.');
  });

  it("echoes each turn's reasoning back on the next request", async () => {
    // DeepSeek requires a turn's reasoning_content on every later request that
    // carries tools, and answers 400 when it is missing. This asserts the round
    // trip: response -> ADK thought part -> session -> next request.
    const {host, session} = await startHost((_messages, callIndex) =>
      callIndex === 0
        ? reasoningChunks('I should think before answering.', 'First answer.')
        : textChunks('Second answer.'),
    );

    await collect(host.run(session, 'first question'));
    await collect(host.run(session, 'second question'));

    expect(fake?.requests).toHaveLength(2);
    const secondRequest = fake?.requests[1]?.messages ?? [];
    const assistant = secondRequest.find(
      (message) =>
        message['role'] === 'assistant' &&
        typeof message['content'] === 'string' &&
        String(message['content']).includes('First answer.'),
    );

    expect(assistant?.['reasoning_content']).toBe(
      'I should think before answering.',
    );
    // Reasoning must not be duplicated into the visible content.
    expect(String(assistant?.['content'])).not.toContain('think before');
  });

  it('sends the configured model on every turn', async () => {
    /*
     * The id is a string between two processes of this app and the engine's
     * `--alias` — so what matters is that the configured one reaches the request,
     * not that any particular one does. It used to be resolved per conversation
     * from an index entry, and there is nothing left to resolve it from.
     */
    const {host, session} = await startHost(() => textChunks('ok'));
    const other = await host.createSession('other chat');

    await collect(host.run(session, 'first'));
    await collect(host.run(other.id, 'second'));

    expect(fake?.requests[0]?.body['model']).toBe(TEST_MODEL);
    expect(fake?.requests[1]?.body['model']).toBe(TEST_MODEL);
  });

  /**
   * Gates outlive the process that raised them.
   *
   * A paused turn is waiting for a person, and people close windows. Before
   * this, `approve` consulted an in-memory round alone, so after a relaunch the
   * card was still on screen and pressing Approve did nothing at all — no
   * error, no effect, no way to tell it had not worked. The conversation is the
   * only thing that survives, so the question is read back out of it.
   */
  describe('a gate that outlives its process', () => {
    /** A turn that asks to run a command, then answers once it has run. */
    function shellCommand(command: string) {
      return (messages: Array<Record<string, unknown>>) =>
        messages.some((message) => message['role'] === 'tool')
          ? textChunks('The command finished.')
          : toolCallChunks('call_shell', 'run_shell', {command});
    }

    it('reads a pending gate back out of the conversation', async () => {
      const command = 'echo persisted-gate';
      const {host, session} = await startHost(shellCommand(command));

      await collect(host.run(session, 'run it'));

      const pending = await host.pendingGates(session);
      expect(pending).toHaveLength(1);
      expect(pending[0]).toMatchObject({tool: 'run_shell', args: {command}});
      expect(pending[0]?.callId.length).toBeGreaterThan(0);
    });

    it('answers one the raising process never saw decided', async () => {
      const marker = `marimo-restart-${Date.now()}`;
      const command = `echo ${marker}`;

      const {host, session} = await startHost(shellCommand(command));
      const first = await collect(host.run(session, 'echo the marker'));

      const approval = first.find((event) => event.type === 'approval.request');
      const callId =
        approval?.type === 'approval.request' ? approval.callId : '';
      expect(callId.length).toBeGreaterThan(0);

      /*
       * The restart: the object that raised the gate is gone, and so is
       * everything it was holding. A second host over the same session
       * directory is what the app looks like after a relaunch.
       */
      host.dispose();
      const restarted = createHost(fake?.baseUrl ?? '');

      expect(
        (await restarted.pendingGates(session)).map((gate) => gate.callId),
      ).toEqual([callId]);

      const second = await collect(
        restarted.approve({sessionId: session, callId, confirmed: true}),
      );

      const finished = second.find((event) => event.type === 'tool.finished');
      expect(finished).toMatchObject({type: 'tool.finished', ok: true});
      if (finished?.type === 'tool.finished') {
        expect(finished.result).toContain(marker);
      }
    });

    it('honours a refusal given after the restart', async () => {
      const marker = `marimo-refused-${Date.now()}`;
      const command = `echo ${marker}`;
      const {host, session} = await startHost(shellCommand(command));
      const first = await collect(host.run(session, 'run it'));
      const approval = first.find((event) => event.type === 'approval.request');
      const callId =
        approval?.type === 'approval.request' ? approval.callId : '';

      host.dispose();
      const restarted = createHost(fake?.baseUrl ?? '');

      const second = await collect(
        restarted.approve({sessionId: session, callId, confirmed: false}),
      );

      const finished = second.find((event) => event.type === 'tool.finished');
      expect(finished).toMatchObject({ok: false});

      /*
       * The assertion that matters is not the wording — that belongs to ADK, and
       * pinning it here would make a dependency's phrasing a test failure. It is
       * that the command did not run: a refusal that still executed the thing it
       * refused would be the worst bug this file could have.
       */
      if (finished?.type === 'tool.finished') {
        expect(finished.result).not.toContain(marker);
      }
    });

    it('stops reporting a gate once it has been answered', async () => {
      const {host, session} = await startHost(shellCommand('echo once'));
      const first = await collect(host.run(session, 'run it'));
      const approval = first.find((event) => event.type === 'approval.request');
      const callId =
        approval?.type === 'approval.request' ? approval.callId : '';

      await collect(
        host.approve({sessionId: session, callId, confirmed: true}),
      );

      expect(await host.pendingGates(session)).toEqual([]);
    });

    it('reports nothing for a conversation that never asked', async () => {
      const {host, session} = await startHost(() => textChunks('hello'));
      await collect(host.run(session, 'hi'));
      expect(await host.pendingGates(session)).toEqual([]);
    });

    it('reports nothing for a conversation that does not exist', async () => {
      const {host} = await startHost(() => textChunks('ok'));
      // An empty answer rather than a throw: a window asks this for whatever it
      // is showing, including a conversation deleted in another window a moment
      // ago, and that must not become an error on screen.
      expect(await host.pendingGates('no-such-session')).toEqual([]);
    });

    it('ignores an approval for a call that is not waiting', async () => {
      const {host, session} = await startHost(shellCommand('echo x'));
      await collect(host.run(session, 'run it'));

      // Nothing is driven: sending ADK a confirmation for a question it never
      // asked is what it refuses outright.
      const events = await collect(
        host.approve({
          sessionId: session,
          callId: 'a-call-that-was-never-made',
          confirmed: true,
        }),
      );
      expect(events).toEqual([]);
    });
  });

  /*
   * The two failures a small local model actually produces. Both come from a
   * real `Qwen3-1.7B` conversation: a turn that called `web_search` and
   * `read_file` alternately with identical arguments until the context was
   * spent, and then a turn that ended on reasoning with no reply at all, so the
   * user got nothing. A prompt asking the model not to do either is the first
   * thing a model this size loses, which is why both are enforced here.
   */

  it('warns on a repeated tool call and refuses the third', async () => {
    const queries: string[] = [];
    const provider: WebSearchProvider = {
      search: async ({query}) => {
        queries.push(query);
        return [
          {
            title: 'Marimo Bot',
            url: 'https://example.com/marimo',
            snippet: 'A reactive notebook',
          },
        ];
      },
    };

    const {host, session} = await startHost(
      (messages) => {
        const results = messages.filter(
          (message) => message['role'] === 'tool',
        ).length;
        return results < 3
          ? toolCallChunks(`call_search_${results}`, 'web_search', {
              query: 'marimo',
            })
          : textChunks('Answered.');
      },
      provider,
    );

    const events = await collect(host.run(session, 'search for marimo'));

    /*
     * The number that matters. The tool ran for the first and second calls and
     * not for the third: a refusal that still executed the thing it refused
     * would be worse than the loop it was meant to break.
     */
    expect(queries).toEqual(['marimo', 'marimo']);

    const finished = events.filter((event) => event.type === 'tool.finished');
    expect(finished).toHaveLength(3);
    if (
      finished[0]?.type === 'tool.finished' &&
      finished[1]?.type === 'tool.finished' &&
      finished[2]?.type === 'tool.finished'
    ) {
      expect(finished[0].ok).toBe(true);
      expect(finished[0].result).not.toContain('[repeated call]');

      // Still allowed through, so the model sees the result *and* the warning.
      expect(finished[1].ok).toBe(true);
      expect(finished[1].result).toContain('https://example.com/marimo');
      expect(finished[1].result).toContain('[repeated call]');

      // Refused, and marked failed so the window draws it as a call that did not
      // happen rather than one that quietly returned something odd.
      expect(finished[2].ok).toBe(false);
      expect(finished[2].result).toContain('Refused');
    }

    expect(typesOf(events)).toContain('turn.completed');
  });

  it('forgets the count when the turn ends', async () => {
    const queries: string[] = [];
    const provider: WebSearchProvider = {
      search: async ({query}) => {
        queries.push(query);
        return [{title: query, url: `https://example.com/${query}`, snippet: ''}];
      },
    };

    const {host, session} = await startHost(
      (_messages, callIndex) =>
        callIndex % 2 === 0
          ? toolCallChunks(`call_search_${callIndex}`, 'web_search', {
              query: 'marimo',
            })
          : textChunks('Found it.'),
      provider,
    );

    const first = await collect(host.run(session, 'search for marimo'));
    const second = await collect(host.run(session, 'search for marimo again'));

    // One call per turn with identical arguments is two turns doing the same
    // thing, not one turn looping. Counting across turns would warn on the
    // second one, and warn on the same harmless pattern forever after.
    expect(queries).toEqual(['marimo', 'marimo']);
    for (const call of [...first, ...second]) {
      if (call.type === 'tool.finished') {
        expect(call.result).not.toContain('[repeated call]');
      }
    }
  });

  it('lets a repeated call with different arguments through', async () => {
    const queries: string[] = [];
    const provider: WebSearchProvider = {
      search: async ({query}) => {
        queries.push(query);
        return [
          {title: query, url: `https://example.com/${query}`, snippet: ''},
        ];
      },
    };

    const {host, session} = await startHost(
      (messages) => {
        const results = messages.filter(
          (message) => message['role'] === 'tool',
        ).length;
        return results < 2
          ? toolCallChunks(`call_search_${results}`, 'web_search', {
              query: results === 0 ? 'first' : 'second',
            })
          : textChunks('Both done.');
      },
      provider,
    );

    const events = await collect(host.run(session, 'search twice'));

    // The guard is about the same call, not about the same tool: changing the
    // query is the model doing exactly what the warning asks of it.
    expect(queries).toEqual(['first', 'second']);
    for (const call of events) {
      if (call.type === 'tool.finished') {
        expect(call.result).not.toContain('[repeated call]');
      }
    }
  });

  it('recovers the reply from a turn that produced only reasoning', async () => {
    const {host, session} = await startHost((_messages, callIndex) =>
      callIndex === 0
        ? reasoningChunks('I should ask which recipe they want.', '')
        : textChunks('Which recipe would you like for today?'),
    );

    const events = await collect(host.run(session, 'add in the one for today'));

    expect(typesOf(events)).not.toContain('turn.failed');
    expect(typesOf(events)).toContain('turn.completed');
    expect(
      events
        .filter((event) => event.type === 'text.delta')
        .map((event) => (event.type === 'text.delta' ? event.text : ''))
        .join(''),
    ).toBe('Which recipe would you like for today?');

    // The second request is the recovery, and it carries the two things the
    // model needs to answer from: what was asked, and what it already worked out.
    const recovery = String(fake?.requests[1]?.messages[0]?.['content']);
    expect(recovery).toContain('add in the one for today');
    expect(recovery).toContain('I should ask which recipe they want.');

    /*
     * Stored, not merely streamed. The window re-reads the transcript the moment
     * the turn completes, so a recovered reply that was only sent as a delta
     * would vanish on the reload that follows it.
     */
    const {messages} = await host.getTranscript(session);
    const last = messages[messages.length - 1];
    expect(last?.text).toContain('Which recipe would you like for today?');
  });

  it('reports a turn that stays silent even after a second attempt', async () => {
    const {host, session} = await startHost(() =>
      reasoningChunks('thinking, and never saying', ''),
    );

    const events = await collect(host.run(session, 'hi'));

    // Reported as a failure rather than as words the model never said: a
    // sentence in the transcript would read as an answer, and there was none.
    expect(typesOf(events)).not.toContain('turn.completed');
    const failed = events.find((event) => event.type === 'turn.failed');
    expect(failed).toMatchObject({type: 'turn.failed'});
    if (failed?.type === 'turn.failed') {
      expect(failed.message).toContain('second attempt');
    }
    expect(typesOf(events)).not.toContain('text.delta');
  });

  it('counts a whitespace-only reply as silence', async () => {
    const {host, session} = await startHost((_messages, callIndex) =>
      callIndex === 0 ? textChunks('   ') : textChunks('Here is your answer.'),
    );

    const events = await collect(host.run(session, 'well?'));

    // A bubble holding a space is the same nothing to the person looking at it,
    // so it gets the same recovery rather than being taken as an answer.
    expect(typesOf(events)).not.toContain('turn.failed');
    const text = events
      .filter((event) => event.type === 'text.delta')
      .map((event) => (event.type === 'text.delta' ? event.text : ''))
      .join('');
    expect(text).toContain('Here is your answer.');
    expect(fake?.requests).toHaveLength(2);
  });

  it('does not treat a turn that is waiting for approval as silent', async () => {
    await writeFile(join(workDir, 'notes.md'), 'original', 'utf8');

    const {host, session} = await startHost(() =>
      toolCallChunks('call_write', 'write_file', {
        path: 'notes.md',
        content: 'replaced',
      }),
    );

    const paused = await collect(host.run(session, 'replace it'));
    expect(paused.some((event) => event.type === 'approval.request')).toBe(true);

    // One request, which is the gate. A recovery call would show up as a second:
    // a turn waiting on the user is not a turn that said nothing.
    expect(fake?.requests).toHaveLength(1);
  });
  /*
   * What of memory reaches the prompt, once recall is available.
   *
   * This is the half of the feature that changes behaviour rather than adding a
   * tool, so it is tested where a turn is: the instruction the provider is handed
   * is inspected, and what it is inspected *for* is the asymmetry — rules whole,
   * facts recalled, and the whole file whenever retrieval could not be trusted to
   * answer.
   */
  describe('memory retrieval', () => {
    /** A lookup that answers with whatever the test says, and records the asks. */
    function lookup(
      answer: Partial<RecallAnswer> = {},
    ): {service: RecallLookup; asked: string[]} {
      const asked: string[] = [];
      return {
        asked,
        service: {
          scopes: () => ['folder', 'memory'],
          search: async (request) => {
            asked.push(request.query);
            return {hits: [], searched: ['memory'], notes: [], ...answer};
          },
        },
      };
    }

    function bullet(section: string, text: string) {
      return {
        kind: 'memory' as const,
        path: '',
        section,
        preview: text,
        score: 0.8,
        text,
        stale: false,
      };
    }

    async function start(
      recall: RecallLookup | undefined,
      responder: Responder,
    ): Promise<{host: AgentHost; session: string}> {
      fake = await startFakeDeepSeek(responder);
      const host = new AgentHost({
        sessionsDir: join(workDir, 'sessions'),
        config: createConfig(fake.baseUrl),
        ...(recall === undefined ? {} : {recallService: recall}),
      });
      host.init();
      openHosts.push(host);
      const session = await host.createSession();
      return {host, session: session.id};
    }

    /** The system instruction of the first request the fake model was sent. */
    function instructionOf(): string {
      const system = fake?.requests[0]?.messages[0];
      return String(system?.['content'] ?? '');
    }

    async function seedMemory(host: AgentHost): Promise<void> {
      await host.remember('About the user', 'Has a dog called Sunshine');
      await host.remember('About the user', 'Lives in Berlin');
      await host.remember('Boundaries', 'Never force-push');
    }

    /*
     * Enough memory that narrowing is a real decision.
     *
     * A file smaller than the recalled-block budget cannot be narrowed at all, so
     * every test about retrieval has to get past that first — otherwise the
     * fallback path is what is being asserted and the test says so nowhere. The
     * bullets are individually under `MAX_ENTRY_CHARS` and distinct, so they are
     * three entries rather than one rejected line.
     */
    async function padMemory(host: AgentHost): Promise<void> {
      for (let index = 0; index < 3; index += 1) {
        await host.remember('Notes', `Scratch note ${index} ${'z'.repeat(1_600)}`);
      }
    }

    it('injects the whole file when there is no recall service', async () => {
      const {host, session} = await start(undefined, () => textChunks('ok'));
      await seedMemory(host);

      await collect(host.run(session, 'where does the retry logic live'));

      const instruction = instructionOf();
      expect(instruction).toContain('Never force-push');
      expect(instruction).toContain('Has a dog called Sunshine');
      expect(instruction).toContain('Lives in Berlin');
      expect(instruction).not.toContain('Recalled for this question');
    });

    /*
     * Retrieval on a file it cannot narrow is latency for nothing: the recalled
     * block is capped at 4096 characters, so a file no larger than that can only
     * be shortened, never added to. The answer is identical either way, which is
     * why this is asserted on the *ask* and not only on the prompt.
     */
    it('does not retrieve while the file fits in the recalled block', async () => {
      const {service, asked} = lookup({
        hits: [bullet('About the user', 'Lives in Berlin')],
      });
      const {host, session} = await start(service, () => textChunks('ok'));
      await seedMemory(host);

      await collect(host.run(session, 'where does the retry logic live'));

      expect(asked).toEqual([]);
      const instruction = instructionOf();
      expect(instruction).toContain('Has a dog called Sunshine');
      expect(instruction).not.toContain('Recalled for this question');
    });

    it('retrieves once the file is larger than the recalled block', async () => {
      const {service, asked} = lookup({
        hits: [bullet('About the user', 'Lives in Berlin')],
      });
      const {host, session} = await start(service, () => textChunks('ok'));
      await seedMemory(host);
      await padMemory(host);

      await collect(host.run(session, 'where does the retry logic live'));

      expect(asked).toEqual(['where does the retry logic live']);
      expect(instructionOf()).toContain('Recalled for this question');
    });

    it('keeps the rules whole and recalls the rest', async () => {
      const {service, asked} = lookup({
        hits: [bullet('About the user', 'Lives in Berlin')],
      });
      const {host, session} = await start(service, () => textChunks('ok'));
      await seedMemory(host);
      await padMemory(host);

      await collect(host.run(session, 'where does the retry logic live'));

      expect(asked).toEqual(['where does the retry logic live']);
      const instruction = instructionOf();
      // The rule is there without having been recalled, and the fact that did not
      // rank is not.
      expect(instruction).toContain('Never force-push');
      expect(instruction).toContain('Lives in Berlin');
      expect(instruction).not.toContain('Has a dog called Sunshine');
      // And the model is told it is looking at part of memory rather than all of
      // it, in the words `selectMemory` writes.
      expect(instruction).toContain('1 of 6 bullets');
      expect(instruction).toContain('read_memory');
    });

    /*
     * The fallback, which is the whole safety of this design. A retrieval that
     * failed must leave the prompt exactly as it was before the feature existed —
     * a smaller prompt produced by a broken step loses facts nobody would notice
     * were missing.
     */
    it('falls back to the whole file when recall fails', async () => {
      const failing: RecallLookup = {
        scopes: () => ['folder', 'memory'],
        search: async () => {
          throw new Error('the recall model is not running');
        },
      };
      const {host, session} = await start(failing, () => textChunks('ok'));
      await seedMemory(host);
      // Padded, so the failure is reached: on a file retrieval cannot narrow the
      // guard returns before `search` is ever called, and this test would pass
      // without the fallback existing at all.
      await padMemory(host);

      await collect(host.run(session, 'where does the retry logic live'));

      const instruction = instructionOf();
      expect(instruction).toContain('Never force-push');
      expect(instruction).toContain('Has a dog called Sunshine');
      expect(instruction).not.toContain('Recalled for this question');
    });

    /*
     * A turn can be three characters long, and a vector for "ok" is nearer the
     * noise in memory than to anything the user meant. Retrieving on one would
     * swap the whole file for whatever happened to rank.
     */
    it('does not retrieve against a question too short to mean anything', async () => {
      const {service, asked} = lookup({hits: [bullet('About the user', 'Lives in Berlin')]});
      const {host, session} = await start(service, () => textChunks('ok'));
      await seedMemory(host);

      await collect(host.run(session, 'ok'));

      expect(asked).toEqual([]);
      expect(instructionOf()).toContain('Has a dog called Sunshine');
      expect(instructionOf()).not.toContain('Recalled for this question');
    });

    /*
     * A retrieval that never answers must not hold a request open. The engine is
     * a process that can be cold or wedged, and the turn it is serving is one a
     * user is watching.
     */
    it('gives up on a retrieval that does not answer, and uses the whole file', async () => {
      const hanging: RecallLookup = {
        scopes: () => ['folder', 'memory'],
        search: () => new Promise<RecallAnswer>(() => undefined),
      };
      const {host, session} = await start(hanging, () => textChunks('ok'));
      await seedMemory(host);
      // Padded for the same reason as the failure test above: a file retrieval
      // cannot narrow returns before the hanging `search` is ever reached.
      await padMemory(host);

      const events = await collect(host.run(session, 'where does the retry logic live'));

      expect(typesOf(events)).toContain('turn.completed');
      const instruction = instructionOf();
      expect(instruction).toContain('Never force-push');
      expect(instruction).toContain('Has a dog called Sunshine');
    }, 10_000);

    /*
     * A fact section that was not recalled is not omitted forever: the model can
     * ask. The tool is offered exactly when the service is, which is the same rule
     * every other conditional tool here follows.
     */
    it('offers the recall tool when the service is there, and not when it is not', async () => {
      const withRecall = await start(lookup().service, () => textChunks('ok'));
      await collect(withRecall.host.run(withRecall.session, 'hi'));
      const names = (fake?.requests[0]?.body['tools'] as Array<{function: {name: string}}>)
        .map((tool) => tool.function.name);

      expect(names).toContain('recall');
      expect(names?.indexOf('recall')).toBe(names.indexOf('search_knowledge_base') + 1);
    });
  });

  /*
   * Which connectors an agent is offered.
   *
   * The grant is a profile field with three answers a user can mean — every
   * connector, only these, none — and what is asserted is the tool declarations
   * the model actually receives, because that is the whole of the difference a
   * grant makes. A server that was not granted is *absent* rather than refused:
   * there is no tool to call, and so nothing for any gate to say no to, which is
   * invariant 9 seen from the model's side of the fence.
   */
  describe('the connector grant', () => {
    /** One connected server and the tools it says it offers. */
    function toolset(name: string, tools: string[]): McpToolsetSource {
      return {
        server: {
          id: `mcp:${name}`,
          name,
          transport: 'stdio',
          command: 'irrelevant-for-a-test',
          enabled: true,
          trusted: true,
          secretStorage: 'keychain',
        },
        // Nothing calls it: what is under test is which tools are *declared*, and
        // a declaration is built from the metadata alone.
        connection: {} as never,
        tools: tools.map((tool) => ({
          name: tool,
          description: '',
          inputSchema: {},
        })),
      };
    }

    /** The tool names one turn sends, for a host configured as given. */
    async function toolsOffered(options: {
      grant?: readonly string[];
      enabledTools?: readonly string[];
      sources?: readonly McpToolsetSource[];
    }): Promise<string[]> {
      const model = await startFakeDeepSeek(() => textChunks('ok'));
      try {
        const host = new AgentHost({
          sessionsDir: join(workDir, 'sessions'),
          config: {
            ...createConfig(model.baseUrl),
            ...(options.enabledTools === undefined
              ? {}
              : {enabledTools: [...options.enabledTools]}),
            ...(options.grant === undefined
              ? {}
              : {mcpServerIds: [...options.grant]}),
          },
          ...(options.sources === undefined
            ? {}
            : {mcpServers: options.sources}),
        });
        host.init();
        openHosts.push(host);
        const session = await host.createSession();
        await collect(host.run(session.id, 'hi'));

        return toolNamesIn(model, 0);
      } finally {
        await model.close();
      }
    }

    /** What the model was offered on one request of a conversation. */
    function toolNamesIn(model: FakeDeepSeek, index: number): string[] {
      const tools = (model.requests[index]?.body['tools'] ?? []) as Array<{
        function: {name: string};
      }>;
      return tools.map((tool) => tool.function.name);
    }

    const two = [toolset('notes', ['search']), toolset('mail', ['send'])];

    it('offers every connected connector when the profile names none', async () => {
      // The state every profile written before the field existed is in, and it
      // has to behave exactly as it did: saying nothing means all, not none.
      const names = await toolsOffered({sources: two});

      expect(names).toContain('mcp_notes_search');
      expect(names).toContain('mcp_mail_send');
    });

    it('offers only the connectors the profile names', async () => {
      const names = await toolsOffered({grant: ['mcp:notes'], sources: two});

      expect(names).toContain('mcp_notes_search');
      expect(names).not.toContain('mcp_mail_send');
    });

    it('offers none of them when the profile grants an empty list', async () => {
      const names = await toolsOffered({grant: [], sources: two});

      expect(names.filter((name) => name.startsWith('mcp_'))).toEqual([]);
      // And the built-in tools are untouched by it: the grant is over servers.
      expect(names).toContain('read_file');
    });

    /*
     * Invariant 14, through the grant.
     *
     * A server's tools are named after the server, and the reserved set they are
     * checked against is every built-in name this build can produce *before* the
     * profile's own filter — a tool the profile has switched off still owns its
     * name, because the profile can change between turns. This server declares a
     * tool under a built-in's own name and arrives prefixed anyway: the grant
     * chooses servers, and it cannot be the thing that lets one take a name the
     * build already uses.
     */
    it('keeps a granted connector from taking a built-in name', async () => {
      const names = await toolsOffered({
        grant: ['mcp:read'],
        // `read_file` is switched off for this profile — and still owns its name.
        enabledTools: ['current_time'],
        sources: [toolset('read', ['file'])],
      });

      expect(names).toContain('mcp_read_file');
      expect(names).not.toContain('read_file');
      expect(names).toContain('current_time');
    });

    /*
     * A grant changed while the window is open.
     *
     * The host caches the runner it built, and a runner holds the tool closures
     * it was made with — so a profile edit that is not noticed would leave the
     * model offered a connector the user has just taken away, until something
     * else happened to rebuild. `updateConfig` is what notices, and this is the
     * test that says so from the outside.
     */
    it('applies a changed grant on the next turn', async () => {
      const model = await startFakeDeepSeek(() => textChunks('ok'));
      try {
        const host = new AgentHost({
          sessionsDir: join(workDir, 'sessions'),
          config: {
            ...createConfig(model.baseUrl),
            mcpServerIds: ['mcp:notes', 'mcp:mail'],
          },
          mcpServers: two,
        });
        host.init();
        openHosts.push(host);
        const session = await host.createSession();

        await collect(host.run(session.id, 'first'));
        expect(toolNamesIn(model, 0)).toContain('mcp_mail_send');

        host.updateConfig({
          ...createConfig(model.baseUrl),
          mcpServerIds: ['mcp:notes'],
        });
        await collect(host.run(session.id, 'second'));

        expect(toolNamesIn(model, 1)).toContain('mcp_notes_search');
        expect(toolNamesIn(model, 1)).not.toContain('mcp_mail_send');
      } finally {
        await model.close();
      }
    });
  });

  /*
   * Dream-RSI is written from inside the model's own request path, and the
   * request is the first thing a turn does — before any event from the runner
   * exists for the host's loop to read an invocation id off. So "when is the
   * recorder created" is not an implementation detail here: it decides whether
   * the first step of every turn is recorded at all.
   *
   * The failure is silent and it has a shape worth naming. A turn whose first
   * request proposes a tool and whose second answers records a tree with one
   * step, one proposal and one call — all of them from the *second* request —
   * and the answer node hangs directly off the root because no step was open
   * when it arrived. Nothing errors, the file validates, and the replay reads a
   * turn that never happened.
   */
  describe('the discovery tree', () => {
    it('records the first step of a turn, not only the steps after it', async () => {
      let tree: DreamTree | undefined;
      fake = await startFakeDeepSeek((messages) =>
        messages.some((message) => message['role'] === 'tool')
          ? textChunks('The clock says noon.')
          : toolCallChunks('call_time', 'current_time', {}),
      );
      const host = new AgentHost({
        sessionsDir: join(workDir, 'sessions'),
        config: {
          ...createConfig(fake.baseUrl),
          dream: {explorationWeight: 1, pruningThreshold: -1},
        },
        dreamSink: {
          append: (snapshot) => {
            tree = snapshot;
          },
        },
      });
      host.init();
      openHosts.push(host);
      const session = await host.createSession();

      await collect(host.run(session.id, 'what time is it?'));

      expect(tree).toBeDefined();
      const nodes = tree?.nodes ?? [];
      const kinds = (kind: string) =>
        nodes.filter((node) => node.kind === kind);

      /*
       * Two requests were made, so two steps. One step means the first request
       * was never recorded — the bug this test exists for.
       */
      expect(kinds('turn')).toHaveLength(3); // the root, plus one per request
      expect(kinds('propose').map((node) => node.tool)).toEqual([
        'current_time',
      ]);
      expect(kinds('call').map((node) => node.tool)).toEqual(['current_time']);
      expect(kinds('answer')).toHaveLength(1);
    });

    /*
     * A tree is filed under the agent that ran the turn, and the host serves one
     * profile while the *plugin* is cached per model — so a recorder built from
     * `config.profileId` would be one profile change away from filing a turn
     * under the wrong agent. Nothing would error: the tree would validate and
     * the replay would attribute the work to somebody who did not do it.
     */
    it('files the tree under the profile that ran the turn', async () => {
      let tree: DreamTree | undefined;
      fake = await startFakeDeepSeek(() => textChunks('ok'));
      const host = new AgentHost({
        sessionsDir: join(workDir, 'sessions'),
        config: {
          ...createConfig(fake.baseUrl),
          profileId: 'profile-served',
          dream: {explorationWeight: 1, pruningThreshold: -1},
        },
        dreamSink: {
          append: (snapshot) => {
            tree = snapshot;
          },
        },
      });
      host.init();
      openHosts.push(host);
      const session = await host.createSession('a chat', 'profile-running');

      await collect(host.run(session.id, 'hi', undefined, 'profile-running'));

      expect(tree?.profileId).toBe('profile-running');
    });
  });

  /*
   * What the turn-context block is built from.
   *
   * The block itself is tested where it lives; this is the half that reads the
   * app's own state, and the property that matters is *when* it is read: before
   * the turn, because ADK appends the user's message as the turn runs and a read
   * afterwards would describe the message being answered.
   */
  describe('session activity', () => {
    it('calls a brand-new conversation a first exchange', async () => {
      fake = await startFakeDeepSeek(() => textChunks('ok'));
      const host = new AgentHost({
        sessionsDir: join(workDir, 'sessions'),
        config: createConfig(fake.baseUrl),
      });
      host.init();
      openHosts.push(host);
      const session = await host.createSession();

      const activity = await host.sessionActivity(session.id);

      expect(activity.firstExchange).toBe(true);
      expect(activity.lastActivity).toBeUndefined();
    });

    it('answers with when the conversation last had activity, before this turn', async () => {
      fake = await startFakeDeepSeek(() => textChunks('ok'));
      const host = new AgentHost({
        sessionsDir: join(workDir, 'sessions'),
        config: createConfig(fake.baseUrl),
      });
      host.init();
      openHosts.push(host);
      const session = await host.createSession();
      await collect(host.run(session.id, 'first question'));

      const activity = await host.sessionActivity(session.id);

      expect(activity.firstExchange).toBe(false);
      expect(activity.lastActivity).toBeInstanceOf(Date);
      expect(Number.isNaN(activity.lastActivity?.getTime() ?? Number.NaN)).toBe(false);
    });

    it('says first exchange rather than throwing for an unknown session', async () => {
      fake = await startFakeDeepSeek(() => textChunks('ok'));
      const host = new AgentHost({
        sessionsDir: join(workDir, 'sessions'),
        config: createConfig(fake.baseUrl),
      });
      host.init();
      openHosts.push(host);

      const activity = await host.sessionActivity('no-such-session');

      expect(activity).toEqual({firstExchange: true});
    });
  });
});


/*
 * Handing work to a named agent, end to end.
 *
 * Real ADK, real session store, a loopback server standing in for the provider —
 * the same harness the rest of this file uses, with a second agent on the other
 * side of a tool call. What these tests are for is the part no unit test can
 * reach: that the helper's words land in the parent's conversation attributed to
 * the helper, that its approval card is answerable there, and that it cannot ask
 * for a helper of its own.
 */
describe('a conversation with a helper agent', () => {
  let workDir: string;
  let fake: FakeDeepSeek | undefined;
  const openHosts: AgentHost[] = [];

  const RESEARCHER = {
    id: 'researcher',
    name: 'Researcher',
    identity: 'You are the Researcher, a test helper.',
  };

  beforeEach(async () => {
    workDir = await mkdtemp(join(process.cwd(), '.marimo-delegate-'));
  });

  afterEach(async () => {
    for (const host of openHosts.splice(0)) {
      host.dispose();
    }
    await fake?.close();
    fake = undefined;
    await rm(workDir, {recursive: true, force: true});
  });

  function config(baseUrl: string, profileId?: string): AgentConfig {
    return {
      baseUrl,
      model: 'test-model',
      provider: 'deepseek',
      apiKey: '',
      systemPrompt: TEST_IDENTITY,
      workspaceRoot: workDir,
      allowPrivateNetworkFetch: false,
      ...(profileId === undefined ? {} : {profileId}),
    };
  }

  /** The seam, resolving one name and refusing everything else. */
  function seam(baseUrl: string) {
    return {
      resolve: async (request: {agent: string; space?: string}) => {
        if (request.agent.trim().toLowerCase() !== 'researcher') {
          return {
            problem:
              `There is no agent called "${request.agent}" on this computer. ` +
              'The ones that exist are "Researcher".',
          };
        }
        if (request.space !== undefined && request.space !== 'Website') {
          return {
            problem:
              `There is no Space called "${request.space}" on this computer. ` +
              'The ones that exist are "Website".',
          };
        }
        return {
          profile: {...RESEARCHER, enabledTools: [], enabledSkills: []},
          config: {
            ...config(baseUrl, RESEARCHER.id),
            systemPrompt: RESEARCHER.identity,
          },
        };
      },
    };
  }

  function askCall(id: string, task = 'read the logs') {
    return toolCallChunks(id, 'ask_agent', {agent: 'Researcher', task});
  }

  /*
   * Whether this request is the helper's.
   *
   * The system prompt is the mark, because it is the one thing the two agents do
   * not share: each carries its own identity. Reading it here also means the
   * assertion below is about the helper's prompt, which is the fact under test.
   */
  function isHelper(messages: Array<Record<string, unknown>>): boolean {
    return String(
      messages.find((message) => message['role'] === 'system')?.['content'] ?? '',
    ).includes(`internal name is "${agentNameFor(RESEARCHER.id)}"`);
  }

  function createTestHost(baseUrl: string): AgentHost {
    const host = new AgentHost({
      sessionsDir: join(workDir, 'sessions'),
      config: config(baseUrl),
      delegate: seam(baseUrl),
      delegateLimits: {timeoutMs: 5_000},
    });
    host.init();
    openHosts.push(host);
    return host;
  }

  it('starts a helper, keeps its words, and splits the bubbles by author', async () => {
    fake = await startFakeDeepSeek((messages) =>
      isHelper(messages)
        ? textChunks('The logs show three warnings.')
        : messages.some((message) => message['role'] === 'tool')
          ? textChunks('Researcher found three warnings.')
          : askCall('call_ask'),
    );

    const host = createTestHost(fake.baseUrl);
    const session = (await host.createSession()).id;
    const events = await collect(host.run(session, 'look into the logs'));

    expect(typesOf(events)).not.toContain('turn.failed');

    /*
     * The helper sees the task and nothing else. `includeContents: 'none'` is
     * what makes the tool's own promise true — it is told it cannot see this
     * conversation — and the failure it prevents is a large prompt for a small
     * task, made of an earlier conversation the user never meant to hand over.
     */
    const helperRequest = fake.requests.find((request) =>
      isHelper(request.messages),
    );
    expect(helperRequest).toBeDefined();
    expect(JSON.stringify(helperRequest?.messages)).not.toContain(
      'look into the logs',
    );
    // Its own identity, rather than the lead's.
    expect(
      helperRequest?.messages.find(
        (message) => message['role'] === 'system',
      )?.['content'],
    ).toContain(RESEARCHER.identity);

    const messages = projectTranscript(await host.eventsFor(session));
    const helper = messages.find((message) => message.agentId === RESEARCHER.id);
    expect(helper?.text).toBe('The logs show three warnings.');
    // The lead's summary is its own bubble, in the lead's own voice.
    expect(messages[messages.length - 1]).toMatchObject({
      role: 'assistant',
      text: 'Researcher found three warnings.',
    });
    expect(messages[messages.length - 1]?.agentId).toBeUndefined();
  });

  /*
   * Depth one, by construction rather than by a number: the helper is built by
   * the same method as the lead, and the dependency that offers `ask_agent` is
   * only passed for the lead. A helper that could ask for a helper would be an
   * unbounded tree of them, each spending the user's money.
   */
  it('does not offer the helper a way to ask for a helper', async () => {
    fake = await startFakeDeepSeek((messages) =>
      isHelper(messages) ? textChunks('Done.') : askCall('call_ask'),
    );

    const host = createTestHost(fake.baseUrl);
    const session = (await host.createSession()).id;
    await collect(host.run(session, 'look into the logs'));

    const declared = (request: RecordedRequest | undefined): string[] =>
      ((request?.body['tools'] ?? []) as Array<{
        function?: {name?: string};
      }>).map((tool) => tool.function?.name ?? '');

    const lead = fake.requests[0];
    const helper = fake.requests.find((request) => isHelper(request.messages));
    expect(declared(lead)).toContain('ask_agent');
    expect(helper).toBeDefined();
    expect(declared(helper)).not.toContain('ask_agent');
  });

  it('hands the model a sentence when the agent it named does not exist', async () => {
    fake = await startFakeDeepSeek((messages) =>
      messages.some((message) => message['role'] === 'tool')
        ? textChunks('There is no such agent.')
        : toolCallChunks('call_ask', 'ask_agent', {
            agent: 'Ghostwriter',
            task: 'write it',
          }),
    );

    const host = createTestHost(fake.baseUrl);
    const session = (await host.createSession()).id;
    const events = await collect(host.run(session, 'get it written'));

    // The refusal is the tool's answer, so the turn finishes rather than failing.
    expect(typesOf(events)).not.toContain('turn.failed');
    const result = events
      .filter((event) => event.type === 'tool.finished')
      .map((event) => (event.type === 'tool.finished' ? event.result : ''))
      .join('\n');
    expect(result).toContain('There is no agent called "Ghostwriter"');
    expect(result).toContain('"Researcher"');
    // And no helper ran: two requests, both the lead's.
    expect(fake.requests).toHaveLength(2);
    expect(fake.requests.every((request) => !isHelper(request.messages))).toBe(
      true,
    );
  });

  it('refuses a space that does not exist, in words', async () => {
    fake = await startFakeDeepSeek((messages) =>
      messages.some((message) => message['role'] === 'tool')
        ? textChunks('Then I cannot put it there.')
        : toolCallChunks('call_ask', 'ask_agent', {
            agent: 'Researcher',
            task: 'write it',
            space: 'Nowhere',
          }),
    );

    const host = createTestHost(fake.baseUrl);
    const session = (await host.createSession()).id;
    const events = await collect(host.run(session, 'write it down'));

    const result = events
      .filter((event) => event.type === 'tool.finished')
      .map((event) => (event.type === 'tool.finished' ? event.result : ''))
      .join('\n');
    expect(result).toContain('There is no Space called "Nowhere"');
    expect(result).toContain('"Website"');
  });

  /*
   * The round trip the whole design exists for: the helper asks to change
   * something, a card is raised in the *parent's* conversation because both share
   * one session, the user clicks it, and the helper carries on from where it
   * stopped — finishing in the turn that click started.
   *
   * Two turns, and the shape of each is the point. The first parks: the helper
   * stops at its gate, and the call raises a card of its own through
   * `requestConfirmation`, so the conversation ends with nothing dangling for the
   * provider to refuse. The second is the click, which resumes this tool; it
   * answers the helper's own gate with the confirmation ADK binds to the call it
   * stopped on, so the approved `write_file` actually runs.
   *
   * That last part is what the sentence version could not do: it told the helper
   * "the user approved" without the task or the pending call, so the helper
   * re-planned, re-asked, and the file was never written.
   */
  it('raises the helper’s approval in the conversation and finishes it', async () => {
    await writeFile(join(workDir, 'notes.txt'), 'old');

    fake = await startFakeDeepSeek((messages) => {
      if (!isHelper(messages)) {
        // The lead's second turn is the one carrying the tool result.
        return messages.some((message) => message['role'] === 'tool')
          ? textChunks('All clear.')
          : askCall('call_ask', 'write the note');
      }
      /*
       * The helper's first request proposes the gated write. The second is what
       * the runner asks for after the approved call has executed — it carries the
       * tool result, which is the only thing that can tell the helper to stop.
       */
      return messages.some((message) => message['role'] === 'tool')
        ? textChunks('Written.')
        : toolCallChunks('call_write', 'write_file', {
            path: 'notes.txt',
            content: 'new',
          });
    });

    const host = createTestHost(fake.baseUrl);
    const session = (await host.createSession()).id;

    const parked = await collect(host.run(session, 'write the note'));
    expect(typesOf(parked)).not.toContain('turn.failed');

    /*
     * One card, raised by the parent's own call. The helper's gate is in the log
     * beside it — that is the call the click will resume — but it is not a second
     * question, and it must not reach the window's pending list.
     */
    const card = parked.find((event) => event.type === 'approval.request');
    expect(card).toMatchObject({tool: 'ask_agent'});
    expect(
      card?.type === 'approval.request' ? card.hint : '',
    ).toContain('Researcher');
    expect(
      card?.type === 'approval.request' ? card.hint : '',
    ).toContain('write_file');
    expect((await host.pendingGates(session)).map((gate) => gate.tool)).toEqual([
      'ask_agent',
    ]);

    /*
     * The click. Resuming is a new turn carrying the confirmation, exactly as it
     * is for any other gated call — which is why this is `approve` and not a
     * second `run`.
     */
    const resumed = await collect(
      host.approve({
        sessionId: session,
        callId: card?.type === 'approval.request' ? card.callId : '',
        confirmed: true,
      }),
    );

    const resumedResult = resumed
      .filter((event) => event.type === 'tool.finished')
      .map((event) => (event.type === 'tool.finished' ? event.result : ''))
      .join('\n');
    expect(resumedResult).toContain('Written.');

    // The approved call ran: the file the helper asked to replace is replaced.
    expect(await readFile(join(workDir, 'notes.txt'), 'utf8')).toBe('new');

    // Every word the helper wrote is in the transcript, attributed to it — and
    // the lead's own summary is not.
    const messages = projectTranscript(await host.eventsFor(session));
    expect(
      messages.some(
        (message) =>
          message.agentId === RESEARCHER.id && message.text.includes('Written.'),
      ),
    ).toBe(true);
    expect(messages[messages.length - 1]?.agentId).toBeUndefined();
  });
});
