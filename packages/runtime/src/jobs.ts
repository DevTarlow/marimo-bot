/**
 * The jobs document, in one file beside the app's other state.
 *
 * This is a sibling of `todos.ts` and for the same reasons: the list is small,
 * every gesture in the panel or the agent's tools produces a whole new document,
 * and replacing it wholesale means the window and the file cannot disagree about
 * what an edit did. Durability and the validation of what came off disk live
 * here; the scheduling *rules* live in `scheduler.ts`, and the panel's reading of
 * a job lives in `jobs-view.ts`.
 *
 * One thing here is not a mirror of `TodoStore`: `nextRunAt` is derived. It is
 * stored so the panel can sort and label without re-parsing five cron
 * expressions per render, and recomputed on every read and every write, so a
 * document that sat on disk for a week cannot claim a next run in the past.
 */
import {randomUUID} from 'node:crypto';
import {mkdir, rename, writeFile} from 'node:fs/promises';
import {dirname} from 'node:path';

import {
  emptyJobs,
  jobsFileSchema,
  nextCronRun,
  PLACEHOLDER_JOB_NAME,
} from '@marimo/protocol';
import type {Job, JobPatch, JobStatus, Jobs} from '@marimo/protocol';

import {withFileLock} from './lock.js';
import {
  DocumentTooNewError,
  quarantineDocument,
  readVersionedDocument,
} from '@marimo/agent';

export interface JobStoreOptions {
  file: string;
  /**
   * The clock, injected so a test can schedule a job "for tomorrow" without
   * waiting until tomorrow. Production uses the real one.
   */
  now?: () => Date;
}

/** What a new job needs; everything else is stamped here. */
export interface NewJob {
  name: string;
  description: string;
  /** The conversation it was asked for in, so it can be opened again. */
  sessionId: string;
  profileId: string;
  schedules?: string[];
}

/** How a run ended, as the scheduler saw it. */
export interface JobRunRecord {
  at: string;
  status: JobStatus;
  error?: string;
}

/** The default: 09:00 every day, which is what a job with no schedule means. */
export const DEFAULT_SCHEDULE = '0 9 * * *';

/**
 * The name a job wears between "New job" and the agent proposing a real one.
 *
 * The constant lives in the protocol, beside the list that must hide a draft and
 * the store that names one, so those three cannot disagree about the character.
 * It is re-exported here because every caller that knows a job knows it through
 * the store.
 */
export {PLACEHOLDER_JOB_NAME};

/** Whether a job is still waiting for the agent to give it a name. */
export function isPlaceholder(job: Job): boolean {
  return job.name === PLACEHOLDER_JOB_NAME;
}

export class JobStore {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly now: () => Date;

  constructor(private readonly options: JobStoreOptions) {
    this.now = options.now ?? (() => new Date());
  }

  /**
   * The stored document, with every `nextRunAt` brought up to date.
   *
   * A missing, truncated, or newer-versioned file is not something the user can
   * act on, and refusing to open the panel over it would be worse than starting
   * clean — so anything unreadable reads as empty rather than throwing.
   *
   * Reading does not write: a stale `nextRunAt` is corrected on the way out, and
   * the file is left alone until something actually changes. `syncNextRuns` is
   * the one caller that wants the correction persisted.
   */
  async load(): Promise<Jobs> {
    return (await this.loadChecked()).jobs;
  }

  /**
   * Adds a job, enabled, with its next run already worked out.
   *
   * A job created by the *tool* arrives with a name; one created by the panel's
   * **New job** arrives without, and is named after whatever the conversation
   * turns into. In that second case there is at most one such job per agent —
   * clicking "New job" twice is one intention, not two jobs — so this reuses it
   * rather than stacking up nameless cards.
   */
  async create(input: NewJob): Promise<{jobs: Jobs; job: Job}> {
    if (input.name.trim() === PLACEHOLDER_JOB_NAME) {
      const current = await this.load();
      const existing = current.jobs.find(
        (job) => job.profileId === input.profileId && isPlaceholder(job),
      );
      if (existing) {
        // Reuse rather than stack: two unnamed jobs would be two cards nobody
        // can tell apart.
        return {jobs: current, job: existing};
      }
    }
    const job: Job = {
      id: randomUUID(),
      name: input.name.trim(),
      description: input.description,
      schedules: normalizeSchedules(input.schedules),
      /*
       * A placeholder starts paused, and is enabled when the agent gives it a
       * name and a real instruction. That is the safeguard that matters: a job
       * nobody has described yet must not be able to run the default schedule
       * every morning, whatever the panel does with it.
       */
      enabled: input.name.trim() !== PLACEHOLDER_JOB_NAME,
      profileId: input.profileId,
      sessionId: input.sessionId,
      createdAt: this.now().toISOString(),
    };
    const stamped = stampJob(job, this.now());
    // Newest first, which is the order the panel lists them in.
    const jobs = await this.mutate((current) => ({
      ...current,
      jobs: [stamped, ...current.jobs],
    }));
    return {jobs, job: stamped};
  }

