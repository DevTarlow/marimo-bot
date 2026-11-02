/**
 * Where a message is typed.
 *
 * One box, and the send button is *in* it rather than on a row underneath: the
 * thing being pressed belongs to the line being typed, and a Send below the box
 * reads as the next form field rather than as the end of the sentence. It is a
 * circle with an arrow because that is what it does — the arrow follows the
 * message out — and while a turn is running the same circle becomes Stop, so
 * the control you reach for next is where the one you just pressed was.
 *
 * The foot row is where the actions that act on the *message* live: `+` on the
 * left, the keyboard hint in the middle, the model picker on the right. The
 * textarea grows with what is in it up to a point, because a prompt worth
 * sending is often more than one line and a box that scrolls after two lines
 * hides the question the user is still writing.
 *
 * The model picker is here rather than in Settings because it is a fact about
 * *this* conversation: which model answers the question being typed. It chooses
 * for the conversation only, and the popover offers the way back to the agent's
 * model, so using it once does not pin the chat for good.
 *
 * `+` is on the left of the same row, for the things a message can carry that
 * are not typed: a file to hand over, and the commands that act on the
 * conversation itself. Its menu opens upwards, which is what the popover
 * primitive already does when there is no room below — and there never is, at the
 * bottom of the window.
 *
 * While a turn is running the button becomes Stop rather than the box becoming
 * disabled. A disabled box is the wrong shape: people compose their next thought
 * while waiting, and taking the words away — or losing them on send — is how a
 * conversation gets interrupted by its own tooling.
 *
 * `@` is the other thing this box does, and only when there is somebody to
 * address: it opens the participants of the conversation, and the name picked
 * goes into the text. The name stays there when the message is sent, and
 * `addressedAgent` reads the address back out of it, so the words on screen are
 * the words in the conversation and neither can be right while the other is
 * wrong.
 */
import {useEffect, useRef, useState} from 'react';

import type {
  CommandId,
  PickedFile,
  SkippedFile,
  SpeechLanguage,
} from '@marimo/protocol';

import {composeMessage, describeSkipped} from '../attachments.js';
import {describe} from '../describe.js';
import {useRecorder} from '../hooks/useRecorder.js';
import {addressedAgent, mentionAt} from '../mentions.js';
import type {Participant} from '../participants.js';
import {Popover, PopoverItem} from './Popover.js';
import type {PopoverAnchor} from './Popover.js';

/** The `@` picker, while it is open. */
interface MentionState {
  /** Index of the `@` in the text. */
  start: number;
  /** Where the caret was, which is the end of what has been typed of the name. */
  caret: number;
  /** What has been typed after the `@`, possibly nothing. */
  query: string;
  /** The item the arrow keys are on. */
  active: number;
  anchor: PopoverAnchor;
}

