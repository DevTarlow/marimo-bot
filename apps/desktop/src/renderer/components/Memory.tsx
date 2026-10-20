/**
 * Memory: how much of it there is, and everything the bot carries.
 *
 * The size control is first because it is what the rest is measured against. A
 * byte limit means nothing on its own — "8 KB" is not a quantity anybody has a
 * feel for — so it is drawn as a slider in kilobytes beside a readout of the
 * file it applies to, with the line the agent is warned at made visible. That
 * readout is the same number the agent's `read_memory` quotes, read from the
 * same place, so the bar cannot drift from the warning.
 *
 * Facts are written by the bot as it finds them, so this card is the person's
 * control over them rather than a queue: search the list, read the date, and
 * forget a line. Forgetting also records a refusal, because a fact removed now
 * must not be quietly written back the next time the subject comes up.
 *
 * The refusal list stays here rather than in Learning: it is memory's own
 * history, and it is what stops the reviewer bringing a rejected fact back.
 */
import {useEffect, useState} from 'react';

import {
  DEFAULT_MEMORY_REVIEW_EVENTS,
  DEFAULT_MEMORY_SOFT_LIMIT_BYTES,
  MEMORY_REVIEW_EVENTS_MAX,
  MEMORY_REVIEW_EVENTS_MIN,
  MEMORY_SOFT_LIMIT_MAX_BYTES,
  MEMORY_SOFT_LIMIT_MIN_BYTES,
} from '@marimo/protocol';
import type {
  DismissedMemory,
  MemoryProvenanceEntry,
  MemoryUsage,
} from '@marimo/protocol';

import {
  formatKiB,
  summarizeDismissed,
  summarizeMemory,
} from '../memory-format.js';
import {SettingsSection} from './SettingsSection.js';

