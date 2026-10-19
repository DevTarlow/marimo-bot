/**
 * The scheduler's rules, against a clock and a runner we control.
 *
 * Everything here is about *when* and *whether* a job runs, which is not
 * something that can be tested by waiting: the clock, the timer and the agent are
 * all injected, so a job that comes due at 09:00 on a Tuesday is one line of
 * setup rather than a laptop left running overnight.
 */
import {mkdtemp, rm} from 'node:fs/promises';
import {join} from 'node:path';

import type {AgentUiEvent, Job, Jobs} from '@marimo/protocol';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {JobStore} from './jobs.js';
import {JobScheduler} from './scheduler.js';
import type {JobRunner} from './scheduler.js';

/**
 * A clock the test owns, and a driver that steps the scheduler through it.
 *
 * Time here is a number the test moves, not something to wait for: both the
 * store and the scheduler read it through the same function, so a job created
 * "for 09:00" is due the moment the clock says 09:00.
 *
 * The scheduler is stepped with `tick()`, which is the look its own timer would
 * have performed. That keeps the assertions about *when* a job runs free of
 * anything to do with how a timer is scheduled.
 */
class FakeClock {
  private current: Date;

  constructor(start: Date) {
    this.current = new Date(start.getTime());
  }

  now = (): Date => new Date(this.current.getTime());

  /** Timers are recorded so a test can assert the scheduler armed one. */
  timers: Array<{at: number; handle: number}> = [];
  private nextHandle = 1;

  setTimer = (_task: () => void, delayMs: number): unknown => {
    const handle = this.nextHandle++;
    this.timers.push({at: this.current.getTime() + delayMs, handle});
    return handle;
  };

  clearTimer = (handle: unknown): void => {
    this.timers = this.timers.filter((timer) => timer.handle !== handle);
  };

  /**
   * Moves the clock without running anything.
   *
   * For `runOnce`, which takes no timers: a test has to say what time it is
   * rather than ask to be woken at it.
   */
  setNow(when: Date): void {
    this.current = new Date(when.getTime());
  }

  /** The one timer the scheduler keeps armed, or `null`. */
  armedIn(): number | null {
    const latest = this.timers[this.timers.length - 1];
    return latest ? latest.at - this.current.getTime() : null;
  }

  /**
   * Runs one look per tick until `at`, moving the clock to each moment the
   * scheduler asked to be woken at.
   *
   * `onTick` runs between looks — the one place a test can change the world
   * (the runner going busy, the user pausing a job) without racing the code
   * under test.
   */
  async runUntil(
    scheduler: {tick: () => Promise<number | null>; isIdle: () => boolean},
    at: Date,
    onTick?: () => void | Promise<void>,
  ): Promise<void> {
    for (let guard = 0; guard < 100_000; guard += 1) {
      // A look at `at` itself is the one that matters: 09:00 is the minute a
      // 09:00 job is due. So the clock is stepped first and the look follows,
      // and the loop ends after the look that has arrived.
      const arrived = this.current.getTime() >= at.getTime();
      const delay = await scheduler.tick();
      await onTick?.();
      if (arrived) {
        break;
      }
      this.current = new Date(
        Math.min(
          this.current.getTime() + Math.max(1, delay ?? 1_000),
          at.getTime(),
        ),
      );
    }

    // The last look waits for its own dispatch, so whatever the job did has
    // already happened by the time this returns.
  }

  /** Jumps the clock, as a suspended laptop does; nothing runs in between. */
  jumpTo(at: Date): void {
    this.current = new Date(at.getTime());
  }
}

/** A runner that records what it was asked to do and streams a fixed outcome. */
interface FakeRunner extends JobRunner {
  runs: Array<{
    jobId: string;
    profileId: string;
    sessionId: string | null;
    prompt: string;
  }>;
  busy: boolean;
  /** What the next run's stream will do. */
  outcome: 'completed' | 'failed' | 'aborted' | 'approval';
}

function fakeRunner(): FakeRunner {
  const runner: FakeRunner = {
    runs: [],
    busy: false,
    outcome: 'completed',
    isBusy: () => runner.busy,
    run: async ({jobId, profileId, sessionId, onSession, prompt}) => {
      runner.runs.push({jobId, profileId, sessionId, prompt});
      const resolved = sessionId ?? `session-for-${jobId}`;
      onSession(resolved);
      return {sessionId: resolved, events: stream(runner.outcome)};
    },
  };
  return runner;
}

