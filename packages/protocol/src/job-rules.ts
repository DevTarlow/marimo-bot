/**
 * A job's pure reading: which ones show, in what order, and how each one's state
 * is named.
 *
 * Kept in the protocol rather than in the window so it can be tested without
 * React, and so the process that sorts the Settings list and the card that draws
 * it cannot disagree about the order or the words. The *times* on a card are not
 * worked out here — the scheduler owns those and answers with them in the
 * document — so this only decides the labels and the ordering.
 */
import type {Job, Jobs} from './index.js';

/** How loud a card's status is, which is all the styling needs to know. */
export type JobTone = 'active' | 'paused' | 'waiting' | 'error';

/**
 * The name a job wears between "New job" and the agent proposing a real one.
 *
 * It lives here rather than in the store because two readers need it: the store
 * that names a draft, and the list that must not draw a nameless card. One
 * constant, so a draft can never be shown as a job.
 */
export const PLACEHOLDER_JOB_NAME = '—';

/**
 * The jobs of the agent being looked at.
 *
 * A job belonging to another agent is not listed *here*: its conversation, its
 * memory and the identity that would answer it all belong to that agent. The
 * Settings card lists across bots and therefore does not call this — it shows
 * the owner beside every card instead. This remains for a per-bot view.
 *
 * Neither is a job the agent has not named yet. It exists from the moment "New
 * job" is clicked, and it is what the conversation is about — but a card reading
 * "—" with no instruction and a default schedule would be a lie about what is
 * scheduled.
 */
export function visibleJobs(jobs: Jobs, profileId: string): Job[] {
  return jobs.jobs.filter(
    (job) => job.profileId === profileId && job.name !== PLACEHOLDER_JOB_NAME,
  );
}

/**
 * Enabled before paused; then whichever is due soonest; then newest first.
 *
 * A paused job has no next run, so sorting it by one would put every paused job
 * ahead of an active one on a technicality — the order the user reads should be
 * "what is going to happen, soonest first".
 */
export function sortJobs(jobs: Job[]): Job[] {
  return [...jobs].sort((left, right) => {
    if (left.enabled !== right.enabled) {
      return left.enabled ? -1 : 1;
    }
    const leftNext = left.nextRunAt ? Date.parse(left.nextRunAt) : Infinity;
    const rightNext = right.nextRunAt ? Date.parse(right.nextRunAt) : Infinity;
    if (leftNext !== rightNext) {
      return leftNext - rightNext;
    }
    return Date.parse(right.createdAt) - Date.parse(left.createdAt);
  });
}

/** "active" / "paused" / "waiting" / "error", as a bare word. */
export function jobTone(job: Job): JobTone {
  if (!job.enabled) {
    return 'paused';
  }
  if (job.lastStatus === 'awaiting-approval') {
    return 'waiting';
  }
  if (job.lastStatus === 'error' || job.lastStatus === 'aborted') {
    return 'error';
  }
  return 'active';
}

/**
 * The badge on a card: what the job is doing, in one word.
 *
 * "waiting" rather than "errored" for an approval gate, because the user is the
 * one who has to act, and the card should send them to the conversation rather
 * than to the schedule.
 */
export function jobBadge(job: Job): string {
  switch (jobTone(job)) {
    case 'paused':
      return 'paused';
    case 'waiting':
      return 'waiting';
    case 'error':
      return 'errored';
    default:
      return 'active';
  }
}

/**
 * When the job last did anything, said the short way.
 *
 * `now` is passed in so the wording is testable and so every card in one render
 * agrees about what "today" means.
 */
export function lastRunLabel(job: Job, now: Date): string {
  if (!job.lastRunAt) {
    return 'never run';
  }
  const at = new Date(job.lastRunAt);
  if (Number.isNaN(at.getTime())) {
    return job.lastRunAt;
  }
  const verb =
    job.lastStatus === 'ok'
      ? 'ran'
      : job.lastStatus === 'chatting'
        ? 'you chatted'
        : job.lastStatus === 'aborted'
          ? 'stopped'
          : job.lastStatus === 'busy'
            ? 'deferred'
            : job.lastStatus === 'awaiting-approval'
              ? 'waiting for you'
              : 'failed';
  return `${verb} ${relativeWhen(at, now)}`;
}

/** "3h ago", "in 20m", "Monday", or a date, depending on how far off it is. */
export function relativeWhen(at: Date, now: Date): string {
  const minutes = Math.round((at.getTime() - now.getTime()) / 60_000);
  const future = minutes > 0;

  if (Math.abs(minutes) < 1) {
    return 'just now';
  }
  if (Math.abs(minutes) < 60) {
    return future ? `in ${minutes}m` : `${Math.abs(minutes)}m ago`;
  }

  const days = daysBetween(now, at);
  const hours = Math.round(Math.abs(minutes) / 60);
  if (days === 0) {
    return future ? `in ${hours}h` : `${hours}h ago`;
  }
  if (Math.abs(days) === 1) {
    return future ? 'tomorrow' : 'yesterday';
  }
  if (days > -7 && days < 7) {
    return weekdayName(at);
  }
  return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`;
}

export function weekdayName(at: Date): string {
  return [
    'Sunday',
    'Monday',
    'Tuesday',
    'Wednesday',
    'Thursday',
    'Friday',
    'Saturday',
  ][at.getDay()]!;
}

/** Whole local days from `from` to `to`, ignoring the time of day. */
function daysBetween(from: Date, to: Date): number {
  const start = Date.UTC(from.getFullYear(), from.getMonth(), from.getDate());
  const end = Date.UTC(to.getFullYear(), to.getMonth(), to.getDate());
  return Math.round((end - start) / 86_400_000);
}
