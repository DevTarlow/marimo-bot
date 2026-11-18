import {describe, expect, it} from 'vitest';

import {LISTEN_MAX_SECONDS} from '@marimo/protocol';

import {
  durationOf,
  LISTEN_FRAME_SAMPLES,
  LISTEN_SAMPLE_RATE,
  pcmFromInt16,
  preparePcm,
} from './audio.js';

describe('preparePcm', () => {
  it('leaves an exact frame multiple alone', () => {
    const samples = new Float32Array(1600).fill(0.25);
    const prepared = preparePcm(samples);
    expect(prepared.samples).toHaveLength(1600);
    expect(prepared.durationSeconds).toBeCloseTo(0.1);
    expect(prepared.truncated).toBe(false);
  });

  it('zero-pads a clip that ends mid-frame', () => {
    const samples = new Float32Array(1601).fill(0.5);
    const prepared = preparePcm(samples);
    expect(prepared.samples).toHaveLength(1680);
    expect(prepared.samples[1600]).toBe(0.5);
    expect(prepared.samples[1601]).toBe(0);
    expect(prepared.samples[1679]).toBe(0);
  });

  it('pads a clip shorter than one frame to exactly one frame', () => {
    const prepared = preparePcm(new Float32Array(1));
    expect(prepared.samples).toHaveLength(LISTEN_FRAME_SAMPLES);
  });

  it('trims a clip longer than the cap and reports it', () => {
    const samples = new Float32Array(
      LISTEN_SAMPLE_RATE * (LISTEN_MAX_SECONDS + 1),
    );
    const prepared = preparePcm(samples);
    expect(prepared.samples).toHaveLength(
      LISTEN_SAMPLE_RATE * LISTEN_MAX_SECONDS,
    );
    expect(prepared.samples).toHaveLength(
      Math.ceil(prepared.samples.length / LISTEN_FRAME_SAMPLES) *
        LISTEN_FRAME_SAMPLES,
    );
    expect(prepared.truncated).toBe(true);
    expect(prepared.durationSeconds).toBe(LISTEN_MAX_SECONDS);
  });

  it('refuses an empty recording and a sample rate it cannot drive', () => {
    expect(() => preparePcm(new Float32Array(0))).toThrow(/empty/u);
    expect(() =>
      preparePcm(new Float32Array(80), {sampleRate: 48_000}),
    ).toThrow(/16 kHz/u);
  });
});

describe('pcmFromInt16', () => {
  it('reads little-endian samples into the model range', () => {
    const bytes = Uint8Array.from([0x00, 0x80, 0xff, 0x7f, 0x00, 0x00]);
    const pcm = pcmFromInt16(bytes);
    expect(pcm).toHaveLength(3);
    expect(pcm[0]).toBe(-1);
    expect(pcm[1]).toBeCloseTo(32767 / 32768);
    expect(pcm[2]).toBe(0);
  });

  it('refuses an odd number of bytes', () => {
    expect(() => pcmFromInt16(Uint8Array.from([0, 1, 2]))).toThrow(/odd/u);
  });
});

describe('durationOf', () => {
  it('measures at the model rate', () => {
    expect(durationOf(new Float32Array(16_000))).toBe(1);
  });
});
