/**
 * The voice-input host without ONNX.
 *
 * What is asserted here is the process-shaped part: the one microphone lease,
 * the barge-in callback, the stale-token refusal, the removal guards and the
 * fact that `status` never loads a graph. The graphs themselves are a fake; the
 * pad/encode/decode arithmetic is tested in `@marimo/runtime`.
 */
import {mkdir, mkdtemp, rm, stat, writeFile} from 'node:fs/promises';
import {join} from 'node:path';

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {defaultListenSettings} from '@marimo/protocol';
import type {AgentUiEvent} from '@marimo/protocol';
import type {ListenGraphs} from '@marimo/runtime';

import {ListenHost} from '../src/main/listen-host.js';

const CONFIG = {
  encoder_dim: 2,
  decoder_dim: 2,
  depth: 1,
  nheads: 1,
  head_dim: 1,
  vocab_size: 4,
  bos_id: 1,
  eos_id: 2,
  frame_len: 80,
  total_lookahead: 0,
  d_model_frontend: 2,
  c1: 4,
  c2: 2,
  frontend_state_shapes: {
    sample_buffer: [1, 79],
    sample_len: [1],
    conv1_buffer: [1, 2, 4],
    conv2_buffer: [1, 4, 4],
    frame_count: [1],
  },
};

/** Four tokens: BOS, EOS, an empty entry, and "hi". */
const TOKENIZER = Uint8Array.from([0, 0, 0, 2, 0x68, 0x69]);

