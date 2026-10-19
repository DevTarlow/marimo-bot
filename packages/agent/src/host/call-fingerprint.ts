/**
 * Identifying one tool call, so "the same call" is decided on the arguments
 * rather than on the model happening to type them in the same order twice.
 *
 * Pulled out of `tool-loop-plugin.ts` when the policy plugin started needing the
 * same answer. The two are not the same *rule* — one refuses a repeat, the other
 * estimates an action's worth — but they are the same *question*, and two
 * implementations of "is this the same call" would eventually disagree about
 * argument order and produce a loop-breaker that does not fire.
 *
 * The separator is a NUL because it cannot appear in a parsed JSON key: without
 * it, a tool named `read_file` with an argument `x` and a tool named `read` with
 * argument `file\u0000x` would fingerprint alike, and a collision here refuses a
 * call the model never repeated.
 */
export function callFingerprint(
  name: string,
  args: Record<string, unknown>,
): string {
  return `${name}\u0000${stable(args)}`;
}

/**
 * A key order that does not depend on how the model typed the object.
 *
 * Recursive on purpose: tool arguments nest, and `{a: {b: 1, c: 2}}` and
 * `{a: {c: 2, b: 1}}` are one call. Sorting only the top level is the version of
 * this that nearly works, and its failure is intermittent — the same call
 * fingerprinted two ways depending on which side of the model's output a nested
 * key landed.
 */
export function stable(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map(stable).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>).sort(
    ([left], [right]) => (left < right ? -1 : left > right ? 1 : 0),
  );
  return `{${entries
    .map(([key, inner]) => `${JSON.stringify(key)}:${stable(inner)}`)
    .join(',')}}`;
}
