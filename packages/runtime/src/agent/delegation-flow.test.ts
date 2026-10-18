/**
 * One scene, end to end: the lead hands a blog post to Writer, the draft lands
 * in the Space the chat belongs to and appears in its documents, and a second
 * request puts the post in the website repo — another Space, another folder, and
 * the same guard around both.
 *
 * Every piece of this is tested alone elsewhere: delegation against a stubbed
 * helper in `agent-host.test.ts` and `ask-agent-tool.test.ts`, the path guard in
 * `fs-tools.test.ts`, the library in `documents.test.ts`, the profile and
 * workspace stores in their own files. What none of them can answer is whether
 * the pieces meet, because the name a model says, the profile it resolves to, the
 * folder a Space resolves to and the file the library lists are four separate
 * documents joined only by the path this test walks.
 *
 * The turns are real — a real `AgentRuntime`, a real `AgentHost`, the real ADK
 * runner, the real tool set, the real session files under a temporary folder.
 * Only the model is scripted, and only `fetch` is replaced: the address in the
 * settings is one nothing listens on, so the turn cannot pass by reaching a real
 * service.
 */
import {mkdir, mkdtemp, readFile, rm, stat, writeFile} from 'node:fs/promises';
import {join} from 'node:path';

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import type {AgentUiEvent} from '@marimo/protocol';

import {resolveAppPaths} from '../paths.js';
import type {AppPaths} from '../paths.js';
import {WorkspaceStore} from '../workspaces.js';
import {AgentRuntime} from './runtime.js';

/** The two agents, by the one thing a request carries that tells them apart. */
const LEAD_IDENTITY = 'You are Marimo Bot, and you hand writing work to Writer.';
const WRITER_IDENTITY = 'You are Writer. You draft blog posts and file them.';

/** What the user says, in their own words. */
const BLOG_REQUEST =
  'Write a blog post about why the app stopped running a model of its own.';
const WEBSITE_REQUEST = 'Now put it in the website repo.';

/** What the lead hands over, and what the writer answers. */
const DRAFT_TASK =
  'Draft a short blog post into this space as blog-post.md, about why the app ' +
  'stopped running a model of its own.';
const POST_TASK =
  'Write the post into the website repo, as posts/hello-marimo.md, following ' +
  'the formatting the repo already uses.';
const LEAD_DRAFT_REPLY =
  'Writer drafted it: the post is in this space as blog-post.md.';
const WRITER_DRAFT_REPLY = 'Drafted it into the space as blog-post.md.';
const LEAD_POST_REPLY =
  'It is in the website repo now, as posts/hello-marimo.md.';
const WRITER_POST_REPLY =
  "Wrote it to posts/hello-marimo.md in the repo's format.";

/** The draft, and the file it goes into. */
const DRAFT_FILE = 'blog-post.md';
const DRAFT = [
  '# Why the app stopped running a model of its own',
  '',
  'It used to download weights and supervise an engine on loopback. Now it talks',
  'to a provider, so switching one is a base URL, a key and a model id.',
  '',
].join('\n');

/** The website repo: a convention to read, and the post that follows it. */
const BLOG_DIR = 'blog';
const WEBSITE_DIR = 'website';
const TEMPLATE_FILE = 'TEMPLATE.md';
const POST_FILE = 'posts/hello-marimo.md';
const CONVENTION_PREFIX = 'Series:';
const CONVENTION = `${CONVENTION_PREFIX} Notebooks at work`;
const TEMPLATE = [
  '# How posts are formatted here',
  '',
  'Every post opens with one line naming the series it belongs to:',
  '',
  CONVENTION,
  '',
].join('\n');

/**
 * A write that leaves the writer's Space and lands in the *other* one this chat
 * knows about — the sibling folder, one level up from the website repo.
 */
const ESCAPING_PATH = `../${BLOG_DIR}/escaped.md`;
const ESCAPED_FILE = 'escaped.md';

/** What puts a request in the second half of the scene, for either agent. */
const WEBSITE_MARK = 'website repo';

/**
 * An address nothing answers on. The scripted endpoint below is what replies,
 * and it does so without opening a socket: a turn that somehow went to the real
 * network instead would fail on the connection rather than pass quietly.
 */
