/**
 * The scheduling tools: what lets the agent set up work that happens later.
 *
 * A job outlives the turn that made it, so the shape here is deliberately narrow.
 * The model can list what exists, propose a new one, change the times or the
 * wording of an existing one, and remove one. It cannot run a job (the scheduler
 * decides when), it cannot point a job at another conversation (the runtime knows
 * the current session and stamps it), and it cannot choose the agent a job
 * belongs to (the caller passes the active profile).
 *
 * Creating or changing a job is gated behind ADK's confirmation flow for the
 * same reason `run_shell` is: a job is something that acts while the user is not
 * watching, and the user should read its name, its instruction and its times
 * before it exists.
 */
import {FunctionTool} from '@google/adk';
import {z} from 'zod';

import type {Job, JobPatch} from '@marimo/protocol';
import {describeCron, nextCronRun} from '@marimo/protocol';

/**
 * Everything the tools need from the app that owns the jobs.
 *
 * This is the whole coupling between the agent package and scheduling: no
 * Electron, no Node, no file paths — the desktop main process implements it over
 * its job store, and a test implements it over an array.
 */
export interface JobService {
  /** The jobs belonging to one agent, in the order the panel shows them. */
  list(profileId: string): Promise<Job[]>;
  /** Adds a job stamped with the conversation it was asked for in. */
  create(input: {
    name: string;
    description: string;
    sessionId: string;
    profileId: string;
    schedules?: string[];
  }): Promise<Job>;
  /** Applies a patch, or answers `null` when the job no longer exists. */
  update(
    jobId: string,
    patch: JobPatch,
    profileId: string,
  ): Promise<Job | null>;
  remove(jobId: string, profileId: string): Promise<boolean>;
}

export const DEFAULT_JOB_SCHEDULE = '0 9 * * *';

export interface JobToolContext {
  jobs: JobService;
  /**
   * The agent that will answer when the job runs.
   *
   * The conversation a job points back at is *not* here: it comes from the
   * running turn (`toolContext.sessionId`), which is what keeps the tools
   * shareable across conversations and the link unfakeable by the model.
   */
  profileId: string;
}

export function createListJobsTool(context: JobToolContext) {
  return new FunctionTool({
    name: 'list_jobs',
    description:
      'List the scheduled jobs belonging to this agent, with their times and ' +
      'how their last run went. Use this before creating, changing or removing a ' +
      'job so you are working from what actually exists.',
    parameters: z.object({}),
    execute: async () => {
      const jobs = await context.jobs.list(context.profileId);
      if (jobs.length === 0) {
        return 'There are no scheduled jobs yet.';
      }
      return jobs.map(describeJob).join('\n');
    },
  });
}

export function createCreateJobTool(context: JobToolContext) {
  return new FunctionTool({
    name: 'create_job',
    description:
      'Schedule a job that runs on its own later. `description` is the ' +
      'instruction the job runs, so write it as a complete request, not a label. ' +
      "`schedules` are 5-field cron expressions in the user's local time " +
      '(minute hour day-of-month month day-of-week; "*" means every), for example ' +
      '"0 9 * * 1-5" for weekdays at 09:00 and "*/30 * * * *" for every half ' +
      'hour. The job runs in this conversation, so the user can open it later to ' +
      'talk to you about changing it. The user must approve the new job first.',
    parameters: z.object({
      name: z
        .string()
        .describe('Short name for the job, e.g. "Morning inbox digest".'),
      description: z
        .string()
        .describe('The instruction the job runs when it fires.'),
      schedules: z
        .array(z.string())
        .min(1)
        .max(5)
        .optional()
        .describe(
          `Cron expressions for when it runs. Defaults to ${DEFAULT_JOB_SCHEDULE} ` +
            '(09:00 every day).',
        ),
    }),
    requireConfirmation: true,
    execute: async ({name, description, schedules}, toolContext) => {
      const sessionId = toolContext?.sessionId ?? '';
      if (sessionId.length === 0) {
        // Refused rather than stored with no conversation: a job with no chat
        // could never be opened or edited, and the run would have nowhere to
        // report to. The model can tell the user and try again.
        return 'Cannot schedule a job without a conversation to attach it to.';
      }
      const job = await context.jobs.create({
        name,
        description,
        sessionId,
        profileId: context.profileId,
        ...(schedules ? {schedules} : {}),
      });
      return `Created "${job.name}" (id ${job.id}). ${timing(job)} It runs in this conversation.`;
    },
  });
}

