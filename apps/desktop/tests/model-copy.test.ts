/**
 * When the window is allowed to say the model server cannot call tools.
 *
 * The expensive failure is a false negative: a server that is off has no
 * opinion about tools, and a badge that said "no tools" over a stopped process
 * would send the person looking for the wrong problem. The other half is the
 * button, because a first run that says "Continue" over a bot that cannot touch
 * a file is a promise the next screen breaks.
 */
import {describe, expect, it} from 'vitest';

import type {ModelServerStatus} from '@marimo/protocol';

import {
  cannotCallTools,
  continueLabel,
  TOOLS_OFF_BADGE,
  TOOLS_OFF_CARD,
  TOOLS_OFF_SETUP,
} from '../src/renderer/model-copy.js';

function status(overrides: Partial<ModelServerStatus> = {}): ModelServerStatus {
  return {
    state: 'ready',
    url: 'http://127.0.0.1:8080/v1',
    model: 'some-model.gguf',
    models: ['some-model.gguf'],
    leftOver: [],
    ...overrides,
  };
}

describe('cannotCallTools', () => {
  it('is true for a ready server whose template has no tools block', () => {
    expect(cannotCallTools(status({tools: false}))).toBe(true);
  });

  it('is false when the template renders tools, or does not say', () => {
    expect(cannotCallTools(status({tools: true}))).toBe(false);
    expect(cannotCallTools(status())).toBe(false);
  });

  it('is false while the server is off or failed', () => {
    expect(cannotCallTools(status({state: 'off', tools: false}))).toBe(false);
    expect(cannotCallTools(status({state: 'failed', tools: false}))).toBe(false);
    expect(cannotCallTools(undefined)).toBe(false);
  });
});

describe('continueLabel', () => {
  it('names the trade-off instead of burying it in a warning', () => {
    expect(continueLabel(true)).toBe('Continue without tools');
    expect(continueLabel(false)).toBe('Continue');
  });
});

describe('the tools-off sentences', () => {
  it('name the consequence in every place a person reads it', () => {
    for (const sentence of [TOOLS_OFF_CARD, TOOLS_OFF_SETUP]) {
      expect(sentence).toContain('template');
      expect(sentence).toMatch(/files/u);
      expect(sentence).toMatch(/jobs/u);
    }
    expect(TOOLS_OFF_BADGE).toContain('tools');
  });
});
