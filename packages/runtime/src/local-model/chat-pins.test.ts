/**
 * The pins and the command line, checked as data.
 *
 * A download button that promises 4.7GB while the installer asks for 6.0GB is a
 * lie the user finds out about at 80 percent; a command line missing `--jinja`
 * or `--chat-template` is an engine that answers prose and never calls a tool.
 * Both are cheap to assert before a model ever loads.
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
import {QWEN_VL_CHAT_TEMPLATE} from './qwen-vl-template.js';

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
      expect(CHAT_PINS.models[id].license).toBe('Apache-2.0');
      expect(CHAT_PINS.models[id].repo).toBe(LOCAL_MODELS[id].repo);
    }
  });

  it('defaults to the small copy', () => {
    expect(defaultVariantFor('qwen2.5-vl-7b')).toBe('q4');
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
    modelId: 'qwen2.5-vl-7b',
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
    expect(args[args.indexOf('--alias') + 1]).toBe('qwen2.5-vl-7b');
    expect(args[args.indexOf('--port') + 1]).toBe('8123');
    expect(args[args.indexOf('--ctx-size') + 1]).toBe('32768');
  });

  it('turns tool calls on with the tools-capable template', () => {
    const args = localModelArgs(spec, 8123);
    expect(args).toContain('--jinja');
    expect(args[args.indexOf('--chat-template') + 1]).toBe(
      QWEN_VL_CHAT_TEMPLATE,
    );
    expect(QWEN_VL_CHAT_TEMPLATE).toContain('<tool_call>');
    expect(QWEN_VL_CHAT_TEMPLATE).toContain('tools');
    expect(args).not.toContain('--reasoning');
  });

  it('asks for flash attention and every layer', () => {
    const args = localModelArgs(spec, 8123);
    expect(args[args.indexOf('--flash-attn') + 1]).toBe('on');
    // The pinned archive is a Vulkan or Metal build; 999 asks for every layer,
    // and llama.cpp falls back to the CPU backend when there is no device.
    expect(args[args.indexOf('--n-gpu-layers') + 1]).toBe('999');
    expect(args).toContain('--no-ui');
  });

  it('carries the sampling recipe', () => {
    const args = localModelArgs(spec, 8123);
    expect(args[args.indexOf('--temp') + 1]).toBe('0.2');
    expect(args[args.indexOf('--top-k') + 1]).toBe('50');
    expect(args[args.indexOf('--repeat-penalty') + 1]).toBe('1.05');
  });

  it('omits the projector until the encoder is downloaded', () => {
    const noEncoder: LocalModelSpec = {
      ...spec,
      files: {...spec.files, projectorPresent: false},
    };
    expect(localModelArgs(noEncoder, 8123)).not.toContain('--mmproj');
  });
});