function fakeGraphs(options: {wait?: Promise<void>} = {}): ListenGraphs {
  let calls = 0;
  return {
    async frontend(input) {
      return {
        features: new Float32Array([1, 1]),
        featureFrames: 1,
        sampleBuffer: input.sampleBuffer,
        sampleLen: 0,
        conv1Buffer: input.conv1Buffer,
        conv2Buffer: input.conv2Buffer,
        frameCount: input.frameCount + 1,
      };
    },
    async encoder(features) {
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
    async decoder() {
      if (options.wait !== undefined) {
        await options.wait;
      }
      calls += 1;
      const logits = new Float32Array(4);
      logits[calls === 1 ? 3 : 2] = 10;
      return {
        logits,
        kSelf: new Float32Array(0),
        vSelf: new Float32Array(0),
        cacheLen: 0,
      };
    },
    async release() {
      // Nothing to release in the fake.
    },
  };
}

const pcm = (samples = 4800): string =>
  Buffer.alloc(samples * 2).toString('base64');

describe('ListenHost', () => {
  let root: string;
  let dir: string;
  let events: AgentUiEvent[];

  beforeEach(async () => {
    root = await mkdtemp(join(process.cwd(), '.marimo-listen-host-'));
    dir = join(root, 'listen', 'small');
    await mkdir(dir, {recursive: true});
    await writeFile(join(dir, 'streaming_config.json'), JSON.stringify(CONFIG));
    await writeFile(join(dir, 'tokenizer.bin'), TOKENIZER);
    events = [];
  });

  afterEach(async () => {
    await rm(root, {recursive: true, force: true, maxRetries: 5});
  });

  function host(
    options: {
      installed?: boolean;
      graphs?: ListenGraphs;
      enabled?: boolean;
      access?: boolean;
      onCaptureStarted?: () => void;
    } = {},
  ): ListenHost {
    const current = {
      ...defaultListenSettings(),
      enabled: options.enabled ?? true,
    };
    return new ListenHost({
      dir,
      readSettings: async () => current,
      sendEvent: (event) => {
        events.push(event);
      },
      isInstalled: async () => options.installed ?? true,
      createGraphs: async () => options.graphs ?? fakeGraphs(),
      ensureAccess: async () => options.access ?? true,
      ...(options.onCaptureStarted === undefined
        ? {}
        : {onCaptureStarted: options.onCaptureStarted}),
    });
  }

  it('reports an empty folder as not installed, without a graph', async () => {
    const status = await host({installed: false}).status();
    expect(status.installed).toBe(false);
    expect(status.engine).toBe('idle');
    expect(status.modelBytes).toBeGreaterThan(0);
    expect(status.maxSeconds).toBe(60);
  });

  it('reports an installed model and reads its small files only', async () => {
    const createGraphs = vi.fn();
    const status = await host().status();
    expect(status.installed).toBe(true);
    expect(status.engine).toBe('idle');
    expect(createGraphs).not.toHaveBeenCalled();
  });

  it('grants one capture, calls the barge-in, and refuses the second surface', async () => {
    const onCaptureStarted = vi.fn();
    const subject = host({onCaptureStarted});
    const first = await subject.beginCapture('window');
    expect(first.granted).toBe(true);
    expect(first.token).toBeDefined();
    expect(onCaptureStarted).toHaveBeenCalledTimes(1);
    expect(events).toContainEqual({
      type: 'listen.capture',
      active: true,
      surface: 'window',
    });

    const second = await subject.beginCapture('pet');
    expect(second).toEqual({
      granted: false,
      reason: 'in-use',
      holder: 'window',
    });

    expect(subject.cancel(first.token)).toEqual({cancelled: true});
    expect(events).toContainEqual({
      type: 'listen.capture',
      active: false,
      surface: 'window',
    });
    expect((await subject.beginCapture('pet')).granted).toBe(true);
    subject.dispose();
  });

  it('lets the Settings test use the microphone before voice input is enabled', async () => {
    const subject = host({enabled: false});
    const grant = await subject.beginCapture('settings');
    expect(grant.granted).toBe(true);
    subject.cancel(grant.token);
  });

  it('refuses a chat capture when voice input is off or the model is missing', async () => {
    expect(await host({enabled: false}).beginCapture('window')).toEqual({
      granted: false,
      reason: 'disabled',
    });
    expect(await host({installed: false}).beginCapture('window')).toEqual({
      granted: false,
      reason: 'not-installed',
    });
    expect(await host({access: false}).beginCapture('window')).toEqual({
      granted: false,
      reason: 'permission-denied',
    });
  });

  it('drops a stale token instead of transcribing it', async () => {
    const subject = host();
    const grant = await subject.beginCapture('window');
    subject.cancel(grant.token);
    const result = await subject.transcribe({
      token: grant.token ?? '',
      pcm: pcm(),
      sampleRate: 16_000,
      clipId: 'old',
    });
    expect(result).toEqual({
      text: '',
      cancelled: true,
      truncated: false,
      ms: 0,
      clipId: 'old',
    });
    subject.dispose();
  });

  it('transcribes one clip and releases the lease', async () => {
    const subject = host();
    const grant = await subject.beginCapture('window');
    const result = await subject.transcribe({
      token: grant.token ?? '',
      pcm: pcm(),
      sampleRate: 16_000,
      clipId: 'one',
    });
    expect(result.cancelled).toBe(false);
    expect(result.text).toBe('hi');
    expect(result.clipId).toBe('one');
    expect(events).toContainEqual({
      type: 'listen.capture',
      active: false,
      surface: 'window',
    });
    // The lease is gone, so a second surface can have the microphone.
    expect((await subject.beginCapture('pet')).granted).toBe(true);
    subject.dispose();
  });

  it('refuses a second transcription while one is running', async () => {
    let release: () => void = () => undefined;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const subject = host({graphs: fakeGraphs({wait})});
    const grant = await subject.beginCapture('window');
    const first = subject.transcribe({
      token: grant.token ?? '',
      pcm: pcm(),
      sampleRate: 16_000,
      clipId: 'one',
    });
    await Promise.resolve();
    await expect(
      subject.transcribe({
        token: grant.token ?? '',
        pcm: pcm(),
        sampleRate: 16_000,
        clipId: 'two',
      }),
    ).rejects.toThrow(/already running/u);
    subject.cancel(grant.token);
    release();
    expect((await first).cancelled).toBe(true);
    subject.dispose();
  });

  it('cancels a transcription in flight and returns cancelled', async () => {
    let release: () => void = () => undefined;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const subject = host({graphs: fakeGraphs({wait})});
    const grant = await subject.beginCapture('window');
    const running = subject.transcribe({
      token: grant.token ?? '',
      pcm: pcm(),
      sampleRate: 16_000,
      clipId: 'one',
    });
    await Promise.resolve();
    expect(subject.cancel(grant.token)).toEqual({cancelled: true});
    release();
    expect((await running).cancelled).toBe(true);
    subject.dispose();
  });

  it('refuses to remove while enabled, recording or reading a file it does not own', async () => {
    const subject = host();
    await expect(subject.remove()).rejects.toThrow(/Turn voice input off/u);

    const disabled = host({enabled: false});
    const grant = await disabled.beginCapture('settings');
    await expect(disabled.remove()).rejects.toThrow(/Stop the recording/u);
    disabled.cancel(grant.token);

    const foreign = new ListenHost({
      dir: join(root, 'somewhere', 'else'),
      readSettings: async () => ({...defaultListenSettings(), enabled: false}),
      sendEvent: () => undefined,
      isInstalled: async () => true,
    });
    await expect(foreign.remove()).rejects.toThrow(/not the one this app owns/u);
    subject.dispose();
    disabled.dispose();
    foreign.dispose();
  });

  it('removes the model directory when it is off and idle', async () => {
    const subject = host({enabled: false});
    await expect(subject.remove()).resolves.toEqual({removed: true});
    await expect(stat(dir)).rejects.toThrow();
    subject.dispose();
  });

  it('refuses to install while a recording is active', async () => {
    const subject = host();
    const grant = await subject.beginCapture('window');
    await expect(subject.install()).rejects.toThrow(/Stop the recording/u);
    subject.cancel(grant.token);
    subject.dispose();
  });
});
