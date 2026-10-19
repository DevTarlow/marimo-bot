/**
 * The scheduling tools, against a stand-in job service.
 *
 * What matters here is not that the tools store things — the store has its own
 * tests — but the edges: a job is stamped with the conversation it was asked for
 * in, `list_jobs` is readable by the model, an id that belongs to nobody is a
 * refusal the model can recover from, and every tool that changes what will run
 * unattended sits behind the approval gate.
 */
import {mkdtemp, rm} from 'node:fs/promises';
import {join} from 'node:path';

import type {BaseTool, Context} from '@google/adk';
import type {Job, JobPatch} from '@marimo/protocol';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';

import type {AgentConfig} from '../config.js';
import {MemoryStore} from '../memory/index.js';
import {createTools} from './index.js';
import {
  createCreateJobTool,
  createDeleteJobTool,
  createListJobsTool,
  createUpdateJobTool,
} from './job-tools.js';
import type {JobService} from './job-tools.js';

/** A job service over an array, recording what the tools asked it to do. */
function fakeJobs(): JobService & {jobs: Job[]; created: unknown[]} {
  const jobs: Job[] = [];
  const created: unknown[] = [];
  let counter = 0;
  return {
    jobs,
    created,
    list: async (profileId) =>
      jobs.filter((job) => job.profileId === profileId),
    create: async (input) => {
      created.push(input);
      counter += 1;
      const job: Job = {
        id: `job-${counter}`,
        name: input.name,
        description: input.description,
        schedules: input.schedules ?? ['0 9 * * *'],
        enabled: true,
        profileId: input.profileId,
        sessionId: input.sessionId,
        createdAt: '2026-05-01T09:00:00.000Z',
      };
      jobs.push(job);
      return job;
    },
    update: async (jobId, patch: JobPatch, profileId) => {
      const job = jobs.find(
        (entry) => entry.id === jobId && entry.profileId === profileId,
      );
      if (!job) {
        return null;
      }
      Object.assign(job, patch);
      return job;
    },
    remove: async (jobId, profileId) => {
      const index = jobs.findIndex(
        (entry) => entry.id === jobId && entry.profileId === profileId,
      );
      if (index < 0) {
        return false;
      }
      jobs.splice(index, 1);
      return true;
    },
  };
}

/**
 * The ADK context a tool reads: the session of the running turn, and the user's
 * approval — which is what ADK attaches when it re-runs a gated call. These are
 * the two facts these tools use, so this is the whole context they need.
 */
function turn(sessionId: string): Context {
  return {
    sessionId,
    toolConfirmation: {confirmed: true},
  } as unknown as Context;
}

/**
 * Runs a tool the way ADK does, through its own argument validation.
 *
 * The context is always supplied, because ADK refuses to run a gated tool
 * without one; the empty session is how a caller with no conversation to attach
 * a job to is represented.
 */
async function run(
  tool: BaseTool,
  args: Record<string, unknown>,
  sessionId = '',
): Promise<string> {
  const result = await tool.runAsync({args, toolContext: turn(sessionId)});
  return typeof result === 'string' ? result : JSON.stringify(result);
}

