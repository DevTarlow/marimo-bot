/**
 * The voice-input graphs, loaded through the CPU ONNX runtime.
 *
 * This file is the only place `onnxruntime-node` is required for voice input.
 * It lives under `src/main` rather than `packages/runtime` for the reason the
 * speech host does: the runner is this same binary started as plain Node and must
 * never load a native model, and a value import in the runtime package would put
 * one on its import graph.
 *
 * The sessions are loaded in two phases. The frontend, encoder, adapter and
 * cross-attention graphs are needed only until the cross-attention cache is
 * built; `crossKv` copies that cache into plain arrays and releases them, then the
 * decoder loads for the greedy loop. That keeps the peak to the largest phase
 * rather than the sum of both, and the host's idle unload releases the decoder.
 */
import {createRequire} from 'node:module';
import {cpus} from 'node:os';
import {join} from 'node:path';

import type {
  ListenConfig,
  ListenCross,
  ListenDecoderInput,
  ListenDecoderOutput,
  ListenFrontendInput,
  ListenFrontendOutput,
  ListenGraphs,
} from '@marimo/runtime';

const require = createRequire(import.meta.url);

type Ort = typeof import('onnxruntime-node');
type Session = import('onnxruntime-node').InferenceSession;

/**
 * Create the five sessions for one model directory.
 *
 * `config` is passed in because a tensor's shape is part of the graph's
 * contract: the frontend's convolution buffers are flattened arrays, and the
 * channel counts come from the pinned settings, not from a guess about how many
 * floats happened to arrive.
 */
