/**
 * The speaking half of voice mode.
 *
 * The turn already finished; what is left is turning its stored text into audio
 * and playing it in the window that asked. Four details matter:
 *
 * - **The originating surface only.** The window and the pet share a
 *   conversation, so both receive `turn.completed`. The origin travels on that
 *   event — the stored log does not carry it — and each surface speaks only the
 *   turns it started. Two voices reading one answer is a bug you hear.
 * - **The answer is cleaned before it is sent.** `toSpeech` removes fences,
 *   tables and URLs; the host caps the length. A model that formats by habit
 *   should not turn a sentence into a minute of punctuation.
 * - **The first sentence does not wait for the last.** A reply is split into
 *   sentence-sized pieces. The first is synthesized immediately and played; the
 *   next is requested while the current one is playing. A long answer used to be
 *   one request whose audio began only after the whole WAV existed, which is
 *   exactly the wait a person notices.
 * - **A failed voice is quiet.** The text is already on screen; a spoken reply
 *   that could not be made is a missing convenience, not a failed turn. The hook
 *   reports it through `onProblem` and stays out of the transcript.
 */
import {useCallback, useEffect, useRef, useState} from 'react';

import type {SpeechLanguage, SpeechVoice} from '@marimo/protocol';

import {speechChunks, toSpeech} from '../speech.js';
import {describe} from '../describe.js';

export interface SpokenReply {
  speaking: boolean;
  stop: () => void;
}

/** The answer one `speech.speak` call returns. */
interface SpokenAudio {
  wavBase64: string;
  sampleRate: number;
  truncated: boolean;
}

/**
 * A request that never rejects, so a prefetched chunk the user stops before
 * reaching cannot become an unhandled rejection.
 */
type Outcome = {ok: true; audio: SpokenAudio} | {ok: false; failure: unknown};

export function useSpokenReplies(options: {
  enabled: boolean;
  surface: 'window' | 'pet';
  turn: {id: string; text: string; origin?: 'window' | 'pet'} | null;
  language?: SpeechLanguage;
  voice?: SpeechVoice;
  onProblem?: (message: string) => void;
}): SpokenReply {
  const [speaking, setSpeaking] = useState(false);
  const audioRef = useRef<HTMLAudioElement | undefined>(undefined);
  const spoken = useRef<string | undefined>(undefined);
  /**
   * Which playback owns the state. Incremented by `stop` and by a new turn, so
   * an awaited request from an abandoned run can tell it has been abandoned and
   * must not start the next piece or turn the speaker back on.
   */
  const run = useRef(0);
  /** Wakes the current chunk's wait when the user stops the playback. */
  const wake = useRef<(() => void) | undefined>(undefined);
  const onProblemRef = useRef(options.onProblem);
  onProblemRef.current = options.onProblem;

  const stop = useCallback((): void => {
    run.current += 1;
    wake.current?.();
    wake.current = undefined;
    const audio = audioRef.current;
    audioRef.current = undefined;
    if (audio !== undefined) {
      audio.pause();
      audio.src = '';
    }
    setSpeaking(false);
  }, []);

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
    const plan = speechChunks(toSpeech(turn.text));
    if (plan.chunks.length === 0) {
      return;
    }

    const session = run.current + 1;
    run.current = session;
    const stopped = new Promise<void>((resolve) => {
      wake.current = resolve;
    });
    let prefetch: Promise<Outcome> | undefined;
    let reportedTruncation = false;
    /** A failure already reported; do not add a truncation note after it. */
    let gaveUp = false;

    const request = (index: number): Promise<Outcome> =>
      window.marimo
        .call('speech.speak', {
          text: plan.chunks[index] ?? '',
          ...(options.language === undefined
            ? {}
            : {language: options.language}),
          ...(options.voice === undefined ? {} : {voice: options.voice}),
        })
        .then(
          (audio): Outcome => ({ok: true, audio}),
          (failure: unknown): Outcome => ({ok: false, failure}),
        );

    const speakFrom = async (index: number): Promise<void> => {
      if (index >= plan.chunks.length || run.current !== session) {
        return;
      }
      const current = prefetch ?? request(index);
      prefetch = undefined;
      const outcome = await current;
      if (run.current !== session) {
        return;
      }
      if (!outcome.ok) {
        gaveUp = true;
        setSpeaking(false);
        onProblemRef.current?.(
          `Could not speak that answer: ${describe(outcome.failure)}`,
        );
        return;
      }

      const audio = new Audio(
        `data:audio/wav;base64,${outcome.audio.wavBase64}`,
      );
      let failed = false;
      const ended = new Promise<void>((resolve) => {
        audio.onended = () => {
          resolve();
        };
        audio.onerror = () => {
          failed = true;
          resolve();
        };
      });
      audioRef.current = audio;
      setSpeaking(true);
      try {
        await audio.play();
      } catch (failure) {
        gaveUp = true;
        if (audioRef.current === audio) {
          audioRef.current = undefined;
        }
        setSpeaking(false);
        onProblemRef.current?.(
          `Could not speak that answer: ${describe(failure)}`,
        );
        return;
      }
      if (run.current !== session) {
        audio.pause();
        return;
      }
      /*
       * Start the next request only after this one's audio is playing, so the
       * first piece is never competing with the second for the processor. It
       * finishes during playback, so the gap between pieces is the network and
       * synth time minus the length of the piece the person is hearing.
       */
      if (index + 1 < plan.chunks.length) {
        prefetch = request(index + 1);
      }

      await Promise.race([ended, stopped]);
      if (run.current !== session) {
        return;
      }
      if (failed) {
        gaveUp = true;
        if (audioRef.current === audio) {
          audioRef.current = undefined;
        }
        setSpeaking(false);
        onProblemRef.current?.('Could not play that answer.');
        return;
      }
      if (audioRef.current === audio) {
        audioRef.current = undefined;
      }
      if (outcome.audio.truncated && !reportedTruncation) {
        reportedTruncation = true;
        onProblemRef.current?.(
          'That answer was longer than the spoken version, so only the ' +
            'start was read aloud.',
        );
      }
      await speakFrom(index + 1);
    };

    void speakFrom(0)
      .then(() => {
        if (run.current !== session) {
          return;
        }
        setSpeaking(false);
        if (plan.truncated && !reportedTruncation && !gaveUp) {
          reportedTruncation = true;
          onProblemRef.current?.(
            'That answer was longer than the spoken version, so only the ' +
              'start was read aloud.',
          );
        }
      })
      .catch((failure: unknown) => {
        if (run.current !== session) {
          return;
        }
        setSpeaking(false);
        onProblemRef.current?.(
          `Could not speak that answer: ${describe(failure)}`,
        );
      });

    return () => {
      stop();
    };
  }, [
    options.enabled,
    options.surface,
    options.turn,
    options.language,
    options.voice,
    stop,
  ]);

  return {speaking, stop};
}
