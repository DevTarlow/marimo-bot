/**
 * The job's reading: which ones show, in what order, and how each one's state is
 * named.
 *
 * These are the decisions a user makes sense of at a glance, so they are pinned
 * as strings and orders rather than left to the component.
 */
import {describe, expect, it} from 'vitest';

import type {Job, Jobs} from './index.js';

import {
  jobBadge,
  jobTone,
  lastRunLabel,
  relativeWhen,
  sortJobs,
  visibleJobs,
} from './job-rules.js';

const NOW = new Date(2026, 4, 1, 12, 0);

function job(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job-1',
    name: 'Morning digest',
    description: 'Summarise new issues.',
    schedules: ['0 9 * * *'],
    enabled: true,
    profileId: 'profile-1',
    sessionId: 'session-1',
    createdAt: '2026-04-01T09:00:00.000Z',
    ...overrides,
  };
}

function document(...jobs: Job[]): Jobs {
  return {jobs, open: true, openJobId: null};
}

describe('visibleJobs', () => {
  it('shows only the active agent’s jobs', () => {
    const visible = visibleJobs(
      document(job(), job({id: 'other', profileId: 'profile-2'})),
      'profile-1',
    );
    expect(visible.map((entry) => entry.id)).toEqual(['job-1']);
  });
});

describe('sortJobs', () => {
  it('puts enabled jobs first, however soon the paused one was due', () => {
    const paused = job({id: 'paused', enabled: false});
    const active = job({
      id: 'active',
      nextRunAt: new Date(2026, 4, 4).toISOString(),
    });
    expect(sortJobs([paused, active]).map((entry) => entry.id)).toEqual([
      'active',
      'paused',
    ]);
  });

  it('orders the enabled ones by whichever is due soonest', () => {
    const later = job({
      id: 'later',
      nextRunAt: new Date(2026, 4, 3).toISOString(),
    });
    const sooner = job({
      id: 'sooner',
      nextRunAt: new Date(2026, 4, 2).toISOString(),
    });
    expect(sortJobs([later, sooner]).map((entry) => entry.id)).toEqual([
      'sooner',
      'later',
    ]);
  });

  it('falls back to newest first when two are equally due', () => {
    const at = new Date(2026, 4, 2).toISOString();
    const older = job({
      id: 'older',
      createdAt: '2026-04-01T09:00:00.000Z',
      nextRunAt: at,
    });
    const newer = job({
      id: 'newer',
      createdAt: '2026-04-20T09:00:00.000Z',
      nextRunAt: at,
    });
    expect(sortJobs([older, newer]).map((entry) => entry.id)).toEqual([
      'newer',
      'older',
    ]);
  });
});

describe('the badge', () => {
  it('says active for a job with nothing wrong', () => {
    expect(jobTone(job())).toBe('active');
    expect(jobBadge(job())).toBe('active');
    expect(jobBadge(job({lastStatus: 'ok'}))).toBe('active');
  });

  it('says paused for a job the user stopped', () => {
    expect(jobTone(job({enabled: false}))).toBe('paused');
    expect(jobBadge(job({enabled: false}))).toBe('paused');
  });

  /*
   * Waiting on the user is not a failure: the user is the one who has to act,
   * so the badge says so instead of "errored" and sending them hunting a bug.
   */
  it('says waiting when a run is paused on an approval', () => {
    const waiting = job({lastStatus: 'awaiting-approval'});
    expect(jobTone(waiting)).toBe('waiting');
    expect(jobBadge(waiting)).toBe('waiting');
  });

  it('says errored for a failed or stopped run', () => {
    expect(jobBadge(job({lastStatus: 'error'}))).toBe('errored');
    expect(jobBadge(job({lastStatus: 'aborted'}))).toBe('errored');
  });

  it('does not call a deferred run a failure', () => {
    // The agent was busy; the job is fine and will run.
    expect(jobBadge(job({lastStatus: 'busy'}))).toBe('active');
  });
});

describe('lastRunLabel', () => {
  it('says never run when it has not', () => {
    expect(lastRunLabel(job(), NOW)).toBe('never run');
  });

  it('names what happened and when', () => {
    const ran = job({
      lastRunAt: new Date(2026, 4, 1, 9, 0).toISOString(),
      lastStatus: 'ok',
    });
    expect(lastRunLabel(ran, NOW)).toBe('ran 3h ago');
  });

  it('tells a chat apart from a run', () => {
    const chatted = job({
      lastRunAt: new Date(2026, 4, 1, 11, 30).toISOString(),
      lastStatus: 'chatting',
    });
    expect(lastRunLabel(chatted, NOW)).toBe('you chatted 30m ago');
  });

  it('names a failure and a deferral', () => {
    expect(
      lastRunLabel(
        job({
          lastRunAt: new Date(2026, 4, 1, 9, 0).toISOString(),
          lastStatus: 'error',
        }),
        NOW,
      ),
    ).toBe('failed 3h ago');
    expect(
      lastRunLabel(
        job({
          lastRunAt: new Date(2026, 4, 1, 9, 0).toISOString(),
          lastStatus: 'busy',
        }),
        NOW,
      ),
    ).toBe('deferred 3h ago');
  });
});

describe('relativeWhen', () => {
  it('counts minutes inside the hour', () => {
    expect(relativeWhen(new Date(2026, 4, 1, 11, 40), NOW)).toBe('20m ago');
    expect(relativeWhen(new Date(2026, 4, 1, 12, 20), NOW)).toBe('in 20m');
  });

  it('counts hours inside the day', () => {
    expect(relativeWhen(new Date(2026, 4, 1, 9, 5), NOW)).toBe('3h ago');
    expect(relativeWhen(new Date(2026, 4, 1, 15, 5), NOW)).toBe('in 3h');
  });

  it('names yesterday and tomorrow', () => {
    // 1 May 2026 is a Friday, so the day before is 30 April.
    expect(relativeWhen(new Date(2026, 4, 1 - 1, 9, 0), NOW)).toBe('yesterday');
    expect(relativeWhen(new Date(2026, 4, 2, 9, 0), NOW)).toBe('tomorrow');
  });

  it('names the weekday within the week', () => {
    // 5 May 2026 is a Tuesday.
    expect(relativeWhen(new Date(2026, 4, 5, 9, 0), NOW)).toBe('Tuesday');
    // 28 April 2026 is a Tuesday, three days back.
    expect(relativeWhen(new Date(2026, 4, 1 - 3, 9, 0), NOW)).toBe('Tuesday');
  });

  it('falls back to a date beyond the week', () => {
    expect(relativeWhen(new Date(2026, 5, 20, 9, 0), NOW)).toBe('2026-06-20');
  });

  it('says just now for the same minute', () => {
    expect(relativeWhen(new Date(2026, 4, 1, 12, 0, 20), NOW)).toBe('just now');
  });
});
