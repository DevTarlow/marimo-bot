/**
 * Opening the microphone, collecting PCM and closing it again.
 *
 * The device belongs to this hook and nowhere else. Every path out — a normal
 * stop, a cancel, a disconnected device, the duration cap, a failed permission,
 * unmounting the window — goes through the same detach, which stops every
 * `MediaStreamTrack` *before* anything awaits. That is what turns the OS
 * microphone indicator off at the moment the recording ends rather than when a
 * transcription finishes.
 *
 * The clip is resampled once, after the tracks are stopped, with Chromium's
 * band-limited `OfflineAudioContext`. The worklet only copies blocks and reports
 * their RMS; the arithmetic that can be tested lives in `voice-audio.ts`.
 */
import {useCallback, useEffect, useRef, useState} from 'react';

import {LISTEN_MAX_SECONDS, LISTEN_MIN_SECONDS} from '@marimo/protocol';
import type {ListenSurface} from '@marimo/protocol';

import workletUrl from '../audio/pcm-worklet.js?url&no-inline';
import {
  concatChunks,
  downsampleLinear,
  int16Base64,
  isSpeech,
  resampleTo16k,
  rmsOf,
  silenceReached,
} from '../voice-audio.js';

/** What one finished recording hands to the caller. */
export interface CapturedClip {
  token: string;
  pcmBase64: string;
  durationMs: number;
}

export interface UseVoiceCaptureOptions {
  surface: ListenSurface;
  deviceId: string | null;
  deviceLabel: string | null;
  autoStopOnSilence: boolean;
  /** Overrides the app-wide 60-second cap; the Settings test uses 10. */
  maxSeconds?: number;
  /** The barge-in: called synchronously before the lease is requested. */
  onBargeIn?: () => void;
  /** A sentence the surface can show; never a stack trace. */
  onNotice?: (message: string) => void;
  /** Called once per finished recording, after the tracks are stopped. */
  onCaptured?: (captured: CapturedClip) => void | Promise<void>;
}

export interface VoiceCapture {
  recording: boolean;
  starting: boolean;
  level: number;
  elapsedMs: number;
  start: () => Promise<void>;
  stop: () => Promise<CapturedClip | null>;
  cancel: () => void;
}

interface Session {
  token: string;
  stream: MediaStream;
  context: AudioContext;
  source: MediaStreamAudioSourceNode;
  node: AudioWorkletNode | ScriptProcessorNode | null;
  chunks: Float32Array[];
  sourceRate: number;
  startedAt: number;
  speechSeen: boolean;
  silentSince: number | undefined;
  lastLevelAt: number;
  closed: boolean;
  elapsedTimer: number;
  maxTimer: number;
}

type Callbacks = Pick<
  UseVoiceCaptureOptions,
  'onBargeIn' | 'onNotice' | 'onCaptured'
>;

