import {describe, expect, it} from 'vitest';

import {
  concatChunks,
  downsampleLinear,
  int16Base64,
  isSpeech,
  resampleLength,
  rmsOf,
  silenceReached,
} from '../src/renderer/voice-audio.js';

describe('level and silence', () => {
  it('computes RMS and calls a loud block speech', () => {
    expect(rmsOf(new Float32Array([0.5, 0.5]))).toBeCloseTo(0.5);
    expect(rmsOf(new Float32Array(0))).toBe(0);
    expect(isSpeech(0.02)).toBe(true);
    expect(isSpeech(0.01)).toBe(false);
  });

  it('stops only after speech, a grace period and trailing silence', () => {
    expect(
      silenceReached({speechSeen: false, silentMs: 5000, elapsedMs: 5000}),
    ).toBe(false);
    expect(
      silenceReached({speechSeen: true, silentMs: 1500, elapsedMs: 400}),
    ).toBe(false);
    expect(
      silenceReached({speechSeen: true, silentMs: 1500, elapsedMs: 2000}),
    ).toBe(true);
    expect(
      silenceReached({speechSeen: true, silentMs: 1400, elapsedMs: 2000}),
    ).toBe(false);
  });
});

describe('resampling', () => {
  it('sizes a 48 kHz clip for 16 kHz', () => {
    expect(resampleLength(48_000, 48_000)).toBe(16_000);
    expect(resampleLength(1, 48_000)).toBe(1);
  });

  it('interpolates a linear fallback', () => {
    const source = new Float32Array([0, 1, 0, 1]);
    const out = downsampleLinear(source, 32_000);
    expect(out).toHaveLength(2);
    expect(Array.from(out)).toEqual([0, 0]);
    // The endpoint is preserved rather than dropped.
    const ramp = downsampleLinear(new Float32Array([0, 0.5, 1, 0.5]), 32_000);
    expect(ramp[0]).toBe(0);
    expect(ramp[1]).toBeCloseTo(1);
  });

  it('joins worklet blocks in order', () => {
    expect(
      Array.from(
        concatChunks([Float32Array.from([1, 2]), Float32Array.from([3])]),
      ),
    ).toEqual([1, 2, 3]);
  });
});

describe('int16Base64', () => {
  it('clamps, rounds and writes little-endian sample bytes', () => {
    const encoded = int16Base64(Float32Array.from([0, 0.5, -1, 1, 2, -2]));
    const binary = atob(encoded);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    const view = new DataView(bytes.buffer);
    expect(view.getInt16(0, true)).toBe(0);
    expect(view.getInt16(2, true)).toBe(16_384);
    expect(view.getInt16(4, true)).toBe(-32_767);
    expect(view.getInt16(6, true)).toBe(32_767);
    expect(view.getInt16(8, true)).toBe(32_767);
    expect(view.getInt16(10, true)).toBe(-32_767);
  });
});