export function Memory({
  opened,
  onToggle,
  onChange,
}: {
  opened: ReadonlySet<string>;
  onToggle: (title: string, expanded: boolean) => void;
  onChange?: () => void;
}): React.JSX.Element {
  /**
   * What the user has refused, so the panel can show it and clear it.
   *
   * Held here rather than only counted, because the count is the thing that has
   * to be visible and the text is the thing that makes the count meaningful —
   * "12 suggestions are being suppressed" is a number nobody can check.
   */
  const [dismissed, setDismissed] = useState<DismissedMemory[]>([]);
  const [usage, setUsage] = useState<MemoryUsage | null>(null);
  /**
   * When each remembered bullet was first written.
   *
   * Loaded with the rest rather than on demand: it is one small document, and a
   * list behind a second click is one nobody opens — which would make the whole
   * point, that age is *visible*, not true.
   */
  const [provenance, setProvenance] = useState<MemoryProvenanceEntry[]>([]);
  /**
   * What the person is looking for in what the bot remembers.
   *
   * Client-side rather than a recall query: this list is already in the window,
   * and searching a document the user is looking at should not need the
   * embedding engine, a model, or a round trip. The semantic search in the
   * command palette is still the way to look by meaning.
   */
  const [filter, setFilter] = useState('');
  /**
   * The slider's own value while it is being dragged.
   *
   * Held apart from `usage.limitBytes` so dragging is smooth: the stored value
   * only changes when the pointer is released, and a slider whose handle snapped
   * back to the old number between steps would be unusable.
   */
  const [draftLimit, setDraftLimit] = useState<number | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async (): Promise<void> => {
    try {
      const [listed, measured, dated] = await Promise.all([
        window.marimo.call('memory.proposals', {}),
        window.marimo.call('memory.usage', {}),
        window.marimo.call('memory.provenance', {}),
      ]);
      setDismissed(listed.dismissed);
      setUsage(measured);
      setProvenance(dated.entries);
      setDraftLimit(null);
    } catch (failure) {
      setProblem(describe(failure));
    }
  };

  useEffect(() => {
    void load();
  }, []);

  /*
   * Saved when the drag ends rather than on every step. A slider fires an event
   * per pixel, and writing the settings file on each one would be a burst of disk
   * writes for what is one decision.
   */
  const commitLimit = async (bytes: number): Promise<void> => {
    setBusy(true);
    setProblem(null);
    try {
      await window.marimo.call('settings.set', {
        patch: {memorySoftLimitBytes: bytes},
      });
      await load();
      onChange?.();
    } catch (failure) {
      setProblem(describe(failure));
      setDraftLimit(null);
    } finally {
      setBusy(false);
    }
  };

  const summary = usage === null ? null : summarizeMemory(usage);
  const dismissals = summarizeDismissed(dismissed.length);
  const limit =
    draftLimit ?? usage?.limitBytes ?? DEFAULT_MEMORY_SOFT_LIMIT_BYTES;
  const query = filter.trim().toLowerCase();
  const remembered = [...provenance]
    .sort((left, right) => left.at.localeCompare(right.at))
    .filter(
      (entry) =>
        query.length === 0 ||
        entry.text.toLowerCase().includes(query) ||
        entry.section.toLowerCase().includes(query),
    );

  /**
   * The cadence, which is a number of events rather than of turns.
   *
   * Events rather than turns because that is what the review counts, and a field
   * labelled in turns would be a number the user sets and a different number the
   * app obeys. The explanation says what it means in the units a person thinks
   * in, which is exchanges.
   */
  const commitReviewEvents = async (events: number): Promise<void> => {
    setBusy(true);
    setProblem(null);
    try {
      await window.marimo.call('settings.set', {
        patch: {memoryReviewEvents: events},
      });
      await load();
      onChange?.();
    } catch (failure) {
      setProblem(describe(failure));
    } finally {
      setBusy(false);
    }
  };

  /*
   * Clearing is total and has no undo, so it asks first. That is the one place
   * this panel interrupts, and it is because the alternative is a user finding
   * out what the button did by reading a list that is now empty.
   */
  const clearDismissed = async (): Promise<void> => {
    if (
      !window.confirm(
        `Forget all ${String(dismissed.length)} of these? The bot will be ` +
          'able to suggest them again.',
      )
    ) {
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      const result = await window.marimo.call('memory.forgetDismissals', {});
      setDismissed(result.dismissed);
      onChange?.();
    } catch (failure) {
      setProblem(describe(failure));
    } finally {
      setBusy(false);
    }
  };

  /**
   * Forgets one remembered line, after asking.
   *
   * The question is here because there is no undo: the fact is removed from the
   * file the bot reads at the start of every conversation, and the only way back
   * is saying it again. The whole point of the button is that it is easy to
   * reach, so the confirmation is what keeps an easy button from being an
   * accidental one.
   */
  const forget = async (entry: MemoryProvenanceEntry): Promise<void> => {
    const shown =
      entry.text.length > 90 ? `${entry.text.slice(0, 87)}…` : entry.text;
    if (
      !window.confirm(
        `Forget "${shown}"? The bot will not be told it again unless you say it.`,
      )
    ) {
      return;
    }
    setBusy(true);
    setProblem(null);
    setNote(null);
    try {
      const result = await window.marimo.call('memory.forget', {
        scope: entry.scope,
        section: entry.section,
        text: entry.text,
      });
      setProvenance(result.entries);
      if (!result.removed) {
        setProblem('That fact was no longer in memory.');
      } else {
        setNote('Forgotten.');
        /*
         * The removal also records a refusal, so re-read the list that says what
         * the reviewer will not bring up again — otherwise the panel shows a
         * stale count until it is reopened.
         */
        const listed = await window.marimo.call('memory.proposals', {});
        setDismissed(listed.dismissed);
        onChange?.();
      }
    } catch (failure) {
      setProblem(describe(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsSection title="Memory" opened={opened} onToggle={onToggle}>
      {usage === null ? (
        <p className="settings-muted">{problem ?? 'Reading…'}</p>
      ) : (
        <>
          <p className="settings-muted">
            What this bot remembers about you and your work. The whole file is
            shown to it at the start of every conversation, so the smaller it is
            the less of each prompt it takes up.
          </p>

          <div
            className={`memory-meter memory-meter-${summary?.pressure ?? 'room'}`}
          >
            <div
              className="memory-meter-fill"
              style={{width: `${String(summary?.percent ?? 0)}%`}}
              role="img"
              aria-label={summary?.size ?? ''}
            />
          </div>
          <p className="memory-readout">{summary?.size}</p>
          <p className="settings-why">{summary?.detail}</p>

          <label className="memory-limit">
            <span className="memory-limit-label">
              Ask it to prune past{' '}
              <strong className="memory-limit-value">{formatKiB(limit)}</strong>
            </span>
            <input
              type="range"
              min={MEMORY_SOFT_LIMIT_MIN_BYTES}
              max={MEMORY_SOFT_LIMIT_MAX_BYTES}
              step={1024}
              value={limit}
              disabled={busy}
              aria-label="Memory size before the bot is asked to prune"
              onChange={(event) => {
                setDraftLimit(Number(event.target.value));
              }}
              onPointerUp={() => {
                void commitLimit(limit);
              }}
              onKeyUp={() => {
                void commitLimit(limit);
              }}
            />
            <span className="memory-limit-range">
              <span>{formatKiB(MEMORY_SOFT_LIMIT_MIN_BYTES)}</span>
              <span>{formatKiB(MEMORY_SOFT_LIMIT_MAX_BYTES)}</span>
            </span>
          </label>

          <label className="settings-field memory-cadence">
            <span>
              Read the conversation back after
              <em className="settings-why">
                A review normally waits for a quiet minute, so it is reading a
                conversation you have finished. In a long session that minute
                may never come, and something you said at the start would go
                unremembered for as long as you keep typing. This is how much
                unreviewed conversation is enough to stop waiting — roughly one
                exchange per four or five.
              </em>
            </span>
            <input
              className="settings-input"
              type="number"
              min={MEMORY_REVIEW_EVENTS_MIN}
              max={MEMORY_REVIEW_EVENTS_MAX}
              value={usage.reviewEvents}
              disabled={busy}
              aria-label="Unreviewed events before the bot reads a conversation back"
              onChange={(event) => {
                const reviewEvents = Number(event.target.value);
                /*
                 * A field being cleared, or a keypress that would leave a number
                 * the schema refuses, is allowed to disagree with the stored one
                 * until it is a number worth saving — the same rule the companion
                 * panel's count follows, and for the same reason: writing an
                 * out-of-range value is a failed call and an error line.
                 */
                if (
                  !Number.isInteger(reviewEvents) ||
                  reviewEvents < MEMORY_REVIEW_EVENTS_MIN ||
                  reviewEvents > MEMORY_REVIEW_EVENTS_MAX
                ) {
                  return;
                }
                void commitReviewEvents(reviewEvents);
              }}
            />
            <span className="memory-limit-range">
              <span>
                default {String(DEFAULT_MEMORY_REVIEW_EVENTS)}, in events
              </span>
            </span>
          </label>
        </>
      )}

      <p className="settings-muted">
        The bot writes a fact it decides is worth keeping straight into memory;
        there is nothing to approve. What it wants to change about how it works
        still waits in Learning, above. Here you can see what it carries, search
        it, forget a line, and set how large memory is kept and how often a
        conversation is read back.
      </p>

      {/*
       * Only drawn when there is something to draw, which `summarizeDismissed`
       * decides rather than this expression: a "Nothing refused yet" panel is a
       * heading that exists to explain a capability nobody has reached for.
       */}
      {dismissals.heading !== undefined && (
        <>
          <h4 className="memory-proposals-heading">{dismissals.heading}</h4>
          <p className="settings-muted">
            Facts you turned down or forgot, so the bot does not bring them up
            again. It learns from the refusal only: a fact you remove here is
            still stored the moment you state it yourself, and this list never
            reaches the bot's own prompt.
          </p>
          <p className="settings-why">{dismissals.count}</p>
          <details className="memory-why">
            <summary>Show them</summary>
            <ul className="memory-dismissed">
              {dismissed.map((entry) => (
                <li key={`${entry.profileId}\u0000${entry.text}`}>
                  {entry.text}
                </li>
              ))}
            </ul>
          </details>
          <div className="memory-actions">
            <button
              type="button"
              className="button button-quiet button-small"
              disabled={busy}
              onClick={() => {
                void clearDismissed();
              }}
            >
              Let it suggest them again
            </button>
          </div>
        </>
      )}

      {/*
        What memory holds, oldest first, with the date each bullet was written.
        Folded away because it is a reference rather than a decision — but it is
        the *only* place a person can see their memory in the window, and the only
        way to answer "what in here is stale?" without opening the file.
      */}
      {provenance.length > 0 && (
        <>
          <h4 className="memory-proposals-heading">
            {provenance.length === 1
              ? 'One thing remembered'
              : 'Everything remembered, by when'}
          </h4>
          <p className="settings-muted">
            Oldest first. This is what the bot is shown at the start of every
            conversation; the dates are when each line was first written, so you
            can tell what has been sitting there a year. Forget a line to take
            it out of the file the bot reads, and to stop the reviewer
            suggesting it again.
          </p>
          <label className="settings-field memory-search">
            <input
              className="settings-input"
              type="search"
              placeholder="Search what it remembers…"
              value={filter}
              disabled={busy}
              aria-label="Search memory"
              onChange={(event) => {
                setFilter(event.target.value);
              }}
            />
          </label>
          <details
            className="memory-why"
            {...(query.length > 0 ? {open: true} : {})}
          >
            <summary>
              {query.length > 0
                ? `${String(remembered.length)} of ${String(provenance.length)} match`
                : 'Show them'}
            </summary>
            <ul className="memory-dismissed memory-remembered">
              {remembered.map((entry) => (
                <li
                  key={`${entry.scope}\u0000${entry.section}\u0000${entry.text}`}
                  className="memory-remembered-item"
                >
                  <span className="memory-age">{describeAge(entry.at)}</span>{' '}
                  <span className="memory-remembered-text">{entry.text}</span>
                  <button
                    type="button"
                    className="button button-quiet button-small memory-forget"
                    disabled={busy}
                    onClick={() => {
                      void forget(entry);
                    }}
                  >
                    Forget
                  </button>
                </li>
              ))}
              {remembered.length === 0 && (
                <li className="settings-muted">Nothing matches.</li>
              )}
            </ul>
          </details>
        </>
      )}

      {note !== null && <p className="settings-why">{note}</p>}
      {problem !== null && (
        <p className="connector-detail connector-error">{problem}</p>
      )}
    </SettingsSection>
  );
}

/**
 * How long ago a date was, in the words a person would use.
 *
 * Rough on purpose — "about a year ago" is the judgement being made, and an exact
 * day count invites arithmetic about somebody's memory that nobody asked for. An
 * unparseable date says nothing rather than "NaN".
 */
function describeAge(at: string): string {
  const then = new Date(at);
  if (Number.isNaN(then.getTime())) {
    return 'at some point';
  }
  const days = Math.floor((Date.now() - then.getTime()) / 86_400_000);
  if (days <= 0) {
    return 'today';
  }
  if (days === 1) {
    return 'yesterday';
  }
  if (days < 30) {
    return `${String(days)} days ago`;
  }
  const months = Math.round(days / 30);
  if (months < 18) {
    return months === 1 ? 'a month ago' : `${String(months)} months ago`;
  }
  const years = Math.round(days / 365);
  return years <= 1 ? 'about a year ago' : `${String(years)} years ago`;
}

/** Electron wraps a rejected `invoke` in its own prefix, which is noise here. */
function describe(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/^Error invoking remote method '[^']*':\s*/u, '');
}
