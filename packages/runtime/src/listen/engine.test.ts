import {describe, expect, it} from 'vitest';

import {LISTEN_SAMPLE_RATE} from './audio.js';
import {
  ListenCancelledError,
  transcribePcm,
} from './engine.js';
import type {
  ListenConfig,
  ListenDecoderInput,
  ListenGraphs,
  ListenResult,
} from './types.js';

const CONFIG: ListenConfig = {
  encoderDim: 2,
  decoderDim: 2,
  depth: 1,
  nheads: 1,
  headDim: 1,
  vocabSize: 4,
  bosId: 1,
  eosId: 2,
  frameLen: 80,
  totalLookahead: 0,
  dModelFrontend: 2,
  c1: 4,
  c2: 2,
  stateShapes: {
    sample_buffer: [1, 79],
    sample_len: [1],
    conv1_buffer: [1, 2, 4],
    conv2_buffer: [1, 4, 4],
    frame_count: [1],
  },
};

const TOKENIZER = {
  tokens: [
    new Uint8Array(0),
    new Uint8Array(0),
    new Uint8Array(0),
    new TextEncoder().encode('hello'),
  ],
};

interface Fake extends ListenGraphs {
  chunkLengths: number[];
  encoderFrames: number[];
  decoderCalls: number;
  released: boolean;
}

function fakeGraphs(options: {framesPerChunk?: number} = {}): Fake {
  const framesPerChunk = options.framesPerChunk ?? 1;
  const fake: Fake = {
    chunkLengths: [],
    encoderFrames: [],
    decoderCalls: 0,
    released: false,
    async frontend(input) {
      fake.chunkLengths.push(input.audio.length);
      const featureFrames = framesPerChunk;
      return {
        features: new Float32Array(featureFrames * CONFIG.encoderDim).fill(1),
        featureFrames,
        sampleBuffer: input.sampleBuffer,
        sampleLen: 0,
        conv1Buffer: input.conv1Buffer,
        conv2Buffer: input.conv2Buffer,
        frameCount: input.frameCount + featureFrames,
      };
    },
    async encoder(features, frames) {
      fake.encoderFrames.push(frames);
      return features.slice();
    },
    async adapter(encoded) {
      return encoded.slice();
    },
    async crossKv(_memory, frames) {
      return {
        k: new Float32Array(frames),
        v: new Float32Array(frames),
        frames,
      };
    },
    async decoder(input: ListenDecoderInput) {
      fake.decoderCalls += 1;
      const logits = new Float32Array(CONFIG.vocabSize);
      logits[fake.decoderCalls === 1 ? 3 : 2] = 10;
      return {
        logits,
        kSelf: new Float32Array(0),
        vSelf: new Float32Array(0),
        cacheLen: input.cacheLen,
      };
    },
    async release() {
      fake.released = true;
    },
  };
  return fake;
}

describe('transcribePcm', () => {
  it('pads to a frame multiple and decodes greedy tokens to text', async () => {
    const graphs = fakeGraphs();
    const result: ListenResult = await transcribePcm({
      pcm: new Float32Array(16_001),
      sampleRate: LISTEN_SAMPLE_RATE,
      config: CONFIG,
      tokenizer: TOKENIZER,
      graphs,
    });
    expect(result.text).toBe('hello');
    expect(result.tokens).toEqual([3]);
    expect(result.truncated).toBe(false);
    expect(result.truncatedByTokens).toBe(false);
    // 16,001 samples pad to 16,080; every sample reaches the frontend once.
    expect(graphs.chunkLengths.reduce((sum, length) => sum + length, 0)).toBe(
      16_080,
    );
    // The fake returns one feature frame per frontend call, so the encoder sees
    // exactly that many frames even though the frontend slices them.
    expect(graphs.encoderFrames.reduce((sum, frames) => sum + frames, 0)).toBe(
      graphs.chunkLengths.length,
    );
  });

  it('keeps each encoder window bounded when there are many frames', async () => {
    const graphs = fakeGraphs({framesPerChunk: 2});
    await transcribePcm({
      pcm: new Float32Array(10 * LISTEN_SAMPLE_RATE),
      sampleRate: LISTEN_SAMPLE_RATE,
      config: CONFIG,
      tokenizer: TOKENIZER,
      graphs,
    });
    expect(graphs.encoderFrames.length).toBeGreaterThan(1);
    // left context 16 + new frames 160 + lookahead 0
    for (const frames of graphs.encoderFrames) {
      expect(frames).toBeLessThanOrEqual(176);
    }
  });

  it('trims to the cap and reports the truncation', async () => {
    const graphs = fakeGraphs();
    const result = await transcribePcm({
      pcm: new Float32Array(LISTEN_SAMPLE_RATE * 2),
      sampleRate: LISTEN_SAMPLE_RATE,
      config: CONFIG,
      tokenizer: TOKENIZER,
      graphs,
      maxSeconds: 0.5,
    });
    expect(result.truncated).toBe(true);
    expect(
      graphs.chunkLengths.reduce((sum, length) => sum + length, 0),
    ).toBe(8000);
  });

  it('stops before the first graph when the signal is already aborted', async () => {
    const graphs = fakeGraphs();
    const controller = new AbortController();
    controller.abort();
    await expect(
      transcribePcm({
        pcm: new Float32Array(1600),
        sampleRate: LISTEN_SAMPLE_RATE,
        config: CONFIG,
        tokenizer: TOKENIZER,
        graphs,
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(ListenCancelledError);
    expect(graphs.chunkLengths).toEqual([]);
  });

  it('stops between decoder steps when the signal is aborted', async () => {
    const graphs = fakeGraphs();
    const controller = new AbortController();
    const original = graphs.decoder.bind(graphs);
    graphs.decoder = async (input) => {
      const output = await original(input);
      controller.abort();
      return output;
    };
    await expect(
      transcribePcm({
        pcm: new Float32Array(LISTEN_SAMPLE_RATE),
        sampleRate: LISTEN_SAMPLE_RATE,
        config: CONFIG,
        tokenizer: TOKENIZER,
        graphs,
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(ListenCancelledError);
  });
});
