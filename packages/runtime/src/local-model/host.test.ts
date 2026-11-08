/**
 * The one model in memory, with a fake process.
 *
 * Every interesting failure here is a *process* one: an engine that will not
 * start, a model that is not on disk, a stop that must not happen under a
 * request. None can be produced on demand from a real llama.cpp, so spawn and
 * fetch are injected. The files, the marker and the pid file are real, because
 * they are the half the app's two processes have to agree about.
 */
import {EventEmitter} from 'node:events';
import {mkdir, mkdtemp, rm, truncate, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {PassThrough} from 'node:stream';

import {afterEach, beforeEach, describe, expect, it} from 'vitest';

import {defaultLocalModelsSettings} from '@marimo/protocol';
import type {EngineBackend} from '@marimo/protocol';

import {CHAT_PINS} from './chat-pins.js';
import type {CudaSupport} from './cuda.js';
import {LocalModelHost} from './host.js';
import {writeEngineMarker, writeLocalModelMarker} from './installed.js';
import {engineAssetFor} from './manifest.js';

class FakeChild extends EventEmitter {
  readonly pid = process.pid + 1;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly signals: NodeJS.Signals[] = [];

  kill(signal?: NodeJS.Signals): boolean {
    this.signals.push(signal ?? 'SIGTERM');
    this.emit('exit', null, signal ?? 'SIGTERM');
    return true;
  }
}

describe('LocalModelHost', () => {
  let dir: string;
  let modelRoot: string;
  let child: FakeChild;
  let statuses: number;
  let failures: string[];

  beforeEach(async () => {
    dir = await mkdtemp(join(process.cwd(), '.marimo-host-'));
    modelRoot = join(dir, 'model');
    child = new FakeChild();
    statuses = 0;
    failures = [];
    await mkdir(join(modelRoot, 'engine'), {recursive: true});
    await writeFile(join(modelRoot, 'engine', 'llama-server'), 'engine\n');
    const asset = engineAssetFor(CHAT_PINS);
    if (asset === undefined) {
      throw new Error('this test platform has no pinned engine');
    }
    await writeEngineMarker(modelRoot, asset.asset);
  });

  afterEach(async () => {
    await rm(dir, {recursive: true, force: true, maxRetries: 5, retryDelay: 20});
  });

  /** The smallest installed copy the host will believe: weights and encoder. */
  async function installTextQ4(): Promise<void> {
    const variant = CHAT_PINS.models['qwen2.5-vl-7b'].variants.q4;
    const files = [variant.weights, variant.projector];
    const modelDir = join(modelRoot, 'qwen2.5-vl-7b');
    await mkdir(modelDir, {recursive: true});
    for (const pin of files) {
      if (pin === undefined) {
        continue;
      }
      await writeFile(join(modelDir, pin.file), '');
      await truncate(join(modelDir, pin.file), pin.bytes);
    }
    await writeLocalModelMarker(modelDir, {
      modelId: 'qwen2.5-vl-7b',
      variant: 'q4',
      revision: CHAT_PINS.models['qwen2.5-vl-7b'].revision,
      files: files
        .filter((pin) => pin !== undefined)
        .map((pin) => ({
          name: pin.file,
          sha256: pin.sha256,
          bytes: pin.bytes,
        })),
    });
  }

  function host(
    overrides: {
      idleMs?: number;
      busy?: boolean;
      backend?: EngineBackend;
      cudaProbe?: () => Promise<CudaSupport>;
    } = {},
  ): LocalModelHost {
    return new LocalModelHost({
      userData: dir,
      env: {MARIMO_MODEL_DIR: modelRoot},
      readSettings: async () => ({
        localModels: {
          ...defaultLocalModelsSettings(),
          engineBackend: overrides.backend ?? 'vulkan',
        },
      }),
      isBusy: () => overrides.busy ?? false,
      cudaProbe:
        overrides.cudaProbe ??
        (async () => ({available: false, reason: 'No NVIDIA GPU in this test.'})),
      ...(overrides.idleMs === undefined ? {} : {idleMs: overrides.idleMs}),
      onStatus: () => {
        statuses += 1;
      },
      onFailed: (_id, message) => {
        failures.push(message);
      },
      spawnImpl: (() => child) as unknown as typeof import('node:child_process').spawn,
      fetchImpl: (async () =>
        new Response('{}', {status: 200})) as unknown as typeof fetch,
    });
  }

  it('reports a model that is not downloaded, and does not start anything', async () => {
    const runtime = host();
    const status = await runtime.status();
    expect(status.models['qwen2.5-vl-7b'].installed).toBe(false);
    expect(status.models['qwen2.5-vl-7b'].missing).toContain('weights');
    const result = await runtime.ensure('qwen2.5-vl-7b');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problem).toMatch(/not ready/iu);
      expect(result.problem).toMatch(/Settings/iu);
    }
    expect(child.signals).toEqual([]);
  });

  it('starts the installed copy, reports its state and stops it', async () => {
    await installTextQ4();
    const runtime = host();
    const result = await runtime.ensure('qwen2.5-vl-7b');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/u);
      expect(result.variant).toBe('q4');
    }
    let status = await runtime.status();
    expect(status.models['qwen2.5-vl-7b'].installed).toBe(true);
    expect(status.models['qwen2.5-vl-7b'].installedVariant).toBe('q4');
    expect(status.models['qwen2.5-vl-7b'].state).toBe('ready');
    expect(status.active?.id).toBe('qwen2.5-vl-7b');

    status = await runtime.sleep();
    expect(status.models['qwen2.5-vl-7b'].state).toBe('off');
    expect(status.active).toBeUndefined();
    expect(child.signals.length).toBe(1);
    expect(statuses).toBeGreaterThan(0);
    expect(failures).toEqual([]);
  });

  it('does not believe an engine from a different pin', async () => {
    await installTextQ4();
    // The marker the CPU archive wrote, before this build moved to the GPU one.
    await writeFile(
      join(modelRoot, 'engine', '.pinned'),
      `${JSON.stringify(
        {
          file: 'llama-b11960-bin-ubuntu-x64.tar.gz',
          sha256: '0'.repeat(64),
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
    const runtime = host();
    const status = await runtime.status();
    expect(status.models['qwen2.5-vl-7b'].installed).toBe(false);
    expect(status.models['qwen2.5-vl-7b'].missing).toContain('engine');
    // The weights are still the Q4 copy; only the engine is stale.
    expect(status.models['qwen2.5-vl-7b'].installedVariant).toBe('q4');
    expect((await runtime.ensure('qwen2.5-vl-7b')).ok).toBe(false);
  });

  it('offers CUDA from an NVIDIA probe without selecting it', async () => {
    const runtime = host({
      cudaProbe: async () => ({
        available: true,
        device: 'NVIDIA GeForce RTX 3060',
        driver: '580.82.09',
      }),
    });
    const status = await runtime.status();
    expect(status.engine.backend).toBe('vulkan');
    expect(status.engine.cuda).toMatchObject({
      available: true,
      device: 'NVIDIA GeForce RTX 3060',
      driver: '580.82.09',
    });
    expect(status.engine.cuda.bytes).toBeGreaterThan(700_000_000);
  });

  it('selects CUDA when the settings ask and the driver is new enough', async () => {
    await installTextQ4();
    const runtime = host({
      backend: 'cuda',
      cudaProbe: async () => ({
        available: true,
        device: 'NVIDIA GeForce RTX 3060',
        driver: '580.82.09',
      }),
    });
    const status = await runtime.status();
    expect(status.engine.backend).toBe('cuda');
    // The fixture has the default one-archive engine marker, not the CUDA pair.
    expect(status.models['qwen2.5-vl-7b'].installed).toBe(false);
    expect(status.models['qwen2.5-vl-7b'].missing).toContain('engine');
    expect((await runtime.ensure('qwen2.5-vl-7b')).ok).toBe(false);
  });

  it('falls back to Vulkan when CUDA was asked for but is not available', async () => {
    const runtime = host({
      backend: 'cuda',
      cudaProbe: async () => ({
        available: false,
        reason: 'The NVIDIA driver is too old.',
      }),
    });
    const status = await runtime.status();
    expect(status.engine.backend).toBe('vulkan');
    expect(status.engine.cuda.available).toBe(false);
    expect(status.engine.cuda.reason).toMatch(/too old/u);
  });

  it('does not stop under a request while the caller says it is busy', async () => {
    await installTextQ4();
    const runtime = host({idleMs: 5, busy: true});
    const result = await runtime.ensure('qwen2.5-vl-7b');
    expect(result.ok).toBe(true);
    // The idle timer has fired by now, but a busy host re-arms instead.
    await new Promise((resolve) => setTimeout(resolve, 30));
    const status = await runtime.status();
    expect(status.models['qwen2.5-vl-7b'].state).toBe('ready');
    await runtime.stop();
  });

  it('does not sleep or remove the model under a request', async () => {
    await installTextQ4();
    const runtime = host({busy: true});
    expect((await runtime.ensure('qwen2.5-vl-7b')).ok).toBe(true);
    const slept = await runtime.sleep();
    expect(slept.models['qwen2.5-vl-7b'].state).toBe('ready');
    const removed = await runtime.remove('qwen2.5-vl-7b');
    expect(removed.models['qwen2.5-vl-7b'].installed).toBe(true);
    await runtime.stop();
  });

  it('removes a model from disk, stopping it first', async () => {
    await installTextQ4();
    const runtime = host();
    expect((await runtime.ensure('qwen2.5-vl-7b')).ok).toBe(true);
    const status = await runtime.remove('qwen2.5-vl-7b');
    expect(status.models['qwen2.5-vl-7b'].installed).toBe(false);
    expect(child.signals.length).toBe(1);
  });

  it('lists an old model directory and removes it on request', async () => {
    await mkdir(join(modelRoot, 'lfm3-omni-2b'), {recursive: true});
    await mkdir(join(modelRoot, 'lfm3-1.7b'), {recursive: true});
    const runtime = host();

    expect((await runtime.status()).retired).toEqual([
      'lfm3-1.7b',
      'lfm3-omni-2b',
    ]);

    const after = await runtime.removeRetired('lfm3-omni-2b');
    expect(after.retired).toEqual(['lfm3-1.7b']);
  });
});
