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

import {CHAT_PINS} from './chat-pins.js';
import {LocalModelHost} from './host.js';
import {writeLocalModelMarker} from './installed.js';

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
  });

  afterEach(async () => {
    await rm(dir, {recursive: true, force: true, maxRetries: 5, retryDelay: 20});
  });

  /** The smallest installed copy the host will believe. */
  async function installTextQ4(): Promise<void> {
    const pin = CHAT_PINS.models['lfm3-1.7b'].variants.q4.weights;
    const modelDir = join(modelRoot, 'lfm3-1.7b');
    await mkdir(modelDir, {recursive: true});
    await writeFile(join(modelDir, pin.file), '');
    await truncate(join(modelDir, pin.file), pin.bytes);
    await writeLocalModelMarker(modelDir, {
      modelId: 'lfm3-1.7b',
      variant: 'q4',
      revision: CHAT_PINS.models['lfm3-1.7b'].revision,
      files: [{name: pin.file, sha256: pin.sha256, bytes: pin.bytes}],
    });
  }

  function host(overrides: {idleMs?: number; busy?: boolean} = {}): LocalModelHost {
    return new LocalModelHost({
      userData: dir,
      env: {MARIMO_MODEL_DIR: modelRoot},
      readSettings: async () => ({localModels: defaultLocalModelsSettings()}),
      isBusy: () => overrides.busy ?? false,
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
    expect(status.models['lfm3-1.7b'].installed).toBe(false);
    expect(status.models['lfm3-1.7b'].missing).toContain('weights');
    const result = await runtime.ensure('lfm3-1.7b');
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
    const result = await runtime.ensure('lfm3-1.7b');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/u);
      expect(result.variant).toBe('q4');
    }
    let status = await runtime.status();
    expect(status.models['lfm3-1.7b'].installed).toBe(true);
    expect(status.models['lfm3-1.7b'].installedVariant).toBe('q4');
    expect(status.models['lfm3-1.7b'].state).toBe('ready');
    expect(status.active?.id).toBe('lfm3-1.7b');

    status = await runtime.sleep();
    expect(status.models['lfm3-1.7b'].state).toBe('off');
    expect(status.active).toBeUndefined();
    expect(child.signals.length).toBe(1);
    expect(statuses).toBeGreaterThan(0);
    expect(failures).toEqual([]);
  });

  it('does not stop under a request while the caller says it is busy', async () => {
    await installTextQ4();
    const runtime = host({idleMs: 5, busy: true});
    const result = await runtime.ensure('lfm3-1.7b');
    expect(result.ok).toBe(true);
    // The idle timer has fired by now, but a busy host re-arms instead.
    await new Promise((resolve) => setTimeout(resolve, 30));
    const status = await runtime.status();
    expect(status.models['lfm3-1.7b'].state).toBe('ready');
    await runtime.stop();
  });

  it('removes a model from disk, stopping it first', async () => {
    await installTextQ4();
    const runtime = host();
    expect((await runtime.ensure('lfm3-1.7b')).ok).toBe(true);
    const status = await runtime.remove('lfm3-1.7b');
    expect(status.models['lfm3-1.7b'].installed).toBe(false);
    expect(child.signals.length).toBe(1);
    await rm(dir, {recursive: true, force: true});
    dir = await mkdtemp(join(process.cwd(), '.marimo-host-'));
  });
});
