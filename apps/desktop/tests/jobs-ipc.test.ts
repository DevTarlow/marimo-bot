/**
 * The `jobs.*` calls, over the real IPC entry point.
 *
 * The Jobs card is the one place a person can see what any bot has scheduled,
 * so these tests assert the two facts that make it trustworthy: the list is
 * joined across bots — owner name and conversation title resolved in the main
 * process — and a write goes through the same `JobStore` a turn's tool uses.
 *
 * Electron is mocked for `ipcMain.handle` alone; the service and the store are
 * real, over a throwaway user-data directory.
 */
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

type Dispatch = (
  event: unknown,
  method: unknown,
  params: unknown,
) => Promise<unknown>;

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
  Job,
  JobSummary,
} from '@marimo/protocol';
import {resolveAppPaths} from '@marimo/runtime';
import type {AppPaths} from '@marimo/runtime';

import {AgentService} from '../src/main/agent.js';
import {registerIpcHandler} from '../src/main/ipc.js';

const NOW = new Date().toISOString();

function job(overrides: Partial<Job>): Job {
  return {
    id: 'job-1',
    name: 'Morning digest',
    description: 'Summarise new issues in the inbox.',
    schedules: ['0 9 * * *'],
    enabled: true,
    profileId: 'marimo',
    sessionId: 'chat-marimo',
    createdAt: NOW,
    ...overrides,
  };
}

describe('the jobs.* calls', () => {
  let dir: string;
  let paths: AppPaths;
  let service: AgentService;
  let events: Array<{type: string}>;

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

  function summary(result: {jobs: JobSummary[]}, id: string): JobSummary {
    const found = result.jobs.find((entry) => entry.job.id === id);
    if (found === undefined) {
      throw new Error(`no job ${id} in the list`);
    }
    return found;
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(process.cwd(), '.marimo-jobs-ipc-'));
    paths = resolveAppPaths(dir);
    const spaceDir = join(dir, 'space');
    await mkdir(spaceDir, {recursive: true});

    await writeFile(
      paths.workspaces,
      `${JSON.stringify({
        version: 1,
        workspaces: [{id: 'space', name: 'space', path: spaceDir}],
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
            id: 'writer',
            name: 'Writer',
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
      join(paths.sessions, 'index.json'),
      `${JSON.stringify({
        version: 1,
        sessions: {
          'chat-marimo': {
            id: 'chat-marimo',
            title: 'Inbox digest',
            createdAt: NOW,
            updatedAt: NOW,
            messageCount: 1,
            appName: 'marimo',
            userId: 'local',
            profileId: 'marimo',
            workspaceId: 'space',
          },
          'chat-writer': {
            id: 'chat-writer',
            title: 'Blog draft',
            createdAt: NOW,
            updatedAt: NOW,
            messageCount: 1,
            appName: 'marimo',
            userId: 'local',
            profileId: 'writer',
            workspaceId: 'space',
          },
        },
      })}\n`,
      'utf8',
    );
    await writeFile(
      paths.jobs,
      `${JSON.stringify({
        version: 1,
        jobs: {
          jobs: [
            job({}),
            job({
              id: 'job-2',
              name: 'Weekday draft',
              description: 'Draft the next post.',
              schedules: ['30 8 * * 1-5'],
              enabled: false,
              profileId: 'writer',
              sessionId: 'chat-writer',
            }),
            job({
              id: 'job-draft',
              name: '—',
              description: '',
              enabled: false,
              sessionId: 'chat-marimo',
            }),
          ],
          open: false,
          openJobId: null,
        },
      })}\n`,
      'utf8',
    );

    events = [];
    service = new AgentService({
      paths,
      sendEvent: (event) => {
        events.push(event);
      },
    });
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

  it('lists every bot’s jobs, joined to the owner and the chat title', async () => {
    const listed = await call('jobs.list', {});

    expect(listed.problem).toBeUndefined();
    // The draft is not a job yet: it has no instruction and no chosen schedule.
    expect(listed.jobs).toHaveLength(2);
    expect(listed.jobs.map((entry) => entry.job.id)).toEqual([
      'job-1',
      'job-2',
    ]);

    const digest = summary(listed, 'job-1');
    expect(digest.profileName).toBe('Marimo Bot');
    expect(digest.sessionTitle).toBe('Inbox digest');

    const draft = summary(listed, 'job-2');
    expect(draft.profileName).toBe('Writer');
    expect(draft.sessionTitle).toBe('Blog draft');
  });

  it('pauses a job through the same store rules a tool uses', async () => {
    const paused = await call('jobs.update', {
      jobId: 'job-1',
      patch: {enabled: false},
    });

    expect(paused.found).toBe(true);
    const entry = summary(paused, 'job-1');
    expect(entry.job.enabled).toBe(false);
    // A paused job promises no next run, which is what the card draws.
    expect(entry.job.nextRunAt).toBeUndefined();
    expect(events.some((event) => event.type === 'job.changed')).toBe(true);

    const stored = JSON.parse(await readFile(paths.jobs, 'utf8')) as {
      jobs: {jobs: Job[]};
    };
    expect(stored.jobs.jobs.find((item) => item.id === 'job-1')?.enabled).toBe(
      false,
    );
  });

  it('removes a job and keeps its conversation', async () => {
    const removed = await call('jobs.remove', {jobId: 'job-2'});

    expect(removed.removed).toBe(true);
    expect(removed.jobs.map((entry) => entry.job.id)).toEqual(['job-1']);
    expect(events.some((event) => event.type === 'job.changed')).toBe(true);
    // The chat is still in the index; only the schedule went.
    const index = JSON.parse(
      await readFile(join(paths.sessions, 'index.json'), 'utf8'),
    ) as {sessions: Record<string, unknown>};
    expect(index.sessions['chat-writer']).toBeDefined();
  });

  it('answers found: false for a job that is already gone', async () => {
    const missing = await call('jobs.update', {
      jobId: 'job-that-was-deleted',
      patch: {enabled: true},
    });
    expect(missing.found).toBe(false);
  });
});
