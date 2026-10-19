/**
 * The five `docs.*` calls, over the real IPC entry point.
 *
 * What this file is for is the wiring: that each call arrives on the app's one
 * channel, is checked against the protocol's schema before anything touches a
 * file, and reaches the runtime operation that answers it. The service's own
 * rules — the caps, the conflict, the refusals — are asserted beside it in
 * `packages/runtime/src/documents.test.ts`; what cannot be asserted there is
 * that a window asking for a space's documents ends up in that code at all.
 *
 * Electron is mocked because it has to be: `ipcMain.handle` is where the
 * dispatcher is registered, and capturing it is how a test calls the same
 * function the window calls. The service itself is real, over a throwaway
 * user-data directory.
 */
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

type Dispatch = (
  event: unknown,
  method: unknown,
  params: unknown,
) => Promise<unknown>;

/*
 * Hoisted above the imports, because the mock below needs it before any module
 * that imports Electron is evaluated.
 */
const captured = vi.hoisted(() => ({
  channel: undefined as string | undefined,
  handler: undefined as Dispatch | undefined,
}));

vi.mock('electron', () => ({
  app: {getName: () => 'Marimo Bot', getVersion: () => '0.0.0'},
  ipcMain: {
    handle: (channel: string, handler: Dispatch) => {
      captured.channel = channel;
      captured.handler = handler;
    },
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value, 'utf8'),
    decryptString: (payload: Buffer) => payload.toString('utf8'),
  },
  nativeTheme: {shouldUseDarkColors: false},
  BrowserWindow: {getFocusedWindow: () => null},
  dialog: {showOpenDialog: async () => ({canceled: true, filePaths: []})},
  shell: {openPath: async () => ''},
}));

import {IPC_CALL_CHANNEL} from '@marimo/protocol';
import type {
  AgentCallMethod,
  AgentCallParams,
  AgentCallResults,
} from '@marimo/protocol';
import {resolveAppPaths} from '@marimo/runtime';
import type {AppPaths} from '@marimo/runtime';

import {AgentService} from '../src/main/agent.js';
import {registerIpcHandler} from '../src/main/ipc.js';

const SESSION_ID = 'parser-chat';

