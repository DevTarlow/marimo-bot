/**
 * The one retry that makes the search provider's challenge handling useful.
 *
 * The behaviour is small, but it is the difference between a challenge that
 * fails the tool and a challenge the person never sees: the engine can refuse
 * one window and answer the next, and the model used to be the retry. These
 * tests pin the policy — one retry, only for a challenge, never after an abort
 * — without launching a browser.
 */
import {describe, expect, it} from 'vitest';

import {CHALLENGE_ERROR} from '../src/main/search/parse.js';
import {withChallengeRetry} from '../src/main/search/retry.js';

function challenge(): never {
  throw new Error(CHALLENGE_ERROR);
}

describe('withChallengeRetry', () => {
  it('tries once more after a challenge and returns the second answer', async () => {
    let calls = 0;
    let retried = 0;
    const result = await withChallengeRetry(
      async () => {
        calls += 1;
        if (calls === 1) {
          challenge();
        }
        return 'results';
      },
      {
        delayMs: 0,
        onRetry: () => {
          retried += 1;
        },
      },
    );

    expect(result).toBe('results');
    expect(calls).toBe(2);
    expect(retried).toBe(1);
  });

  it('reports a second challenge instead of looping', async () => {
    let calls = 0;
    let retried = 0;
    await expect(
      withChallengeRetry(
        async () => {
          calls += 1;
          challenge();
        },
        {
          delayMs: 0,
          onRetry: () => {
            retried += 1;
          },
        },
      ),
    ).rejects.toThrow(CHALLENGE_ERROR);

    expect(calls).toBe(2);
    expect(retried).toBe(1);
  });

  it('does not retry an ordinary failure', async () => {
    let calls = 0;
    await expect(
      withChallengeRetry(
        async () => {
          calls += 1;
          throw new Error('the search window closed');
        },
        {delayMs: 0},
      ),
    ).rejects.toThrow('the search window closed');

    expect(calls).toBe(1);
  });

  it('does not retry when the tool has already timed out', async () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    await expect(
      withChallengeRetry(
        async () => {
          calls += 1;
          challenge();
        },
        {delayMs: 0, signal: controller.signal},
      ),
    ).rejects.toThrow(CHALLENGE_ERROR);

    expect(calls).toBe(1);
  });

  it('stops when the wait is aborted', async () => {
    const controller = new AbortController();
    let calls = 0;
    await expect(
      withChallengeRetry(
        async () => {
          calls += 1;
          challenge();
        },
        {
          delayMs: 50,
          signal: controller.signal,
          onRetry: () => {
            controller.abort();
          },
        },
      ),
    ).rejects.toThrow('web search aborted');

    expect(calls).toBe(1);
  });
});