  /**
   * Applies a patch, or answers `null` when the job is not there.
   *
   * `null` rather than a throw: the renderer holding a stale document and the
   * scheduler finding a job removed in another window are both ordinary, and
   * neither is worth an error banner.
   */
  async update(jobId: string, patch: JobPatch): Promise<Job | null> {
    const result = await this.updateWithView(jobId, patch, {});
    if (!result.found) {
      return null;
    }
    return result.jobs.jobs.find((job) => job.id === jobId) ?? null;
  }

  /**
   * Applies a job patch and the rail's view in one write.
   *
   * The two arrive together because they are one gesture: pausing a job and
   * folding the rail are independent, and a window that sent them as two calls
   * would have the first answer overwrite the second.
   */
  async updateWithView(
    jobId: string | null,
    patch: JobPatch,
    view: {open?: boolean; openJobId?: string | null},
  ): Promise<{jobs: Jobs; found: boolean}> {
    let found = false;
    const jobs = await this.mutate((current) => {
      const index =
        jobId === null ? -1 : current.jobs.findIndex((job) => job.id === jobId);
      const nextJobs = [...current.jobs];
      if (index >= 0) {
        found = true;
        nextJobs[index] = this.patchJob(nextJobs[index]!, patch);
      }

      const openJobId =
        view.openJobId === undefined
          ? current.openJobId
          : nextJobs.some((job) => job.id === view.openJobId)
            ? view.openJobId
            : null;
      return {
        jobs: nextJobs,
        open: view.open ?? current.open,
        openJobId,
      };
    });
    return {jobs, found};
  }

  /**
   * One job, with a patch applied and its derived times worked out again.
   *
   * The naming rule lives here: an unnamed job is a *draft* — the placeholder
   * **New job** leaves while the conversation happens — and naming it is what
   * turns it into a job that runs. Until then it stays paused, so a job nobody
   * has described can never fire the default schedule on its own.
   */
  private patchJob(before: Job, patch: JobPatch): Job {
    const named =
      isPlaceholder(before) &&
      patch.name !== undefined &&
      patch.name.trim() !== PLACEHOLDER_JOB_NAME;
    const merged: Job = {
      ...before,
      ...(patch.name !== undefined ? {name: patch.name.trim()} : {}),
      ...(patch.description !== undefined
        ? {description: patch.description}
        : {}),
      ...(patch.schedules !== undefined
        ? {schedules: normalizeSchedules(patch.schedules)}
        : {}),
      // A job that has just been described takes the default schedule then,
      // rather than at the moment it was clicked.
      ...(named && patch.schedules === undefined
        ? {schedules: [DEFAULT_SCHEDULE]}
        : {}),
      ...(patch.enabled !== undefined
        ? {enabled: patch.enabled}
        : named
          ? {enabled: true}
          : {}),
    };
    // A changed schedule starts a new story: the previous run's complaint was
    // about times that no longer apply. Resuming clears it for the same reason —
    // the user has just asked for another go.
    const job: Job =
      patch.schedules !== undefined || patch.enabled === true || named
        ? withoutError(merged)
        : merged;
    return stampJob(job, this.now());
  }

  /** Removes a job, answering whether there was one. */
  async remove(jobId: string): Promise<boolean> {
    let removed = false;
    await this.mutate((current) => {
      const jobs = current.jobs.filter((job) => job.id !== jobId);
      removed = jobs.length !== current.jobs.length;
      return removed ? {...current, jobs} : current;
    });
    return removed;
  }

  /**
   * Removes everything a bot had scheduled, answering how many went.
   *
   * Beside `remove` rather than a loop over it because of what a leftover job
   * does: the runner would wake on its schedule, find no such bot, and report a
   * failure every time it came due — a notification the user cannot act on
   * because the thing it is about is no longer in Settings.
   */
  async removeForProfile(profileId: string): Promise<number> {
    let removed = 0;
    await this.mutate((current) => {
      const jobs = current.jobs.filter((job) => job.profileId !== profileId);
      removed = current.jobs.length - jobs.length;
      return removed > 0 ? {...current, jobs} : current;
    });
    return removed;
  }

