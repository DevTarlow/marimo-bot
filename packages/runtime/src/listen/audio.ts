/**
 * The arithmetic between a microphone and the model.
 *
 * The model's frontend frames raw PCM into 80-sample (5 ms) blocks and carries
 * the last 79 samples across calls. A clip that ends mid-frame therefore has to
 * be zero-padded to a whole frame before the first frontend call, or the tail is
 * silently left in the carry-over buffer and never becomes a feature. The same
 * function enforces the 60-second cap, so the renderer and a hand-crafted call
 * cannot hand the engine an unbounded array.
 *
 * Everything here is plain Float32Array arithmetic; the ONNX runtime and the
 * browser are both elsewhere.
 */
import {LISTEN_MAX_SECONDS} from '@marimo/protocol';

/** The model's sample rate; the renderer resamples before it reaches here. */
export const LISTEN_SAMPLE_RATE = 16_000;

/** The model's frame length in samples (5 ms at 16 kHz). */
export const LISTEN_FRAME_SAMPLES = 80;

export interface PreparedPcm {
  samples: Float32Array;
  durationSeconds: number;
  /** True when the input was longer than the cap and the tail was dropped. */
  truncated: boolean;
}

/**
 * Validate, trim and zero-pad one clip.
 *
 * Empty is a refusal rather than an empty transcript: a microphone that produced
 * no samples is a broken recording, and the model would answer with a
 * hallucinated word if it were given 80 zeros.
 */
export function preparePcm(
  pcm: Float32Array,
  options: {
    maxSeconds?: number;
    frameLen?: number;
    sampleRate?: number;
  } = {},
): PreparedPcm {
  const sampleRate = options.sampleRate ?? LISTEN_SAMPLE_RATE;
  if (sampleRate !== LISTEN_SAMPLE_RATE) {
    throw new Error(
      `The voice-input model needs 16 kHz audio, not ${String(sampleRate)} Hz.`,
    );
  }
  const frameLen = options.frameLen ?? LISTEN_FRAME_SAMPLES;
  if (!Number.isSafeInteger(frameLen) || frameLen <= 0) {
    throw new Error('The voice-input frame length is not a positive integer.');
  }
  if (pcm.length === 0) {
    throw new Error('The recording was empty.');
  }
  const maxSeconds = options.maxSeconds ?? LISTEN_MAX_SECONDS;
  if (!Number.isFinite(maxSeconds) || maxSeconds <= 0) {
    throw new Error('The voice-input duration cap is not a positive number.');
  }
  const limit = Math.floor(maxSeconds * LISTEN_SAMPLE_RATE);
  const kept =
    pcm.length > limit ? pcm.subarray(0, limit) : pcm;
  const target = Math.max(frameLen, Math.ceil(kept.length / frameLen) * frameLen);
  const samples =
    target === kept.length ? kept : withPadding(kept, target);
  return {
    samples,
    durationSeconds: kept.length / LISTEN_SAMPLE_RATE,
    truncated: pcm.length > limit,
  };
}

/** Little-endian Int16 bytes, as the IPC carries them, to the engine's floats. */
export function pcmFromInt16(bytes: Uint8Array): Float32Array {
  if (bytes.byteLength % 2 !== 0) {
    throw new Error('The voice-input audio has an odd number of bytes.');
  }
  const count = bytes.byteLength / 2;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Float32Array(count);
  for (let index = 0; index < count; index += 1) {
    out[index] = view.getInt16(index * 2, true) / 32768;
  }
  return out;
}

/** One clip's duration, for the minimum-length guard. */
export function durationOf(pcm: Float32Array): number {
  return pcm.length / LISTEN_SAMPLE_RATE;
}

function withPadding(samples: Float32Array, target: number): Float32Array {
  const out = new Float32Array(target);
  out.set(samples);
  return out;
}
