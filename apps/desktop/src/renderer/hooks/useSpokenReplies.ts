/**
 * The speaking half of voice mode.
 *
 * The turn already finished; what is left is turning its stored text into a WAV
 * and playing it in the window that asked. Three details matter:
 *
 * - **The originating surface only.** The window and the pet share a
 *   conversation, so both receive `turn.completed`. The origin travels on that
 *   event — the stored log does not carry it — and each surface speaks only the
 *   turns it started. Two voices reading one answer is a bug you hear.
 * - **The answer is cleaned before it is sent.** `toSpeech` removes fences,
 *   tables and URLs; the host caps the length. A model that formats by habit
 *   should not turn a sentence into a minute of punctuation.
 * - **A failed voice is quiet.** The text is already on screen; a spoken reply
 *   that could not be made is a missing convenience, not a failed turn. The hook
 *   reports it through `onProblem` and stays out of the transcript.
 */
import {useCallback, useEffect, useRef, useState} from 'react';

import type {SpeechLanguage, SpeechVoice} from '@marimo/protocol';

import {toSpeech} from '../speech.js';
import {describe} from '../describe.js';

export interface SpokenReply {
  speaking: boolean;
  stop: () => void;
}

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
  const onProblemRef = useRef(options.onProblem);
  onProblemRef.current = options.onProblem;

  const stop = useCallback((): void => {
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
    const text = toSpeech(turn.text);
    let cancelled = false;
    void (async () => {
      try {
        const result = await window.marimo.call('speech.speak', {
          text,
          ...(options.language === undefined
            ? {}
            : {language: options.language}),
          ...(options.voice === undefined ? {} : {voice: options.voice}),
        });
        if (cancelled) {
          return;
        }
        const audio = new Audio(
          `data:audio/wav;base64,${result.wavBase64}`,
        );
        audioRef.current = audio;
        audio.onended = () => {
          if (audioRef.current === audio) {
            audioRef.current = undefined;
            setSpeaking(false);
          }
        };
        audio.onerror = () => {
          if (audioRef.current === audio) {
            audioRef.current = undefined;
            setSpeaking(false);
          }
        };
        setSpeaking(true);
        await audio.play();
        if (result.truncated) {
          onProblemRef.current?.(
            'That answer was longer than the spoken version, so only the ' +
              'start was read aloud.',
          );
        }
      } catch (failure) {
        if (!cancelled) {
          setSpeaking(false);
          onProblemRef.current?.(
            `Could not speak that answer: ${describe(failure)}`,
          );
        }
      }
    })();
    return () => {
      cancelled = true;
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
