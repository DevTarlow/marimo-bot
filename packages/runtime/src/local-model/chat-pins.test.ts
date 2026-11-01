/**
 * The pins and the command line, checked as data.
 *
 * A download button that promises 1.9GB while the installer asks for 2.4GB is a
 * lie the user finds out about at 80 percent; a command line missing `--jinja` is
 * an engine that answers prose and never calls a tool. Both are cheap to assert
 * before a model ever loads.
 */
import {describe, expect, it} from 'vitest';

import {
  LOCAL_MODELS,
  LOCAL_MODEL_IDS,
  LOCAL_MODEL_VARIANTS,
  variantBytes,
} from '@marimo/protocol';

import {CHAT_PINS, defaultVariantFor} from './chat-pins.js';
import {localModelArgs} from './args.js';
import {localModelSpec} from './files.js';
import type {LocalModelSpec} from './files.js';

describe('the chat pins', () => {
  it('has the same sizes the download card shows', () => {
    for (const id of LOCAL_MODEL_IDS) {
      for (const variant of LOCAL_MODEL_VARIANTS) {
        const pin = CHAT_PINS.models[id].variants[variant];
        expect(pin.weights.bytes).toBe(LOCAL_MODELS[id].bytes[variant].weights);
        expect(pin.projector?.bytes ?? 0).toBe(
          LOCAL_MODELS[id].bytes[variant].projector,
        );
        expect(pin.weights.sha256).toMatch(/^[0-9a-f]{64}$/u);
        expect(variantBytes(id, variant)).toBeGreaterThan(1_000_000_000);
      }
    }
  });

  it('names the revision and the licence on every model', () => {
    for (const id of LOCAL_MODEL_IDS) {
      expect(CHAT_PINS.models[id].revision).toMatch(/^[0-9a-f]{40}$/u);
      expect(CHAT_PINS.models[id].license).toMatch(/LFM Open License/u);
      expect(CHAT_PINS.models[id].repo).toBe(LOCAL_MODELS[id].repo);
    }
  });

  it('defaults the voice and omni models to the small copy', () => {
    expect(defaultVariantFor('lfm3-1.7b')).toBe('q8');
    expect(defaultVariantFor('lfm3-vl-2b')).toBe('q8');
    expect(defaultVariantFor('lfm3-audio-2b')).toBe('q4');
    expect(defaultVariantFor('lfm3-omni-2b')).toBe('q4');
  });

  it('pins an engine build and a digest for every platform it knows', () => {
    expect(CHAT_PINS.engine.tag).toBe('b11960');
    for (const [platform, asset] of Object.entries(CHAT_PINS.engine.assets)) {
      expect(platform).toMatch(/^(linux|darwin|win32)-/u);
      expect(asset.sha256).toMatch(/^[0-9a-f]{64}$/u);
    }
  });
});

describe('the chat command line', () => {
  const base = localModelSpec({
    root: '/models',
    manifest: CHAT_PINS,
    modelId: 'lfm3-vl-2b',
    variant: 'q4',
    platform: 'linux',
  });
  // The files are not on disk in a unit test; the argv is what is under test, so
  // the projector is declared present rather than created.
  const spec: LocalModelSpec = {
    ...base,
    files: {...base.files, projectorPresent: true},
  };

  it('passes the model, projector and alias the engine expects', () => {
    const args = localModelArgs(spec, 8123);
    expect(args).toContain('--model');
    expect(args).toContain('--mmproj');
    expect(args[args.indexOf('--alias') + 1]).toBe('lfm3-vl-2b');
    expect(args[args.indexOf('--port') + 1]).toBe('8123');
    expect(args[args.indexOf('--ctx-size') + 1]).toBe('32768');
  });

  it('turns tool calls on and thinking off', () => {
    const args = localModelArgs(spec, 8123);
    expect(args).toContain('--jinja');
    expect(args[args.indexOf('--reasoning') + 1]).toBe('off');
    // The engine is CPU-served; a GPU layer count here would make the archive
    // depend on a driver this build did not ship.
    expect(args[args.indexOf('--n-gpu-layers') + 1]).toBe('0');
    expect(args).toContain('--no-ui');
  });

  it('omits the projector for the text model', () => {
    const text = localModelSpec({
      root: '/models',
      manifest: CHAT_PINS,
      modelId: 'lfm3-1.7b',
      variant: 'q8',
      platform: 'linux',
    });
    expect(localModelArgs(text, 8123)).not.toContain('--mmproj');
  });
});
