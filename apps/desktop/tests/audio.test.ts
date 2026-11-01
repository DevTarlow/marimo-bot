/**
 * The WAV the microphone sends, checked as bytes.
 *
 * A header with the wrong byte rate, or a resampler that reads one sample past
 * the end, produces a file the engine transcribes as noise rather than an error.
 * Neither is visible from the window, so both are pinned here.
 */
import {describe, expect, it} from 'vitest';

import {
  base64FromBytes,
  encodeWav,
  resample,
} from '../src/renderer/audio.js';

describe('encodeWav', () => {
  it('writes a mono 16-bit PCM header at the given rate', () => {
    const wav = encodeWav(new Float32Array([0, 1, -1]), 16_000);
    const view = new DataView(wav.buffer);
    expect(String.fromCharCode(...wav.subarray(0, 4))).toBe('RIFF');
    expect(String.fromCharCode(...wav.subarray(8, 12))).toBe('WAVE');
    expect(view.getUint16(20, true)).toBe(1);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(16_000);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getUint32(40, true)).toBe(6);
    expect(wav.length).toBe(44 + 6);
  });

  it('clamps a sample outside the range rather than wrapping it', () => {
    const wav = encodeWav(new Float32Array([2, -2]), 16_000);
    const view = new DataView(wav.buffer);
    expect(view.getInt16(44, true)).toBe(32_767);
    expect(view.getInt16(46, true)).toBe(-32_767);
  });
});

describe('resample', () => {
  it('returns the input when the rates match', () => {
    const samples = new Float32Array([0.1, 0.2]);
    expect(resample(samples, 16_000, 16_000)).toBe(samples);
  });

  it('halves the sample count when going from 32k to 16k', () => {
    const samples = new Float32Array(32_000);
    expect(resample(samples, 32_000, 16_000).length).toBe(16_000);
  });

  it('stays inside the source at the last sample', () => {
    const samples = new Float32Array([0, 0.5, 1]);
    const output = resample(samples, 48_000, 16_000);
    expect(output.every((value) => Number.isFinite(value))).toBe(true);
    expect(output.length).toBe(1);
    expect(output[0]).toBeCloseTo(0);
  });
});

describe('base64FromBytes', () => {
  it('encodes bytes the engine can decode', () => {
    const bytes = new Uint8Array([0x52, 0x49, 0x46, 0x46]);
    expect(base64FromBytes(bytes)).toBe('UklGRg==');
  });

  it('survives a buffer larger than one argument list', () => {
    const bytes = new Uint8Array(200_000);
    expect(base64FromBytes(bytes).length).toBeGreaterThan(0);
  });
});
