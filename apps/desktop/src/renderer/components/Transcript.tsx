/**
 * The conversation on screen.
 *
 * Text is rendered as text, not as markup. The model's answer is untrusted input
 * — it can contain anything a web page can, because it may be quoting one — so
 * the renderer never turns it into HTML. Markdown arrives with its own pass in
 * the UI milestone, where it can be done with a renderer that escapes by
 * construction rather than by a regex somebody has to keep correct.
 */
import {useEffect, useLayoutEffect, useRef, useState} from 'react';

import {DRAFT_BOT_TOOL} from '@marimo/protocol';
import type {AgentProfile, PendingGate, TranscriptMessage} from '@marimo/protocol';

import {gateCopy} from '../gate-copy.js';
import {shouldFollow, shouldOfferJump} from '../scroll.js';
import {participantFor} from '../participants.js';
import {Copy, Markdown} from './Markdown.js';
import {BotBuilderIntro} from './BotBuilderIntro.js';
import {BotDraftCard} from './BotDraftCard.js';

import type {Delegation, LiveToolCall, LiveTurn} from '../hooks/useAgent.js';

/**
 * The agent's initial.
 *
 * A profile carries no colour — nothing in the document chooses one — so the two
 * places that name a helper, above the words it wrote and on the thread it worked
 * in, agree on this instead. Hidden from a screen reader, because the name is
 * always beside it and hearing "W" first is noise.
 */
function AgentMark({name}: {name: string}): React.JSX.Element {
  // Spread rather than `charAt`: a name may open with an emoji, which is two code
  // units, and half of one renders as a replacement character.
  const [first = '?'] = [...name];
  return (
    <span className="agent-mark" aria-hidden="true">
      {first.toUpperCase()}
    </span>
  );
}

/** A call, collapsed to one line, with its result folded away behind it. */
function ToolCall({call}: {call: LiveToolCall}): React.JSX.Element {
  const summary =
    typeof call.args === 'object' && call.args !== null
      ? Object.values(call.args as Record<string, unknown>)
          .filter((value) => typeof value === 'string')
          .slice(0, 1)
          .join('')
      : '';

  return (
    <details className="call" data-state={call.ok === undefined ? 'running' : call.ok ? 'ok' : 'failed'}>
      <summary className="call-head">
        <span className="call-mark" aria-hidden="true">
          {call.ok === undefined ? '…' : call.ok ? '✓' : '✕'}
        </span>
        <code className="call-name">{call.tool}</code>
        {summary.length > 0 && <span className="call-args">{summary}</span>}
      </summary>
      {call.result !== undefined && (
        <pre className="call-result">{call.result}</pre>
      )}
    </details>
  );
}

/**
 * A delegated call, drawn as the work it did.
 *
 * The lead's turn is suspended inside `ask_agent` while the helper works, so this
 * takes the place the tool call would have had — and it is not one line, because
 * what comes back is a second agent's words and the calls that agent made. Open
 * while it runs and after it fails, since both are states somebody is watching;
 * folded to a summary once it has worked, because by then the answer is already
 * in the transcript and the group is only its receipt.
 */
function Thread({
  work,
  open,
}: {
  work: Delegation;
  open: boolean;
}): React.JSX.Element {
  const state =
    work.done !== true ? 'running' : work.ok === false ? 'failed' : 'ok';

  return (
    <details className="call thread" data-state={state} open={open}>
      <summary className="call-head">
        <span className="call-mark" aria-hidden="true">
          {state === 'running' ? '…' : state === 'ok' ? '✓' : '✕'}
        </span>
        <AgentMark name={work.name} />
        <span className="thread-who">{work.name}</span>
        <span className="thread-task">{`— ${work.task}`}</span>
        <span className="thread-when">{outcome(work)}</span>
      </summary>
      <div className="thread-body">
        {work.text.length > 0 && (
          <div className="bubble bubble-answer">
            <Markdown text={work.text} />
          </div>
        )}
        {work.toolCalls.length > 0 && (
          <div className="calls">
            {work.toolCalls.map((call) => (
              <ToolCall key={call.callId} call={call} />
            ))}
          </div>
        )}
        {state === 'running' && work.text.length === 0 && (
          <div className="bubble thinking" aria-label={`${work.name} is working`}>
            <span />
            <span />
            <span />
          </div>
        )}
        {work.error !== undefined && work.error.length > 0 && (
          <p className="message-error">{work.error}</p>
        )}
      </div>
    </details>
  );
}

