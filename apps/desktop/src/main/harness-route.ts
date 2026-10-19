/**
 * Which engine a conversation starts on.
 *
 * A small pure decision, extracted from `AgentService` so the default is a test
 * and not a comment. The rules, in order:
 *
 * - a conversation with a v2 log stays on v2, including a restart;
 * - an addressed turn with no log stays on v1, because a v2 group writes its
 *   participants event before its first message;
 * - a new conversation — a row with no messages — starts on v2;
 * - an id the index does not know falls back to the old transcript's emptiness.
 */
export function shouldUseV2(input: {
  hasLog: boolean;
  addressed: boolean;
  /** The index row's message count, when the row exists. */
  indexMessageCount?: number;
  /** The old transcript's emptiness, when there is no index row. */
  fallbackEmpty?: boolean;
}): boolean {
  if (input.hasLog) {
    return true;
  }
  if (input.addressed) {
    return false;
  }
  if (input.indexMessageCount !== undefined) {
    return input.indexMessageCount === 0;
  }
  return input.fallbackEmpty === true;
}