/** One turn's events, in the shape ADK produces them. */
async function* stream(
  outcome: FakeRunner['outcome'],
): AsyncGenerator<AgentUiEvent> {
  const sessionId = 'session';
  const base = {sessionId, messageId: 'message-1'};
  yield {type: 'turn.started', ...base};
  if (outcome === 'failed') {
    yield {type: 'turn.failed', ...base, message: 'the provider said no'};
  } else if (outcome === 'aborted') {
    yield {type: 'turn.aborted', ...base};
  } else if (outcome === 'approval') {
    yield {
      type: 'approval.request',
      ...base,
      callId: 'call-1',
      tool: 'run_shell',
      args: {},
      hint: 'approve?',
    };
  } else {
    yield {type: 'turn.completed', ...base};
  }
}

/** A time `ms` after the fixed start every test shares. */
function afterStart(ms: number): Date {
  return new Date(new Date(2026, 4, 1, 8, 0).getTime() + ms);
}

describe('JobScheduler', () => {
  let dir: string;
  let store: JobStore;
  /**
   * The one clock everything reads.
   *
   * The store computes `nextRunAt` and the scheduler decides what is due, so
   * both have to be looking at the same instant — a store on the machine's real
   * clock would schedule a fake "09:00" for a real tomorrow.
   */
  let clock: FakeClock;
  let runner: FakeRunner;
  let changed: string[];
  let profileId: string;
  let scheduler: JobScheduler;

  beforeEach(async () => {
    dir = await mkdtemp(join(process.cwd(), '.marimo-scheduler-'));
    clock = new FakeClock(afterStart(0));
    // One clock for both: the store works out `nextRunAt` from it, and the
    // scheduler decides what is due from it.
    store = new JobStore({file: join(dir, 'jobs.json'), now: clock.now});
    runner = fakeRunner();
    changed = [];
    profileId = 'profile-1';
    scheduler = new JobScheduler({
      store,
      runner,
      onChange: (jobId) => changed.push(jobId),
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      idleMs: 30_000,
      // `staleMs` is deliberately left at its default. It used to be pinned here
      // to a day and a half, which is not the window production uses — and a
      // test that argues with the shipped value is how a deferral that outlived
      // its window went unnoticed.
    });
  });

  afterEach(async () => {
    scheduler.stop();
    await rm(dir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 20,
    });
  });

  /** A job on a given schedule, owned by the active agent by default. */
  async function jobAt(
    schedule: string,
    overrides: Partial<Job> = {},
  ): Promise<Job> {
    const {job} = await store.create({
      name: 'Morning digest',
      description: 'Summarise new issues.',
      sessionId: 'session-1',
      profileId: (overrides.profileId as string | undefined) ?? profileId,
      schedules: [schedule],
    });
    return {...job, ...overrides};
  }

  /*
   * The other half of the claim. A scheduler that is told "somebody else got
   * there first" has to *not run*: the occurrence is gone, and running it anyway
   * is the duplicate this arrangement exists to prevent.
   */
  it('does not run an occurrence it failed to claim', async () => {
    await jobAt('0 9 * * *');
    // Stands in for the app and the headless runner racing for one occurrence.
    const refused = vi.spyOn(store, 'advanceDue').mockResolvedValue(null);
    try {
      await scheduler.start();
      await clock.runUntil(scheduler, afterStart(2 * 3_600_000));
      expect(runner.runs).toEqual([]);
    } finally {
      refused.mockRestore();
    }
  });

  /*
   * The one-shot path, for a process that runs the due jobs and exits.
   *
   * Its defining property is that it *waits*: the timer path deliberately does
   * not, because blocking the loop on one job would stop every other job's
   * clock. A headless runner that returned early would exit with the turn
   * half-written and the occurrence unconsumed.
   */
  it('runs what is due and waits for it, without arming a timer', async () => {
    await jobAt('0 9 * * *');

    await clock.setNow(afterStart(3_600_000));
    await scheduler.runOnce();

    expect(runner.runs).toHaveLength(1);
    // Nothing armed: this caller is not coming back.
    expect(scheduler.nextLookIn()).toBeNull();
    expect(scheduler.isIdle()).toBe(true);
  });

  it('is safe to call with nothing due', async () => {
    await expect(scheduler.runOnce()).resolves.toBeUndefined();
    expect(runner.runs).toEqual([]);
  });

  it('does not run a second occurrence in the same one-shot look', async () => {
    await jobAt('0 9 * * *');
    await clock.setNow(afterStart(3_600_000));

    await scheduler.runOnce();
    await scheduler.runOnce();

    // The second look finds the marker moved on, so nothing is due.
    expect(runner.runs).toHaveLength(1);
  });

  it('runs a job when its time comes, with a prompt that says what it is', async () => {
    await jobAt('0 9 * * *');
    await scheduler.start();

    expect(runner.runs).toEqual([]);
    await clock.runUntil(scheduler, afterStart(3_600_000));

    expect(runner.runs).toHaveLength(1);
    expect(runner.runs[0]?.sessionId).toBe('session-1');
    expect(runner.runs[0]?.prompt).toContain('[scheduled job "Morning digest"');
    expect(runner.runs[0]?.prompt).toContain('Summarise new issues.');
    expect(runner.runs[0]?.prompt).toContain('Perform this job now');

    const stored = (await store.load()).jobs[0];
    expect(stored?.lastStatus).toBe('ok');
    expect(stored?.lastRunAt).toBeDefined();
    expect(changed).toContain(stored?.id);
  });

  it('runs a job once per occurrence, not once per look', async () => {
    await jobAt('*/5 * * * *');
    await scheduler.start();

    // Across twenty minutes at a five-minute step there are four runs.
    await clock.runUntil(scheduler, afterStart(20 * 60_000));
    expect(runner.runs).toHaveLength(4);
  });

  it('never runs a paused job', async () => {
    const job = await jobAt('0 9 * * *');
    await store.update(job.id, {enabled: false});
    await scheduler.start();

    await clock.runUntil(scheduler, afterStart(6 * 3_600_000));
    expect(runner.runs).toEqual([]);
  });

  /*
   * A job belongs to the agent it was asked of, and runs for that agent —
   * whichever one the user happens to be looking at.
   *
   * The version this is extracted from only ran the active agent's jobs, so a
   * second agent's schedule quietly stopped being a schedule: it fired when you
   * switched to that agent and not otherwise. There is no way to tell that apart
   * from "the job is broken", which is why it is worth a test.
   */
  it('runs a job that belongs to another agent', async () => {
    await jobAt('0 9 * * *', {profileId: 'profile-2'});
    await scheduler.start();

    await clock.runUntil(scheduler, afterStart(6 * 3_600_000));

    expect(runner.runs).toHaveLength(1);
  });

  it('tells the runner which agent the job belongs to', async () => {
    // The whole point of lifting the restriction: the turn has to be answered
    // by the right agent, in that agent's conversation and with that agent's
    // tools — not by whoever is on screen.
    await jobAt('0 9 * * *', {profileId: 'profile-2'});
    await scheduler.start();

    await clock.runUntil(scheduler, afterStart(6 * 3_600_000));

    expect(runner.runs[0]?.profileId).toBe('profile-2');
  });

  it("runs two agents' due jobs in one look", async () => {
    await jobAt('0 9 * * *', {profileId: 'profile-1'});
    await jobAt('0 9 * * *', {profileId: 'profile-2'});

    await scheduler.start();
    await clock.runUntil(scheduler, afterStart(6 * 3_600_000));

    expect(runner.runs.map((entry) => entry.profileId).sort()).toEqual([
      'profile-1',
      'profile-2',
    ]);
  });

  /*
   * The one that keeps the app usable: a job that comes due while the user is
   * mid-conversation is deferred, not refused, and the card says so. The
   * occurrence is kept rather than consumed, so the run happens when the agent
   * is next free — consuming it would turn "the agent was busy for three
   * seconds" into "the 10:10 alarm went off at 10:10 tomorrow night".
   */
  it('defers a job while the agent is busy, then runs it at the next look', async () => {
    await jobAt('0 9 * * *');
    runner.busy = true;
    await scheduler.start();

    // Nine o'clock. The look defers, and asks to be woken an idle tick later
    // rather than immediately, so a long conversation is not polled several
    // times a second.
    clock.jumpTo(afterStart(3_600_000));
    expect(await scheduler.tick()).toBe(30_000);

    expect(runner.runs).toEqual([]);
    expect((await store.load()).jobs[0]?.lastStatus).toBe('busy');
    // Still due: the marker was not moved on, so the occurrence is the one that
    // runs — not tomorrow's.
    expect(Date.parse((await store.load()).jobs[0]?.dueAt ?? '')).toBe(
      afterStart(3_600_000).getTime(),
    );

    // The turn ends, and the next look takes the job.
    runner.busy = false;
    await clock.runUntil(scheduler, afterStart(3_600_000 + 60_000));
    expect(runner.runs).toHaveLength(1);
    expect((await store.load()).jobs[0]?.lastStatus).toBe('ok');
  });

  /*
   * A deferral is not a licence to run the job at any hour. Past the window the
   * occurrence is dropped and the schedule carries on; leaving the marker where
   * it was would pin the job to a moment that has gone — never due again under
   * the staleness rule, and never run.
   */
  it('gives up on an occurrence the agent stayed busy through', async () => {
    await jobAt('0 9 * * *');
    runner.busy = true;
    await scheduler.start();

    // Nine o'clock: deferred, and still waiting at ten — the edge of the window
    // rather than past it.
    clock.jumpTo(afterStart(3_600_000));
    await scheduler.tick();
    clock.jumpTo(afterStart(2 * 3_600_000));
    await scheduler.tick();

    expect(runner.runs).toEqual([]);
    expect(Date.parse((await store.load()).jobs[0]?.dueAt ?? '')).toBe(
      afterStart(3_600_000).getTime(),
    );

    // Half a minute past it, the occurrence is gone and the job points at
    // tomorrow's nine.
    clock.jumpTo(afterStart(2 * 3_600_000 + 30_000));
    await scheduler.tick();

    const stored = (await store.load()).jobs[0];
    expect(Date.parse(stored?.dueAt ?? '')).toBeGreaterThan(
      afterStart(2 * 3_600_000).getTime(),
    );

    // Which it runs, on time: a deferral that outlived its window costs one
    // occurrence, not the schedule.
    runner.busy = false;
    clock.jumpTo(afterStart(25 * 3_600_000 - 120_000));
    await clock.runUntil(scheduler, afterStart(25 * 3_600_000));
    expect(runner.runs).toHaveLength(1);
  });

  /*
   * The same drop, for the app rather than the agent. The store keeps a past
   * marker for a day and a half in case it is a job waiting to run; the
   * scheduler refuses to run anything more than an hour late, so between those
   * two numbers the marker has to be retired by the scheduler or the job stops
   * running at all.
   */
  it('drops a run missed while the app was closed, and keeps the schedule', async () => {
    await jobAt('0 9 * * *');
    await scheduler.start();

    // Closed through nine o'clock and reopened at eleven.
    clock.jumpTo(afterStart(3 * 3_600_000));
    await clock.runUntil(scheduler, afterStart(3 * 3_600_000 + 60_000));

    expect(runner.runs).toEqual([]);
    const stored = (await store.load()).jobs[0];
    expect(Date.parse(stored?.dueAt ?? '')).toBeGreaterThan(
      afterStart(3 * 3_600_000).getTime(),
    );
  });

  it('skips a run the app was not there for', async () => {
    await jobAt('0 9 * * *');
    await scheduler.start();

    // The app was closed for two days: firing the missed 09:00 now would be a
    // run at the wrong time of day, so it is skipped and the next one is used.
    clock.jumpTo(new Date(2026, 4, 3, 12, 0));
    await clock.runUntil(scheduler, afterStart(60_000));

    expect(runner.runs).toEqual([]);
    // And the schedule still holds: the next 09:00 is tomorrow's.
    const stored = (await store.load()).jobs[0];
    expect(Date.parse(stored?.nextRunAt ?? '')).toBeGreaterThan(
      new Date(2026, 4, 3, 12, 0).getTime(),
    );
  });

  it('records an approval gate as waiting rather than as an ending', async () => {
    await jobAt('0 9 * * *');
    runner.outcome = 'approval';
    await scheduler.start();
    await clock.runUntil(scheduler, afterStart(3_600_000));

    expect((await store.load()).jobs[0]?.lastStatus).toBe('awaiting-approval');
  });

  it('records a failure and keeps the job scheduled', async () => {
    await jobAt('0 9 * * *');
    runner.outcome = 'failed';
    await scheduler.start();
    await clock.runUntil(scheduler, afterStart(3_600_000));

    const stored = (await store.load()).jobs[0];
    expect(stored?.lastStatus).toBe('error');
    expect(stored?.lastError).toBe('the provider said no');
    // Still enabled: a failing job is not a job the user asked to stop.
    expect(stored?.enabled).toBe(true);
    expect(stored?.nextRunAt).toBeDefined();
  });

  it('records a stopped run', async () => {
    await jobAt('0 9 * * *');
    runner.outcome = 'aborted';
    await scheduler.start();
    await clock.runUntil(scheduler, afterStart(3_600_000));
    expect((await store.load()).jobs[0]?.lastStatus).toBe('aborted');
  });

  it('starts a failure message when the runner throws', async () => {
    await jobAt('0 9 * * *');
    runner.run = async () => {
      throw new Error('the session was deleted');
    };
    await scheduler.start();
    await clock.runUntil(scheduler, afterStart(3_600_000));

    const stored = (await store.load()).jobs[0];
    expect(stored?.lastStatus).toBe('error');
    expect(stored?.lastError).toBe('the session was deleted');
  });

  /*
   * A conversation the user is editing by hand. The card should show that the
   * job is being used rather than that it has never run — and the turn is not
   * mistaken for one the scheduler started.
   */
  describe('a turn in a job’s conversation that the scheduler did not start', () => {
    async function started(): Promise<Job> {
      const job = await jobAt('0 9 * * *');
      await scheduler.start();
      return job;
    }

    it('records the user chatting', async () => {
      await started();
      expect(
        await scheduler.noteTurn('session-1', {
          type: 'turn.started',
          sessionId: 'session-1',
          messageId: 'm1',
        }),
      ).toBe(true);
      expect((await store.load()).jobs[0]?.lastStatus).toBe('chatting');
    });

    it('records the answer that followed', async () => {
      await started();
      await scheduler.noteTurn('session-1', {
        type: 'turn.completed',
        sessionId: 'session-1',
        messageId: 'm1',
      });
      const stored = (await store.load()).jobs[0];
      expect(stored?.lastStatus).toBe('ok');
      expect(stored?.lastRunAt).toBeDefined();
    });

    it('records a failure with its message', async () => {
      await started();
      await scheduler.noteTurn('session-1', {
        type: 'turn.failed',
        sessionId: 'session-1',
        messageId: 'm1',
        message: 'no API key',
      });
      expect((await store.load()).jobs[0]?.lastError).toBe('no API key');
    });

    it('records an approval gate as waiting for the user', async () => {
      await started();
      await scheduler.noteTurn('session-1', {
        type: 'approval.request',
        sessionId: 'session-1',
        messageId: 'm1',
        callId: 'c1',
        tool: 'run_shell',
        args: {},
        hint: '',
      });
      expect((await store.load()).jobs[0]?.lastStatus).toBe(
        'awaiting-approval',
      );
    });

    it('ignores a conversation that belongs to no job', async () => {
      await started();
      expect(
        await scheduler.noteTurn('some-other-session', {
          type: 'turn.completed',
          sessionId: 'some-other-session',
          messageId: 'm1',
        }),
      ).toBe(false);
    });

    it('does not re-record the run the scheduler itself started', async () => {
      const job = await jobAt('0 9 * * *');
      await scheduler.start();
      await clock.runUntil(scheduler, afterStart(3_600_000));
      const afterRun = (await store.load()).jobs[0]?.lastRunAt;
      // The conversation still belongs to that job, and its last turn is one
      // this scheduler started — which is what the panel path asks before it
      // reports anything.
      expect(scheduler.jobForSession('session-1')).toBe(job.id);
      expect(scheduler.isOwnRun('session-1')).toBe(true);

      // The same events, seen a second time by the panel path.
      expect(
        await scheduler.noteTurn('session-1', {
          type: 'turn.started',
          sessionId: 'session-1',
          messageId: 'm1',
        }),
      ).toBe(false);
      expect((await store.load()).jobs[0]?.lastRunAt).toBe(afterRun);
      expect((await store.load()).jobs[0]?.lastStatus).toBe('ok');
    });
  });

  it('knows which job a conversation belongs to', async () => {
    const job = await jobAt('0 9 * * *');
    await scheduler.start();
    expect(scheduler.jobForSession('session-1')).toBe(job.id);
    expect(scheduler.jobForSession('nope')).toBeUndefined();
  });

  it('stops looking once it is stopped', async () => {
    await jobAt('*/5 * * * *');
    await scheduler.start();
    scheduler.stop();
    await clock.runUntil(scheduler, afterStart(30 * 60_000));
    expect(runner.runs).toEqual([]);
  });

  it('runs two jobs that come due together, one after the other', async () => {
    await jobAt('0 9 * * *');
    await store.create({
      name: 'Second',
      description: '',
      sessionId: 'session-2',
      profileId: 'profile-1',
      schedules: ['0 9 * * *'],
    });
    await scheduler.start();
    await clock.runUntil(scheduler, afterStart(3_600_000));

    expect(runner.runs).toHaveLength(2);
    expect(new Set(runner.runs.map((run) => run.sessionId))).toEqual(
      new Set(['session-1', 'session-2']),
    );
  });

  /* The document's shape is the store's business; this is about the timer. */
  it('works from an empty document', async () => {
    const empty: Jobs = {jobs: [], open: false, openJobId: null};
    expect((await store.load()).jobs).toEqual(empty.jobs);
    await scheduler.start();
    await clock.runUntil(scheduler, afterStart(60 * 60_000));
    expect(runner.runs).toEqual([]);
  });
});
