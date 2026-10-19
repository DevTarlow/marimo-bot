/**
 * Learning: the one place a suggestion becomes a decision.
 *
 * Memory suggestions, capability requests and changes to how a bot runs are
 * different documents with different lifetimes, and to the person they are one
 * thing — something the bot wants to do differently. This card is that one
 * thing. It sits above Memory because a suggestion is about the *next* turn,
 * while the memory card is about what the bot already carries.
 *
 * Two decisions shape it.
 *
 * **The evidence comes before the reasoning.** A memory proposal carries a
 * quote checked against the transcript; a capability request carries the turn it
 * came from. The model's own explanation is folded away, because it is the part
 * that costs nothing to invent.
 *
 * **A refusal is a decision, not a dismissal.** Saying no records a lesson, and
 * the lesson is listed here with a way to clear it. A queue that forgets its
 * refusals asks the same question forever; a queue that keeps them without
 * showing them is a silence nobody can undo.
 */
import {useCallback, useEffect, useState} from 'react';

import type {
  HarnessReport,
  LearningLesson,
  LearningProposal,
  MemoryProposal,
} from '@marimo/protocol';

import {describe} from '../describe.js';
import {SettingsSection} from './SettingsSection.js';

type Inbox = {
  proposals: LearningProposal[];
  memory: MemoryProposal[];
  lessons: LearningLesson[];
};

const KIND_LABEL: Record<LearningProposal['kind'], string> = {
  grant: 'Capability',
  policy: 'How it runs',
  maintenance: 'Housekeeping',
};

export function Learning({
  opened,
  onToggle,
  profileId,
  onChange,
  lastReview,
}: {
  opened: ReadonlySet<string>;
  onToggle: (title: string, expanded: boolean) => void;
  /** The active bot, for the outcome counts. Absent while the roster loads. */
  profileId?: string;
  onChange?: () => void;
  lastReview?: {events: number; found: number} | null;
}): React.JSX.Element {
  const [inbox, setInbox] = useState<Inbox | null>(null);
  const [report, setReport] = useState<HarnessReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    try {
      const listed = await window.marimo.call('learning.proposals', {});
      setInbox(listed);
      setProblem(null);
      if (profileId !== undefined) {
        setReport(await window.marimo.call('harness.report', {profileId}));
      } else {
        setReport(null);
      }
    } catch (failure) {
      setProblem(describe(failure));
    }
  }, [profileId]);

  useEffect(() => {
    void load();
  }, [load]);

  const resolve = async (id: string, accept: boolean): Promise<void> => {
    setBusy(true);
    setProblem(null);
    setNote(null);
    try {
      const result = await window.marimo.call('learning.resolve', {
        proposalId: id,
        accept,
      });
      if (!result.ok) {
        setProblem(result.problem ?? 'That suggestion could not be applied.');
      } else {
        setNote(result.applied ?? (accept ? 'Applied.' : 'Declined.'));
        /*
         * The correction was written and the old bullet was not found. Said out
         * loud because the person pressed Apply believing one fact would replace
         * another, and both are now in memory until they look.
         */
        if (result.supersede?.outcome === 'absent') {
          setProblem(
            'Remembered, but the fact this was meant to replace was not found, ' +
              'so the old wording may still be there.',
          );
        } else if (result.supersede?.outcome === 'ambiguous') {
          setProblem(
            `Remembered, but the fact this was meant to replace matched ${
              result.supersede.matches ?? 0
            } entries, so none was removed.`,
          );
        }
      }
      await load();
      onChange?.();
    } catch (failure) {
      setProblem(describe(failure));
      await load();
    } finally {
      setBusy(false);
    }
  };

  const forgetLessons = async (): Promise<void> => {
    if (
      !window.confirm(
        `Forget ${String(inbox?.lessons.length ?? 0)} refusals? The bot will be ` +
          'able to ask for these again.',
      )
    ) {
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      const result = await window.marimo.call('learning.forgetLessons', {});
      setInbox((current) =>
        current === null ? current : {...current, lessons: result.lessons},
      );
      onChange?.();
    } catch (failure) {
      setProblem(describe(failure));
    } finally {
      setBusy(false);
    }
  };

  const waiting =
    inbox === null
      ? null
      : [
          ...inbox.memory.map((proposal) => ({
            id: proposal.id,
            at: proposal.createdAt,
            node: <MemoryItem proposal={proposal} />,
            resolve,
          })),
          ...inbox.proposals.map((proposal) => ({
            id: proposal.id,
            at: proposal.createdAt,
            node: <LearningItem proposal={proposal} />,
            resolve,
          })),
        ].sort((left, right) => right.at.localeCompare(left.at));

  return (
    <SettingsSection title="Learning" opened={opened} onToggle={onToggle}>
      <p className="settings-muted">
        What the bot wants to change about itself. It can suggest a fact, ask
        for a capability, or propose a change to how it runs; none of it happens
        until you say yes. A no is remembered, so it does not ask again in
        different words.
      </p>

      {report !== null && <Stats report={report} />}

      {lastReview !== undefined && lastReview !== null && (
        <p className="settings-why">
          The last look read {lastReview.events} message
          {lastReview.events === 1 ? '' : 's'} and found {lastReview.found}.
        </p>
      )}

      <h4 className="memory-proposals-heading">Waiting for you</h4>
      {waiting === null ? (
        <p className="settings-muted">Reading…</p>
      ) : waiting.length === 0 ? (
        <p className="settings-muted">
          Nothing waiting. Most conversations have nothing in them worth
          changing — that is the expected answer, not a problem.
        </p>
      ) : (
        waiting.map((entry) => (
          <div className="memory-item" key={entry.id}>
            {entry.node}
            <div className="memory-actions">
              <button
                type="button"
                className="button button-quiet button-small"
                disabled={busy}
                onClick={() => {
                  void entry.resolve(entry.id, false);
                }}
              >
                Not now
              </button>
              <button
                type="button"
                className="button button-primary button-small"
                disabled={busy}
                onClick={() => {
                  void entry.resolve(entry.id, true);
                }}
              >
                Apply
              </button>
            </div>
          </div>
        ))
      )}

      {note !== null && <p className="settings-why">{note}</p>}
      {problem !== null && (
        <p className="connector-detail connector-error">{problem}</p>
      )}

      {inbox !== null && inbox.lessons.length > 0 && (
        <>
          <h4 className="memory-proposals-heading">
            {inbox.lessons.length === 1
              ? 'One thing it will not ask for again'
              : 'Things it will not ask for again'}
          </h4>
          <p className="settings-muted">
            Refusals, kept so the bot does not repeat a question you have
            answered. You can let it ask again, one decision at a time, by
            clearing them.
          </p>
          <details className="memory-why">
            <summary>Show them</summary>
            <ul className="memory-dismissed">
              {inbox.lessons.map((lesson) => (
                <li key={lesson.id}>
                  <span className="memory-age">{KIND_LABEL[lesson.kind]}</span>{' '}
                  {lesson.summary}
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
                void forgetLessons();
              }}
            >
              Let it ask again
            </button>
          </div>
        </>
      )}
    </SettingsSection>
  );
}

