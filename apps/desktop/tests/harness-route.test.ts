import {describe, expect, it} from 'vitest';

import {shouldUseV2} from '../src/main/harness-route.js';

describe('the conversation engine route', () => {
  it('keeps a conversation with a v2 log on v2', () => {
    expect(
      shouldUseV2({
        hasLog: true,
        addressed: false,
        indexMessageCount: 12,
      }),
    ).toBe(true);
  });

  it('starts a new conversation on v2', () => {
    expect(
      shouldUseV2({
        hasLog: false,
        addressed: false,
        indexMessageCount: 0,
      }),
    ).toBe(true);
  });

  it('keeps a v1 conversation with messages on v1', () => {
    expect(
      shouldUseV2({
        hasLog: false,
        addressed: false,
        indexMessageCount: 3,
      }),
    ).toBe(false);
  });

  it('does not route an addressed turn to v2 without a log', () => {
    expect(
      shouldUseV2({
        hasLog: false,
        addressed: true,
        indexMessageCount: 0,
      }),
    ).toBe(false);
  });

  it('falls back to transcript emptiness for an unknown id', () => {
    expect(
      shouldUseV2({
        hasLog: false,
        addressed: false,
        fallbackEmpty: true,
      }),
    ).toBe(true);
    expect(
      shouldUseV2({
        hasLog: false,
        addressed: false,
        fallbackEmpty: false,
      }),
    ).toBe(false);
  });
});