export async function createOrtGraphs(
  dir: string,
  config: ListenConfig,
): Promise<ListenGraphs> {
  let ort: Ort;
  try {
    ort = require('onnxruntime-node') as Ort;
  } catch (failure) {
    throw new Error(
      `The speech runtime is missing from this build: ${describe(failure)}.`,
    );
  }
  const options: import('onnxruntime-node').InferenceSession.SessionOptions = {
    executionProviders: ['cpu'],
    graphOptimizationLevel: 'all' as const,
    // Four threads is enough for a question and leaves the desktop responsive.
    // The CPU arena is off because it reserves more than this pipeline needs and
    // the decoder's peak is the number the README quotes.
    intraOpNumThreads: Math.max(1, Math.min(4, cpus().length)),
    interOpNumThreads: 1,
    enableCpuMemArena: false,
    logSeverityLevel: 3,
  };

  let frontend: Session | undefined;
  let encoder: Session | undefined;
  let adapter: Session | undefined;
  let cross: Session | undefined;
  let decoder: Session | undefined;

  const load = async (name: string): Promise<Session> => {
    try {
      return await ort.InferenceSession.create(
        join(dir, `${name}.ort`),
        options,
      );
    } catch (failure) {
      throw new Error(
        `The voice-input ${name} model could not be loaded: ` +
          `${describe(failure)}. Download it again from Settings → Voice input.`,
      );
    }
  };

  const ensureFrontend = async (): Promise<Session> => {
    frontend ??= await load('frontend');
    return frontend;
  };
  const ensureEncoder = async (): Promise<Session> => {
    encoder ??= await load('encoder');
    return encoder;
  };
  const ensureAdapter = async (): Promise<Session> => {
    adapter ??= await load('adapter');
    return adapter;
  };
  const ensureCross = async (): Promise<Session> => {
    cross ??= await load('cross_kv');
    return cross;
  };
  const ensureDecoder = async (): Promise<Session> => {
    decoder ??= await load('decoder_kv');
    return decoder;
  };

  const releaseSession = async (session: Session | undefined): Promise<void> => {
    if (session === undefined) {
      return;
    }
    try {
      await session.release();
    } catch {
      // A released session is already gone; a second failure is not a reason to
      // keep a transcription from finishing.
    }
  };

  const releaseEncoding = async (): Promise<void> => {
    const sessions = [frontend, encoder, adapter, cross];
    frontend = undefined;
    encoder = undefined;
    adapter = undefined;
    cross = undefined;
    await Promise.all(sessions.map((session) => releaseSession(session)));
  };

  const graphs: ListenGraphs = {
    async frontend(input: ListenFrontendInput): Promise<ListenFrontendOutput> {
      const session = await ensureFrontend();
      const outputs = await session.run({
        audio_chunk: new ort.Tensor('float32', input.audio, [
          1,
          input.audio.length,
        ]),
        sample_buffer: new ort.Tensor('float32', input.sampleBuffer, [
          1,
          input.sampleBuffer.length,
        ]),
        sample_len: new ort.Tensor(
          'int64',
          BigInt64Array.from([BigInt(input.sampleLen)]),
          [1],
        ),
        conv1_buffer: new ort.Tensor('float32', input.conv1Buffer, [
          1,
          input.conv1Buffer.length / 4,
          4,
        ]),
        conv2_buffer: new ort.Tensor('float32', input.conv2Buffer, [
          1,
          input.conv2Buffer.length / 4,
          4,
        ]),
        frame_count: new ort.Tensor(
          'int64',
          BigInt64Array.from([BigInt(input.frameCount)]),
          [1],
        ),
      });
      const features = floatData(outputs['features']);
      const dims = outputs['features']?.dims ?? [];
      const featureFrames = dims[1] ?? 0;
      return {
        features,
        featureFrames,
        sampleBuffer: floatData(outputs['sample_buffer_out']),
        sampleLen: intData(outputs['sample_len_out']),
        conv1Buffer: floatData(outputs['conv1_buffer_out']),
        conv2Buffer: floatData(outputs['conv2_buffer_out']),
        frameCount: intData(outputs['frame_count_out']),
      };
    },

    async encoder(features: Float32Array, frames: number): Promise<Float32Array> {
      const session = await ensureEncoder();
      const outputs = await session.run({
        features: new ort.Tensor('float32', features, [
          1,
          frames,
          config.encoderDim,
        ]),
      });
      return floatData(outputs['encoded']);
    },

    async adapter(
      encoded: Float32Array,
      frames: number,
      posOffset: number,
    ): Promise<Float32Array> {
      const session = await ensureAdapter();
      const outputs = await session.run({
        encoded: new ort.Tensor('float32', encoded, [
          1,
          frames,
          config.encoderDim,
        ]),
        pos_offset: new ort.Tensor(
          'int64',
          BigInt64Array.from([BigInt(posOffset)]),
          [1],
        ),
      });
      return floatData(outputs['memory']);
    },

    async crossKv(memory: Float32Array, frames: number): Promise<ListenCross> {
      const session = await ensureCross();
      const outputs = await session.run({
        memory: new ort.Tensor('float32', memory, [
          1,
          frames,
          config.decoderDim,
        ]),
      });
      const k = floatData(outputs['k_cross']);
      const v = floatData(outputs['v_cross']);
      const crossFrames = outputs['k_cross']?.dims?.[3] ?? frames;
      /*
       * The four encoding graphs have done their work; the decoder needs only
       * the cache built here. Releasing now is what keeps an 11 s clip at about
       * 450 MB and a 60 s clip under a gigabyte.
       */
      await releaseEncoding();
      return {k, v, frames: crossFrames};
    },

    async decoder(input: ListenDecoderInput): Promise<ListenDecoderOutput> {
      const session = await ensureDecoder();
      const outputs = await session.run({
        token: new ort.Tensor(
          'int64',
          BigInt64Array.from([BigInt(input.token)]),
          [1, 1],
        ),
        k_self: new ort.Tensor('float32', input.kSelf, [
          config.depth,
          1,
          config.nheads,
          input.cacheLen,
          config.headDim,
        ]),
        v_self: new ort.Tensor('float32', input.vSelf, [
          config.depth,
          1,
          config.nheads,
          input.cacheLen,
          config.headDim,
        ]),
        out_k_cross: new ort.Tensor('float32', input.kCross, [
          config.depth,
          1,
          config.nheads,
          input.crossLen,
          config.headDim,
        ]),
        out_v_cross: new ort.Tensor('float32', input.vCross, [
          config.depth,
          1,
          config.nheads,
          input.crossLen,
          config.headDim,
        ]),
      });
      const logits = floatData(outputs['logits']);
      const kSelf = floatData(outputs['out_k_self']);
      const vSelf = floatData(outputs['out_v_self']);
      const cacheLen = outputs['out_k_self']?.dims?.[3] ?? input.cacheLen;
      return {
        logits: logits.subarray(0, config.vocabSize),
        kSelf,
        vSelf,
        cacheLen,
      };
    },

    async release(): Promise<void> {
      const sessions = [frontend, encoder, adapter, cross, decoder];
      frontend = undefined;
      encoder = undefined;
      adapter = undefined;
      cross = undefined;
      decoder = undefined;
      await Promise.all(sessions.map((session) => releaseSession(session)));
    },
  };
  return graphs;
}

/** A tensor's data as a copied Float32Array, or an empty one when it is absent. */
function floatData(
  value: import('onnxruntime-node').Tensor | undefined,
): Float32Array {
  if (value === undefined) {
    return new Float32Array(0);
  }
  const data = value.data;
  if (!(data instanceof Float32Array)) {
    throw new Error('The voice-input model answered with a non-float tensor.');
  }
  return Float32Array.from(data);
}

/** The first value of an int64 tensor, as a number. */
function intData(value: import('onnxruntime-node').Tensor | undefined): number {
  if (value === undefined) {
    return 0;
  }
  const data = value.data;
  if (!(data instanceof BigInt64Array)) {
    throw new Error('The voice-input model answered with a non-integer tensor.');
  }
  return Number(data[0] ?? 0n);
}

function describe(failure: unknown): string {
  return failure instanceof Error ? failure.message : String(failure);
}
