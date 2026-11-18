/**
 * The speaking half of spoken replies.
 *
 * The turn already finished; what is left is turning its stored text into audio
 * and playing it in the window that asked. Four details matter:
 *
 * - **The originating surface only.** The window and the pet share a
 *   conversation, so both receive `turn.completed`. The origin travels on that
 *   event — the stored log does not carry it — and each surface speaks only the
 *   turns it started. Two voices reading one answer is a bug you hear.
 * - **A reply is a stream of sentences.** The host synthesises sentence N+1
 *   while sentence N plays; this hook schedules each chunk at the previous
 *   chunk's end, so the joins do not click or pause.
 * - **Stop is total.** Pressing Stop, starting another answer or turning speech
 *   off marks the utterance cancelled at the host and stops every scheduled
 *   source here. A chunk already in flight is ignored because its id no longer
 *   matches.
 * - **A failed voice is quiet.** The text is already on screen; a spoken reply
 *   that could not be made is a missing convenience, not a failed turn. The
 *   Settings card is where the model's own problems are explained.
 */
import {useCallback, useEffect, useRef, useState} from 'react';

import {isBargeIn} from '../barge-in.js';
import {toSpeech} from '../speech.js';
import {SpeechPlayer} from '../speech-player.js';

export interface SpokenReply {
  speaking: boolean;
  /** The message or turn being spoken, for the per-message Stop button. */
  speakingId: string | null;
  stop: () => void;
  /**
   * Speak any text on demand. `id` is what the message's Speak/Stop button
   * compares; `agentId` lets the host apply that bot's voice and speed.
   */
  speak: (text: string, id?: string, agentId?: string) => Promise<void>;
}

export function useSpokenReplies(options: {
  enabled: boolean;
  surface: 'window' | 'pet';
  turn: {
    id: string;
    text: string;
    origin?: 'window' | 'pet';
    agentId?: string;
  } | null;
}): SpokenReply {
  const [speaking, setSpeaking] = useState(false);
  const [speakingId, setSpeakingId] = useState<string | null>(null);
  const player = useRef<SpeechPlayer | undefined>(undefined);
  /**
   * Which utterance the renderer is listening to. A chunk is played only while
   * its id matches; that is the whole of the stale-chunk guard.
   */
  const utterance = useRef<string | undefined>(undefined);
  /**
   * Which turn has been spoken. A re-render with the same last turn must not
   * speak it again; a new turn must.
   */
  const spoken = useRef<string | undefined>(undefined);
  /** Which playback owns the state, incremented by every stop and new start. */
  const run = useRef(0);
  const wasEnabled = useRef(options.enabled);

  const playerFor = (): SpeechPlayer => {
    player.current ??= new SpeechPlayer();
    return player.current;
  };

  const finish = useCallback((): void => {
    setSpeaking(false);
    setSpeakingId(null);
  }, []);

  const stop = useCallback((): void => {
    run.current += 1;
    const id = utterance.current;
    utterance.current = undefined;
    if (id !== undefined) {
      void window.marimo
        .call('speech.stop', {utteranceId: id})
        .catch(() => undefined);
    }
    player.current?.stop();
    finish();
  }, [finish]);

  const speak = useCallback(
    async (text: string, id?: string, agentId?: string): Promise<void> => {
      const cleaned = toSpeech(text);
      if (cleaned.trim().length === 0) {
        return;
      }
      stop();
      const session = run.current;
      const utteranceId = crypto.randomUUID();
      utterance.current = utteranceId;
      setSpeaking(true);
      setSpeakingId(id ?? utteranceId);
      try {
        await window.marimo.call('speech.speak', {
          text: cleaned,
          utteranceId,
          ...(agentId === undefined ? {} : {agentId}),
        });
      } catch {
        if (run.current === session && utterance.current === utteranceId) {
          utterance.current = undefined;
          finish();
        }
      }
    },
    [finish, stop],
  );

  /*
   * One listener for the whole hook. The host sends a chunk for whichever
   * surface started the utterance; the id check is what makes the other window
   * ignore it.
   */
  useEffect(() => {
    const off = window.marimo.onEvent((event) => {
      if (isBargeIn(event)) {
        stop();
        return;
      }
      if (event.type !== 'speech.audio') {
        return;
      }
      if (event.utteranceId !== utterance.current) {
        return;
      }
      if (event.error !== undefined || event.wavBase64 === undefined) {
        stop();
        return;
      }
      const final = event.final;
      void playerFor()
        .play(
          event.wavBase64,
          final
            ? () => {
                if (utterance.current === event.utteranceId) {
                  utterance.current = undefined;
                  finish();
                }
              }
            : undefined,
        )
        .catch(() => {
          if (utterance.current === event.utteranceId) {
            stop();
          }
        });
    });
    return () => {
      off();
      player.current?.dispose();
      player.current = undefined;
    };
  }, [finish, stop]);

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

  /*
   * The automatic path: a finished turn for this surface, once. The manual path
   * is the same `speak`, called by a message's Speak button, and it works with
   * the switch off — that is the point of having both.
   */
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
    spoken.current = turn.id;
    void speak(turn.text, turn.id, turn.agentId);
  }, [options.enabled, options.surface, options.turn, speak]);

  /* Unmount is a stop, so a closed window does not keep a voice alive. */
  useEffect(() => {
    return () => {
      stop();
    };
  }, [stop]);

  return {speaking, speakingId, stop, speak};
}