const DEAD_ADDRESS = 'http://127.0.0.1:1/v1';

/**
 * The model, as a script.
 *
 * `fetch` is the seam because it is the only one there is. The runtime builds its
 * own `AgentHost`, the host builds its own client, and that client reads
 * `globalThis.fetch` as it is constructed — so the transport is replaced for the
 * length of a test rather than injected anywhere.
 */
function scriptedEndpoint(
  reply: (
    messages: Array<Record<string, unknown>>,
  ) => Array<Record<string, unknown>>,
): {fetchImpl: typeof fetch; urls: string[]} {
  const urls: string[] = [];
  const fetchImpl = (async (url: unknown, init: RequestInit = {}) => {
    const body = JSON.parse(String(init.body ?? '{}')) as {
      messages?: Array<Record<string, unknown>>;
    };
    urls.push(String(url));
    return new Response(streamOf(reply(body.messages ?? [])), {status: 200});
  }) as unknown as typeof fetch;
  return {fetchImpl, urls};
}

/**
 * One answer as the bytes a provider sends it in: the frames of the
 * OpenAI-compatible stream, ended by the `[DONE]` sentinel.
 */
function streamOf(
  chunks: Array<Record<string, unknown>>,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`),
        );
      }
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
}

function textChunks(text: string): Array<Record<string, unknown>> {
  return [
    {choices: [{delta: {content: text}, finish_reason: null}]},
    {choices: [{delta: {}, finish_reason: 'stop'}]},
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
  ];
}

/** The instruction a request was sent, which tells the two agents apart. */
function systemOf(messages: Array<Record<string, unknown>>): string {
  return String(
    messages.find((message) => message['role'] === 'system')?.['content'] ?? '',
  );
}

/** Whether this request is the helper's: each agent carries its own identity. */
function isWriter(messages: Array<Record<string, unknown>>): boolean {
  return systemOf(messages).includes(WRITER_IDENTITY);
}

/**
 * The newest thing said to an agent — a task for a helper, a question for the
 * lead. Serialised rather than read as a string because a content part may
 * arrive as a list.
 */
function lastUserText(messages: Array<Record<string, unknown>>): string {
  const user = [...messages]
    .reverse()
    .find((message) => message['role'] === 'user');
  return JSON.stringify(user?.['content'] ?? '');
}

function toolResultCount(messages: Array<Record<string, unknown>>): number {
  return messages.filter((message) => message['role'] === 'tool').length;
}

/** What the last tool handed back, as text. */
function lastToolResult(messages: Array<Record<string, unknown>>): string {
  const tool = [...messages]
    .reverse()
    .find((message) => message['role'] === 'tool');
  return String(tool?.['content'] ?? '');
}

/**
 * The post, written the way the repo says it is: the convention line the writer
 * has just read is the line the file opens with. Composed from the tool result
 * rather than typed twice, so the assertion about the write is a statement about
 * the read.
 */
function postFor(readResult: string): string {
  const convention =
    readResult.split('\n').find((line) => line.startsWith(CONVENTION_PREFIX)) ??
    '';
  return [
    convention,
    '',
    '# Hello, Marimo Bot',
    '',
    'The app runs no model of its own.',
    '',
  ].join('\n');
}

/**
 * The conversation the model would have had, request by request.
 *
 * Which agent is asking is read from the identity in the request, and where a
 * helper is in its work is read from how many results it already has — a helper
 * is given its task and its own results and nothing else of this chat.
 */
function replyFor(
  messages: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  if (isWriter(messages)) {
    return writerSays(messages);
  }
  /*
   * The lead: one delegation and then a sentence about it, in each half of the
   * scene. Which half this is comes from what the user last said, and how far
   * into the turn it is from the results already in hand — one is the writer's
   * answer to the delegation, none is the user's own message.
   */
  const results = toolResultCount(messages);
  if (lastUserText(messages).includes(WEBSITE_MARK)) {
    return results === 1
      ? toolCallChunks('lead_repo', 'ask_agent', {
          agent: 'Writer',
          space: 'Website',
          task: POST_TASK,
        })
      : textChunks(LEAD_POST_REPLY);
  }
  return results === 0
    ? toolCallChunks('lead_draft', 'ask_agent', {
        agent: 'Writer',
        task: DRAFT_TASK,
      })
    : textChunks(LEAD_DRAFT_REPLY);
}

function writerSays(
  messages: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  const results = toolResultCount(messages);
  if (lastUserText(messages).includes(WEBSITE_MARK)) {
    /*
     * The first call is the one the guard exists to refuse, and it is aimed at
     * the *other* Space on purpose: the same path is what a writer confined to
     * the wrong root would have been allowed to write, so the refusal is also
     * what says which folder this helper was given.
     */
    if (results === 0) {
      return toolCallChunks('writer_outside', 'write_file', {
        path: ESCAPING_PATH,
        content: '# Escaped\n',
      });
    }
    if (results === 1) {
      return toolCallChunks('writer_convention', 'read_file', {
        path: TEMPLATE_FILE,
      });
    }
    if (results === 2) {
      return toolCallChunks('writer_post', 'write_file', {
        path: POST_FILE,
        content: postFor(lastToolResult(messages)),
      });
    }
    return textChunks(WRITER_POST_REPLY);
  }
  return results === 0
    ? toolCallChunks('writer_draft', 'write_file', {
        path: DRAFT_FILE,
        content: DRAFT,
      })
    : textChunks(WRITER_DRAFT_REPLY);
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

/**
 * The sentence of a turn that did not finish, if it did not.
 *
 * Asserting on this as the turns run means a failure names the reason — a
 * refused key, a malformed request — rather than arriving three assertions later
 * as a file that is not there.
 */
function problemIn(events: AgentUiEvent[]): string | undefined {
  for (const event of events) {
    if (event.type === 'turn.failed') {
      return event.message;
    }
  }
  return undefined;
}

/** Whether a path is there, without the platform's own error as the answer. */
async function exists(path: string): Promise<boolean> {
  return await stat(path).then(
    () => true,
    () => false,
  );
}

/**
 * The path a recorded call named.
 *
 * A transcript's arguments are `unknown`, because a tool's own schema is the only
 * thing that knows their shape — so this is where the one field these assertions
 * are about is read out. A call that named no path answers with an empty string,
 * which matches no file rather than throwing inside an assertion.
 */
function pathOf(args: unknown): string {
  if (typeof args !== 'object' || args === null) {
    return '';
  }
  const path = (args as {path?: unknown}).path;
  return typeof path === 'string' ? path : '';
}

describe('a blog post, from the chat to the website repo', () => {
  let dir: string;
  let paths: AppPaths;
  let blogRoot: string;
  let websiteRoot: string;
  let blogId: string;
  const open: AgentRuntime[] = [];

  beforeEach(async () => {
    dir = await mkdtemp(join(process.cwd(), '.marimo-delegation-flow-'));
    paths = resolveAppPaths(dir);
    blogRoot = join(dir, BLOG_DIR);
    websiteRoot = join(dir, WEBSITE_DIR);
    await mkdir(blogRoot, {recursive: true});
    await mkdir(websiteRoot, {recursive: true});
    await writeFile(join(websiteRoot, TEMPLATE_FILE), TEMPLATE, 'utf8');

    /*
     * The folder document, written before the runtime reads it. Otherwise the
     * first read seeds — and creates — the app's starting folder under the
     * tester's home, and the scene below would be working in a folder nobody
     * chose.
     */
    const workspaces = new WorkspaceStore({
      file: paths.workspaces,
      defaultWorkspaceRoot: blogRoot,
    });
    const seeded = await workspaces.load();
    blogId = seeded.workspaces[0].id;
    await workspaces.rename(blogId, 'Blog');
    // The website repo, loaded beside it: another id, another folder.
    await workspaces.add(websiteRoot, 'Website');
    // And the rail back on the Space the chat belongs to.
    await workspaces.select(blogId);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    for (const agent of open.splice(0)) {
      await agent.dispose();
    }
    await rm(dir, {recursive: true, force: true});
  });

  function start(): AgentRuntime {
    const agent = new AgentRuntime({
      paths,
      // A key that is present, so a turn resolves: the transport is the stub.
      readSecret: async () => ({state: 'present', value: 'test-key'}),
    });
    open.push(agent);
    return agent;
  }

  it('drafts into the chat’s Space, then writes it into the website repo', async () => {
    const agent = start();
    await agent.updateSettings({
      providers: {configs: {deepseek: {baseUrl: DEAD_ADDRESS}}},
    });

    const lead = await agent.activeProfile();
    await agent.updateProfile(lead.id, {
      identity: LEAD_IDENTITY,
      enabledTools: ['ask_agent'],
      spaceId: blogId,
    });

    const writer = await agent.createProfile({name: 'Writer'});
    await agent.updateProfile(writer.id, {
      identity: WRITER_IDENTITY,
      // Which Space the writer works in when the lead names none. This is the
      // "it drafts into the Space we are working in" half that is a grant
      // rather than a sentence in the task.
      spaceId: blogId,
      enabledTools: ['read_file', 'write_file'],
    });
    // Creating a profile switches to it, and this scene is the lead's chat.
    await agent.selectProfile(lead.id);

    const endpoint = scriptedEndpoint(replyFor);
    vi.stubGlobal('fetch', endpoint.fetchImpl);

    const session = await agent.createSession(lead.id, 'Blog post', blogId);
    const sessionId = session?.id ?? '';
    expect(sessionId.length).toBeGreaterThan(0);

    const first = await collect(agent.run(lead.id, sessionId, BLOG_REQUEST));
    expect(problemIn(first)).toBeUndefined();

    const second = await collect(
      agent.run(lead.id, sessionId, WEBSITE_REQUEST),
    );
    expect(problemIn(second)).toBeUndefined();

    /*
     * The transport, asserted once. The address in the settings answers nothing,
     * so what replied is this test's script — and it replied at the address the
     * settings document holds, which is what makes "no network" a fact about the
     * run rather than a promise in a comment.
     */
    expect(endpoint.urls[0]).toBe(`${DEAD_ADDRESS}/chat/completions`);

    const {messages} = await agent.transcript(lead.id, sessionId);

    /*
     * 1. The delegation happened, and each voice is in its own bubble. A bubble
     * carries one speaker: the helper's words folded into the lead's — or the
     * lead's into the helper's — is the failure, so each answer is asserted
     * *absent* from the other's bubble rather than merely present somewhere.
     * The conversation's own agent is the one with no `agentId`, which is how
     * the window tells the chat's agent from a helper it asked.
     */
    const writerBubbles = messages.filter(
      (message) => message.agentId === writer.id,
    );
    const leadBubbles = messages.filter(
      (message) =>
        message.role === 'assistant' && message.agentId === undefined,
    );
    const draftBubble = writerBubbles.find((message) =>
      message.text.includes(WRITER_DRAFT_REPLY),
    );
    const draftSummary = leadBubbles.find((message) =>
      message.text.includes(LEAD_DRAFT_REPLY),
    );
    expect(draftBubble).toBeDefined();
    expect(draftSummary).toBeDefined();
    expect(draftBubble?.text).not.toContain(LEAD_DRAFT_REPLY);
    expect(draftSummary?.text).not.toContain(WRITER_DRAFT_REPLY);

    /*
     * 2. The writer really wrote into the Space the chat belongs to: the call is
     * recorded in its bubble with the path it used, and the drafted text is on
     * disk under that Space's folder.
     */
    const draftCall = draftBubble?.toolCalls?.find(
      (call) => call.tool === 'write_file',
    );
    const draftPath = pathOf(draftCall?.args);
    // Without this the read below fails as a directory error rather than as the
    // assertion it is.
    expect(draftPath.length).toBeGreaterThan(0);
    expect(await readFile(join(blogRoot, draftPath), 'utf8')).toBe(DRAFT);

    /*
     * 3. The Space's documents list it. The space id comes from the
     * conversation's own record rather than from the variable this test made the
     * chat with, because the join is the whole point: session → Space → folder →
     * library → the file the helper wrote, with nothing shared between the two
     * halves except the document the app itself reads.
     */
    const filed = (await agent.listSessions(lead.id)).find(
      (entry) => entry.id === sessionId,
    );
    const library = await agent.documentsFor(filed?.workspaceId ?? '');
    const listed = await library.list();
    expect(listed.files.map((file) => file.path)).toContain(draftPath);
    expect(listed.files.find((file) => file.path === draftPath)?.bytes).toBe(
      Buffer.byteLength(DRAFT, 'utf8'),
    );

    /*
     * 4. A second Space is a different folder. The writer read the repo's own
     * formatting before writing — "it understands the formatting" means it
     * looked — and the file it produced opens with the line it read, so the two
     * are one act rather than two.
     */
    const postBubble = writerBubbles.find((message) =>
      message.text.includes(WRITER_POST_REPLY),
    );
    const postCalls = postBubble?.toolCalls ?? [];
    const readAt = postCalls.findIndex(
      (call) =>
        call.tool === 'read_file' && pathOf(call.args) === TEMPLATE_FILE,
    );
    const postAt = postCalls.findIndex(
      (call) => pathOf(call.args) === POST_FILE,
    );
    expect(readAt).toBeGreaterThanOrEqual(0);
    expect(postAt).toBeGreaterThan(readAt);
    const post = await readFile(join(websiteRoot, POST_FILE), 'utf8');
    expect(post.startsWith(CONVENTION)).toBe(true);
    // And not into the Space this chat belongs to, which is the folder a writer
    // that had resolved the wrong one would have written in.
    expect(await exists(join(blogRoot, POST_FILE))).toBe(false);

    /*
     * 5. The guard holds across both. The write above the read is the one the
     * guard exists to refuse: a path that leaves the writer's Space and lands in
     * the other one. Nothing was written there, which is also what a writer
     * confined to the wrong root would have done — silently, one folder over.
     */
    const outsideAt = postCalls.findIndex(
      (call) => pathOf(call.args) === ESCAPING_PATH,
    );
    expect(outsideAt).toBeGreaterThanOrEqual(0);
    expect(postCalls[outsideAt]?.result).toMatch(/outside the workspace root/u);
    expect(await exists(join(blogRoot, ESCAPED_FILE))).toBe(false);
  });

  /*
   * Where a helper works when nobody says.
   *
   * The chain is: the Space the model named, then the agent's own default, then
   * the Space *this conversation* is filed under, and only then whatever the rail
   * is on. The third step is the one worth a test of its own, because losing it
   * is quiet and wrong in a way nobody would report as a bug: a turn's own file
   * tools run in the conversation's folder, so a helper that ran in whichever
   * Space somebody happened to be browsing would be the one place in the app
   * where clicking the rail changes where work lands.
   *
   * So the rail is deliberately moved to the *other* Space before the turn, and
   * the writer has no default of its own.
   */
  it('drafts into the conversation’s Space even when the rail has moved', async () => {
    const agent = start();
    await agent.updateSettings({
      providers: {configs: {deepseek: {baseUrl: DEAD_ADDRESS}}},
    });

    const lead = await agent.activeProfile();
    await agent.updateProfile(lead.id, {
      identity: LEAD_IDENTITY,
      enabledTools: ['ask_agent'],
    });

    const writer = await agent.createProfile({name: 'Writer'});
    await agent.updateProfile(writer.id, {
      identity: WRITER_IDENTITY,
      // No `spaceId`: this writer has nowhere of its own.
      enabledTools: ['read_file', 'write_file'],
    });
    await agent.selectProfile(lead.id);

    const endpoint = scriptedEndpoint(replyFor);
    vi.stubGlobal('fetch', endpoint.fetchImpl);

    // The chat is filed under the blog, and *then* somebody clicks the website
    // in the rail. The conversation does not move with them.
    const session = await agent.createSession(lead.id, 'Blog post', blogId);
    const sessionId = session?.id ?? '';
    const other = (await agent.workspaces()).workspaces.find(
      (entry) => entry.path === websiteRoot,
    );
    expect(other).toBeDefined();
    await agent.selectWorkspace(other?.id ?? '');

    const events = await collect(agent.run(lead.id, sessionId, BLOG_REQUEST));
    expect(problemIn(events)).toBeUndefined();

    // The draft is in the conversation's Space, and the rail's Space is untouched.
    expect(await exists(join(blogRoot, DRAFT_FILE))).toBe(true);
    expect(await exists(join(websiteRoot, DRAFT_FILE))).toBe(false);
  });
});
