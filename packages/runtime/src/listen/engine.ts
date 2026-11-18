/**
 * One recording, from 16 kHz PCM to text.
 *
 * The model is a streaming encoder wrapped in a one-shot call. The frontend and
 * encoder could be run over the whole clip at once, and for a short question
 * that is what happens; for a sixty-second dictation the encoder window is held
 * to a fixed number of frames (`16 * depth` of left context, a chunk of new
 * frames and the model's lookahead) so its attention buffer does not grow with
 * the clip. The adapter's position offset is what makes the sliced windows come
 * back together with the same positions they would have had in one pass.
 *
 * The decoder is a single merged graph. It starts with BOS and an empty
 * self-attention cache, takes the cross-attention keys and values once, and
 * returns the cache it grew. Greedy argmax is this model's own decoding mode;
 * there is no beam search and no sampling to reproduce.
 *
 * This file talks to `ListenGraphs`, not to ONNX. That is what lets the padding,
 * window alignment, token cap and cancellation be tested with a fake, and it
 * keeps the native runtime in the main process.
 */
import {preparePcm, LISTEN_SAMPLE_RATE} from './audio.js';
import {decodeTokens} from './tokenizer.js';
import type {
  ListenConfig,
  ListenGraphs,
  ListenResult,
} from './types.js';
import type {ListenBinTokenizer} from './types.js';

/** How many new encoder frames one window produces. 160 frames is 800 ms. */
const NEW_FRAMES = 160;

/** The model's own decoding ceiling, from the official runtime's fallback. */
const MAX_DECODER_TOKENS = 448;

/** Tokens per second of audio; the official card's 6.5. */
const TOKENS_PER_SECOND = 6.5;

/** The error a cancel raises, so the host can tell a stop from a real failure. */
export class ListenCancelledError extends Error {
  constructor() {
    super('The voice-input transcription was cancelled.');
    this.name = 'ListenCancelledError';
  }
}

export interface TranscribePcmOptions {
  pcm: Float32Array;
  sampleRate: number;
  config: ListenConfig;
  tokenizer: ListenBinTokenizer;
  graphs: ListenGraphs;
  /** Overrides `LISTEN_MAX_SECONDS` for the live check. */
  maxSeconds?: number;
  /** Aborted by a stop; checked between windows and decoder steps. */
  signal?: AbortSignal;
}

export async function transcribePcm(
  options: TranscribePcmOptions,
): Promise<ListenResult> {
  const started = Date.now();
  const {config, graphs, tokenizer} = options;
  const prepared = preparePcm(options.pcm, {
    maxSeconds: options.maxSeconds,
    frameLen: config.frameLen,
    sampleRate: options.sampleRate,
  });
  throwIfAborted(options.signal);

  const features = await runFrontend(prepared.samples, config, graphs, options.signal);
  if (features.frames === 0) {
    return {
      text: '',
      tokens: [],
      durationSeconds: prepared.durationSeconds,
      truncated: prepared.truncated,
      truncatedByTokens: false,
      ms: Date.now() - started,
    };
  }

  const memory = await runEncoder(
    features.all,
    features.frames,
    config,
    graphs,
    options.signal,
  );
  throwIfAborted(options.signal);
  if (memory.frames === 0) {
    return {
      text: '',
      tokens: [],
      durationSeconds: prepared.durationSeconds,
      truncated: prepared.truncated,
      truncatedByTokens: false,
      ms: Date.now() - started,
    };
  }

  const cross = await graphs.crossKv(memory.memory, memory.frames);
  throwIfAborted(options.signal);
  if (cross.frames !== memory.frames) {
    throw new Error(
      'The voice-input cross-attention cache does not match the encoded audio.',
    );
  }
  const decoded = await runDecoder(
    cross,
    prepared.durationSeconds,
    config,
    graphs,
    options.signal,
  );
  const text = decodeTokens(tokenizer, decoded.tokens);
  return {
    text,
    tokens: decoded.tokens,
    durationSeconds: prepared.durationSeconds,
    truncated: prepared.truncated || decoded.truncatedByTokens,
    truncatedByTokens: decoded.truncatedByTokens,
    ms: Date.now() - started,
  };
}

/** The frontend loop, in 80 ms chunks, carrying its state between calls. */
async function runFrontend(
  samples: Float32Array,
  config: ListenConfig,
  graphs: ListenGraphs,
  signal: AbortSignal | undefined,
): Promise<{all: Float32Array; frames: number}> {
  const state = initialFrontendState(config);
  const chunks: Float32Array[] = [];
  let frames = 0;
  const chunkSize = config.frameLen * 16;
  for (let at = 0; at < samples.length; at += chunkSize) {
    throwIfAborted(signal);
    const audio = samples.subarray(at, Math.min(at + chunkSize, samples.length));
    const output = await graphs.frontend({...state, audio});
    const expected = output.featureFrames * config.encoderDim;
    if (
      output.featureFrames < 0 ||
      output.features.length < expected
    ) {
      throw new Error('The voice-input front end answered with the wrong shape.');
    }
    if (output.featureFrames > 0) {
      chunks.push(output.features.subarray(0, expected));
      frames += output.featureFrames;
    }
    state.sampleBuffer = output.sampleBuffer;
    state.sampleLen = output.sampleLen;
    state.conv1Buffer = output.conv1Buffer;
    state.conv2Buffer = output.conv2Buffer;
    state.frameCount = output.frameCount;
  }
  const all = new Float32Array(frames * config.encoderDim);
  let at = 0;
  for (const chunk of chunks) {
    all.set(chunk, at);
    at += chunk.length;
  }
  return {all, frames};
}