describe('the docs.* calls', () => {
  let dir: string;
  let paths: AppPaths;
  let service: AgentService;

  /** One stored event, in the shape the session service writes. */
  function stored(author: string, role: string, text: string): string {
    return JSON.stringify({
      author,
      content: {role, parts: [{text}]},
      id: `event-${author}-${String(text.length)}`,
      invocationId: '',
      actions: {
        stateDelta: {},
        artifactDelta: {},
        requestedAuthConfirmation: {},
        requestedToolConfirmations: {},
      },
      longRunningToolIds: [],
      timestamp: Date.now(),
    });
  }

  /** The call as the window makes it: the channel's own dispatcher. */
  async function call<M extends AgentCallMethod>(
    method: M,
    params: AgentCallParams<M>,
  ): Promise<AgentCallResults[M]> {
    const handler = captured.handler;
    if (handler === undefined) {
      throw new Error('the IPC channel was never registered');
    }
    return (await handler(undefined, method, params)) as AgentCallResults[M];
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(process.cwd(), '.marimo-docs-ipc-'));
    paths = resolveAppPaths(dir);
    /*
     * The documents and the conversation are seeded as files rather than through
     * the app, so `docs.saveChat` reads the same shape a real install writes —
     * and the space is seeded the same way, because a fresh workspaces document
     * would point at the tester's home directory.
     */
    await writeFile(
      paths.workspaces,
      `${JSON.stringify({
        version: 1,
        workspaces: [{id: 'space', name: 'space', path: dir}],
        activeWorkspaceId: 'space',
      })}\n`,
      'utf8',
    );
    await writeFile(
      paths.profiles,
      `${JSON.stringify({
        version: 1,
        activeProfileId: 'marimo',
        profiles: [
          {
            id: 'marimo',
            name: 'Marimo Bot',
            identity: '',
            enabledTools: [],
            enabledSkills: [],
          },
          {
            id: 'researcher',
            name: 'Researcher',
            identity: '',
            enabledTools: [],
            enabledSkills: [],
          },
        ],
      })}\n`,
      'utf8',
    );
    await mkdir(paths.sessions, {recursive: true});
    await writeFile(
      join(paths.sessions, `${SESSION_ID}.jsonl`),
      `${[
        stored('user', 'user', 'show me the parser output'),
        stored('marimo', 'model', 'Here it is.'),
        stored('a_researcher', 'model', 'I checked the tokens.'),
      ].join('\n')}\n`,
      'utf8',
    );
    await writeFile(
      join(paths.sessions, 'index.json'),
      `${JSON.stringify({
        version: 1,
        sessions: {
          [SESSION_ID]: {
            id: SESSION_ID,
            title: 'Parser output',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            messageCount: 3,
            appName: 'marimo',
            userId: 'local',
            profileId: 'marimo',
          },
        },
      })}\n`,
      'utf8',
    );

    service = new AgentService({paths, sendEvent: () => undefined});
    registerIpcHandler({paths, agent: () => service});
  });

  afterEach(async () => {
    await service.stop();
    await rm(dir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 20,
    });
  });

  it('registers the one channel the preload calls', () => {
    expect(captured.channel).toBe(IPC_CALL_CHANNEL);
  });

  it('lists, reads, writes and creates inside a space', async () => {
    await writeFile(join(dir, 'notes.md'), 'first\n', 'utf8');

    const listed = await call('docs.list', {spaceId: 'space'});
    expect(listed.files.map((entry) => entry.path)).toEqual(['notes.md']);
    expect(listed.notes).toEqual([]);

    const read = await call('docs.read', {spaceId: 'space', path: 'notes.md'});
    expect(read.text).toBe('first\n');

    const written = await call('docs.write', {
      spaceId: 'space',
      path: 'notes.md',
      text: 'second\n',
      revision: read.revision,
    });
    expect(written.ok).toBe(true);
    expect(await readFile(join(dir, 'notes.md'), 'utf8')).toBe('second\n');

    const created = await call('docs.create', {
      spaceId: 'space',
      name: 'new.md',
    });
    expect(created).toMatchObject({path: 'new.md', text: ''});
    expect(await readFile(join(dir, 'new.md'), 'utf8')).toBe('');

    /*
     * And the one case the whole revision exists for: the file moved on, so the
     * answer is a conflict — a value, not a rejection — and the other writer's
     * text is still on disk.
     */
    await writeFile(
      join(dir, 'notes.md'),
      'somebody else typed this\n',
      'utf8',
    );
    const conflict = await call('docs.write', {
      spaceId: 'space',
      path: 'notes.md',
      text: 'mine\n',
      revision: read.revision,
    });
    expect(conflict).toMatchObject({ok: false, conflict: true});
    expect(await readFile(join(dir, 'notes.md'), 'utf8')).toBe(
      'somebody else typed this\n',
    );
  });

  it('saves a conversation as a document, with each agent named', async () => {
    const saved = await call('docs.saveChat', {
      profileId: 'marimo',
      sessionId: SESSION_ID,
      spaceId: 'space',
      path: 'from-chat.md',
    });

    expect(saved.path).toBe('from-chat.md');
    const markdown = await readFile(join(dir, 'from-chat.md'), 'utf8');
    expect(markdown).toContain('# Parser output');
    expect(markdown).toContain('## You\n\nshow me the parser output');
    expect(markdown).toContain('## Marimo Bot\n\nHere it is.');
    expect(markdown).toContain('## Researcher\n\nI checked the tokens.');
  });

  it('refuses an unknown space and a path that leaves it', async () => {
    await expect(call('docs.list', {spaceId: 'gone'})).rejects.toThrow(
      /There is no space called "gone"/u,
    );
    await expect(
      call('docs.read', {spaceId: 'space', path: '../outside.md'}),
    ).rejects.toThrow(/is outside the workspace root/u);
  });

  it('refuses a malformed call before it reaches a file', async () => {
    await expect(
      call('docs.read', {spaceId: 'space', path: ''}),
    ).rejects.toThrow(/Invalid parameters for docs.read/u);
  });
});