  /**
   * Records how a job's run went.
   *
   * Called by the scheduler, and by the panel's conversation when the *user* is
   * the one chatting: a card that said "never run" while the user has been
   * talking to that job all afternoon would be a lie by omission.
   */
  async recordRun(jobId: string, run: JobRunRecord): Promise<Job | null> {
    let updated: Job | null = null;
    await this.mutate((current) => {
      const index = current.jobs.findIndex((job) => job.id === jobId);
      if (index < 0) {
        return current;
      }
      const job: Job = {
        ...current.jobs[index]!,
        lastRunAt: run.at,
        lastStatus: run.status,
        // An old complaint is dropped rather than left behind: a stale error
        // next to a fresh run reads as if it had just happened.
        ...(run.error === undefined ? {} : {lastError: run.error}),
      };
      updated = job;
      const jobs = [...current.jobs];
      jobs[index] = job;
      return {...current, jobs};
    });
    return updated;
  }

  /**
   * Moves a job's occurrence marker on to the next time its schedule names.
   *
   * Called the moment a job is dispatched, before the turn runs: the marker is
   * what stops a daily job firing once a minute all day, and it has to move even
   * if the run then fails, or the same occurrence would be retried forever.
   *
   * A schedule with no next occurrence — 30 February, or one the user has just
   * edited into that — leaves the job with nothing to watch, and the marker is
   * *removed* rather than left where it is. A stale marker on a job whose
   * schedule can no longer move it reads as an occurrence that is still due, and
   * every look would rewrite the document trying to retire it.
   *
   * Returns the advanced job, or `null` when this call did *not* consume the
   * occurrence — either because the job is gone, or because the marker had
   * already moved past `from`. The caller must not run the job in that case:
   * somebody else already has it.
   */
  async advanceDue(
    jobId: string,
    from: string,
    options: {after?: Date} = {},
  ): Promise<Job | null> {
    let updated: Job | null = null;
    await this.mutate((current) => {
      const index = current.jobs.findIndex((job) => job.id === jobId);
      if (index < 0) {
        return current;
      }
      const before = current.jobs[index]!;
      /*
       * Consuming an occurrence is a compare-and-set, and that is what makes a
       * job run once.
       *
       * Two processes can both see the same occurrence as due — the app and the
       * headless runner are exactly this case — and without this check both
       * would advance the marker and both would run the turn. Nothing about a
       * lock is needed for that: the document is the arbiter, and the winner is
       * whoever's read-modify-write lands first. The loser is told so by the
       * `null`, and must not run.
       */
      if (before.dueAt !== from) {
        return current;
      }
      /*
       * Where the search for the next occurrence begins.
       *
       * Normally a millisecond after the one being consumed: the occurrence is
       * a whole minute, and the cron walk only reports times strictly after its
       * start, so this lands on the *next* occurrence rather than a whole
       * schedule later.
       *
       * `after` is for the other caller — retiring an occurrence that was missed
       * while nothing was running. There the point is to skip everything that
       * was missed and land on the next one from now, rather than walking
       * forward an occurrence per look until the schedule catches up.
       */
      const consumed =
        options.after ??
        (Number.isFinite(Date.parse(from))
          ? new Date(Date.parse(from) + 1)
          : this.now());
      const dueAt = occurrenceAfter(before, consumed);
      const job: Job =
        dueAt === undefined ? withoutDue(before) : {...before, dueAt};
      updated = job;
      const jobs = [...current.jobs];
      jobs[index] = job;
      return {...current, jobs};
    });
    return updated;
  }

  /**
   * Sets what the rail is showing: open or folded, and which card expanded.
   *
   * One write for both because they are one view — the rail remembers whether it
   * was there and what it was looking at — and because writing them separately
   * would let the first answer, which predates the second gesture, overwrite it.
   *
   * A job id that no longer exists means the list: a stale id must not leave the
   * panel pointing at a card nobody can see.
   */
  async setView(view: {
    open?: boolean;
    openJobId?: string | null;
  }): Promise<Jobs> {
    return await this.mutate((current) => {
      const openJobId =
        view.openJobId === undefined
          ? current.openJobId
          : current.jobs.some((job) => job.id === view.openJobId)
            ? view.openJobId
            : null;
      return {
        jobs: current.jobs,
        open: view.open ?? current.open,
        openJobId,
      };
    });
  }

  /**
   * Points a job at a conversation.
   *
   * Separate from `update` because `sessionId` is not patchable from outside:
   * the window may rename a job or change its times, but only the app decides
   * which conversation a job belongs to. This is how a run repairs the link
   * after the user deleted the chat from the sidebar.
   */
  async setSession(jobId: string, sessionId: string): Promise<Job | null> {
    let updated: Job | null = null;
    await this.mutate((current) => {
      const index = current.jobs.findIndex((job) => job.id === jobId);
      if (index < 0) {
        return current;
      }
      const job: Job = {...current.jobs[index]!, sessionId};
      updated = job;
      const jobs = [...current.jobs];
      jobs[index] = job;
      return {...current, jobs};
    });
    return updated;
  }