export function useVoiceCapture(options: UseVoiceCaptureOptions): VoiceCapture {
  const [recording, setRecording] = useState(false);
  const [starting, setStarting] = useState(false);
  const [level, setLevel] = useState(0);
  const [elapsedMs, setElapsedMs] = useState(0);
  const session = useRef<Session | null>(null);
  const startingRef = useRef(false);
  const stoppingRef = useRef(false);
  const attempt = useRef(0);
  const pendingToken = useRef<string | undefined>(undefined);
  const mounted = useRef(true);
  const callbacks = useRef<Callbacks>({});
  callbacks.current = {
    onBargeIn: options.onBargeIn,
    onNotice: options.onNotice,
    onCaptured: options.onCaptured,
  };
  const config = useRef(options);
  config.current = options;

  const detach = useCallback((current: Session): void => {
    if (current.closed) {
      return;
    }
    current.closed = true;
    clearInterval(current.elapsedTimer);
    clearTimeout(current.maxTimer);
    // The tracks go first: the OS indicator turns off here, not after resample.
    for (const track of current.stream.getTracks()) {
      track.stop();
    }
    current.source.disconnect();
    if (current.node !== null) {
      if ('port' in current.node) {
        current.node.port.onmessage = null;
      } else {
        current.node.onaudioprocess = null;
      }
      current.node.disconnect();
    }
    void current.context.close().catch(() => undefined);
  }, []);

  const cancel = useCallback((): void => {
    attempt.current += 1;
    const pending = pendingToken.current;
    pendingToken.current = undefined;
    const current = session.current;
    session.current = null;
    if (current !== null) {
      detach(current);
      void window.marimo
        .call('listen.cancel', {token: current.token})
        .catch(() => undefined);
    } else if (pending !== undefined) {
      void window.marimo
        .call('listen.cancel', {token: pending})
        .catch(() => undefined);
    }
    if (mounted.current) {
      setRecording(false);
      setStarting(false);
      setLevel(0);
      setElapsedMs(0);
    }
  }, [detach]);

  const stop = useCallback(async (): Promise<CapturedClip | null> => {
    const current = session.current;
    if (current === null || stoppingRef.current) {
      return null;
    }
    stoppingRef.current = true;
    session.current = null;
    const stoppedAt = Date.now();
    detach(current);
    if (mounted.current) {
      setRecording(false);
      setLevel(0);
      setElapsedMs(0);
    }
    try {
      const samples = concatChunks(current.chunks);
      if (samples.length < LISTEN_MIN_SECONDS * 16_000) {
        void window.marimo
          .call('listen.cancel', {token: current.token})
          .catch(() => undefined);
        callbacks.current.onNotice?.(
          'That recording was too short. Hold the microphone a little longer.',
        );
        return null;
      }
      const pcm = await resampleTo16k(samples, current.sourceRate).catch(() =>
        downsampleLinear(samples, current.sourceRate),
      );
      const captured: CapturedClip = {
        token: current.token,
        pcmBase64: int16Base64(pcm),
        durationMs: stoppedAt - current.startedAt,
      };
      stoppingRef.current = false;
      try {
        await callbacks.current.onCaptured?.(captured);
      } catch (failure) {
        callbacks.current.onNotice?.(describe(failure));
      }
      return captured;
    } finally {
      stoppingRef.current = false;
    }
  }, [detach]);

  const stopRef = useRef(stop);
  stopRef.current = stop;
  const cancelRef = useRef(cancel);
  cancelRef.current = cancel;

  const start = useCallback(async (): Promise<void> => {
    if (startingRef.current || session.current !== null) {
      return;
    }
    startingRef.current = true;
    const run = attempt.current + 1;
    attempt.current = run;
    if (mounted.current) {
      setStarting(true);
    }
    callbacks.current.onBargeIn?.();
    let token: string | undefined;
    let stream: MediaStream | undefined;
    let context: AudioContext | undefined;
    try {
      const grant = await window.marimo.call('listen.beginCapture', {
        surface: config.current.surface,
      });
      if (attempt.current !== run) {
        if (grant.token !== undefined) {
          void window.marimo
            .call('listen.cancel', {token: grant.token})
            .catch(() => undefined);
        }
        return;
      }
      if (!grant.granted || grant.token === undefined) {
        callbacks.current.onNotice?.(grantNotice(grant.reason, grant.holder));
        return;
      }
      token = grant.token;
      pendingToken.current = token;
      stream = await openStream(
        config.current.deviceId,
        config.current.deviceLabel,
        (message) => callbacks.current.onNotice?.(message),
      );
      if (attempt.current !== run) {
        for (const track of stream.getTracks()) {
          track.stop();
        }
        return;
      }
      context = new AudioContext();
      await context.resume().catch(() => undefined);
      const source = context.createMediaStreamSource(stream);
      const chunks: Float32Array[] = [];
      const current: Session = {
        token,
        stream,
        context,
        source,
        // Assigned immediately below; the block callback closes over `current`.
        node: null,
        chunks,
        sourceRate: context.sampleRate,
        startedAt: Date.now(),
        speechSeen: false,
        silentSince: undefined,
        lastLevelAt: 0,
        closed: false,
        elapsedTimer: 0,
        maxTimer: 0,
      };
      const onBlock = (pcm: Float32Array, rms: number): void => {
        if (current.closed || session.current !== current) {
          return;
        }
        chunks.push(pcm);
        const now = Date.now();
        if (now - current.lastLevelAt > 80) {
          current.lastLevelAt = now;
          if (mounted.current) {
            setLevel(Math.min(1, rms / 0.15));
          }
        }
        if (config.current.autoStopOnSilence) {
          if (isSpeech(rms)) {
            current.speechSeen = true;
            current.silentSince = undefined;
          } else if (current.speechSeen && current.silentSince === undefined) {
            current.silentSince = now;
          }
          const elapsed = now - current.startedAt;
          const silentMs =
            current.silentSince === undefined ? 0 : now - current.silentSince;
          if (
            silenceReached({
              speechSeen: current.speechSeen,
              silentMs,
              elapsedMs: elapsed,
            })
          ) {
            callbacks.current.onNotice?.('Stopped after a pause.');
            void stopRef.current();
          }
        }
      };
      const node = await createCaptureNode(context, onBlock);
      current.node = node;
      if (attempt.current !== run) {
        detach(current);
        return;
      }
      session.current = current;
      source.connect(node);
      node.connect(context.destination);
      for (const track of stream.getAudioTracks()) {
        track.onended = () => {
          if (current.closed) {
            return;
          }
          callbacks.current.onNotice?.('The microphone disconnected.');
          void stopRef.current();
        };
      }
      const maxSeconds = config.current.maxSeconds ?? LISTEN_MAX_SECONDS;
      current.elapsedTimer = window.setInterval(() => {
        if (!current.closed && mounted.current) {
          setElapsedMs(Date.now() - current.startedAt);
        }
      }, 200);
      current.maxTimer = window.setTimeout(() => {
        if (current.closed) {
          return;
        }
        callbacks.current.onNotice?.(
          `The ${String(maxSeconds)}-second limit was reached.`,
        );
        void stopRef.current();
      }, maxSeconds * 1000);
      pendingToken.current = undefined;
      if (mounted.current) {
        setRecording(true);
        setElapsedMs(0);
        setLevel(0);
      }
    } catch (failure) {
      for (const track of stream?.getTracks() ?? []) {
        track.stop();
      }
      if (context !== undefined) {
        void context.close().catch(() => undefined);
      }
      callbacks.current.onNotice?.(mediaError(failure));
      if (token !== undefined) {
        void window.marimo
          .call('listen.cancel', {token})
          .catch(() => undefined);
      }
    } finally {
      startingRef.current = false;
      if (mounted.current) {
        setStarting(false);
      }
    }
  }, [detach]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      cancelRef.current();
    };
  }, []);

  /*
   * The main process owns the lease, so it can end a capture this hook did not
   * stop — the 70-second safety timer, a settings write that turned voice input
   * off, or another surface taking over. The event is how the renderer learns to
   * stop the tracks it owns; without it the OS microphone would stay open for a
   * recording the host has already forgotten.
   */
  useEffect(() => {
    return window.marimo.onEvent((event) => {
      if (
        event.type === 'listen.capture' &&
        !event.active &&
        event.surface === options.surface &&
        (session.current !== null || pendingToken.current !== undefined)
      ) {
        cancelRef.current();
      }
    });
  }, [options.surface]);

  return {recording, starting, level, elapsedMs, start, stop, cancel};
}

