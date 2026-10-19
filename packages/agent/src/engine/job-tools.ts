/**
 * Scheduling from a v2 turn.
 *
 * A job outlives the turn that made it, so the tools are narrow: list what
 * exists, create one, change one, remove one. The model cannot run a job, point
 * one at another conversation, or choose its agent — the runtime stamps those
 * from the turn. Creating or changing one is gated, because a job acts while
 * nobody is watching.
 */
import {z} from 'zod';

import type {Job, JobPatch} from '@marimo/protocol';
import {describeCron} from '@marimo/protocol';

import type {JobService} from '../tools/job-tools.js';
import {
  describeToolError,
  outcome,
  type AnyToolDefinition,
  type ToolContext,
  type ToolOutcome,
} from './tool-contract.js';

export const DEFAULT_JOB_SCHEDULE = '0 9 * * *';

function contextOf(context: ToolContext): {
  jobs: JobService;
  profileId: string;
  sessionId: string;
} | null {
  if (
    context.jobs === undefined ||
    context.profileId === undefined ||
    context.sessionId === undefined
  ) {
    return null;
  }
  return {
    jobs: context.jobs,
    profileId: context.profileId,
    sessionId: context.sessionId,
  };
}

function describeJob(job: Job): string {
  const state = job.enabled ? 'on' : 'paused';
  const next =
    job.nextRunAt === undefined
      ? 'no next run'
      : `next ${new Date(job.nextRunAt).toLocaleString()}`;
  const last =
    job.lastStatus === undefined
      ? 'never run'
      : `${job.lastStatus}${job.lastError === undefined ? '' : `: ${job.lastError}`}`;
  return [
    `- ${job.name} (${job.id}) — ${state}, ${job.schedules.map(describeCron).join(' / ')}, ${next}, last ${last}`,
    `  ${job.description.length === 0 ? '(the name is the instruction)' : job.description}`,
  ].join('\n');
}

export const listJobsTool: AnyToolDefinition = {
  name: 'list_jobs',
  description:
    'List the scheduled jobs belonging to this agent, with their times and how ' +
    'their last run went. Use this before creating, changing or removing a job.',
  parameters: z.object({}),
  requiresJobs: true,
  execute: async (_args, context): Promise<ToolOutcome> => {
    const scoped = contextOf(context);
    if (scoped === null) {
      return outcome(false, 'Scheduling is not available in this turn.');
    }
    try {
      const jobs = await scoped.jobs.list(scoped.profileId);
      return outcome(
        true,
        jobs.length === 0
          ? 'There are no scheduled jobs yet.'
          : jobs.map(describeJob).join('\n'),
      );
    } catch (error) {
      return outcome(false, `Could not list jobs: ${describeToolError(error)}`);
    }
  },
};

export const createJobTool: AnyToolDefinition = {
  name: 'create_job',
  description:
    'Schedule a job that runs on its own later. `description` is the instruction ' +
    'the job runs, so write it as a complete request, not a label. `schedules` ' +
    "are 5-field cron expressions in the user's local time (minute hour " +
    'day-of-month month day-of-week; "*" means every), for example "0 9 * * 1-5" ' +
    'for weekdays at 09:00. The job runs in this conversation, so the user can ' +
    'open it later. The user must approve the new job first.',
  parameters: z.object({
    name: z.string().describe('Short name for the job.'),
    description: z
      .string()
      .describe('The instruction the job runs when it fires.'),
    schedules: z
      .array(z.string())
      .min(1)
      .max(5)
      .optional()
      .describe(
        `Cron expressions. Defaults to ${DEFAULT_JOB_SCHEDULE} (09:00 daily).`,
      ),
  }),
  gate: 'always',
  requiresJobs: true,
  execute: async (args, context): Promise<ToolOutcome> => {
    const scoped = contextOf(context);
    if (scoped === null) {
      return outcome(false, 'Scheduling is not available in this turn.');
    }
    try {
      const job = await scoped.jobs.create({
        name: String(args.name ?? ''),
        description: String(args.description ?? ''),
        sessionId: scoped.sessionId,
        profileId: scoped.profileId,
        ...(Array.isArray(args.schedules)
          ? {schedules: args.schedules.map(String)}
          : {}),
      });
      return outcome(
        true,
        `Scheduled "${job.name}" (${job.id}) for ${job.schedules.map(describeCron).join(' / ')}. The user can change it here later.`,
      );
    } catch (error) {
      return outcome(
        false,
        `Could not schedule that job: ${describeToolError(error)}`,
      );
    }
  },
};

export const updateJobTool: AnyToolDefinition = {
  name: 'update_job',
  description:
    'Change a scheduled job: its name, the instruction it runs, its times, or ' +
    'whether it is paused. Read it with list_jobs first. The user must approve ' +
    'the change.',
  parameters: z.object({
    jobId: z.string().describe('The job id from list_jobs.'),
    name: z.string().optional(),
    description: z.string().optional(),
    schedules: z.array(z.string()).min(1).max(5).optional(),
    enabled: z.boolean().optional(),
  }),
  gate: 'always',
  requiresJobs: true,
  execute: async (args, context): Promise<ToolOutcome> => {
    const scoped = contextOf(context);
    if (scoped === null) {
      return outcome(false, 'Scheduling is not available in this turn.');
    }
    const patch: JobPatch = {
      ...(typeof args.name === 'string' ? {name: args.name} : {}),
      ...(typeof args.description === 'string'
        ? {description: args.description}
        : {}),
      ...(Array.isArray(args.schedules)
        ? {schedules: args.schedules.map(String)}
        : {}),
      ...(typeof args.enabled === 'boolean' ? {enabled: args.enabled} : {}),
    };
    try {
      const job = await scoped.jobs.update(
        String(args.jobId ?? ''),
        patch,
        scoped.profileId,
      );
      return job === null
        ? outcome(false, 'That job no longer exists.')
        : outcome(
            true,
            `Updated "${job.name}". ${job.enabled ? 'It is on' : 'It is paused'}; next ${job.nextRunAt === undefined ? 'no run' : new Date(job.nextRunAt).toLocaleString()}.`,
          );
    } catch (error) {
      return outcome(
        false,
        `Could not update that job: ${describeToolError(error)}`,
      );
    }
  },
};

export const deleteJobTool: AnyToolDefinition = {
  name: 'delete_job',
  description:
    'Remove a scheduled job. Read it with list_jobs first; the user must approve ' +
    'the removal.',
  parameters: z.object({
    jobId: z.string().describe('The job id from list_jobs.'),
  }),
  gate: 'always',
  requiresJobs: true,
  execute: async (args, context): Promise<ToolOutcome> => {
    const scoped = contextOf(context);
    if (scoped === null) {
      return outcome(false, 'Scheduling is not available in this turn.');
    }
    try {
      const removed = await scoped.jobs.remove(
        String(args.jobId ?? ''),
        scoped.profileId,
      );
      return removed
        ? outcome(true, 'Removed that job.')
        : outcome(false, 'That job no longer exists.');
    } catch (error) {
      return outcome(
        false,
        `Could not remove that job: ${describeToolError(error)}`,
      );
    }
  },
};

export const JOB_TOOLS: readonly AnyToolDefinition[] = [
  listJobsTool,
  createJobTool,
  updateJobTool,
  deleteJobTool,
];
