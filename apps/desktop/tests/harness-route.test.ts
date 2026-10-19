import {describe, expect, it} from 'vitest';

import {shouldUseV2} from '../src/main/harness-route.js';

describe('the conversation engine route', () => {
  it('keeps a conversation with a v2 log on v2', () => {
    expect(
      shouldUseV2({
        hasLog: true,
        addressed: false,
        escapeHatch: false,
        indexMessageCount: 12,
      }),
    ).toBe(true);
  });

  it('starts a new conversation on v2', () => {
    expect(
      shouldUseV2({
        hasLog: false,
        addressed: false,
        escapeHatch: false,
        indexMessageCount: 0,
      }),
    ).toBe(true);
  });

  it('keeps a v1 conversation with messages on v1', () => {
    expect(
      shouldUseV2({
        hasLog: false,
        addressed: false,
        escapeHatch: false,
        indexMessageCount: 3,
      }),
    ).toBe(false);
  });

  it('does not route an addressed or escape-hatched turn to v2 without a log', () => {
    expect(
      shouldUseV2({
        hasLog: false,
        addressed: true,
        escapeHatch: false,
        indexMessageCount: 0,
      }),
    ).toBe(false);
    expect(
      shouldUseV2({
        hasLog: false,
        addressed: false,
        escapeHatch: true,
        indexMessageCount: 0,
      }),
    ).toBe(false);
  });

  it('falls back to transcript emptiness for an unknown id', () => {
    expect(
      shouldUseV2({
        hasLog: false,
        addressed: false,
        escapeHatch: false,
        fallbackEmpty: true,
      }),
    ).toBe(true);
    expect(
      shouldUseV2({
        hasLog: false,
        addressed: false,
        escapeHatch: false,
        fallbackEmpty: false,
      }),
    ).toBe(false);
  });
});