/**
 * What the finished turns cost.
 *
 * The denominator for every proposal on the page. "Three tool errors" is not a
 * number anybody can act on without knowing how many turns it took to make
 * them, and a correction count beside a completion count is the closest thing
 * this app has to "did it do the job".
 */
function Stats({report}: {report: HarnessReport}): React.JSX.Element {
  const {outcomes} = report;
  const finished = outcomes.completed + outcomes.failed + outcomes.aborted;
  return (
    <div className="learning-stats">
      <span>
        <strong>{finished.toLocaleString()}</strong> finished turn
        {finished === 1 ? '' : 's'}
      </span>
      <span>
        <strong>{outcomes.completed.toLocaleString()}</strong> completed
      </span>
      <span>
        <strong>{outcomes.failed.toLocaleString()}</strong> failed
      </span>
      <span>
        <strong>{outcomes.toolErrors.toLocaleString()}</strong> tool error
        {outcomes.toolErrors === 1 ? '' : 's'}
      </span>
      <span>
        <strong>{outcomes.corrections.toLocaleString()}</strong> correction
        {outcomes.corrections === 1 ? '' : 's'}
      </span>
    </div>
  );
}

/** A fact the reviewer proposed, drawn the same way the Memory card used to. */
function MemoryItem({proposal}: {proposal: MemoryProposal}): React.JSX.Element {
  return (
    <>
      <p className="memory-text">{proposal.text}</p>
      {proposal.replaces !== undefined && (
        <p className="settings-muted memory-replaces">
          {/* eslint-disable-next-line react/no-unescaped-entities */}
          This replaces: <span>{proposal.replaces}</span>
        </p>
      )}
      {proposal.evidence !== undefined && (
        <blockquote className="memory-evidence">
          &ldquo;{proposal.evidence.quote}&rdquo;
        </blockquote>
      )}
      {proposal.reason.length > 0 && (
        <details className="memory-why">
          <summary>Why it suggested this</summary>
          <p>{proposal.reason}</p>
        </details>
      )}
      <span className="memory-section">
        {proposal.reason.length === 0 ? 'Memory' : proposal.section}
      </span>
    </>
  );
}

/** A change the bot asked for: a grant, a policy, or housekeeping. */
function LearningItem({
  proposal,
}: {
  proposal: LearningProposal;
}): React.JSX.Element {
  const title =
    proposal.kind === 'grant'
      ? `${proposal.target === 'tool' ? 'Tool' : 'Connector'}: ${proposal.name}`
      : proposal.summary;
  return (
    <>
      <span className="learning-kind">{KIND_LABEL[proposal.kind]}</span>
      <p className="memory-text">{title}</p>
      {proposal.reason.length > 0 && (
        <p className="settings-muted">{proposal.reason}</p>
      )}
      {proposal.evidence.length > 0 && (
        <details className="memory-why">
          <summary>Where this came from</summary>
          <ul className="memory-dismissed">
            {proposal.evidence.map((entry, index) => (
              <li key={`${proposal.id}-${String(index)}`}>
                {entry.quote ?? entry.turnId ?? 'An earlier turn.'}
              </li>
            ))}
          </ul>
        </details>
      )}
    </>
  );
}
