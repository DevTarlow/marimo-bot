/**
 * The seam between the turn state machine and whatever produces the model's
 * work.
 *
 * The engine owns the log, the gates, the budgets and the outcome. A driver owns
 * one invocation: ask the model, run the tools it asks for, stream what comes
 * back. Today the only real driver is ADK; a scripted driver is what the tests
 * use and what a future transport would implement.
 *
 * The driver never writes the log. It yields facts; the engine decides which of
 * them are durable, in what order, and what to do when the driver stops at a
 * gate or fails.
 */
import type {AgentModel} from '@marimo/protocol';

import type {SessionEvent, TokenUsage} from './events.js';
import type {HarnessSpec} from '../harness/spec.js';

export interface DriverRun {
  sessionId: string;
  turnId: string;
  profileId: string;
  text: string;
  harness: HarnessSpec;
  /** The conversation as it stood before this turn. */
  history: readonly SessionEvent[];
  signal: AbortSignal;
}

export interface GateDecision {
  callId: string;
  confirmed: boolean;
  payload?: Record<string, unknown>;
}

export interface DriverResume {
  sessionId: string;
  turnId: string;
  profileId: string;
  harness: HarnessSpec;
  /** The conversation including the approval decisions just recorded. */
  history: readonly SessionEvent[];
  decisions: readonly GateDecision[];
  signal: AbortSignal;
}

export type DriverEvent =
  /** One model request. The engine counts these against `maxSteps`. */
  | {type: 'step'}
  | {type: 'text'; text: string; partial: boolean}
  | {type: 'reasoning'; text: string; partial: boolean}
  /**
   * The end of one model response.
   *
   * A response may be followed by tool calls and another response, so the engine
   * cannot persist on the first text it sees. The driver assembles the response
   * and emits this once; partial text before it is for the window only.
   */
  | {type: 'message'; text: string; reasoning?: string}
  | {
      type: 'tool.call';
      callId: string;
      tool: string;
      args: Record<string, unknown>;
    }
  | {
      type: 'tool.result';
      callId: string;
      tool: string;
      ok: boolean;
      result: unknown;
    }
  | {
      type: 'approval.request';
      callId: string;
      tool: string;
      args: Record<string, unknown>;
      hint?: string;
    }
  | {type: 'usage'; usage: TokenUsage}
  | {type: 'error'; message: string; code?: string}
  | {type: 'done'};

export interface TurnDriver {
  run(input: DriverRun): AsyncIterable<DriverEvent>;
  resume(input: DriverResume): AsyncIterable<DriverEvent>;
}

/** The model a turn is actually using, for the log and the trace. */
export type DriverModel = AgentModel;
