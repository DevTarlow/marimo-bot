/**
 * One more search window after DuckDuckGo's anti-bot challenge.
 *
 * The challenge is intermittent: the same query and the same hidden window
 * sometimes get the interstitial and sometimes get results, and the model was
 * the thing retrying by asking for a second search. A retry inside the provider
 * is cheaper and more reliable than hoping the model tries again — it is one
 * window, one short wait, and the same query.
 *
 * Exactly one retry. Two refusals in a row are reported as a refusal; a loop
 * would turn a rate-limit into a burst of requests from the same machine.
 * The overall request signal is the tool's timeout, so a retry that would run
 * past it is not started, and an abort during the wait ends the same way.
 */
import {CHALLENGE_ERROR} from './parse.js';

export interface SearchRetryOptions {
  /** The tool's overall timeout; a retry respects an abort before or during the wait. */
  signal?: AbortSignal;
  /** How long to wait before the second window. */
  delayMs?: number;
  /** Called once when the first attempt is a challenge, before the wait. */
  onRetry?: () => void;
}

/**
 * A short wait for a rate-limit to clear, and short enough that the second
 * attempt still has room inside the tool's twenty-second budget.
 */
const RETRY_DELAY_MS = 600;

export async function withChallengeRetry<T>(
  attempt: () => Promise<T>,
  options: SearchRetryOptions = {},
): Promise<T> {
  try {
    return await attempt();
  } catch (error) {
    if (!isChallenge(error) || aborted(options.signal)) {
      throw error;
    }
    options.onRetry?.();
    await delay(options.delayMs ?? RETRY_DELAY_MS, options.signal);
    if (aborted(options.signal)) {
      throw new Error('web search aborted');
    }
    return await attempt();
  }
}

function isChallenge(error: unknown): boolean {
  return error instanceof Error && error.message === CHALLENGE_ERROR;
}

function aborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (aborted(signal)) {
    return Promise.reject(new Error('web search aborted'));
  }
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error('web search aborted'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, {once: true});
  });
}
