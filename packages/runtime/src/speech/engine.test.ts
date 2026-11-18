import {describe, expect, it, vi} from 'vitest';

import {
  joinWithGaps,
  synthesize,
  trimAndFade,
  trimForSpeech,
} from './engine.js';
import type {SpeechSession} from './engine.js';

const vocab: Record<string, number> = {
  h: 1,
  ə: 2,
  l: 3,
  ˈ: 4,
  O: 5,
  ' ': 16,
};

function session(
  waveform: Float32Array,
  durations: number[],
  calls = vi.fn(),
): {session: SpeechSession; calls: ReturnType<typeof vi.fn>} {
  return {
    session: {
      async run(input) {
        calls(input);
        return {waveform, durations};
      },
    },
    calls,
  };
}

describe('synthesize', () => {
  it('turns phonemes into a mono 24 kHz WAV', async () => {
    const {session: fake, calls} = session(
      Float32Array.from({length: 1200}, (_, index) => Math.sin(index / 10)),
      [5, 20, 5],
    );
    const result = await synthesize({
      text: 'Hello.',
      vocab,
      voicePack: Float32Array.from({length: 510 * 256}, () => 0.5),
      session: fake,
      phonemize: async () => ({phonemes: 'həlˈO', dropped: 0}),
      sampleRate: 24_000,
    });
    expect(calls).toHaveBeenCalledTimes(1);
    const input = calls.mock.calls[0]?.[0] as {
      inputIds: BigInt64Array;
      style: Float32Array;
      speed: number;
    };
    expect([...input.inputIds]).toEqual([0, 1, 2, 3, 4, 5, 10, 0].map(BigInt));
    expect(input.style.length).toBe(256);
    expect(input.speed).toBe(1);
    expect(result.sampleRate).toBe(24_000);
    expect(result.truncated).toBe(false);
    // 44-byte header, then 16-bit samples; the trim leaves 880 of the 1200.
    expect(result.wav.length).toBe(44 + 880 * 2);
    const wav = Buffer.from(result.wav);
    expect(wav.toString('latin1', 0, 4)).toBe('RIFF');
    expect(wav.toString('latin1', 8, 12)).toBe('WAVE');
  });

  it('passes the requested speed to the model', async () => {
    const {session: fake, calls} = session(
      Float32Array.from({length: 1000}, () => 0.1),
      [10, 30, 10],
    );
    await synthesize({
      text: 'Hello.',
      vocab,
      voicePack: new Float32Array(510 * 256),
      session: fake,
      phonemize: async () => ({phonemes: 'həlˈO', dropped: 0}),
      sampleRate: 24_000,
      speed: 1.4,
    });
    const input = calls.mock.calls[0]?.[0] as {speed: number};
    expect(input.speed).toBe(1.4);
  });

  it('reports a reply longer than the cap', async () => {
    const {session: fake} = session(new Float32Array(100), [1, 1]);
    const result = await synthesize({
      text: 'a '.repeat(2000),
      vocab,
      voicePack: new Float32Array(510 * 256),
      session: fake,
      phonemize: async () => ({phonemes: 'həlˈO', dropped: 0}),
      sampleRate: 24_000,
      maxChars: 10,
    });
    expect(result.truncated).toBe(true);
  });

  it('refuses a reply with no words', async () => {
    const {session: fake} = session(new Float32Array(100), [1]);
    await expect(
      synthesize({
        text: '   ',
        vocab,
        voicePack: new Float32Array(510 * 256),
        session: fake,
        phonemize: async () => ({phonemes: '', dropped: 0}),
        sampleRate: 24_000,
      }),
    ).rejects.toThrow(/no words/u);
  });
});

describe('trimAndFade', () => {
  it('trims the first and last duration frame and fades both ends', () => {
    const out = trimAndFade(
      Float32Array.from({length: 1000}, () => 1),
      [10, 30, 10],
    );
    // samples per frame = 1000 / 50 = 20; lead and trail are 9 frames each.
    expect(out.length).toBe(1000 - 9 * 20 * 2);
    expect(out[0]).toBe(0);
    expect(out[out.length - 1]).toBe(0);
  });
});

describe('joinWithGaps', () => {
  it('puts 0.15 s of silence between chunks', () => {
    const joined = joinWithGaps(
      [new Float32Array(10), new Float32Array(10)],
      24_000,
    );
    expect(joined.length).toBe(20 + Math.round(0.15 * 24_000));
    expect(joined[10]).toBe(0);
    expect(joined[joined.length - 1]).toBe(0);
  });
});

describe('trimForSpeech', () => {
  it('leaves a short reply whole', () => {
    expect(trimForSpeech('Hello there.', 100)).toEqual({
      text: 'Hello there.',
      truncated: false,
    });
  });

  it('cuts at the last sentence end before the cap', () => {
    const text = `${'a'.repeat(90)}. ${'b'.repeat(90)}. ${'c'.repeat(90)}.`;
    const out = trimForSpeech(text, 200);
    expect(out.truncated).toBe(true);
    expect(out.text.endsWith('.')).toBe(true);
    expect(out.text.length).toBeLessThanOrEqual(200);
  });
});