describe('scheduling tools', () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(process.cwd(), '.marimo-jobs-'));
  });

  afterEach(async () => {
    await rm(workDir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 20,
    });
  });

  function config(): AgentConfig {
    return {
      baseUrl: 'http://127.0.0.1:1',
      model: 'deepseek-chat',
      provider: 'deepseek',
      apiKey: '',
      systemPrompt: 'test',
      profileId: 'profile-1',
      workspaceRoot: workDir,
      allowPrivateNetworkFetch: false,
    };
  }

  describe('the catalogue', () => {
    it('offers no scheduling tools without a job service', () => {
      const tools = createTools(config(), {
        memory: new MemoryStore({workspaceRoot: workDir}),
        model: 'deepseek-chat',
        provider: 'deepseek',
      });
      expect(tools.map((tool) => tool.name)).not.toContain('create_job');
    });

    it('offers them after the shell when a job service is injected', () => {
      const tools = createTools(config(), {
        memory: new MemoryStore({workspaceRoot: workDir}),
        model: 'deepseek-chat',
        provider: 'deepseek',
        jobService: fakeJobs(),
      });
      expect(tools.map((tool) => tool.name).slice(9)).toEqual([
        'run_shell',
        'list_jobs',
        'create_job',
        'update_job',
        'delete_job',
        'draft_bot',
      ]);
    });
  });

  describe('create_job', () => {
    it('stamps the job with the running turn and its agent', async () => {
      const jobs = fakeJobs();
      const tool = createCreateJobTool({jobs, profileId: 'profile-1'});
      const result = await run(
        tool,
        {
          name: 'Morning digest',
          description: 'Summarise new issues.',
          schedules: ['0 9 * * 1-5'],
        },
        'session-9',
      );

      expect(result).toContain('Morning digest');
      // The reply is timed in the user's words, with the expression beside it so
      // the model can read it back exactly.
      expect(result).toContain('at 09:00 on Mondays');
      expect(result).toContain('`0 9 * * 1-5`');
      expect(result).toContain('It runs in this conversation.');
      expect(jobs.created).toEqual([
        {
          name: 'Morning digest',
          description: 'Summarise new issues.',
          sessionId: 'session-9',
          profileId: 'profile-1',
          schedules: ['0 9 * * 1-5'],
        },
      ]);
    });

    it('refuses a job with no conversation to attach it to', async () => {
      const jobs = fakeJobs();
      const tool = createCreateJobTool({jobs, profileId: 'profile-1'});
      const result = await run(tool, {name: 'x', description: 'y'});
      expect(result).toContain('without a conversation');
      expect(jobs.jobs).toHaveLength(0);
    });

    it('asks the user before anything is scheduled', async () => {
      const jobs = fakeJobs();
      const tool = createCreateJobTool({jobs, profileId: 'profile-1'});
      await expect(
        tool.checkRequireConfirmation({name: 'x', description: 'y'}),
      ).resolves.toBe(true);
    });
  });

  describe('list_jobs', () => {
    it('says so when there is nothing scheduled', async () => {
      const jobs = fakeJobs();
      const tool = createListJobsTool({jobs, profileId: 'profile-1'});
      expect(await run(tool, {})).toContain('no scheduled jobs');
    });

    it('reports each job with its times, state and last run', async () => {
      const jobs = fakeJobs();
      await jobs.create({
        name: 'Nightly',
        description: 'Roll the logs.',
        sessionId: 'session-1',
        profileId: 'profile-1',
        schedules: ['30 2 * * *'],
      });
      const paused = await jobs.create({
        name: 'Weekly',
        description: 'Tidy up.',
        sessionId: 'session-2',
        profileId: 'profile-1',
      });
      await jobs.update(paused.id, {enabled: false}, 'profile-1');

      const tool = createListJobsTool({jobs, profileId: 'profile-1'});
      const text = await run(tool, {});
      expect(text).toContain('"Nightly" · active · Runs at 02:30 every day');
      expect(text).toContain('Roll the logs.');
      expect(text).toContain('"Weekly" · paused');
      expect(text).toContain('never run');
    });

    it('shows only the jobs of the agent asking', async () => {
      const jobs = fakeJobs();
      await jobs.create({
        name: 'Mine',
        description: '',
        sessionId: 'session-1',
        profileId: 'profile-1',
      });
      await jobs.create({
        name: 'Theirs',
        description: '',
        sessionId: 'session-2',
        profileId: 'profile-2',
      });
      const tool = createListJobsTool({jobs, profileId: 'profile-1'});
      const text = await run(tool, {});
      expect(text).toContain('Mine');
      expect(text).not.toContain('Theirs');
    });
  });

  describe('update_job', () => {
    it('changes only what was passed', async () => {
      const jobs = fakeJobs();
      const job = await jobs.create({
        name: 'Nightly',
        description: 'Roll the logs.',
        sessionId: 'session-1',
        profileId: 'profile-1',
        schedules: ['30 2 * * *'],
      });
      const tool = createUpdateJobTool({jobs, profileId: 'profile-1'});
      await run(tool, {jobId: job.id, schedules: ['0 6 * * *']}, 'session-1');
      expect(jobs.jobs[0]).toMatchObject({
        name: 'Nightly',
        description: 'Roll the logs.',
        schedules: ['0 6 * * *'],
      });
    });

    it('answers a missing id with something the model can act on', async () => {
      const jobs = fakeJobs();
      const tool = createUpdateJobTool({jobs, profileId: 'profile-1'});
      const result = await run(tool, {jobId: 'ghost', name: 'x'});
      expect(result).toContain('No job with id ghost');
      expect(result).toContain('list_jobs');
    });

    it('asks the user before a job is changed', async () => {
      const jobs = fakeJobs();
      const tool = createUpdateJobTool({jobs, profileId: 'profile-1'});
      await expect(
        tool.checkRequireConfirmation({jobId: 'job-1', enabled: false}),
      ).resolves.toBe(true);
    });
  });

  describe('delete_job', () => {
    it('removes the job and says so', async () => {
      const jobs = fakeJobs();
      const job = await jobs.create({
        name: 'Nightly',
        description: '',
        sessionId: 'session-1',
        profileId: 'profile-1',
      });
      const tool = createDeleteJobTool({jobs, profileId: 'profile-1'});
      expect(await run(tool, {jobId: job.id})).toContain('Removed job');
      expect(jobs.jobs).toHaveLength(0);
    });

    it('refuses to touch another agent’s job', async () => {
      const jobs = fakeJobs();
      const job = await jobs.create({
        name: 'Theirs',
        description: '',
        sessionId: 'session-2',
        profileId: 'profile-2',
      });
      const tool = createDeleteJobTool({jobs, profileId: 'profile-1'});
      expect(await run(tool, {jobId: job.id})).toContain('No job with id');
      expect(jobs.jobs).toHaveLength(1);
    });

    it('asks the user before a job is removed', async () => {
      const jobs = fakeJobs();
      const tool = createDeleteJobTool({jobs, profileId: 'profile-1'});
      await expect(
        tool.checkRequireConfirmation({jobId: 'job-1'}),
      ).resolves.toBe(true);
    });
  });
});