export function Composer({
  onSend,
  onStop,
  busy,
  disabled,
  modelLabel,
  modelState,
  onOpenModels,
  voiceEnabled,
  speechLanguage,
  onVoiceWarm,
  speaking,
  onStopSpeaking,
  onPickFiles,
  commands,
  onRunCommand,
  participants,
}: {
  /**
   * Resolves `true` when the turn was accepted.
   *
   * The boolean is why this returns a promise: a send that is refused — a turn
   * already running in another window, a conversation that no longer exists —
   * arrives as `accepted: false`, and clearing the box on the press instead
   * would throw the user's words away for a message that was never stored.
   *
   * The second argument is the agent the message addressed, when it addressed
   * one. It is a parameter rather than something the send path works out for
   * itself because the picker and the text are both here, and two places
   * deciding who a message is for is one place too many.
   */
  onSend: (
    text: string,
    agentId?: string,
    attachments?: readonly PickedFile[],
  ) => Promise<boolean>;
  onStop: () => void;
  busy: boolean;
  disabled: boolean;
  /** The local model's name, for the badge at the foot of the box. */
  modelLabel?: string;
  /** Its process state, drawn as a dot: awake, waking, resting, failed. */
  modelState?: 'awake' | 'waking' | 'resting' | 'failed';
  /** Opens Settings → Models. The badge is the route to managing them. */
  onOpenModels?: () => void;
  /** Voice mode is on: the microphone button is offered. */
  voiceEnabled?: boolean;
  /** The language the voice model listens and speaks. */
  speechLanguage?: SpeechLanguage;
  /**
   * Starts the voice model while the person is recording.
   *
   * The audio model is the slow part of the first press, and the turn needs it
   * anyway; warming here is what overlaps that load with the speaking.
   */
  onVoiceWarm?: () => void;
  /** A spoken reply is playing; the stop button is shown. */
  speaking?: boolean;
  onStopSpeaking?: () => void;
  /**
   * Asks for files, judged against the space this conversation works in.
   *
   * Rejects with a sentence when there is no space to attach from; answers with
   * what was accepted and what was refused otherwise. A refusal is not an error —
   * a file outside the space is a file the agent cannot read, and saying so is
   * the answer.
   */
  onPickFiles: () => Promise<{files: PickedFile[]; skipped: SkippedFile[]}>;
  /**
   * The commands the `+` menu offers — the ones Settings has not switched off.
   *
   * Passed in rather than looked up here, so the catalogue and the switch that
   * turns one off live in the same place: this component draws what it is given.
   */
  commands: readonly {id: CommandId; label: string; blurb: string}[];
  /**
   * Runs one, and answers with what to say about it.
   *
   * A note rather than a result object, because the only thing the composer can
   * do with an outcome is draw one line of it. A rejection is a genuine failure
   * and is drawn in the failure colour; a resolved note is news.
   */
  onRunCommand: (id: CommandId) => Promise<string | null>;
  /**
   * The agents a message can be addressed to.
   *
   * One or none is a conversation with nothing to choose between: the agent that
   * is there answers whether or not it is named, so the picker is not drawn and
   * no address is read out of the text. Deleted agents are not here either — an
   * `@` that could only be refused is not an offer.
   */
  participants: readonly Participant[];
}): React.JSX.Element {
  const [text, setText] = useState('');
  const [attached, setAttached] = useState<PickedFile[]>([]);
  /** The last thing that happened, drawn in the hint slot. */
  const [note, setNote] = useState<{text: string; failed: boolean} | null>(null);
  /** The command being run, so the row can say so while it does. */
  const [running, setRunning] = useState<CommandId | null>(null);
  const [menu, setMenu] = useState<PopoverAnchor | null>(null);
  const [mention, setMention] = useState<MentionState | null>(null);
  /*
   * The microphone, if voice mode is on. The transcript goes into the box rather
   * than straight out: a misheard word should be editable before it becomes a
   * message, and the person is looking at the text anyway.
   */
  const recorder = useRecorder({
    ...(speechLanguage === undefined ? {} : {language: speechLanguage}),
    onWarm: onVoiceWarm,
    onText: (transcript) => {
      setText((current) =>
        current.trim().length === 0 ? transcript : `${current.trim()} ${transcript}`,
      );
    },
    onError: (message) => {
      setNote({text: message, failed: true});
    },
  });
  /**
   * Where the caret goes once a picked name is in the box.
   *
   * A ref rather than state: it is applied by the effect below and never drawn,
   * and a second render to move a caret is a render the user can see.
   */
  const caretAfterPick = useRef<number | null>(null);
  /*
   * Read by `syncMention`, which needs the state as it is *now*: the picker keeps
   * the rectangle it was measured at and the highlight it has, and both are read
   * during an event rather than during a render.
   */
  const mentionRef = useRef<MentionState | null>(null);
  mentionRef.current = mention;
  const box = useRef<HTMLTextAreaElement>(null);
  const add = useRef<HTMLButtonElement>(null);

  const mentionable = participants.length > 1;

  /** Where the picker hangs from: the box it is completing into. */
  const measureBox = (): PopoverAnchor | null => {
    const rect = box.current?.getBoundingClientRect();
    return rect === undefined
      ? null
      : {top: rect.top, bottom: rect.bottom, left: rect.left};
  };

  /**
   * Keeps the picker in step with the box.
   *
   * Called on every edit and every caret move, so whether it is open is a fact
   * about the text rather than a second copy of the text that can fall out of
   * step: deleting the `@` closes it, typing more of a name filters it, and
   * addressing the same message twice is not a state it can reach.
   */
  const syncMention = (value: string, caret: number): void => {
    if (!mentionable) {
      return;
    }
    const found = mentionAt(value, caret);
    if (found === null) {
      setMention(null);
      return;
    }
    // The `+` menu hangs from the same corner of the window, and one popover
    // over another is one the user cannot read.
    setMenu(null);
    const current = mentionRef.current;
    /*
     * Measured when it opens and kept afterwards: the popover closes on a scroll
     * of what it is anchored to, so the rectangle cannot go stale while it is up,
     * and re-measuring on every keystroke would be work with nothing to show for
     * it.
     */
    const anchor = current?.anchor ?? measureBox();
    if (anchor === null) {
      setMention(null);
      return;
    }
    setMention({
      start: found.start,
      caret,
      query: found.query,
      // A different query is a different list, so the highlight starts at the
      // top of it.
      active:
        current !== null && current.query === found.query ? current.active : 0,
      anchor,
    });
  };

  const matches =
    mention === null
      ? []
      : participants.filter((participant) =>
          participant.name
            .toLowerCase()
            .startsWith(mention.query.toLowerCase()),
        );
  const activeIndex =
    mention === null || matches.length === 0
      ? -1
      : Math.min(mention.active, matches.length - 1);

  /**
   * Puts a name into the box in place of what was typed of it.
   *
   * The mention stays in the text. Keeping it is the honest half of the choice:
   * a stored user message carries no addressee of its own — only the answer
   * carries an author — so a mention stripped on the way out would leave a
   * transcript in which nobody can see who the question was put to, and would
   * send words that differ from the words on screen. `addressedAgent` reads it
   * back at send time, so the address is derived from the same text rather than
   * held beside it, where deleting the mention could not take it back.
   */
  const pickMention = (participant: Participant): void => {
    if (mention === null) {
      return;
    }
    caretAfterPick.current = mention.start + participant.name.length + 2;
    setText(
      `${text.slice(0, mention.start)}@${participant.name} ${text.slice(mention.caret)}`,
    );
    setMention(null);
  };

  /* Grow with the content, then stop. */
  useEffect(() => {
    const element = box.current;
    if (element === null) {
      return;
    }
    element.style.height = 'auto';
    element.style.height = `${Math.min(element.scrollHeight, 220)}px`;
  }, [text]);

  /*
   * The picker never takes the keyboard.
   *
   * `Popover` moves focus into itself when it mounts, which is right for a menu
   * somebody pressed a button to open and wrong for one that appears because a
   * character was typed: the next keystroke would land on a menu item instead of
   * in the box, and the name being typed could never be finished. Focus goes back
   * with the caret where it was. A child's effects run before its parent's, so
   * this is the later word on where the keyboard is.
   */
  useEffect(() => {
    const element = box.current;
    if (mention === null || element === null) {
      return;
    }
    element.focus();
    element.setSelectionRange(mention.caret, mention.caret);
    // On opening only: every keystroke while it is open changes `mention`, and
    // moving the caret on each of those would fight the person typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mention !== null]);

  /* The caret, once the name a click or Enter chose is actually in the box. */
  useEffect(() => {
    const element = box.current;
    const caret = caretAfterPick.current;
    if (element === null || caret === null) {
      return;
    }
    caretAfterPick.current = null;
    element.focus();
    element.setSelectionRange(caret, caret);
  }, [text]);

  const ready =
    (text.trim().length > 0 || attached.length > 0) && !busy && !disabled;

  const submit = async (): Promise<void> => {
    if (!ready) {
      return;
    }
    /*
     * Who the message is for, read out of the text rather than remembered beside
     * it. Only a conversation with a choice to make is read at all: with one
     * participant the id would name the agent that answers anyway.
     */
    const addressed = mentionable ? addressedAgent(text, participants) : null;
    /*
     * Cleared only once the turn was accepted, and cleared as a pair: the words
     * and the files are one message, so a refusal must not leave the box empty
     * with two chips the user now has to remove by hand.
     */
    if (await onSend(composeMessage(text, attached), addressed?.id, attached)) {
      setText('');
      setAttached([]);
      setNote(null);
      setMention(null);
    }
  };

  const pick = async (): Promise<void> => {
    try {
      const {files, skipped} = await onPickFiles();
      if (files.length > 0) {
        setAttached((current) => [...current, ...files]);
      }
      const refused = describeSkipped(skipped);
      setNote(
        refused === null ? null : {text: `Not attached — ${refused}`, failed: true},
      );
    } catch (failure) {
      setNote({text: describe(failure), failed: true});
    }
  };

  const run = async (id: CommandId): Promise<void> => {
    setRunning(id);
    setNote(null);
    try {
      const answer = await onRunCommand(id);
      setNote(answer === null ? null : {text: answer, failed: false});
    } catch (failure) {
      setNote({text: describe(failure), failed: true});
    } finally {
      setRunning(null);
    }
  };

  const hint =
    running !== null
      ? 'Working…'
      : busy
        ? 'Working…'
        : note !== null
          ? note.text
          : 'Enter to send, Shift+Enter for a new line';

  /*
   * A `const`, so the narrowing survives into the picker's callbacks: a
   * parameter may be reassigned, and TypeScript will not carry "not undefined"
   * into a closure for one.
   */
  return (
    <div className="composer">
      <div className="composer-box">
        {attached.length > 0 && (
          <div className="composer-chips">
            {attached.map((file) => (
              <span className="composer-chip" key={file.path} title={file.path}>
                <span className="composer-chip-name">{file.name}</span>
                <button
                  type="button"
                  className="composer-chip-remove"
                  aria-label={`Remove ${file.name}`}
                  onClick={() => {
                    setAttached((current) =>
                      current.filter((entry) => entry.path !== file.path),
                    );
                  }}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}

        <div className="composer-line">
          <textarea
            ref={box}
            className="composer-input"
            rows={1}
            value={text}
            placeholder={
              disabled
                ? 'Add a bot to start chatting.'
                : mentionable
                  ? 'Ask Marimo Bot anything… type @ to address a bot'
                  : 'Ask Marimo Bot anything…'
            }
            disabled={disabled}
            aria-label="Message"
            onChange={(event) => {
              setText(event.target.value);
              syncMention(
                event.target.value,
                event.target.selectionStart ?? event.target.value.length,
              );
            }}
            // Fires on a caret move as well as on a selection, which is what keeps
            // the picker's idea of "the word the caret is in" true when the caret
            // is moved without the text changing.
            onSelect={(event) => {
              syncMention(
                event.currentTarget.value,
                event.currentTarget.selectionStart ??
                  event.currentTarget.value.length,
              );
            }}
            onKeyDown={(event) => {
              /*
               * The picker's keys come first: while it is open Enter picks the
               * highlighted name instead of sending, and the arrows move the
               * highlight. Both are read here rather than in the menu because the
               * keyboard is here — see the effect above.
               */
              if (mention !== null && matches.length > 0) {
                if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                  event.preventDefault();
                  const step =
                    event.key === 'ArrowDown' ? 1 : matches.length - 1;
                  setMention((current) =>
                    current === null
                      ? current
                      : {
                          ...current,
                          active: (activeIndex + step) % matches.length,
                        },
                  );
                  return;
                }
                if (event.key === 'Enter' || event.key === 'Tab') {
                  event.preventDefault();
                  const chosen = matches[activeIndex];
                  if (chosen !== undefined) {
                    pickMention(chosen);
                  }
                  return;
                }
              }
              if (event.key === 'Escape' && mention !== null) {
                setMention(null);
                return;
              }
              // Enter sends; Shift+Enter is the browser's newline. The other way
              // round is the convention everywhere else and gets it wrong here.
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                void submit();
              }
            }}
          />
          {busy ? (
            <button
              type="button"
              className="composer-send is-stop"
              aria-label="Stop"
              title="Stop"
              onClick={onStop}
            >
              <span aria-hidden="true">■</span>
            </button>
          ) : (
            <button
              type="button"
              className="composer-send"
              aria-label="Send message"
              title="Send (Enter)"
              disabled={!ready}
              onClick={() => {
                void submit();
              }}
            >
              <span aria-hidden="true">↑</span>
            </button>
          )}
        </div>

        <div className="composer-foot">
          <button
            ref={add}
            type="button"
            className="composer-add"
            aria-label="Add files or run a command"
            title="Add files or run a command"
            aria-haspopup="menu"
            aria-expanded={menu !== null}
            disabled={disabled}
            onClick={() => {
              const rect = add.current?.getBoundingClientRect();
              setMenu(
                menu !== null || rect === undefined
                  ? null
                  : {top: rect.top, bottom: rect.bottom, left: rect.left},
              );
            }}
          >
            <span aria-hidden="true">+</span>
          </button>

          {voiceEnabled === true && (
            <button
              type="button"
              className={
                recorder.recording
                  ? 'composer-mic is-recording'
                  : 'composer-mic'
              }
              aria-label={
                recorder.recording ? 'Stop recording' : 'Record a message'
              }
              title={
                recorder.recording
                  ? 'Listening — release to transcribe'
                  : 'Speak to Marimo'
              }
              disabled={disabled || recorder.busy}
              onPointerDown={(event) => {
                event.preventDefault();
                void recorder.start();
              }}
              onPointerUp={() => {
                void recorder.stop();
              }}
              onPointerLeave={() => {
                if (recorder.recording) {
                  void recorder.stop();
                }
              }}
            >
              <span aria-hidden="true">
                {recorder.busy ? '…' : recorder.recording ? '■' : '🎙'}
              </span>
            </button>
          )}

          {speaking === true && onStopSpeaking !== undefined && (
            <button
              type="button"
              className="composer-mic is-speaking"
              aria-label="Stop speaking"
              title="Stop speaking"
              onClick={onStopSpeaking}
            >
              <span aria-hidden="true">■</span>
            </button>
          )}

          <span
            className={
              note === null || !note.failed
                ? 'composer-hint'
                : 'composer-hint is-failure'
            }
            role={note?.failed === true ? 'alert' : undefined}
          >
            {hint}
          </span>

          {modelLabel !== undefined && (
            <button
              type="button"
              className={`composer-model-badge is-${modelState ?? 'resting'}`}
              title="The local model that answers. Open Settings → Models to manage it."
              onClick={onOpenModels}
            >
              <span className="composer-model-dot" aria-hidden="true" />
              <span>{modelLabel}</span>
              {modelState === 'waking' && (
                <span className="composer-model-state">waking…</span>
              )}
            </button>
          )}
        </div>
      </div>

      {menu !== null && (
        <Popover
          anchor={menu}
          label="Add to the message"
          onClose={() => {
            setMenu(null);
          }}
        >
          <PopoverItem
            onSelect={() => {
              setMenu(null);
              void pick();
            }}
          >
            Add files…
          </PopoverItem>

          {commands.length > 0 && (
            <>
              <div className="popover-sep" />
              <span className="popover-label">Commands</span>
              {commands.map((command) => (
                <PopoverItem
                  key={command.id}
                  // A command acts on the conversation the turn is running in, so
                  // it waits for the turn: the agent refuses mid-flight anyway,
                  // and a menu item that can only be refused is a dead control.
                  disabled={busy || running !== null}
                  onSelect={() => {
                    setMenu(null);
                    void run(command.id);
                  }}
                >
                  {command.label}
                </PopoverItem>
              ))}
            </>
          )}
        </Popover>
      )}

      {mention !== null && matches.length > 0 && (
        <Popover
          anchor={mention.anchor}
          label="Address a bot"
          onClose={() => {
            setMention(null);
          }}
        >
          <span className="popover-label">To</span>
          {matches.map((participant, index) => (
            <PopoverItem
              key={participant.id}
              active={index === activeIndex}
              onSelect={() => {
                pickMention(participant);
              }}
            >
              {participant.name}
            </PopoverItem>
          ))}
        </Popover>
      )}
    </div>
  );
}
