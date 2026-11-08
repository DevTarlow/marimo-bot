/**
 * The Jobs card.
 *
 * The first place a person can see what *any* bot has set to happen. A job is
 * made in a conversation and then belongs to that bot, so without a cross-bot
 * list the only way to find one is to remember which chat made it — and a job
 * that was never created looks exactly like one that is running quietly.
 *
 * The card is a reader first and a control second. Every job shows the words it
 * runs, the schedule in plain English, when it next runs and how its last run
 * went, because those are the facts a person needs before deciding whether to
 * pause or delete it. Pause, resume, delete and open the conversation are here
 * because they are the edits that do not need a conversation to make.
 */
import {useCallback, useEffect, useState} from 'react';

import type {AgentProfile, JobSummary, JobTone} from '@marimo/protocol';
import {
  describeCron,
  jobTone,
  lastRunLabel,
  relativeWhen,
} from '@marimo/protocol';

import {describe} from '../describe.js';
import {BotAvatar} from './BotAvatar.js';
import {KeepRunning} from './KeepRunning.js';
import {SettingsSection} from './SettingsSection.js';

/** The badge's word, rather than the tone's internal name. */
const BADGE_LABEL: Record<JobTone, string> = {
  active: 'Active',
  paused: 'Paused',
  waiting: 'Waiting for you',
  error: 'Needs attention',
};

/** The schedule in the words a person reads, not the five fields it is stored as. */
function scheduleText(entry: JobSummary): string {
  return entry.job.schedules.map(describeCron).join('; ');
}

/**
 * When it runs next, or why it does not.
 *
 * `nextRunAt` is absent for a paused job and for a schedule with no remaining
 * occurrence; those are different answers and the card says which one it has.
 */
function nextRunText(entry: JobSummary, now: Date): string {
  if (!entry.job.enabled) {
    return 'Paused';
  }
  if (entry.job.nextRunAt === undefined) {
    return 'No next run on this schedule';
  }
  const at = new Date(entry.job.nextRunAt);
  if (Number.isNaN(at.getTime())) {
    return `Next run ${entry.job.nextRunAt}`;
  }
  return `Next run ${relativeWhen(at, now)}`;
}

/** "Never run." or "Last ran 3h ago." — the sentence, not the bare label. */
function lastRunText(entry: JobSummary, now: Date): string {
  if (entry.job.lastRunAt === undefined) {
    return 'Never run.';
  }
  return `Last ${lastRunLabel(entry.job, now)}.`;
}

