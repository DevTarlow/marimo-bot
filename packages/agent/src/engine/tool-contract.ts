/**
 * The v2 tool contract.
 *
 * A tool is data: a name, a description, a zod schema, whether it needs a
 * Space, and a function that returns an outcome. It does not know about ADK or
 * about confirmation calls. The engine's ADK adapter wraps these into the
 * framework's tools; a test can call one directly.
 *
 * The outcome is explicit rather than a thrown error because a tool failure is
 * something the model has to see and reason about, not something that ends the
 * turn. `ok: false` is a result the model can act on.
 */
import type {ZodObject, ZodRawShape} from 'zod';

import type {GateRule} from '../harness/spec.js';

export type ToolOutcome =
  {ok: true; result: unknown} | {ok: false; result: string};

export interface ToolContext {
  workspaceRoot: string;
  signal: AbortSignal;
}

export interface ToolDefinition<Args = unknown> {
  name: string;
  description: string;
  parameters: ZodObject<ZodRawShape>;
  /** Absent means `never`; the harness's policy is consulted by the adapter. */
  gate?: GateRule;
  /** A tool that cannot work without a Space is not offered without one. */
  requiresWorkspace?: boolean;
  execute(args: Args, context: ToolContext): Promise<ToolOutcome>;
}

export function outcome(ok: true, result: unknown): ToolOutcome;
export function outcome(ok: false, result: string): ToolOutcome;
export function outcome(ok: boolean, result: unknown): ToolOutcome;
export function outcome(ok: boolean, result: unknown): ToolOutcome {
  return ok
    ? {ok: true, result}
    : {ok: false, result: typeof result === 'string' ? result : String(result)};
}

/** A sentence a model can read, never a stack trace. */
export function describeToolError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
