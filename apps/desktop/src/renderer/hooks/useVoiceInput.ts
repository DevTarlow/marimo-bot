/**
 * The chat surfaces' half of voice input: is it set up, is the microphone free,
 * record, transcribe, hand the text on.
 *
 * The capture hook owns the device; this hook owns the decision of what to do
 * with a finished clip. It also listens for `listen.capture`, because the other
 * window has to grey its microphone while this one is speaking and stop its
 * spoken reply when this one starts.
 *
 * A transcript is accepted only while its recording is still the newest one.
 * The capture is stopped before the IPC call, so a cancel can arrive while the
 * CPU is decoding; when it does, the run number has already moved and the text is
 * dropped rather than typed into a box the person has left.
 */
import {useCallback, useEffect, useRef, useState} from 'react';

import {LISTEN_MAX_SECONDS} from '@marimo/protocol';
import type {
  ListenSettings,
  ListenStatus,
  ListenSurface,
} from '@marimo/protocol';

import {describe} from '../describe.js';
import {TranscriptGate} from '../voice-insert.js';
import {useVoiceCapture} from './useVoiceCapture.js';
import type {CapturedClip} from './useVoiceCapture.js';

export type VoiceInputPhase =
  | 'setup'
  | 'starting'
  | 'recording'
  | 'transcribing'
  | 'remote'
  | 'ready';

export interface VoiceInput {
  phase: VoiceInputPhase;
  level: number;
  elapsedMs: number;
  installed: boolean;
  remoteSurface: ListenSurface | null;
  note: string | null;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  cancel: () => void;
}

export interface UseVoiceInputOptions {
  surface: 'window' | 'pet';
  settings: ListenSettings;
  /** Where a finished transcript goes; inserting or sending is the caller's. */
  onTranscript: (text: string) => void | Promise<void>;
  /** Opens Settings → Voice input when the microphone is not set up. */
  onSetup: () => void;
  /** Stops the local spoken reply synchronously, before the lease is asked for. */
  onBargeIn?: () => void;
}

export function useVoiceInput(options: UseVoiceInputOptions): VoiceInput {
  const [status, setStatus] = useState<ListenStatus | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [transcribing, setTranscribing] = useState(false);
  const [remoteSurface, setRemoteSurface] = useState<ListenSurface | null>(null);
  const gate = useRef(new TranscriptGate());
  const activeId = useRef(0);
  const activeToken = useRef<string | undefined>(undefined);
  const transcriptRef = useRef(options.onTranscript);
  transcriptRef.current = options.onTranscript;
  const setupRef = useRef(options.onSetup);
  setupRef.current = options.onSetup;
  const bargeRef = useRef(options.onBargeIn);
  bargeRef.current = options.onBargeIn;
  const installed = status?.installed ?? false;

  useEffect(() => {
    let cancelled = false;
    const read = async (): Promise<void> => {
      try {
        const next = await window.marimo.call('listen.status', {});
        if (!cancelled) {
          setStatus(next);
        }
      } catch {
        // Same rule: the card is where a broken model is explained.
      }
    };
    void read();
    const off = window.marimo.onEvent((event) => {
      if (event.type === 'listen.installed' || event.type === 'listen.failed') {
        void read();
      } else if (event.type === 'listen.capture') {
        setRemoteSurface((current) => {
          if (event.active) {
            return event.surface === options.surface ? null : event.surface;
          }
          return current === event.surface ? null : current;
        });
      }
    });
    return () => {
      cancelled = true;
      off();
    };
  }, [options.surface]);

  const handleCaptured = useCallback(
    async (captured: CapturedClip): Promise<void> => {
      const id = activeId.current;
      if (!gate.current.accepts(id)) {
        void window.marimo
          .call('listen.cancel', {token: captured.token})
          .catch(() => undefined);
        return;
      }
      activeToken.current = captured.token;
      setTranscribing(true);
      try {
        const result = await window.marimo.call('listen.transcribe', {
          token: captured.token,
          pcm: captured.pcmBase64,
          sampleRate: 16_000,
          clipId: String(id),
        });
        if (!gate.current.accepts(id) || result.cancelled) {
          return;
        }
        if (result.text.trim().length === 0) {
          setNote('I didn’t catch that. Try again a little closer to the mic.');
          return;
        }
        setNote(null);
        await transcriptRef.current(result.text);
      } catch (failure) {
        if (gate.current.accepts(id)) {
          setNote(describe(failure));
        }
        void window.marimo
          .call('listen.cancel', {token: captured.token})
          .catch(() => undefined);
      } finally {
        if (activeToken.current === captured.token) {
          activeToken.current = undefined;
        }
        setTranscribing(false);
      }
    },
    [],
  );

  const capture = useVoiceCapture({
    surface: options.surface,
    deviceId: options.settings.deviceId,
    deviceLabel: options.settings.deviceLabel,
    autoStopOnSilence: options.settings.autoStopOnSilence,
    maxSeconds: LISTEN_MAX_SECONDS,
    onBargeIn: () => bargeRef.current?.(),
    onNotice: (message) => {
      setNote(message);
    },
    onCaptured: handleCaptured,
  });

  const startCapture = capture.start;
  const stopCapture = capture.stop;
  const cancelCapture = capture.cancel;

  const cancel = useCallback((): void => {
    gate.current.cancel();
    activeId.current = 0;
    const token = activeToken.current;
    activeToken.current = undefined;
    if (token !== undefined) {
      void window.marimo
        .call('listen.cancel', {token})
        .catch(() => undefined);
    }
    cancelCapture();
    setTranscribing(false);
    setNote(null);
  }, [cancelCapture]);

  /*
   * Turning the feature off while a recording is open cancels it. The main
   * process does the same from its side; this is the half that stops the local
   * tracks immediately rather than waiting for the event.
   */
  useEffect(() => {
    if (!options.settings.enabled) {
      cancel();
    }
  }, [options.settings.enabled, cancel]);

  const start = useCallback(async (): Promise<void> => {
    if (!options.settings.enabled || !installed) {
      setupRef.current();
      return;
    }
    if (transcribing) {
      return;
    }
    if (remoteSurface !== null) {
      setNote('The other window is using the microphone.');
      return;
    }
    setNote(null);
    activeId.current = gate.current.begin();
    await startCapture();
  }, [
    installed,
    options.settings.enabled,
    remoteSurface,
    startCapture,
    transcribing,
  ]);

  const stop = useCallback(async (): Promise<void> => {
    await stopCapture();
  }, [stopCapture]);

  const phase: VoiceInputPhase = capture.recording
    ? 'recording'
    : capture.starting
      ? 'starting'
      : transcribing
        ? 'transcribing'
        : !options.settings.enabled || !installed
          ? 'setup'
          : remoteSurface !== null
            ? 'remote'
            : 'ready';

  return {
    phase,
    level: capture.level,
    elapsedMs: capture.elapsedMs,
    installed,
    remoteSurface,
    note,
    start,
    stop,
    cancel,
  };
}
