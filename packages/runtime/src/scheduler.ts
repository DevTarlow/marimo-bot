/**
 * The thing that actually runs a job when its time comes.
 *
 * A job is a promise that something will happen later, so this is where the app
 * keeps that promise: one timer, one queue, and a record of how each run went.
 * It owns no storage and no agent — both are handed in — which is what makes the
 * due-job logic testable with a fake clock and a fake runner rather than a laptop
 * left asleep for a day.
 *
 * Three rules shape everything here:
 *
 * - **One turn at a time.** A conversation answers one turn at a time, so a job that
 *   comes due mid-conversation is deferred, not refused. A deferral is not a
 *   failure and is not recorded as one, and it does not consume the occurrence:
 *   the job runs as soon as the agent is free rather than waiting a whole
 *   schedule for its next turn.
 * - **Only the active agent's jobs run.** A job's conversation and memory belong
 *   to the profile that made it, so a job belonging to another agent waits.
 * - **No backfill.** A run missed while the app was closed is missed; the next
 *   future occurrence is scheduled instead. Catching up would mean running an
 *   arbitrary number of turns the moment the app opens.
 */
import type {AgentUiEvent, Job, JobStatus, Jobs} from '@marimo/protocol';

import type {JobStore} from './jobs.js';

/** What the runner needs from the app to start and follow a job's turn. */
export interface JobRunner {
  /**
   * Runs one turn in a job's conversation and reports its events, creating the
   * conversation when the job has none yet.
   *
   * The generator must be consumed to completion; the scheduler does that and
   * turns the final event into the job's recorded outcome.
   */
  run(request: {
    jobId: string;
    /**
     * The agent that owns the job, and therefore the one that answers it.
     *
     * Passed per run rather than read from "the active agent", because a job
     * belongs to the agent that was asked for it: leaving the others dormant
     * until somebody happens to switch to them is how a schedule quietly stops
     * being a schedule.
     */
    profileId: string;
    sessionId: string | null;
    /** The conversation the run happens in, once one exists. */
    onSession: (sessionId: string) => void;
    prompt: string;
    title: string;
  }): Promise<{sessionId: string; events: AsyncGenerator<AgentUiEvent>}>;
  /** Whether a turn is already in flight, by any conversation. */
  isBusy(): boolean;
}

