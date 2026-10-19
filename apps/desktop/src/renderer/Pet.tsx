/**
 * The desktop pet.
 *
 * A moss ball with a chat bar, answers floating up above it, and nothing else —
 * no rail, no settings, no header. It exists so the agent can be asked something
 * without opening a window, and it is deliberately not a smaller version of the
 * app: everything that is not "say a thing and see the answer" is somewhere else.
 *
 * It shares the conversation with the main window rather than having one of its
 * own. Asking here and reading there is one thread, and a companion with its own
 * history would be a second agent the user has to remember to talk to.
 *
 * **The order of the three pieces is the whole layout: answers, then the moss,
 * then the bar.** A question is typed at the bottom, the answer arrives directly
 * above the moss, and the moss sits between the two so the conversation reads
 * upwards from the thing that is talking. The bar was once above the moss, which
 * put it between the user and the answer they were waiting for.
 *
 * **It is mostly transparent, and it tells the main process where it is not.**
 * The window is a fixed 340×460 rectangle over whatever the user is working in,
 * and without click-through that rectangle swallows every click on the things
 * behind it. So the renderer reports whether the pointer is over something
 * real, and the window stops accepting the mouse when it is not. That is what
 * makes it sit *on* the desktop instead of in a box on top of it.
 */
import {useEffect, useRef, useState} from 'react';

import {defaultCompanionSettings} from '@marimo/protocol';
import type {
  CompanionSettings,
  TranscriptMessage,
} from '@marimo/protocol';

import {Copy, Markdown} from './components/Markdown.js';
import {gateCopy} from './gate-copy.js';
import {useAgent} from './hooks/useAgent.js';