/**
 * What a thread's head says when there is an ending to report.
 *
 * Nothing while it runs: a helper that started four seconds ago is not news, and
 * a clock that ticked would mean re-rendering the transcript for a number nobody
 * asked for. A failure says so rather than giving a time, because a duration
 * beside a thread that failed reads as a result.
 */
function outcome(work: Delegation): string {
  if (work.done !== true) {
    return '';
  }
  if (work.ok === false) {
    return 'failed';
  }
  /*
   * The engine's `ms` is the measurement — it is the process that timed the work
   * — and the window's own clock is only for a finish that carried no duration.
   */
  return describeDuration(work.ms ?? Math.max(0, Date.now() - work.startedAt));
}

/**
 * How long something took, in the roughest useful unit.
 *
 * Tenths of a second up to a minute, because the question is "a moment or a
 * while" and 4.2 against 4.9 is not an answer anybody is comparing.
 */
function describeDuration(ms: number): string {
  const seconds = Math.max(0, ms) / 1000;
  if (seconds < 60) {
    return `${seconds.toFixed(1)}s`;
  }
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes)}m ${String(Math.round(seconds - minutes * 60))}s`;
}

/**
 * A gate, as a card.
 *
 * The card leads with what will happen — "Overwrite this existing file", "Run
 * this command in the workspace" — and then the exact thing it will happen to.
 * The tool's own hint is used only when it is a sentence a person can decide on;
 * ADK's boilerplate about FunctionResponse payloads is dropped, because the
 * person reading this is choosing an action, not an API call.
 */
function ApprovalCard({
  gate,
  onDecide,
}: {
  gate: PendingGate;
  onDecide: (callId: string, confirmed: boolean) => void;
}): React.JSX.Element {
  const waited = describeWait(gate.askedAt);
  const copy = gateCopy(gate);

  return (
    <div className="approval" role="group" aria-label={`Approve: ${copy.heading}`}>
      <div className="approval-head">
        <strong>{copy.heading}</strong>
      </div>
      <div className="approval-body">
        {copy.hint === undefined ? null : (
          <p className="approval-hint">{copy.hint}</p>
        )}
        {copy.primary === undefined ? null : (
          <pre className="approval-primary">{copy.primary}</pre>
        )}
        {copy.note === undefined ? null : (
          <p className="approval-note">{copy.note}</p>
        )}
        {copy.detail === undefined ? null : (
          <details className="approval-detail">
            <summary>{copy.detailLabel ?? 'Show the details'}</summary>
            <pre>{copy.detail}</pre>
          </details>
        )}
      </div>
      <div className="approval-foot">
        <span className="approval-waited">waiting {waited}</span>
        <button
          type="button"
          className="button button-quiet"
          onClick={() => {
            onDecide(gate.callId, false);
          }}
        >
          Deny
        </button>
        <button
          type="button"
          className="button button-primary"
          onClick={() => {
            onDecide(gate.callId, true);
          }}
        >
          Approve
        </button>
      </div>
    </div>
  );
}

function Message({
  message,
  agents,
  leadId,
  author,
  onFeedback,
  onBotCreated,
}: {
  message: TranscriptMessage;
  /** The roster, for a draft card's receipt and its restored lead. */
  agents: readonly AgentProfile[];
  leadId: string | undefined;
  /**
   * Who wrote it, when that is not the conversation's lead. Absent for every
   * message in a chat with one participant, which is most of them.
   */
  author?: string;
  onFeedback?: (
    message: TranscriptMessage,
    correction?: string,
  ) => Promise<boolean>;
  onBotCreated?: (next: {
    profiles: AgentProfile[];
    activeProfileId: string;
    created: AgentProfile;
  }) => void;
}): React.JSX.Element {
  /**
   * Whether the correction box is open, and what has been typed into it.
   *
   * Local to the message rather than lifted: two answers on screen can be judged
   * at once in principle, and a single piece of state in the transcript would
   * make opening the second close the first.
   */
  const [correcting, setCorrecting] = useState(false);
  const [correction, setCorrection] = useState('');
  /*
   * Stored, not just remembered. The old state started at false on every mount,
   * so reopening a conversation offered to note an answer that had already been
   * noted — and the second note was a second entry about one turn. The message is
   * keyed by its id, so a refresh reuses this component: the local flag covers
   * the click, and `markedWrong` covers a mark that arrived from another surface
   * — the pet shares the conversation, and its note is the same note.
   */
  const [notedHere, setNotedHere] = useState(false);
  const noted = notedHere || message.markedWrong === true;

  /*
   * What a compaction wrote, in place of the messages it replaced. Drawn as its
   * own thing rather than as a user's bubble — the words are the model's, and the
   * role is the user's only because that is how the provider is sent it — and it
   * says where the messages went, because "fewer messages than I wrote" is the
   * one thing about compaction that reads as loss.
   */
  if (message.compacted !== undefined) {
    return (
      <article className="message message-compacted">
        <div className="compacted-head">
          <span className="compacted-label">Compacted history</span>
          <Copy text={message.text} what="summary" />
        </div>
        <p className="compacted-note">
          {message.compacted === 1
            ? 'One earlier message was replaced by this summary.'
            : `${String(message.compacted)} earlier messages were replaced by this summary.`}{' '}
          They are still in this conversation&rsquo;s file — the bot is simply
          not sent them any more.
        </p>
        <div className="bubble bubble-answer">
          <Markdown text={message.text} />
        </div>
      </article>
    );
  }

  return (
    <article className={`message message-${message.role}`}>
      {/*
        Above the calls and the words, so the two are read as one agent's answer.
        Only ever on an answer: the user's own message is the user's, and putting a
        name over it would attribute their sentence to whoever happens to be last
        in the roster.
      */}
      {author !== undefined && (
        <p className="message-author">
          <AgentMark name={author} />
          {author}
        </p>
      )}
      {message.toolCalls !== undefined && message.toolCalls.length > 0 && (
        <div className="calls">
          {message.toolCalls.map((call) =>
            call.tool === DRAFT_BOT_TOOL ? (
              <BotDraftCard
                key={call.callId}
                call={call}
                profiles={agents}
                leadId={leadId}
                {...(onBotCreated === undefined ? {} : {onBotCreated})}
              />
            ) : (
              <ToolCall key={call.callId} call={call} />
            ),
          )}
        </div>
      )}
      {message.text.length > 0 && (
        message.role === 'assistant' ? (
          <div className="bubble bubble-answer">
            <Markdown text={message.text} />
            <div className="bubble-actions">
              <Copy text={message.text} what="answer" />
              {/*
               * The one place the user can say an answer was wrong. Offered only
               * on a stored message and never on the live one: a turn still
               * arriving is not one to judge, and the live bubble is not yet the
               * message this note would be filed under.
               */}
              {onFeedback !== undefined && !noted && (
                <button
                  type="button"
                  className="button button-quiet bubble-note"
                  onClick={() => {
                    setCorrecting((open) => !open);
                  }}
                >
                  Not quite
                </button>
              )}
              {noted && (
                <span className="bubble-noted" role="status">
                  Noted
                </span>
              )}
            </div>
            {correcting && onFeedback !== undefined && (
              <form
                className="bubble-correction"
                onSubmit={(event) => {
                  event.preventDefault();
                  void onFeedback(message, correction).then((ok) => {
                    if (ok) {
                      setNotedHere(true);
                      setCorrecting(false);
                      setCorrection('');
                    }
                  });
                }}
              >
                <label htmlFor={`correction-${message.id}`}>
                  What was wrong, or what is right instead?
                </label>
                <div className="bubble-correction-row">
                  <input
                    id={`correction-${message.id}`}
                    type="text"
                    value={correction}
                    maxLength={400}
                    placeholder="Optional — the bot will read this next time"
                    onChange={(event) => {
                      setCorrection(event.target.value);
                    }}
                  />
                  <button type="submit" className="button button-primary button-small">
                    Send
                  </button>
                  <button
                    type="button"
                    className="button button-quiet button-small"
                    onClick={() => {
                      setCorrecting(false);
                    }}
                  >
                    Never mind
                  </button>
                </div>
              </form>
            )}
          </div>
        ) : (
          <div className="bubble">{message.text}</div>
        )
      )}
      {message.error !== undefined && message.error.length > 0 && (
        <p className="message-error">{message.error}</p>
      )}
    </article>
  );
}

export function Transcript({
  messages,
  outbox,
  live,
  delegations,
  pending,
  agents,
  leadId,
  onDecide,
  onFeedback,
  onBotCreated,
  builder,
  busy,
}: {
  messages: TranscriptMessage[];
  /**
   * The user's words while they are sent but not yet read back from the
   * conversation. Drawn in the position the stored copy will take, so the turn
   * ending does not move it.
   */
  outbox: string | null;
  live: LiveTurn | null;
  /** Work a helper is doing right now, by the lead's tool call id. */
  delegations: Record<string, Delegation>;
  pending: PendingGate[];
  /**
   * Every agent in the install, so a message's `agentId` can be turned into the
   * name of whoever wrote it — including an agent that has since been deleted,
   * which is drawn as exactly that rather than as a blank.
   */
  agents: readonly AgentProfile[];
  /**
   * The agent whose voice the conversation's own messages are in.
   *
   * The first participant, or the agent that owns the conversation when nobody
   * has been named. An answer from anyone else is labelled; an answer from this
   * one needs no label, because it is what the transcript has always shown.
   */
  leadId: string | undefined;
  onDecide: (callId: string, confirmed: boolean) => void;
  /**
   * Records that an answer was wrong. Absent in a caller with nowhere to put it.
   *
   * Optional rather than required because the transcript is also drawn in tests
   * and in states where the agent is not answering — and a prop the component
   * cannot do without would make every one of those carry a stub.
   */
  onFeedback?: (
    message: TranscriptMessage,
    correction?: string,
  ) => Promise<boolean>;
  /**
   * A bot was made from a draft card, so the window's settings copy is stale.
   * Absent in a transcript with nowhere to put it, which draws the card's
   * receipt but leaves the rail to the next reload.
   */
  onBotCreated?: (next: {
    profiles: AgentProfile[];
    activeProfileId: string;
    created: AgentProfile;
  }) => void;
  /**
   * Whether this is the conversation that makes a bot. It changes the opening:
   * a pinned question from Marimo instead of the empty-chat invitation.
   */
  builder?: boolean;
  busy: boolean;
}): React.JSX.Element {
  const empty =
    !builder &&
    messages.length === 0 &&
    outbox === null &&
    live === null &&
    pending.length === 0;

  const view = useRef<HTMLDivElement>(null);
  const [jumpable, setJumpable] = useState(false);
  /*
   * Whether to follow is decided from the geometry *before* the new content
   * arrived, which is why it is a ref rather than a comparison made after the
   * render: by then the element is already taller and the view looks further from
   * the bottom than the user left it.
   */
  const follow = useRef(true);

  const onScroll = (): void => {
    const element = view.current;
    if (element === null) {
      return;
    }
    const geometry = {
      scrollTop: element.scrollTop,
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight,
    };
    follow.current = shouldFollow(geometry);
    setJumpable(shouldOfferJump(geometry));
  };

  /*
   * Runs before the browser paints, so streamed text never appears a frame late
   * and then jumps. A `useEffect` here would show the new text at the old scroll
   * position first, which reads as a stutter on every token.
   */
  useLayoutEffect(() => {
    const element = view.current;
    if (element === null || !follow.current) {
      return;
    }
    element.scrollTop = element.scrollHeight;
    setJumpable(false);
  });

  /*
   * A new conversation starts at the bottom, whatever the last one was doing.
   * Keyed on emptiness rather than on the messages themselves, so arriving text
   * does not re-run it and fight the follow rule above.
   */
  const blank = messages.length === 0 && outbox === null && live === null;
  useEffect(() => {
    follow.current = true;
    setJumpable(false);
    const element = view.current;
    if (element !== null) {
      element.scrollTop = element.scrollHeight;
    }
  }, [blank]);

  /*
   * Threads whose parent call the window has not been shown.
   *
   * `delegate.started` names the lead's tool call, and in the ordinary order that
   * call is streamed first — which is what puts the group where the call is
   * rather than at the end of the list. The thread is the delegation's own fact,
   * though, so it is drawn either way instead of depending on another event
   * having arrived before it.
   */
  const placed = new Set((live?.toolCalls ?? []).map((call) => call.callId));
  const unplaced = Object.entries(delegations).filter(
    ([callId]) => !placed.has(callId),
  );

  /*
   * Whether a thread is unfolded.
   *
   * Open while it runs and open after it fails — both are states somebody is
   * meant to be watching. Folded once it has worked, because the answer is
   * already above it and the group is then only a receipt. A pending gate opens
   * every thread as well: the cards are drawn further down the transcript rather
   * than inside a thread, so a closed one cannot hide a card, but while somebody
   * is deciding they should be able to see the work that asked.
   */
  const threadOpen = (work: Delegation): boolean =>
    work.done !== true || work.ok === false || pending.length > 0;

  return (
    <div className="transcript-wrap">
    <div
      className="transcript"
      role="log"
      aria-live="polite"
      aria-label="Conversation"
      ref={view}
      onScroll={onScroll}
    >
      {builder === true && (
        <BotBuilderIntro
          lead={agents.find((entry) => entry.id === leadId)}
        />
      )}

      {empty && (
        <div className="empty">
          <img className="empty-mark" src="./marimo-logo.png" alt="" />
          <h2>Say something to Marimo Bot</h2>
          <p>
            It can read and write files in the space you chose, and use whatever
            else you have switched on — it asks before running a command or
            replacing a file that is already there.
          </p>
        </div>
      )}

      {messages.map((message) => {
        /*
         * A stored answer is the conversation's own unless it says otherwise:
         * `agentId` absent is the agent that owns the chat, and so is a value
         * equal to the lead. Either way there is nothing to label, and a name over
         * every answer in the app would be the noise this avoids.
         */
        const other =
          message.role === 'assistant' &&
          message.agentId !== undefined &&
          message.agentId !== leadId
            ? participantFor(message.agentId, agents).name
            : undefined;
        return (
          <Message
            key={message.id}
            message={message}
            agents={agents}
            leadId={leadId}
            {...(other === undefined ? {} : {author: other})}
            {...(onFeedback === undefined ? {} : {onFeedback})}
            {...(onBotCreated === undefined ? {} : {onBotCreated})}
          />
        );
      })}

      {outbox !== null && (
        <article className="message message-user">
          <div className="bubble">{outbox}</div>
        </article>
      )}

      {live !== null && (
        <article className="message message-assistant">
          {(live.toolCalls.length > 0 || unplaced.length > 0) && (
            <div className="calls">
              {live.toolCalls.map((call) => {
                const work = delegations[call.callId];
                /*
                 * A call the lead made while a helper was working is inside that
                 * helper's thread instead — the hook files it there — so anything
                 * still in this list is the lead's own, or the delegation itself.
                 */
                if (work !== undefined) {
                  return (
                    <Thread key={call.callId} work={work} open={threadOpen(work)} />
                  );
                }
                return call.tool === DRAFT_BOT_TOOL ? (
                  <BotDraftCard
                    key={call.callId}
                    call={call}
                    profiles={agents}
                    leadId={leadId}
                    {...(onBotCreated === undefined ? {} : {onBotCreated})}
                  />
                ) : (
                  <ToolCall key={call.callId} call={call} />
                );
              })}
              {unplaced.map(([callId, work]) => (
                <Thread key={callId} work={work} open={threadOpen(work)} />
              ))}
            </div>
          )}
          {live.text.length > 0 && (
            <div className="bubble bubble-answer">
              <Markdown text={live.text} />
            </div>
          )}
          {live.running && live.text.length === 0 && (
            <div className="bubble thinking" aria-label="Working">
              <span />
              <span />
              <span />
            </div>
          )}
        </article>
      )}

      {pending.map((gate) => (
        <ApprovalCard key={gate.callId} gate={gate} onDecide={onDecide} />
      ))}

      {/*
        The turn is on its way but has not streamed its first event, so there is
        no live copy to hang the dots on yet. The same dots in the same shape as
        the live article's, because waiting is one thing and should look like
        one — the paragraph that used to be here could not draw at all, since
        `busy` was defined as a live turn running and this branch requires none.
      */}
      {busy && pending.length === 0 && live === null && (
        <article className="message message-assistant">
          <div className="bubble thinking" aria-label="Working">
            <span />
            <span />
            <span />
          </div>
        </article>
      )}
    </div>

      {/*
        Offered only once somebody has clearly stopped following. A button that
        appeared the moment they scrolled a line would flicker in and out while
        they read, which is worse than not offering one.
      */}
      {jumpable && (
        <button
          type="button"
          className="jump"
          onClick={() => {
            const element = view.current;
            if (element !== null) {
              element.scrollTop = element.scrollHeight;
            }
            follow.current = true;
            setJumpable(false);
          }}
        >
          Jump to latest
        </button>
      )}
    </div>
  );
}

/**
 * How long a card has waited, in the roughest useful unit.
 *
 * Rough on purpose: the question a person is asking is "did I leave this
 * overnight", not "how many seconds".
 */
function describeWait(askedAt: string): string {
  const then = Date.parse(askedAt);
  if (!Number.isFinite(then)) {
    return 'a moment';
  }
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < 60) {
    return 'a moment';
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return `${hours} hour${hours === 1 ? '' : 's'}`;
  }
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'}`;
}