interface FrontendState {
  sampleBuffer: Float32Array;
  sampleLen: number;
  conv1Buffer: Float32Array;
  conv2Buffer: Float32Array;
  frameCount: number;
}

function initialFrontendState(config: ListenConfig): FrontendState {
  return {
    sampleBuffer: new Float32Array(product(config.stateShapes.sample_buffer)),
    sampleLen: 0,
    conv1Buffer: new Float32Array(product(config.stateShapes.conv1_buffer)),
    conv2Buffer: new Float32Array(product(config.stateShapes.conv2_buffer)),
    frameCount: 0,
  };
}

/**
 * Encode in bounded windows and adapt each window's new frames.
 *
 * `windowEnd` reaches `totalLookahead` frames past `stable` so the new frames
 * still have the future context the first and last encoder layers look at. The
 * adapter's `posOffset` counts frames already emitted, not frames in the window,
 * which is what keeps the positional embedding continuous across windows.
 */
async function runEncoder(
  all: Float32Array,
  frames: number,
  config: ListenConfig,
  graphs: ListenGraphs,
  signal: AbortSignal | undefined,
): Promise<{memory: Float32Array; frames: number}> {
  const leftContext = 16 * config.depth;
  const chunks: Float32Array[] = [];
  let emitted = 0;
  let adapterPos = 0;
  let memoryFrames = 0;
  while (emitted < frames) {
    throwIfAborted(signal);
    const stable = Math.min(frames, emitted + NEW_FRAMES);
    const windowStart = Math.max(0, emitted - leftContext);
    const windowEnd = Math.min(frames, stable + config.totalLookahead);
    const windowFrames = windowEnd - windowStart;
    const window = all.subarray(
      windowStart * config.encoderDim,
      windowEnd * config.encoderDim,
    );
    const encoded = await graphs.encoder(window, windowFrames);
    const expected = windowFrames * config.encoderDim;
    if (encoded.length < expected) {
      throw new Error('The voice-input encoder answered with the wrong shape.');
    }
    const newFrames = stable - emitted;
    const sliceStart = emitted - windowStart;
    const encodedNew = encoded.subarray(
      sliceStart * config.encoderDim,
      (sliceStart + newFrames) * config.encoderDim,
    );
    const adapted = await graphs.adapter(encodedNew, newFrames, adapterPos);
    const expectedMemory = newFrames * config.decoderDim;
    if (adapted.length < expectedMemory) {
      throw new Error('The voice-input adapter answered with the wrong shape.');
    }
    chunks.push(adapted.subarray(0, expectedMemory));
    memoryFrames += newFrames;
    adapterPos += newFrames;
    emitted = stable;
  }
  const memory = new Float32Array(memoryFrames * config.decoderDim);
  let at = 0;
  for (const chunk of chunks) {
    memory.set(chunk, at);
    at += chunk.length;
  }
  return {memory, frames: memoryFrames};
}

interface DecoderRun {
  tokens: number[];
  truncatedByTokens: boolean;
}

/** Greedy decode until EOS or the model's own token ceiling. */
async function runDecoder(
  cross: {k: Float32Array; v: Float32Array; frames: number},
  durationSeconds: number,
  config: ListenConfig,
  graphs: ListenGraphs,
  signal: AbortSignal | undefined,
): Promise<DecoderRun> {
  const maxTokens = Math.min(
    MAX_DECODER_TOKENS,
    Math.max(1, Math.ceil(durationSeconds * TOKENS_PER_SECOND)),
  );
  const tokens: number[] = [];
  let token = config.bosId;
  let kSelf: Float32Array = new Float32Array(0);
  let vSelf: Float32Array = new Float32Array(0);
  let cacheLen = 0;
  for (let step = 0; step < maxTokens; step += 1) {
    throwIfAborted(signal);
    const output = await graphs.decoder({
      token,
      kSelf,
      vSelf,
      cacheLen,
      kCross: cross.k,
      vCross: cross.v,
      crossLen: cross.frames,
    });
    if (output.logits.length < config.vocabSize) {
      throw new Error('The voice-input decoder answered with no vocabulary.');
    }
    const next = argmax(output.logits, config.vocabSize);
    if (next === config.eosId) {
      return {tokens, truncatedByTokens: false};
    }
    tokens.push(next);
    token = next;
    kSelf = output.kSelf;
    vSelf = output.vSelf;
    cacheLen = output.cacheLen;
  }
  return {tokens, truncatedByTokens: true};
}

/** The highest logit in the first `size` entries; ties keep the lower id. */
export function argmax(logits: Float32Array, size: number): number {
  let best = 0;
  let bestValue = logits[0] ?? -Infinity;
  for (let index = 1; index < size; index += 1) {
    const value = logits[index] ?? -Infinity;
    if (value > bestValue) {
      best = index;
      bestValue = value;
    }
  }
  return best;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new ListenCancelledError();
  }
}

function product(shape: readonly number[]): number {
  return shape.reduce((total, value) => total * value, 1);
}

/** Re-exported so a caller does not have to import the audio helper as well. */
export {LISTEN_SAMPLE_RATE};