export function Pet(): React.JSX.Element {
  const agent = useAgent();
  const [draft, setDraft] = useState('');
  /**
   * Whether the app can answer at all, from the same settings read below.
   *
   * True until a payload says otherwise, which is the shape this window had
   * before the question existed: a companion that refused to be typed into for
   * the first frame of every launch would be a box that looks broken, and a
   * question typed in that moment is answered by the same refusal it would have
   * met a second later.
   */
  const [canAnswer, setCanAnswer] = useState(true);
  /*
   * How much of the conversation floats above the moss, and how the window
   * behaves — the user's answers from Settings, which is in the *other* window.
   * Seeded with the defaults so the first paint is the shape this window always
   * had rather than an empty frame waiting on an IPC round trip.
   */
  const [settings, setSettings] = useState<CompanionSettings>(
    defaultCompanionSettings,
  );
  const column = useRef<HTMLDivElement>(null);
  /*
   * Read inside the mouse listener, which is registered once. Without this the
   * listener would close over the first render's settings forever, and turning
   * click-through off would go on being reported as on.
   */
  const clickThrough = useRef(settings.clickThrough);
  clickThrough.current = settings.clickThrough;

  const busy = agent.busy;

  useEffect(() => {
    let cancelled = false;
    const read = async (): Promise<void> => {
      try {
        const {settings: loaded} = await window.marimo.call('settings.get', {});
        if (!cancelled) {
          setSettings(loaded.companion);
          /*
           * The one thing this window does about the app being unable to
           * answer: its ask bar goes quiet. The moss has no room for a setup
           * flow of its own, and a chat bar under a companion that cannot reply
           * is the same dead end the main window stopped offering.
           */
          setCanAnswer(loaded.modelReady);
        }
      } catch {
        // The defaults are what this window showed before any of this was
        // adjustable, so a failed read is a pet that works rather than one that
        // refuses to draw.
      }
    };
    void read();
    const off = window.marimo.onEvent((event) => {
      if (event.type === 'companion.changed') {
        setSettings(event.settings);
      }
    });
    return () => {
      cancelled = true;
      off();
    };
  }, []);

  /*
   * Reports whether the pointer is over anything. `closest` rather than a
   * per-element handler, because the answer has to be right for everything
   * inside a bubble as well — a link, a code block, a copy button.
   *
   * With click-through off the answer is always "the window has the mouse",
   * which is what the setting means: an ordinary small window over whatever is
   * behind it. Sending `over: true` rather than not sending at all is what keeps
   * the main process's view of the window in step if the setting is turned back
   * on later.
   */
  useEffect(() => {
    const report = (event: MouseEvent): void => {
      const target = event.target as Element | null;
      const over =
        !clickThrough.current ||
        target?.closest('.pet, .pet-input, .pet-bubble, .pet-gate') != null;
      void window.marimo
        .call('companion.pointer', {over, enabled: clickThrough.current})
        .catch(() => undefined);
    };
    window.addEventListener('mousemove', report);
    return () => {
      window.removeEventListener('mousemove', report);
    };
  }, []);

  /*
   * The last few turns, oldest first. Older ones are in the window, which is
   * where a conversation is for reading; here it is for the answer that just
   * arrived. How many is the user's `visibleMessages`.
   */
  const shown: TranscriptMessage[] = agent.messages.slice(
    -settings.visibleMessages,
  );

  /*
   * The outbox is in the dependencies as well as the stored messages: the echo
   * is a bubble that has to be visible without scrolling as soon as it exists,
   * and the transcript it will be replaced by has not grown yet.
   */
  useEffect(() => {
    const element = column.current;
    if (element !== null) {
      element.scrollTop = element.scrollHeight;
    }
  }, [shown.length, agent.outbox, agent.live?.text.length]);

  const submit = (): void => {
    const text = draft.trim();
    if (
      text.length === 0 ||
      busy ||
      agent.profile === undefined ||
      agent.sessionId === null
    ) {
      return;
    }
    /*
     * Through the window's own send rather than by posting `chat.send` here.
     * The origin is still the one extra fact this turn needs — asked at the
     * moss, the agent answers more briefly than the window, and the window keeps
     * answering at its own length — but passing it in buys the local echo that
     * puts the question on screen the moment it is asked, which is the same
     * thing the window does. A rejected call is reported the way `useAgent`
     * reports its own, as the error line in the column above.
     */
    void agent.send(text, 'pet');
    setDraft('');
  };

  return (
    <div className="pet">
      <div className="pet-column" ref={column}>
        {shown.map((message) => (
          <div
            key={message.id}
            className={`pet-bubble pet-${message.role}`}
          >
            {message.role === 'assistant' ? (
              <Markdown text={message.text} />
            ) : (
              message.text
            )}
          </div>
        ))}

        {agent.outbox !== null && (
          <div className="pet-bubble pet-user">{agent.outbox}</div>
        )}

        {agent.live !== null && agent.live.text.length > 0 && (
          <div className="pet-bubble pet-assistant">
            <Markdown text={agent.live.text} />
          </div>
        )}

        {busy && (agent.live?.text.length ?? 0) === 0 && (
          <div className="pet-bubble pet-assistant pet-thinking" aria-label="Working">
            <span />
            <span />
            <span />
          </div>
        )}

        {/*
          A gate is the one thing worth interrupting for — an unattended run that
          stops on one will not proceed and will not give up — so the companion
          shows it rather than leaving the answer to be found in the window.
        */}
        {agent.pending.map((gate) => {
          const copy = gateCopy(gate);
          /*
           * The bubble is small, so it names the action and the one thing it is
           * about rather than the whole card the window draws — the first line
           * of a preview, not a file's contents.
           */
          const line = copy.hint ?? copy.primary?.split('\n')[0] ?? '';
          return (
            <div className="pet-bubble pet-gate" key={gate.callId}>
              <strong>{copy.heading}</strong>
              <span className="pet-gate-hint">{line}</span>
              <div className="pet-gate-actions">
                <button
                  type="button"
                  className="pet-button"
                  onClick={() => {
                    void agent.decide(gate.callId, false);
                  }}
                >
                  Deny
                </button>
                <button
                  type="button"
                  className="pet-button pet-button-go"
                  onClick={() => {
                    void agent.decide(gate.callId, true);
                  }}
                >
                  Allow
                </button>
              </div>
            </div>
          );
        })}

        {agent.error !== null && (
          <div className="pet-bubble pet-error">{agent.error}</div>
        )}
      </div>

      {/*
        The moss, and the handle for moving the window. Dragging is the window's
        own gesture — `-webkit-app-region` in the stylesheet — rather than a
        mousedown handler, because the OS already knows how to move a window and
        reimplementing it is how a drag comes to feel wrong.

        It sits below the conversation and above the bar, which is the order the
        three are read in: ask at the bottom, the answer appears above the pet
        that gave it.
      */}
      <div className="pet-moss" title="Drag to move">
        <img src="./marimo-logo.png" alt="Marimo Bot" draggable={false} />
        {/*
          The same dot the window's Settings entry carries, on the surface a
          casual user actually leaves open: the moss is the thing on screen all
          day, and a suggestion that arrives while nobody is in the window is
          exactly the case this is for. Not a badge with a number — the pet is too
          small for one, and there is nothing here that needs acting on now.
        */}
        {agent.memoryWaiting > 0 && (
          <span
            className="pet-dot"
            role="status"
            aria-label="Something worth remembering is waiting"
          />
        )}
        <div className="pet-hover-actions">
          <Copy text={lastAnswer(shown, agent.live?.text)} what="last answer" />
          {/*
            The same note the window offers, for the same reason it is worth
            having at all — and offered only once the answer has stopped
            arriving. A turn still streaming has no stored message to record
            against, and an answer halfway written is not one to judge.
          */}
          {!busy && lastStoredAnswer(shown) !== undefined && (
            <button
              type="button"
              className="pet-note"
              onClick={() => {
                const answer = lastStoredAnswer(shown);
                if (answer !== undefined) {
                  void agent.noteCorrection(answer);
                }
              }}
            >
              Not quite
            </button>
          )}
        </div>
      </div>

      <div className="pet-bar">
        {/*
          New conversation, at the leading edge of the bar — the one control
          this window has beyond asking, and the one a companion needs: the
          thread it shares can be long, and "start again" should not mean
          opening the window you were avoiding.

          Disabled during a turn, which the window's own New button is not. The
          reason is the shape of this window: it shows the newest few bubbles
          and nothing else, so switching conversations mid-turn would hide the
          answer being written with nothing left on screen to say where it
          went. Once the turn ends the button is back, and the answer is in the
          window.
        */}
        <button
          type="button"
          className="pet-new"
          aria-label="New chat"
          title="New chat"
          disabled={busy || agent.profile === undefined}
          onClick={() => {
            void agent.newSession();
          }}
        >
          +
        </button>
        <input
          className="pet-input"
          value={draft}
          placeholder={
            !canAnswer
              ? 'Pick a provider first'
              : busy
                ? 'Working…'
                : 'Ask Marimo Bot…'
          }
          aria-label="Message"
          title={
            canAnswer
              ? undefined
              : 'Marimo Bot has no provider yet. Settings, in the main window, is where one is chosen.'
          }
          disabled={!canAnswer}
          onChange={(event) => {
            setDraft(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              submit();
            }
            if (event.key === 'Escape') {
              event.currentTarget.blur();
            }
          }}
        />
        {busy ? (
          <button
            type="button"
            className="pet-send"
            aria-label="Stop"
            onClick={() => {
              void agent.stop();
            }}
          >
            ■
          </button>
        ) : (
          <button
            type="button"
            className="pet-send"
            aria-label="Send"
            disabled={!canAnswer || draft.trim().length === 0}
            onClick={submit}
          >
            ↑
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * The most recent answer the agent *finished*, for the correction button.
 *
 * Separate from `lastAnswer` because the two want different things: Copy should
 * offer whatever is on screen, including a half-written answer, while a
 * correction has to be recorded against a stored message with an id.
 */
function lastStoredAnswer(
  messages: readonly TranscriptMessage[],
): TranscriptMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === 'assistant' && message.text.length > 0) {
      return message;
    }
  }
  return undefined;
}

/** The most recent thing the agent said, for the copy button. */
function lastAnswer(
  messages: readonly TranscriptMessage[],
  live: string | undefined,
): string {
  if (live !== undefined && live.length > 0) {
    return live;
  }
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === 'assistant' && message.text.length > 0) {
      return message.text;
    }
  }
  return '';
}
