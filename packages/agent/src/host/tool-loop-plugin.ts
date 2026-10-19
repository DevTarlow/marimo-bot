/**
 * Loop breaking for a small model, in code rather than in the prompt.
 *
 * The failure this exists for is on disk: a `Qwen3-1.7B` turn that called
 * `web_search` and `read_file` alternately with byte-identical arguments until
 * the context was spent, and then ended on reasoning with no answer at all — the
 * user saw nothing. The reasoning skill already tells the model not to repeat
 * itself, and a prompt is the first thing a model this size loses.
 *
 * So the count lives here, keyed by invocation — one turn — and the escalation is
 * the part the model is worst at doing for itself:
 *
 *   1st call   run it.
 *   2nd call   run it, and append a warning to the result. A repeat is sometimes
 *              legitimate (`git status` at the start of a turn and again at the
 *              end), so this one still runs and is told what it did rather than
 *              stopped from doing it.
 *   3rd call   refuse it without running. The result says the call was a repeat
 *              and to answer the user with what it already has.
 *
 * Refusing is the point. A tool result is the one channel a small model reliably
 * reads — it is a function response, not more instruction — so a refusal is
 * something it has to respond to. The turn then ends, and the never-silent guard
 * in `agent-host.ts` sits behind this one so a loop cannot turn into silence.
 *
 * `adk_request_confirmation` is deliberately not counted. It is not the model
 * calling a tool: it is the model asking the user a question, and two rounds of
 * the same question are two different calls with two different ids.
 */
import {BasePlugin, REQUEST_CONFIRMATION_FUNCTION_CALL_NAME} from '@google/adk';
import type {BaseTool, Context} from '@google/adk';

import {callFingerprint} from './call-fingerprint.js';

/**
 * The call number that is refused rather than run.
 *
 * Three, not two, because the second identical call is allowed through — see the
 * note above. The refusal is what actually stops a loop; the warning is what
 * usually stops it one call earlier, which is why both exist.
 */
export const REFUSE_REPEAT_AT = 3;

/**
 * How many invocations' worth of counts to keep.
 *
 * A turn is one invocation, and this app runs one turn at a time, so the live
 * entry is the only one that matters. The bound is here so a long-lived window
 * cannot grow a map forever one turn at a time; the oldest is dropped, which is
 * always a finished turn because insertion order is turn order.
 */
const REMEMBERED_INVOCATIONS = 8;

export class RepeatedToolCallPlugin extends BasePlugin {
  /** invocationId → fingerprint → how many times it has been called. */
  private readonly counts = new Map<string, Map<string, number>>();

  constructor(private readonly refuseAt: number = REFUSE_REPEAT_AT) {
    super('repeated_tool_calls');
  }

  override async beforeToolCallback(params: {
    tool: BaseTool;
    toolArgs: Record<string, unknown>;
    toolContext: Context;
  }): Promise<Record<string, unknown> | undefined> {
    const {tool, toolArgs, toolContext} = params;
    if (tool.name === REQUEST_CONFIRMATION_FUNCTION_CALL_NAME) {
      return undefined;
    }

    const count = this.count(toolContext.invocationId, tool.name, toolArgs);
    if (count < this.refuseAt) {
      return undefined;
    }

    /*
     * Returned as `error` rather than `result` on purpose: the call did not
     * happen, and marking it failed is what makes the window draw it as a call
     * that was refused instead of one that quietly returned something odd.
     */
    return {error: refusalNotice(tool.name, count)};
  }

  override async afterToolCallback(params: {
    tool: BaseTool;
    toolArgs: Record<string, unknown>;
    toolContext: Context;
    result: Record<string, unknown>;
  }): Promise<Record<string, unknown> | undefined> {
    const {tool, toolArgs, toolContext, result} = params;
    if (tool.name === REQUEST_CONFIRMATION_FUNCTION_CALL_NAME) {
      return undefined;
    }

    // Read, never counted: `beforeToolCallback` already counted this call, and
    // counting again here would make the second call look like the third.
    const count = this.peek(toolContext.invocationId, tool.name, toolArgs);
    if (count !== this.refuseAt - 1) {
      return undefined;
    }
    return withWarning(result, repeatWarning(tool.name, count));
  }

  private count(
    invocationId: string,
    name: string,
    args: Record<string, unknown>,
  ): number {
    let turn = this.counts.get(invocationId);
    if (turn === undefined) {
      turn = new Map();
      this.counts.set(invocationId, turn);
      while (this.counts.size > REMEMBERED_INVOCATIONS) {
        const oldest = this.counts.keys().next().value;
        if (oldest === undefined) {
          break;
        }
        this.counts.delete(oldest);
      }
    }

    const key = callFingerprint(name, args);
    const next = (turn.get(key) ?? 0) + 1;
    turn.set(key, next);
    return next;
  }

  private peek(
    invocationId: string,
    name: string,
    args: Record<string, unknown>,
  ): number {
    return this.counts.get(invocationId)?.get(callFingerprint(name, args)) ?? 0;
  }
}

/**
 * The result with the warning appended to whatever the model reads.
 *
 * The shape here is not the one the event ends up with. `result` is the value
 * the tool itself returned — for a `FunctionTool` that is the plain string its
 * `execute` produced — and ADK wraps it into `{result: ...}` afterwards. So a
 * string is the common case and has to be handled first: spreading one into an
 * object turns the text into character-indexed keys, which is what an earlier
 * version of this did, and the test caught it replacing the result with nothing
 * but the warning.
 *
 * An `error` result keeps its key. A failed call reported as a success would
 * misdescribe what happened, and the model would act on a result it never got.
 */
function withWarning(
  result: unknown,
  warning: string,
): Record<string, unknown> | undefined {
  // A tool that threw has an error the caller is about to be told about, and a
  // warning about repetition is not worth overwriting it.
  if (result === undefined || result === null) {
    return undefined;
  }

  if (typeof result === 'string') {
    return result.length > 0
      ? {result: `${result}\n\n${warning}`}
      : {result: warning};
  }

  if (typeof result === 'object' && !Array.isArray(result)) {
    const record = result as Record<string, unknown>;
    for (const key of ['result', 'error', 'errorMessage'] as const) {
      const value = record[key];
      if (typeof value === 'string' && value.length > 0) {
        return {...record, [key]: `${value}\n\n${warning}`};
      }
    }
    return {...record, result: warning};
  }

  return {result: warning};
}

function repeatWarning(name: string, count: number): string {
  return (
    `[repeated call] This is call ${count} of \`${name}\` in this turn with the ` +
    'same arguments. A repeat returns the same result, so calling it again is ' +
    'wasted work. Use different arguments, call a different tool, or reply to ' +
    'the user with what you already have.'
  );
}

function refusalNotice(name: string, count: number): string {
  return (
    `[repeated call] Refused: \`${name}\` has now been called ${count} times in ` +
    'this turn with identical arguments, and the result will not change. Stop ' +
    'calling tools and reply to the user with the information you already have. ' +
    'If you cannot answer from it, say what is missing and ask for it.'
  );
}