export interface JobSchedulerOptions {
  store: JobStore;
  runner: JobRunner;
  /** How the app tells the window that a card changed. */
  onChange: (jobId: string) => void;
  /** Injected for tests; production uses the real clock and `setTimeout`. */
  now?: () => Date;
  setTimer?: (task: () => void, delayMs: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  /** How long to wait before looking again when nothing is due. */
  idleMs?: number;
  /** How late a job may be and still be run rather than skipped as stale. */
  staleMs?: number;
}

/** Look again this often even with nothing scheduled, to notice a clock jump. */
const DEFAULT_IDLE_MS = 30_000;

/**
 * A run more than this late is skipped rather than fired.
 *
 * Without it, opening the app after a week would fire every job that came due in
 * that week, one after another, which is the opposite of what a schedule means.
 */
const DEFAULT_STALE_MS = 60 * 60_000;

/** How a drained turn ended. */
interface RunOutcome {
  status: JobStatus;
  error?: string;
}

export class JobScheduler {
  private readonly store: JobStore;
  private readonly runner: JobRunner;
  private readonly onChange: (jobId: string) => void;
  private readonly now: () => Date;
  private readonly setTimer: (task: () => void, delayMs: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly idleMs: number;
  private readonly staleMs: number;

  private timer: unknown;
  /** When `timer` is due, as epoch milliseconds; `undefined` when nothing is armed. */
  private timerAt: number | undefined;
  private running = false;
  /** Serialises dispatch, so two due jobs do not race for one turn. */
  private dispatchQueue: Promise<void> = Promise.resolve();
  /** How many dispatched jobs have not finished yet. */
  private outstanding = 0;
  /** session id → job id, so an event stream is attributed without a read. */
  private registry = new Map<string, string>();
  /**
   * session id → the turn being followed there.
   *
   * Which turn an event belongs to decides whether it is the user chatting (and
   * the card should say so) or a run this scheduler started (already recorded
   * by the dispatch, so reporting it again would overwrite the outcome).
   */
  private readonly turns = new Map<string, {jobId: string; own: boolean}>();
  /**
   * The last moment already dispatched.
   *
   * The record that a job ran is written asynchronously, so without this a
   * second look before that write landed would see the same job still due and
   * start it twice. Anything at or before this line has had its turn — with one
   * exception, `waiting` below.
   */
  private dispatchedThrough = 0;
  /**
   * Occurrences the agent was too busy to take, by job id, as epoch ms.
   *
   * A deferral is not a run, so the occurrence is kept rather than consumed and
   * the job is tried again at the next look. This map is what lets that same
   * occurrence past `dispatchedThrough` a second time; it is dropped the moment
   * the run happens, or the occurrence gets too old to be worth running.
   */
  private readonly waiting = new Map<string, number>();

  constructor(options: JobSchedulerOptions) {
    this.store = options.store;
    this.runner = options.runner;
    this.onChange = options.onChange;
    this.now = options.now ?? (() => new Date());
    this.setTimer =
      options.setTimer ??
      ((task, delayMs) => setTimeout(task, delayMs) as unknown);
    this.clearTimer =
      options.clearTimer ??
      ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    this.idleMs = options.idleMs ?? DEFAULT_IDLE_MS;
    this.staleMs = options.staleMs ?? DEFAULT_STALE_MS;
  }

  /**
   * Begins watching. Idempotent, so a restart does not leave two timers.
   *
   * Resolves once the first look is done and a timer is armed, so a caller that
   * awaits it knows the scheduler is watching rather than about to.
   */
  async start(): Promise<void> {
    this.updateRegistry(await this.store.load());
    // Nothing is waiting for a run that the previous watch never took: the
    // store's own marker is the only record that has to survive a restart.
    this.waiting.clear();
    this.running = true;
    await this.arm();
  }

  stop(): void {
    this.running = false;
    this.clearTimer(this.timer);
    this.timer = undefined;
    this.timerAt = undefined;
  }

  /**
   * Whether every dispatched job has finished.
   *
   * Exposed for the tests, which drive `tick()` by hand and then need to know
   * that the work it started is done. Production never asks: its timer comes
   * round again regardless.
   */
  isIdle(): boolean {
    return this.outstanding === 0;
  }

  /**
   * How long until the next look, in milliseconds, or `null` when nothing is
   * armed.
   *
   * Exposed for the tests, which drive a fake clock: the scheduler's timing is
   * its whole job, and "it looks again in a minute" is not something a test can
   * assert by waiting a minute.
   */
  nextLookIn(): number | null {
    if (this.timerAt === undefined) {
      return null;
    }
    return Math.max(0, this.timerAt - this.now().getTime());
  }

  /**
   * Looks at the clock and the store once, and does whatever that says.
   *
   * Resolves to how long until the next look. This is the whole scheduler
   * without its timer: production calls it from `setTimeout`, and a test calls
   * it directly, which is what makes "at 09:00 the job runs" assertable instead
   * of something to wait for.
   */
  async tick(): Promise<number | null> {
    if (!this.running) {
      return null;
    }
    this.clearTimer(this.timer);
    this.timer = undefined;
    this.timerAt = undefined;
    const jobs = await this.pendingForLook();
    if (jobs === null) {
      return this.idleMs;
    }
    await this.retireStale(jobs);
    const due = jobs.filter((job) => this.isDue(job));
    if (due.length > 0) {
      this.enqueue(due);
      // Waited for here rather than left to the timer: a caller that has just
      // been told a job is running wants to know when it stopped, and a failure
      // inside it should surface where it can be acted on rather than vanish
      // into the silent catch the timer path needs.
      await this.dispatchQueue;
    }
    return this.waitFor(jobs);
  }

  /**
   * Looks once, waits for everything it started, and arms nothing.
   *
   * For a process that runs the due jobs and then exits — the headless runner.
   * `tick` is close to this and is not it: `tick` is written for a caller that
   * will be back, and the timer path deliberately does *not* wait for dispatch,
   * because blocking the loop on a job would stop every other job's clock.
   *
   * Here the opposite is true. A one-shot runner that returned before its turn
   * finished would exit with the conversation half-written and the job's
   * outcome unrecorded — and the next tick a minute later would see the
   * occurrence as still due, because the claim that consumes it happens inside
   * the dispatch.
   */
  async runOnce(): Promise<void> {
    this.waiting.clear();
    this.running = true;
    try {
      const jobs = await this.pendingForLook();
      if (jobs === null) {
        return;
      }
      await this.retireStale(jobs);
      const due = jobs.filter((job) => this.isDue(job));
      if (due.length === 0) {
        return;
      }
      this.enqueue(due);
      // The whole difference from the timer path.
      await this.dispatchQueue;
    } finally {
      this.running = false;
    }
  }

  /**
   * Re-arms after something changed the jobs or the active agent.
   *
   * Called on every jobs mutation and every profile switch, so the timer is
   * always pointed at the nearest due time.
   */
  sync(): void {
    if (!this.running) {
      return;
    }
    void this.store
      .load()
      .then((jobs) => {
        this.updateRegistry(jobs);
        this.arm();
      })
      .catch(() => undefined);
  }

  /**
   * Records a turn in a job's conversation that the scheduler did not start.
   *
   * The user opening a job and chatting with it is the ordinary way to edit one,
   * and the card should show that it was used rather than that it never ran. The
   * scheduler's own runs are skipped: their outcome is recorded from the dispatch
   * that started them, where the difference between "ran ok" and "was aborted"
   * is known.
   *
   * Answers whether the session belonged to a job at all.
   */
  async noteTurn(sessionId: string, event: AgentUiEvent): Promise<boolean> {
    const jobId = this.registry.get(sessionId);
    if (!jobId) {
      return false;
    }

    // Which turn this event belongs to. A stream is followed from its first
    // event, so the turn is adopted the first time it is seen; a run the
    // scheduler itself started is already adopted, and marked as its own.
    const turn = this.turns.get(sessionId);
    if (turn?.own) {
      return false;
    }
    const eventTurn =
      'messageId' in event ? event.messageId : `other:${event.type}`;
    const known = turn?.jobId === jobId ? eventTurn : undefined;
    if (known !== eventTurn) {
      this.turns.set(sessionId, {jobId, own: false});
    }

    if (event.type === 'turn.completed') {
      await this.record(jobId, {status: 'ok'});
    } else if (event.type === 'turn.failed') {
      await this.record(jobId, {status: 'error', error: event.message});
    } else if (event.type === 'turn.aborted') {
      await this.record(jobId, {status: 'aborted'});
    } else if (event.type === 'approval.request') {
      // Not an ending: the turn is paused until the user answers, and the card
      // saying so is what sends them to the conversation.
      await this.record(jobId, {status: 'awaiting-approval'});
    } else {
      // Anything before a settle says only that this conversation is in use.
      await this.record(jobId, {status: 'chatting'});
    }
    return true;
  }

  /** The job a session belongs to, if any. */
  jobForSession(sessionId: string): string | undefined {
    return this.registry.get(sessionId);
  }

  /**
   * Whether the turn being followed in this conversation was started here.
   *
   * A scheduler run is recorded from the dispatch that began it, where the
   * difference between "finished" and "was stopped" is known. The window path
   * asks this before it reports anything, so the same run is not recorded twice
   * — once as its outcome, and once as "someone chatted here".
   */
  isOwnRun(sessionId: string): boolean {
    return this.turns.get(sessionId)?.own === true;
  }

  /** Points the timer at the next due moment, or dispatches what is already due. */
  private arm(): Promise<void> {
    if (!this.running) {
      return Promise.resolve();
    }
    this.clearTimer(this.timer);
    this.timer = undefined;
    this.timerAt = undefined;
    return this.runLook();
  }

  /** One look at the store: dispatch what is due, then say when to look again. */
  private async runLook(): Promise<void> {
    const jobs = await this.pendingForLook().catch(() => null);
    if (jobs === null) {
      // A store that cannot be read is already reported by the panel; the
      // scheduler simply keeps its distance and looks again later.
      this.schedule(this.idleMs);
      return;
    }
    if (!this.running) {
      return;
    }
    await this.retireStale(jobs);
    if (!this.running) {
      return;
    }
    const due = jobs.filter((job) => this.isDue(job));
    if (due.length > 0) {
      this.enqueue(due);
    }
    this.schedule(this.waitFor(jobs));
  }

  /**
   * Moves the marker off an occurrence that can no longer be run.
   *
   * An occurrence older than the staleness window is never going to happen: the
   * app was closed through it, or the agent stayed busy for longer than a run
   * may be late. Left where it is, it would pin the job to a moment that has
   * gone — due forever under one reading and never runnable under the other, and
   * either way the next scheduled run is lost with it. Dropping it hands the job
   * back to its schedule, whose next occurrence is worked out from now.
   *
   * Nothing is recorded for a dropped occurrence. A run that did not happen is
   * not a failure, and the card's last-run line should keep saying what last
   * actually happened rather than blaming the job for a closed laptop.
   */
  private async retireStale(jobs: Job[]): Promise<void> {
    const live = new Set(jobs.map((job) => job.id));
    for (const jobId of [...this.waiting.keys()]) {
      // Paused, deleted, or another agent's: nothing is waiting for it now.
      if (!live.has(jobId)) {
        this.waiting.delete(jobId);
      }
    }

    const now = this.now().getTime();
    for (const job of jobs) {
      const at = job.dueAt ? Date.parse(job.dueAt) : NaN;
      if (!Number.isFinite(at) || now - at <= this.staleMs) {
        continue;
      }
      this.waiting.delete(job.id);
      // Through the same line as a dispatched occurrence: a look still holding
      // this snapshot must not treat it as due while the write lands.
      this.dispatchedThrough = Math.max(this.dispatchedThrough, at);
      /*
       * Claimed against the occurrence this look actually saw, and moved to the
       * next one *from now* — a job missed for a week should skip the week, not
       * step forward one occurrence per look until it catches up.
       */
      await this.store.advanceDue(job.id, job.dueAt ?? '', {
        after: new Date(now),
      });
    }
  }

  /**
   * The jobs of the active agent, or `null` when the store could not be read.
   *
   * `null` rather than an empty list on purpose: "there is nothing to run" and
   * "the jobs could not be read" want different waits, and collapsing them would
   * make a corrupt file look like an empty one.
   */
  private async pendingForLook(): Promise<Job[] | null> {
    try {
      return await this.pending();
    } catch (error) {
      /*
       * Reported rather than swallowed. A scheduler that cannot read its own
       * file looks exactly like a scheduler with nothing to do — the same
       * exit-0-having-done-nothing problem the headless runner had — and the
       * only place that difference can surface is here.
       *
       * It is not re-thrown: the look is on a timer, and an exception escaping
       * would end the loop and stop every future job too.
       */
      const detail = error instanceof Error ? error.message : String(error);
      console.error(`[marimo] the job list could not be read: ${detail}`);
      return null;
    }
  }

  private schedule(delayMs: number): void {
    if (!this.running) {
      return;
    }
    this.timerAt = this.now().getTime() + delayMs;
    this.timer = this.setTimer(() => void this.arm(), delayMs);
  }

  /** How long until the next look: the soonest next run, capped at the idle wait. */
  private waitFor(jobs: Job[]): number {
    const now = this.now().getTime();
    const next = jobs
      .map((job) => (job.dueAt ? Date.parse(job.dueAt) : NaN))
      .filter((time) => Number.isFinite(time))
      .sort((left, right) => left - right)[0];
    if (next === undefined) {
      return this.idleMs;
    }
    // An occurrence already in the past is a deferral waiting for the agent to
    // be free. Looking at it the instant a look ends would spin for as long as
    // the conversation lasts — several times a second, each look re-recording
    // the deferral and re-broadcasting it — so it is taken at the ordinary idle
    // tick, which is within half a minute of the agent going quiet.
    if (next <= now) {
      return this.idleMs;
    }
    return Math.max(250, Math.min(next - now, this.idleMs));
  }

  /**
   * Every enabled job, in due order — whichever agent owns it.
   *
   * Not just the active agent's. A job belongs to the agent it was asked of, and
   * a user with two agents should not find that one of them only works while
   * they are looking at it. Each run names its own profile, so the turn is
   * answered by the right agent in the right conversation.
   */
  private async pending(): Promise<Job[]> {
    const jobs = await this.store.load();
    this.updateRegistry(jobs);
    return jobs.jobs
      .filter((job) => job.enabled)
      .sort(
        (left, right) =>
          Date.parse(left.dueAt ?? '') - Date.parse(right.dueAt ?? ''),
      );
  }

  private isDue(job: Job): boolean {
    if (!job.dueAt) {
      return false;
    }
    const at = Date.parse(job.dueAt);
    if (!Number.isFinite(at)) {
      return false;
    }
    const now = this.now().getTime();
    // Already handled: the write that moves this occurrence on has not landed
    // yet, so a look in the meantime must not treat it as due again. An
    // occurrence the agent was too busy to take is the one exception — it was
    // not handled, it is still waiting, and it is deliberately tried again.
    if (at <= this.dispatchedThrough && this.waiting.get(job.id) !== at) {
      return false;
    }
    // Too late to be this run: it belongs to a time the app was not there for,
    // or one the agent was busy through. `retireStale` has just moved the marker
    // on — this is the snapshot taken before that, and it must not fire.
    if (now - at > this.staleMs) {
      return false;
    }
    // The occurrence has come. Whether it has gone is the next look's business,
    // because a deferral keeps the same one and tries again.
    return at <= now;
  }

  private enqueue(jobs: Job[]): void {
    /*
     * The line moves to the latest occurrence just handed out — not to "now".
     * Recording it as now would swallow a job that comes due inside the same
     * tick: the timer fires at 09:00:00 for a 09:00:00 job, and anything at or
     * before the line is treated as already handled.
     */
    for (const job of jobs) {
      const at = job.dueAt ? Date.parse(job.dueAt) : NaN;
      if (Number.isFinite(at)) {
        this.dispatchedThrough = Math.max(this.dispatchedThrough, at);
      }
    }
    this.outstanding += jobs.length;
    this.dispatchQueue = this.dispatchQueue
      .then(async () => {
        for (const job of jobs) {
          await this.dispatch(job);
          this.outstanding -= 1;
        }
      })
      .catch((error: unknown) => {
        /*
         * Reported, not swallowed. `dispatch` already turns a failed *run* into
         * a recorded outcome, so reaching here means something threw outside
         * that — and a scheduler whose work vanishes without a word is the
         * failure this whole file keeps having to be defended against.
         *
         * Still not re-thrown: this runs on a timer, and an exception escaping
         * would end the loop and stop every future job as well.
         */
        const detail = error instanceof Error ? error.message : String(error);
        console.error(`[marimo] a scheduled job could not be dispatched: ${detail}`);
        this.outstanding = 0;
      });
  }

  /**
   * Runs one job, or records why it did not.
   *
   * Every path writes something: a job that came due and was deferred has to be
   * told apart from one that never came due, and both have to stop being due, so
   * the next run is worked out from now rather than from the moment it should
   * have happened.
   */
  private async dispatch(job: Job): Promise<void> {
    const at = job.dueAt ?? this.now().toISOString();

    if (this.runner.isBusy()) {
      /*
       * Deferred, not failed — and deliberately not consumed.
       *
       * The occurrence is kept and tried again at the next look, which is what
       * makes "the agent was busy" cost a conversation rather than a schedule.
       * Advancing the marker here would turn a message asked for at 22:10
       * tonight into one that arrives at 22:10 tomorrow night: the card says
       * "queued — the agent was busy", and that has to be true.
       */
      this.waiting.set(job.id, Date.parse(at));
      await this.record(job.id, {status: 'busy', at});
      return;
    }
    this.waiting.delete(job.id);

    /*
     * The occurrence is consumed before anything else: it has to move whether
     * the run happens or fails, or the same moment would be retried forever.
     *
     * And it is a claim. `null` means the marker had already moved past this
     * occurrence — another process got there first, which is exactly what the
     * app and the headless runner look like to each other. Running it anyway is
     * the one failure this whole arrangement exists to prevent: the user gets
     * the same scheduled message twice.
     */
    const claimed = await this.store.advanceDue(job.id, at);
    if (claimed === null) {
      this.waiting.delete(job.id);
      return;
    }

    const prompt = [
      `[scheduled job "${job.name}" — ${at}]`,
      job.description.trim().length > 0
        ? job.description.trim()
        : `Run the job named "${job.name}".`,
      'Perform this job now and reply with what you did.',
    ].join('\n');

    this.turns.set(job.sessionId ?? job.id, {jobId: job.id, own: true});
    await this.record(job.id, {status: 'busy', at});
    let outcome: RunOutcome;
    try {
      const started = await this.runner.run({
        jobId: job.id,
        profileId: job.profileId,
        sessionId: job.sessionId,
        onSession: (sessionId) => {
          this.registry.set(sessionId, job.id);
          this.turns.set(sessionId, {jobId: job.id, own: true});
        },
        prompt,
        title: job.name,
      });
      this.registry.set(started.sessionId, job.id);
      this.turns.set(started.sessionId, {jobId: job.id, own: true});
      outcome = await drain(started.events);
    } catch (error) {
      outcome = {
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
      };
    }

    await this.record(job.id, {
      status: outcome.status,
      ...(outcome.error === undefined ? {} : {error: outcome.error}),
    });
  }

  private async record(
    jobId: string,
    run: {status: JobStatus; at?: string; error?: string},
  ): Promise<void> {
    const updated = await this.store.recordRun(jobId, {
      at: run.at ?? this.now().toISOString(),
      status: run.status,
      ...(run.error === undefined ? {} : {error: run.error}),
    });
    if (updated) {
      this.onChange(jobId);
    }
  }

  private updateRegistry(jobs: Jobs): void {
    const next = new Map<string, string>();
    for (const job of jobs.jobs) {
      if (job.sessionId) {
        next.set(job.sessionId, job.id);
      }
    }
    this.registry = next;
  }
}

/**
 * Consumes a turn's events and reports how it ended.
 *
 * An approval gate is not an ending: the turn is paused, the job stays visibly
 * waiting for the user, and the scheduler is free to move on. It is the one case
 * where a run's outcome is "unfinished" by design.
 */
async function drain(
  events: AsyncGenerator<AgentUiEvent>,
): Promise<RunOutcome> {
  let outcome: RunOutcome = {status: 'ok'};
  try {
    for await (const event of events) {
      if (event.type === 'turn.completed') {
        outcome = {status: 'ok'};
      } else if (event.type === 'turn.failed') {
        outcome = {status: 'error', error: event.message};
      } else if (event.type === 'turn.aborted') {
        outcome = {status: 'aborted'};
      } else if (event.type === 'approval.request') {
        outcome = {status: 'awaiting-approval'};
      }
    }
  } catch (error) {
    outcome = {
      status: 'error',
      error: error instanceof Error ? error.message : String(error),
    };
  }
  return outcome;
}
