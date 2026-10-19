/**
 * The v2 tool contract.
 *
 * A tool is data: a name, a description, a zod schema, whether it needs a Space
 * or a service, and a function that returns an outcome. It does not know about
 * ADK or about confirmation calls. The engine's ADK adapter wraps these into the
 * framework's tools; a test can call one directly.
 *
 * The outcome is explicit rather than a thrown error because a tool failure is
 * something the model has to see and reason about, not something that ends the
 * turn. `ok: false` is a result the model can act on.
 */
import type {ZodObject, ZodRawShape} from 'zod';

import type {GateRule} from '../harness/spec.js';
import type {MemoryStore} from '../memory/memory-store.js';

export type ToolOutcome =
  {ok: true; result: unknown} | {ok: false; result: string};

export interface SkillSummary {
  name: string;
  description: string;
}

export interface SkillLoad {
  skill?: {name: string; description: string; instructions: string};
  names: string[];
}

export interface SkillSaveInput {
  name: string;
  description: string;
  instructions: string;
}

/** The granted-skill surface a tool may use, bound to one profile by the caller. */
export interface SkillToolService {
  load(name: string): Promise<SkillLoad>;
  save(input: SkillSaveInput): Promise<{name: string; updated: boolean}>;
}

export interface DelegationRequest {
  agent: string;
  task: string;
}

export interface DelegationResult {
  ok: boolean;
  result: string;
}

export interface ToolContext {
  workspaceRoot: string;
  signal: AbortSignal;
  /** Present only when this turn has a memory store. */
  memory?: MemoryStore;
  /** Present only when this profile may load and save skills. */
  skills?: SkillToolService;
  /** Present only when this runtime can reach another bot. */
  delegate?: (request: DelegationRequest) => Promise<DelegationResult>;
}

export interface ToolDefinition<Args = unknown> {
  name: string;
  description: string;
  parameters: ZodObject<ZodRawShape>;
  /** Absent means `never`; the harness's policy is consulted by the adapter. */
  gate?: GateRule;
  /** A tool that cannot work without a Space is not offered without one. */
  requiresWorkspace?: boolean;
  /** A tool that needs memory is absent when the turn has no store. */
  requiresMemory?: boolean;
  /** A tool that needs skills is absent when the profile has no library. */
  requiresSkills?: boolean;
  /** A tool that needs another bot is absent when delegation is unavailable. */
  requiresDelegate?: boolean;
  execute(args: Args, context: ToolContext): Promise<ToolOutcome>;
}

export type AnyToolDefinition = ToolDefinition<Record<string, unknown>>;

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