export function createUpdateJobTool(context: JobToolContext) {
  return new FunctionTool({
    name: 'update_job',
    description:
      'Change an existing job: its name, the instruction it runs, or the times ' +
      'it runs. Only the fields you pass are changed. Pausing is `enabled: ' +
      'false`; resuming is `enabled: true`. Call `list_jobs` first if you do not ' +
      'already know the job id. The user must approve the change.',
    parameters: z.object({
      jobId: z.string().describe('Id of the job, as `list_jobs` reports it.'),
      name: z.string().optional().describe('New name.'),
      description: z
        .string()
        .optional()
        .describe('New instruction the job runs.'),
      schedules: z
        .array(z.string())
        .min(1)
        .max(5)
        .optional()
        .describe('New cron expressions, replacing the current ones.'),
      enabled: z
        .boolean()
        .optional()
        .describe('false pauses the job, true resumes it.'),
    }),
    requireConfirmation: true,
    execute: async ({jobId, name, description, schedules, enabled}) => {
      const patch: JobPatch = {
        ...(name !== undefined ? {name} : {}),
        ...(description !== undefined ? {description} : {}),
        ...(schedules !== undefined ? {schedules} : {}),
        ...(enabled !== undefined ? {enabled} : {}),
      };
      const job = await context.jobs.update(jobId, patch, context.profileId);
      if (!job) {
        // A refusal the model can act on: it can list what exists and try again.
        return `No job with id ${jobId} belongs to this agent. Use list_jobs to see the jobs that do.`;
      }
      return `Updated "${job.name}" (id ${job.id}). ${timing(job)}`;
    },
  });
}

export function createDeleteJobTool(context: JobToolContext) {
  return new FunctionTool({
    name: 'delete_job',
    description:
      'Remove a scheduled job for good. The conversation where it was set up is ' +
      'kept, so its history is not lost. The user must approve the removal.',
    parameters: z.object({
      jobId: z.string().describe('Id of the job, as `list_jobs` reports it.'),
    }),
    requireConfirmation: true,
    execute: async ({jobId}) => {
      const removed = await context.jobs.remove(jobId, context.profileId);
      return removed
        ? `Removed job ${jobId}.`
        : `No job with id ${jobId} belongs to this agent. Use list_jobs to see the jobs that do.`;
    },
  });
}

/** One line per job, in the form the model can read back to the user. */
function describeJob(job: Job): string {
  const state = job.enabled ? 'active' : 'paused';
  const last = job.lastRunAt
    ? `last ran ${job.lastRunAt}${job.lastStatus ? ` (${job.lastStatus})` : ''}`
    : 'never run';
  const description =
    job.description.trim().length > 0 ? ` — ${job.description.trim()}` : '';
  return `- id ${job.id} · "${job.name}" · ${state} · ${timing(job)} · ${last}${description}`;
}

/** "every day at 09:00, next at 2026-05-02T09:00:00.000Z". */
function timing(job: Job): string {
  const parts = job.schedules.map(
    (schedule) => `${describeCron(schedule)} (\`${schedule}\`)`,
  );
  if (!job.enabled) {
    return `Runs ${parts.join('; ')} — paused.`;
  }
  const next = nextCronRun(job.schedules[0] ?? '', new Date());
  const nextText = next ? `, next ${next.toISOString()}` : '';
  return `Runs ${parts.join('; ')}${nextText}.`;
}
