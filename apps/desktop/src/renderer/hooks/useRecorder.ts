/**
 * Push-to-talk, in the renderer.
 *
 * Chromium owns the microphone and the speech model lives in the main process,
 * so this hook is the bridge: it captures mono PCM, resamples to the model's
 * 16kHz, encodes a WAV and asks the main process to transcribe it. The bytes
 * never touch disk and the recording stops the moment the button is released.
 *
 * A push-to-talk button rather than always-listening, deliberately: the app has
 * no wake word, no voice activity detector and no second model to decide when
 * speech starts, and a microphone that opens on its own is a promise this
 * version cannot keep honestly. The cap is a safety net for a stuck pointer, not
 * the expected length of a question.
 */
import {useCallback, useEffect, useRef, useState} from 'react';

import type {SpeechLanguage} from '@marimo/protocol';

import {
  base64FromBytes,
  encodeWav,
  resample,
} from '../audio.js';
import {describe} from '../describe.js';

/** The model was trained at 16kHz mono; this is not a tuning knob. */
const SAMPLE_RATE = 16_000;

/** A stuck pointer must not record forever. */
const MAX_RECORDING_MS = 60_000;

/** Big enough to keep the main thread out of the capture callback. */
const BUFFER_SIZE = 4096;

export interface VoiceRecorder {
  recording: boolean;
  /** A transcription is in flight; the button should not start another. */
  busy: boolean;
  start: () => Promise<void>;
  stop: () => Promise<void>;
}

export function useRecorder(options: {
  language?: SpeechLanguage;
  onText: (text: string) => void;
  onError: (message: string) => void;
  /**
   * Starts the voice model while the person is still speaking.
   *
   * Loading the audio model is the slowest part of the first microphone press;
   * the turn needs it anyway, and the recording gives it something to overlap
   * with. A failure is the caller's to ignore — `speech.transcribe` reports the
   * real one.
   */
  onWarm?: () => void;
}): VoiceRecorder {
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  const recordingRef = useRef(false);
  /** A release before `getUserMedia` answered must still stop the capture. */
  const stopRequested = useRef(false);
  const busyRef = useRef(false);
  const streamRef = useRef<MediaStream | undefined>(undefined);
  const contextRef = useRef<AudioContext | undefined>(undefined);
  const processorRef = useRef<ScriptProcessorNode | undefined>(undefined);
  const sourceRef = useRef<MediaStreamAudioSourceNode | undefined>(undefined);
  const chunksRef = useRef<Float32Array[]>([]);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const languageRef = useRef(options.language);
  languageRef.current = options.language;
  const onTextRef = useRef(options.onText);
  onTextRef.current = options.onText;
  const onErrorRef = useRef(options.onError);
  onErrorRef.current = options.onError;
  const onWarmRef = useRef(options.onWarm);
  onWarmRef.current = options.onWarm;

  const cleanup = useCallback((): number => {
    if (timerRef.current !== undefined) {
      clearTimeout(timerRef.current);
      timerRef.current = undefined;
    }
    setRecording(false);
    recordingRef.current = false;
    const processor = processorRef.current;
    processorRef.current = undefined;
    if (processor !== undefined) {
      try {
        processor.disconnect();
        processor.onaudioprocess = null;
      } catch {
        // A context already closed by a device change is not a second error.
      }
    }
    const source = sourceRef.current;
    sourceRef.current = undefined;
    if (source !== undefined) {
      try {
        source.disconnect();
      } catch {
        // Same.
      }
    }
    const stream = streamRef.current;
    streamRef.current = undefined;
    if (stream !== undefined) {
      for (const track of stream.getTracks()) {
        track.stop();
      }
    }
    const context = contextRef.current;
    contextRef.current = undefined;
    const rate = context?.sampleRate ?? SAMPLE_RATE;
    if (context !== undefined) {
      void context.close().catch(() => undefined);
    }
    return rate;
  }, []);

  const start = useCallback(async (): Promise<void> => {
    if (recordingRef.current || busyRef.current) {
      return;
    }
    stopRequested.current = false;
    const media = navigator.mediaDevices;
    if (media === undefined) {
      onErrorRef.current('This window has no microphone access.');
      return;
    }
    // The engine loads while the person speaks; transcribe waits for it either
    // way, and this is the only part of the wait that can overlap with them.
    onWarmRef.current?.();
    try {
      const stream = await media.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      const AudioContextImpl =
        window.AudioContext ??
        (window as unknown as {webkitAudioContext?: typeof AudioContext})
          .webkitAudioContext;
      if (AudioContextImpl === undefined) {
        for (const track of stream.getTracks()) {
          track.stop();
        }
        onErrorRef.current('This window cannot capture audio.');
        return;
      }
      const context = new AudioContextImpl();
      await context.resume().catch(() => undefined);
      const source = context.createMediaStreamSource(stream);
      const processor = context.createScriptProcessor(BUFFER_SIZE, 1, 1);
      const silent = context.createGain();
      silent.gain.value = 0;
      chunksRef.current = [];
      processor.onaudioprocess = (event) => {
        const data = event.inputBuffer.getChannelData(0);
        chunksRef.current.push(new Float32Array(data));
      };
      source.connect(processor);
      processor.connect(silent);
      silent.connect(context.destination);
      streamRef.current = stream;
      contextRef.current = context;
      sourceRef.current = source;
      processorRef.current = processor;
      if (stopRequested.current) {
        // The button was released while the permission prompt was open. The
        // stream and its context are torn down without transcribing silence.
        cleanup();
        return;
      }
      recordingRef.current = true;
      setRecording(true);
      timerRef.current = setTimeout(() => {
        void stopRef.current();
      }, MAX_RECORDING_MS);
    } catch (failure) {
      onErrorRef.current(
        `The microphone is not available: ${describe(failure)}`,
      );
    }
  }, []);

  const stopRef = useRef<() => Promise<void>>(async () => undefined);

  const stop = useCallback(async (): Promise<void> => {
    if (!recordingRef.current) {
      stopRequested.current = true;
      return;
    }
    const sampleRate = cleanup();
    busyRef.current = true;
    setBusy(true);
    try {
      const chunks = chunksRef.current;
      chunksRef.current = [];
      const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
      if (total === 0) {
        onErrorRef.current('Nothing was recorded.');
        return;
      }
      const merged = new Float32Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.length;
      }
      const wav = encodeWav(
        resample(merged, sampleRate, SAMPLE_RATE),
        SAMPLE_RATE,
      );
      const {text} = await window.marimo.call('speech.transcribe', {
        audioBase64: base64FromBytes(wav),
        ...(languageRef.current === undefined
          ? {}
          : {language: languageRef.current}),
      });
      if (text.trim().length > 0) {
        onTextRef.current(text.trim());
      } else {
        onErrorRef.current('The speech model heard nothing.');
      }
    } catch (failure) {
      onErrorRef.current(describe(failure));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [cleanup]);

  stopRef.current = stop;

  useEffect(() => {
    return () => {
      cleanup();
    };
  }, [cleanup]);

  return {recording, busy, start, stop};
}