export function Jobs({
  opened,
  onToggle,
  profiles,
  onOpenConversation,
}: {
  opened: ReadonlySet<string>;
  onToggle: (title: string, expanded: boolean) => void;
  profiles: AgentProfile[];
  /**
   * Opens the job's conversation. Absent in a window that cannot navigate; the
   * card then leaves the button off rather than offering a dead one.
   */
  onOpenConversation?: (
    entry: JobSummary,
  ) => Promise<{ok: boolean; problem?: string}>;
}): React.JSX.Element {
  const [entries, setEntries] = useState<JobSummary[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** The job whose write is in flight, so no second write races it. */
  const [busy, setBusy] = useState<string | null>(null);
  /** The job whose delete is asking, in place. */
  const [confirming, setConfirming] = useState<string | null>(null);
  /**
   * The clock the labels are read against.
   *
   * A ticker rather than a value read during render: the card can stay open
   * while a job comes due, and "next run in 2m" that never counts down is the
   * one thing on this screen that would look frozen. Thirty seconds is close
   * enough for a minute-resolution schedule.
   */
  const [now, setNow] = useState(() => new Date());

  const load = useCallback(async (): Promise<void> => {
    try {
      const result = await window.marimo.call('jobs.list', {});
      setEntries(result.jobs);
      setProblem(result.problem ?? null);
    } catch (failure) {
      setProblem(describe(failure));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const handle = setInterval(() => {
      setNow(new Date());
    }, 30_000);
    return () => {
      clearInterval(handle);
    };
  }, []);

  /*
   * A run records its outcome on its own schedule, and a job created in another
   * window exists before this one has been reopened. The event carries only the
   * id, which is enough: the document is small and is replaced whole.
   */
  useEffect(() => {
    const off = window.marimo.onEvent((event) => {
      if (event.type === 'job.changed') {
        void load();
      }
    });
    return off;
  }, [load]);

  const setEnabled = async (entry: JobSummary): Promise<void> => {
    setBusy(entry.job.id);
    setError(null);
    try {
      const result = await window.marimo.call('jobs.update', {
        jobId: entry.job.id,
        patch: {enabled: !entry.job.enabled},
      });
      setEntries(result.jobs);
      setProblem(result.problem ?? null);
      if (!result.found) {
        setError('That job was already gone.');
      }
    } catch (failure) {
      setError(describe(failure));
    } finally {
      setBusy(null);
    }
  };

  const remove = async (jobId: string): Promise<void> => {
    setBusy(jobId);
    setError(null);
    try {
      const result = await window.marimo.call('jobs.remove', {jobId});
      setEntries(result.jobs);
      setProblem(result.problem ?? null);
      setConfirming(null);
      if (!result.removed) {
        setError('That job was already gone.');
      }
    } catch (failure) {
      setError(describe(failure));
    } finally {
      setBusy(null);
    }
  };

  const open = async (entry: JobSummary): Promise<void> => {
    if (onOpenConversation === undefined) {
      return;
    }
    setError(null);
    const outcome = await onOpenConversation(entry);
    if (!outcome.ok) {
      setError(outcome.problem ?? 'That conversation could not be opened.');
    }
  };

  /*
   * Grouped by the owner the main process named, not by the window's profile
   * list. The name travels with the job so a bot that was removed cannot make
   * its leftover jobs disappear into another group; the roster is used only for
   * the avatar, and a missing profile leaves the name standing.
   */
  const groups: Array<{
    profileId: string;
    profileName: string;
    profile: AgentProfile | undefined;
    jobs: JobSummary[];
  }> = [];
  const groupAt = new Map<string, (typeof groups)[number]>();
  for (const entry of entries ?? []) {
    const existing = groupAt.get(entry.job.profileId);
    if (existing !== undefined) {
      existing.jobs.push(entry);
      continue;
    }
    const group = {
      profileId: entry.job.profileId,
      profileName: entry.profileName,
      profile: profiles.find((profile) => profile.id === entry.job.profileId),
      jobs: [entry],
    };
    groupAt.set(entry.job.profileId, group);
    groups.push(group);
  }
  // The roster's order, with anything no longer in it last.
  const rosterOrder = new Map(
    profiles.map((profile, index) => [profile.id, index]),
  );
  groups.sort(
    (left, right) =>
      (rosterOrder.get(left.profileId) ?? Infinity) -
      (rosterOrder.get(right.profileId) ?? Infinity),
  );

  return (
    <SettingsSection title="Jobs" opened={opened} onToggle={onToggle}>
      <p className="settings-muted">
        Every bot&rsquo;s scheduled jobs, in one place. A job runs in its own
        conversation, with the same tools and approvals as a chat — so an
        approval it hits waits for you rather than going ahead on its own.
      </p>

      <h4 className="settings-group">While the app is closed</h4>
      <KeepRunning showUnavailable />

      <h4 className="settings-group">Scheduled jobs</h4>

      {problem !== null && (
        <p className="settings-problem" role="alert">
          {problem}
        </p>
      )}
      {error !== null && (
        <p className="settings-problem" role="alert">
          {error}
        </p>
      )}

      {entries === null ? (
        problem === null ? (
          <p className="settings-muted">Reading the jobs…</p>
        ) : null
      ) : entries.length === 0 ? (
        /*
         * An unreadable document and an empty one read the same in the list but
         * not to the person: one needs the file fixed, and the other needs a
         * job made. The problem above is the whole answer when there is one.
         */
        problem === null ? (
          <p className="settings-muted">
            No jobs yet. Ask a bot to schedule one in a conversation — for
            example, &ldquo;every weekday at 9, summarise my inbox&rdquo;. It
            appears here under the bot that owns it, with the words it will run.
          </p>
        ) : null
      ) : (
        <>
          {groups.map((group) => (
            <div className="settings-job-group" key={group.profileId}>
              <h4 className="settings-group settings-job-owner">
                {group.profile !== undefined && (
                  <BotAvatar profile={group.profile} size="sm" />
                )}
                {group.profileName}
              </h4>
              {group.jobs.map((entry) => (
                <JobCard
                  key={entry.job.id}
                  entry={entry}
                  now={now}
                  busy={busy !== null}
                  confirming={confirming === entry.job.id}
                  canOpen={
                    group.profile !== undefined &&
                    onOpenConversation !== undefined &&
                    entry.job.sessionId !== null &&
                    entry.sessionTitle !== null
                  }
                  onPause={() => {
                    void setEnabled(entry);
                  }}
                  onOpen={() => {
                    void open(entry);
                  }}
                  onAskDelete={() => {
                    setConfirming(entry.job.id);
                  }}
                  onCancelDelete={() => {
                    setConfirming(null);
                  }}
                  onDelete={() => {
                    void remove(entry.job.id);
                  }}
                />
              ))}
            </div>
          ))}
        </>
      )}
    </SettingsSection>
  );
}

function JobCard({
  entry,
  now,
  busy,
  confirming,
  canOpen,
  onPause,
  onOpen,
  onAskDelete,
  onCancelDelete,
  onDelete,
}: {
  entry: JobSummary;
  now: Date;
  busy: boolean;
  confirming: boolean;
  canOpen: boolean;
  onPause: () => void;
  onOpen: () => void;
  onAskDelete: () => void;
  onCancelDelete: () => void;
  onDelete: () => void;
}): React.JSX.Element {
  const tone = jobTone(entry.job);
  const description = entry.job.description.trim();

  return (
    <div className="settings-job" data-tone={tone}>
      <div className="settings-job-head">
        <div className="settings-job-title">
          <span className="settings-job-name">{entry.job.name}</span>
          <span className="settings-job-badge" data-tone={tone}>
            {BADGE_LABEL[tone]}
          </span>
        </div>
        <button
          type="button"
          className="button button-quiet button-small"
          disabled={busy}
          onClick={onPause}
        >
          {entry.job.enabled ? 'Pause' : 'Resume'}
        </button>
      </div>

      <p className="settings-job-when">
        Runs {scheduleText(entry)}. {nextRunText(entry, now)}.
      </p>
      {description.length > 0 && (
        <p className="settings-job-instruction">{description}</p>
      )}
      <p className="settings-job-meta">
        {lastRunText(entry, now)}{' '}
        {entry.sessionTitle === null
          ? 'Its conversation was deleted; the next run starts a new one.'
          : `Its conversation is “${entry.sessionTitle}”.`}
      </p>
      {entry.job.lastError !== undefined && (
        <p className="settings-problem">Last error: {entry.job.lastError}</p>
      )}

      <div className="settings-job-actions">
        {canOpen && (
          <button
            type="button"
            className="button button-quiet button-small"
            disabled={busy}
            onClick={onOpen}
          >
            Open conversation
          </button>
        )}
        {confirming ? (
          <>
            <span className="settings-why">
              Delete this job? Its conversation stays.
            </span>
            <button
              type="button"
              className="button button-quiet button-small"
              disabled={busy}
              onClick={onCancelDelete}
            >
              Cancel
            </button>
            <button
              type="button"
              className="button button-danger button-small"
              disabled={busy}
              onClick={onDelete}
            >
              Delete
            </button>
          </>
        ) : (
          <button
            type="button"
            className="button button-quiet button-small"
            disabled={busy}
            onClick={onAskDelete}
          >
            Delete
          </button>
        )}
      </div>
    </div>
  );
}