  /**
   * Recomputes every job's next run and writes the result.
   *
   * The scheduler calls this after its clock jumps — a laptop that slept through
   * three runs comes back with a document whose next runs are in the past, and
   * the panel would show them as due right now.
   */
  async syncNextRuns(): Promise<Jobs> {
    return await this.mutate((current) => ({...current}));
  }

  /**
   * Reads, edits, validates and writes the document in one serialised turn.
   *
   * The document is re-stamped before it is written, so `nextRunAt` reflects the
   * moment of the write rather than the moment the edit was computed. An edit
   * that produces something the schema refuses is a bug in this file, not user
   * input — every field crosses a zod boundary before it gets here — so it
   * throws rather than storing a document that will read back as empty.
   */
  private async mutate(edit: (current: Jobs) => Jobs): Promise<Jobs> {
    return await this.withLock(async () => {
      /*
       * And then the filesystem's lock, because the queue above is only this
       * process's. The app and the headless runner both read and write this
       * document, and read-modify-write without exclusion loses whichever write
       * lands second — which for a job marker means the same occurrence being
       * consumed twice and the run happening twice.
       */
      return await withFileLock(`${this.options.file}.lock`, async () => {
      /*
       * Before anything is written, decide what the file on disk deserves.
       *
       * The read below is lenient by design — an unreadable document becomes an
       * empty one so the window still opens — and leniency plus a write is how a
       * user's jobs disappear: the file from a newer build reads as empty, the
       * edit is applied to nothing, and the result is stored over the original.
       *
       * A newer file is refused outright, because a later Marimo Bot can still
       * read it. A corrupt one is moved aside first, because nothing can read it
       * — including this build — and refusing forever would mean the app could
       * never save anything again with no hint about which file to delete.
       */
      const read = await readVersionedDocument(this.options.file, {
        label: 'The jobs file',
      });
      if (read.state === 'too-new') {
        throw new DocumentTooNewError(
          'The jobs file',
          read.found,
          read.supported,
        );
      }
      if (read.state === 'unreadable') {
        await quarantineDocument(this.options.file);
      }

      const current = (await this.loadChecked()).jobs;
      const edited = this.stamp(edit(current));
      const validated = jobsFileSchema.safeParse({version: 1, jobs: edited});
      if (!validated.success) {
        const detail = validated.error.issues
          .map((issue) => issue.path.join('.') || issue.message)
          .join('; ');
        throw new Error(
          `Refusing to store an invalid jobs document: ${detail}`,
        );
      }
      await this.writeFile(validated.data.jobs);
      return validated.data.jobs;
      });
    });
  }

  private async writeFile(jobs: Jobs): Promise<void> {
    await mkdir(dirname(this.options.file), {recursive: true});
    // Written to a sibling and renamed so a crash mid-write cannot leave a
    // half-file where the jobs used to be.
    const temporary = `${this.options.file}.${randomUUID()}.tmp`;
    await writeFile(
      temporary,
      `${JSON.stringify({version: 1, jobs}, null, 2)}\n`,
      'utf8',
    );
    await rename(temporary, this.options.file);
  }

  /**
   * The jobs, and the reason there are none when the file could not be read.
   *
   * `load()` deliberately treats an unreadable file as an empty one: the window
   * has to open so the user can fix whatever is wrong, and throwing there would
   * turn a bad file into an app that will not start. The headless runner cannot
   * afford the same leniency, because for it "unreadable" and "nothing
   * scheduled" have the same observable outcome — a process that exits 0 having
   * done nothing — and that is exactly the failure nobody notices. So the reason
   * travels back with the document and each caller decides what to do with it.
   *
   * The read goes through `readVersionedDocument`, which is what refuses a file
   * from a newer build rather than reporting it as empty. Without that, a user
   * who ran a newer Marimo Bot and came back would silently lose their jobs
   * the first time anything wrote the document.
   */
  async loadChecked(): Promise<{jobs: Jobs; problem?: string}> {
    const read = await readVersionedDocument(this.options.file, {
      label: 'The jobs file',
    });

    if (read.state === 'absent') {
      return {jobs: emptyJobs()};
    }

    if (read.state === 'too-new') {
      return {
        jobs: emptyJobs(),
        problem:
          'The jobs file was written by a newer version of Marimo Bot ' +
          `(format ${read.found}; this build understands ${read.supported}). ` +
          'It has been left untouched — update the app to run these jobs.',
      };
    }

    if (read.state === 'unreadable') {
      return {jobs: emptyJobs(), problem: read.reason};
    }

    const parsed = jobsFileSchema.safeParse(read.document);
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map((issue) => issue.path.join('.') || issue.message)
        .slice(0, 3)
        .join('; ');
      return {
        jobs: emptyJobs(),
        problem: `The jobs file is not a jobs document: ${detail}`,
      };
    }