async function createCaptureNode(
  context: AudioContext,
  onBlock: (pcm: Float32Array, rms: number) => void,
): Promise<AudioWorkletNode | ScriptProcessorNode> {
  try {
    if (context.audioWorklet !== undefined) {
      await context.audioWorklet.addModule(workletUrl);
      const node = new AudioWorkletNode(context, 'marimo-pcm-capture', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        channelCount: 1,
        channelCountMode: 'explicit',
      });
      node.port.onmessage = (event: MessageEvent) => {
        const data = event.data as {pcm?: Float32Array; rms?: number};
        if (data.pcm instanceof Float32Array) {
          onBlock(data.pcm, data.rms ?? rmsOf(data.pcm));
        }
      };
      return node;
    }
  } catch {
    // An AudioWorklet that cannot load is a fallback, not a failed recording.
  }
  const processor = context.createScriptProcessor(4096, 1, 1);
  processor.onaudioprocess = (event) => {
    const input = event.inputBuffer.getChannelData(0);
    const copy = new Float32Array(input.length);
    copy.set(input);
    event.outputBuffer.getChannelData(0).fill(0);
    onBlock(copy, rmsOf(copy));
  };
  return processor;
}

async function openStream(
  deviceId: string | null,
  deviceLabel: string | null,
  onFallback: (message: string) => void,
): Promise<MediaStream> {
  if (navigator.mediaDevices?.getUserMedia === undefined) {
    throw new Error('This window cannot reach a microphone.');
  }
  const constraints: MediaTrackConstraints = {
    channelCount: 1,
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  };
  if (deviceId !== null) {
    try {
      return await navigator.mediaDevices.getUserMedia({
        audio: {...constraints, deviceId: {exact: deviceId}},
        video: false,
      });
    } catch (failure) {
      if (!isMissingDevice(failure)) {
        throw failure;
      }
      onFallback(
        `Your saved microphone${deviceLabel === null ? '' : ` (${deviceLabel})`} ` +
          'is not connected; using the system default.',
      );
    }
  }
  return await navigator.mediaDevices.getUserMedia({
    audio: constraints,
    video: false,
  });
}

function isMissingDevice(failure: unknown): boolean {
  const name = (failure as {name?: unknown}).name;
  return name === 'NotFoundError' || name === 'OverconstrainedError';
}

function grantNotice(
  reason:
    | 'disabled'
    | 'not-installed'
    | 'in-use'
    | 'transcribing'
    | 'permission-denied'
    | undefined,
  holder: ListenSurface | undefined,
): string {
  switch (reason) {
    case 'permission-denied':
      return (
        'Microphone access was denied. Allow Marimo Bot in your system ' +
        'settings, then try again.'
      );
    case 'in-use':
      return `The ${surfaceName(holder)} is using the microphone.`;
    case 'transcribing':
      return 'A transcription is already running.';
    case 'disabled':
    case 'not-installed':
    case undefined:
      return 'Voice input is not set up. Open Settings → Voice input.';
  }
}

function surfaceName(surface: ListenSurface | undefined): string {
  switch (surface) {
    case 'pet':
      return 'moss';
    case 'settings':
      return 'Settings test';
    case 'window':
    default:
      return 'main window';
  }
}

function mediaError(failure: unknown): string {
  const name = (failure as {name?: unknown}).name;
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return (
        'Microphone access was denied. Allow Marimo Bot in your system ' +
        'settings, then try again.'
      );
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'No microphone was found. Connect one and try again.';
    case 'NotReadableError':
      return 'The microphone is being used by another app.';
    default:
      return `The microphone could not be opened: ${describe(failure)}.`;
  }
}

function describe(failure: unknown): string {
  return failure instanceof Error ? failure.message : String(failure);
}
