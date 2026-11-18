/**
 * The speaking half of spoken replies.
 *
 * The turn already finished; what is left is turning its stored text into audio
 * and playing it in the window that asked. Three details matter:
 *
 * - **The originating surface only.** The window and the pet share a
 *   conversation, so both receive `turn.completed`. The origin travels on that
 *   event — the stored log does not carry it — and each surface speaks only the
 *   turns it started. Two voices reading one answer is a bug you hear.
 * - **The answer is cleaned before it is sent.** `toSpeech` removes fences,
 *   tables and URLs; the host caps the length and reports the cap.
 * - **A failed voice is quiet.** The text is already on screen; a spoken reply
 *   that could not be made is a missing convenience, not a failed turn. The
 *   Settings card is where the model's own problems are explained.
 *
 * One request per turn, not one per sentence: a local model synthesises a short
 * reply in about a second, and the old chunked pipeline existed to start sooner
 * over a network endpoint. The stop button and a new turn are the two ways a
 * playback ends early.
 */
import {useCallback, useEffect, useRef, useState} from 'react';

import {toSpeech} from '../speech.js';

export interface SpokenReply {
  speaking: boolean;
  stop: () => void;
}

/**
 * A request that never rejects, so a playback the user stops before it starts
 * cannot become an unhandled rejection.
 */
type Outcome =
  | {
      ok: true;
      audio: {wavBase64: string; sampleRate: number; truncated: boolean};
    }
  | {ok: false; failure: unknown};

export function useSpokenReplies(options: {
  enabled: boolean;
  surface: 'window' | 'pet';
  turn: {id: string; text: string; origin?: 'window' | 'pet'} | null;
}): SpokenReply {
  const [speaking, setSpeaking] = useState(false);
  const audioRef = useRef<HTMLAudioElement | undefined>(undefined);
  /**
   * Which turn has been spoken. A re-render with the same last turn must not
   * speak it again; a new turn must.
   */
  const spoken = useRef<string | undefined>(undefined);
  /**
   * Which playback owns the state. Incremented by `stop`, by a new turn and by
   * a toggle-off, so an awaited request from an abandoned run can tell it has
   * been abandoned and must not start playing.
   */
  const run = useRef(0);
  /** Whether the last observed enabled state was on, for the toggle edge. */
  const wasEnabled = useRef(options.enabled);

  const stop = useCallback((): void => {
    run.current += 1;
    const audio = audioRef.current;
    audioRef.current = undefined;
    if (audio !== undefined) {
      audio.pause();
      audio.src = '';
    }
    setSpeaking(false);
  }, []);

  /*
   * Turning speech off stops what is playing. It also marks the answer already
   * on screen as spoken, so turning the switch back on does not read the last
   * answer aloud as if it were new.
   */
  useEffect(() => {
    if (!options.enabled && wasEnabled.current) {
      stop();
      if (options.turn !== null) {
        spoken.current = options.turn.id;
      }
    }
    wasEnabled.current = options.enabled;
  }, [options.enabled, options.turn, stop]);

  useEffect(() => {
    const turn = options.turn;
    if (
      !options.enabled ||
      turn === null ||
      turn.origin !== options.surface ||
      spoken.current === turn.id
    ) {
      return;
    }
    const text = toSpeech(turn.text);
    if (text.trim().length === 0) {
      return;
    }
    spoken.current = turn.id;
    const session = run.current + 1;
    run.current = session;

    const request = window.marimo.call('speech.speak', {text}).then(
      (audio): Outcome => ({ok: true, audio}),
      (failure): Outcome => ({ok: false, failure}),
    );

    void request
      .then(async (outcome) => {
        if (run.current !== session) {
          return;
        }
        if (!outcome.ok) {
          // Quiet on purpose: the answer is on screen, and the Settings card
          // explains a missing or broken model.
          return;
        }
        const audio = new Audio(
          `data:audio/wav;base64,${outcome.audio.wavBase64}`,
        );
        audioRef.current = audio;
        setSpeaking(true);
        try {
          await audio.play();
        } catch {
          if (audioRef.current === audio) {
            audioRef.current = undefined;
          }
          setSpeaking(false);
          return;
        }
        if (run.current !== session) {
          audio.pause();
          return;
        }
        await new Promise<void>((resolve) => {
          audio.onended = () => {
            resolve();
          };
          audio.onerror = () => {
            resolve();
          };
        });
        if (run.current !== session) {
          return;
        }
        if (audioRef.current === audio) {
          audioRef.current = undefined;
        }
        setSpeaking(false);
      })
      .catch(() => {
        if (run.current === session) {
          setSpeaking(false);
        }
      });

    return () => {
      stop();
    };
  }, [options.enabled, options.surface, options.turn, stop]);

  return {speaking, stop};
}