    /*
     * A `migrated` read is stamped and used but not written back here. Reading
     * does not write — that is the rule the whole store follows — and the
     * migrated shape is persisted by the next real change. There are no
     * migrations yet, so this is a note for whoever adds the first one rather
     * than a path anything currently takes.
     */
    return {jobs: this.stamp(parsed.data.jobs)};
  }

  private stamp(jobs: Jobs): Jobs {
    const now = this.now();
    return {...jobs, jobs: jobs.jobs.map((job) => stampJob(job, now))};
  }

  private async withLock<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return await run;
  }
}

/**
 * A schedule list that is always a real one.
 *
 * The protocol refuses an empty array on the way in; this covers the caller that
 * has not discussed a schedule yet, which is the ordinary path when "New job" is
 * clicked in the panel.
 */
function normalizeSchedules(schedules: string[] | undefined): string[] {
  const cleaned = (schedules ?? [])
    .map((entry) => entry.trim())
    .filter(Boolean);
  return cleaned.length > 0 ? cleaned : [DEFAULT_SCHEDULE];
}

/**
 * Brings a job's two derived times up to date.
 *
 * `dueAt` is the occurrence the scheduler is watching; `nextRunAt` is the
 * promise the card makes. Both have to exist for "it is 09:00 on the minute it
 * says" to mean anything, and neither can be derived from the other: a job whose
 * occurrence is *now* has `dueAt` in the past and `nextRunAt` in the future.
 *
 * `dueAt` is recomputed from the schedule whenever it is missing or implausibly
 * old — which is what makes the first launch after a week off skip the runs it
 * missed and pick up the next one. A marker that is merely in the past, by less
 * than the staleness window, is left exactly as it is: that is a job waiting to
 * be run, and recomputing it would silently forget the occurrence.
 */
function stampJob(job: Job, now: Date): Job {
  const stale = now.getTime() - STALE_AFTER_MS;

  if (!job.enabled) {
    // A paused job is not going to run, so it promises no next run. The marker
    // is kept so resuming at, say, 10:00 does not immediately fire the 09:00
    // that the pause was meant to skip.
    const {nextRunAt: _next, ...rest} = job;
    return rest;
  }

  const marked = job.dueAt ? Date.parse(job.dueAt) : NaN;
  const dueAt =
    Number.isFinite(marked) && marked > stale
      ? job.dueAt
      : occurrenceAfter(job, now);

  // The next run is the one after the occurrence being watched, so the card does
  // not promise a time that has already been consumed.
  const next =
    dueAt !== undefined
      ? occurrenceAfter(job, new Date(Date.parse(dueAt)))
      : undefined;

  const {nextRunAt: _next, ...rest} = job;
  return {
    ...rest,
    ...(dueAt === undefined ? {} : {dueAt}),
    ...(next === undefined ? {} : {nextRunAt: next}),
  };
}

/**
 * How late an occurrence may be and still be run.
 *
 * A day and a half: long enough that an app left open over a weekend still runs
 * what it missed that morning, short enough that opening the app after a
 * fortnight does not fire two weeks of runs one after another.
 */
const STALE_AFTER_MS = 36 * 3_600_000;

/**
 * The soonest occurrence of a job's schedules strictly after `from`.
 *
 * `nextRunAfter` already means "strictly after", so a job whose time is exactly
 * now is reported as due by `dueAt` and promised as the *next* occurrence by
 * `nextRunAt`, which is why the scheduler needs both.
 */
function occurrenceAfter(job: Job, from: Date): string | undefined {
  let soonest: Date | null = null;
  for (const schedule of job.schedules) {
    const next = nextCronRun(schedule, from);
    if (next && (!soonest || next.getTime() < soonest.getTime())) {
      soonest = next;
    }
  }
  return soonest ? soonest.toISOString() : undefined;
}

function withoutError(job: Job): Job {
  const {lastError: _previous, ...rest} = job;
  return rest;
}

/** The job with no occurrence being watched, which is what it has left. */
function withoutDue(job: Job): Job {
  const {dueAt: _consumed, ...rest} = job;
  return rest;
}
