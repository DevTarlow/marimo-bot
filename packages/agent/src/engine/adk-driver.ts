/**
 * The real driver: ADK on one side, the engine's events on the other.
 *
 * This file is the only place the v2 core imports `@google/adk`. The engine does
 * not know what an ADK event is, and ADK does not know that a turn is a log. The
 * adapter rebuilds an in-memory ADK session from the canonical history, runs the
 * agent, and translates what comes back.
 *
 * The history translation is the load-bearing part. A gated tool in ADK is two
 * events — the original call, then an `adk_request_confirmation` call carrying
 * it — and the approval is a function response to the second. The canonical log
 * records the same thing with both ids, so a resumed turn can be rebuilt exactly
 * rather than approximated.
 */
import {
  createEvent,
  FunctionTool,
  InMemorySessionService,
  LlmAgent,
  REQUEST_CONFIRMATION_FUNCTION_CALL_NAME,
  Runner,
  StreamingMode,
} from '@google/adk';
import type {BaseLlm} from '@google/adk';
import type {Content, Part} from '@google/genai';
import {stat} from 'node:fs/promises';

import type {GateRule, HarnessSpec} from '../harness/spec.js';
import {
  composeHarnessInstruction,
  type HarnessPromptContext,
} from '../context/instruction.js';
import {resolveInsideWorkspace} from '../tools/paths.js';
import {gateFor, toolsFor, type AnyToolDefinition} from './core-tools.js';
import type {
  DriverEvent,
  DriverResume,
  DriverRun,
  TurnDriver,
} from './driver.js';
import {turnIdOf} from './events.js';
import type {SessionEvent, TokenUsage} from './events.js';
import {
  describeToolError,
  type ToolContext,
  type ToolOutcome,
} from './tool-contract.js';

export interface AdkDriverOptions {
  /** Builds the model client for a harness. May throw if a key is missing. */
  resolveModel: (harness: HarnessSpec) => BaseLlm;
  /** Injected for tests; the app uses the v2 core tool set. */
  toolDefinitions?: (harness: HarnessSpec) => readonly AnyToolDefinition[];
  /** The turn's memory and skill index, read fresh for each request. */
  promptContext?: (
    harness: HarnessSpec,
  ) => HarnessPromptContext | Promise<HarnessPromptContext>;
  /** The services tools may use this turn. */
  toolContext?: (
    harness: HarnessSpec,
    signal: AbortSignal,
  ) => ToolContext | Promise<ToolContext>;
  appName?: string;
  userId?: string;
}

const DEFAULT_APP_NAME = 'marimo';
const DEFAULT_USER_ID = 'local';
/**
 * A hard ceiling on the history replayed into ADK.
 *
 * The canonical log keeps everything; this is only what the provider sees. A
 * turn that outgrows the window would otherwise fail with a provider error, so
 * the oldest turns are dropped and a note says so. A model summary is the better
 * answer and is what compaction should become; this is the failure it replaces.
 */
const MAX_HISTORY_CHARS = 240_000;
const MAX_HISTORY_EVENTS = 600;

const GATE_STRENGTH: Record<GateRule, number> = {
  never: 0,
  'on-overwrite': 1,
  'on-untrusted-server': 1,
  always: 2,
};

function strongerGate(left: GateRule, right: GateRule): GateRule {
  return GATE_STRENGTH[right] >= GATE_STRENGTH[left] ? right : left;
}

/**
 * The name ADK sees for an agent. The display name can be anything a person
 * typed; ADK's agent names are identifiers.
 */
export function adkAgentName(id: string): string {
  return `a_${id.replace(/[^A-Za-z0-9_]/g, '_')}`;
}

export class AdkDriver implements TurnDriver {
  private readonly options: AdkDriverOptions;
  private readonly appName: string;
  private readonly userId: string;

  constructor(options: AdkDriverOptions) {
    this.options = options;
    this.appName = options.appName ?? DEFAULT_APP_NAME;
    this.userId = options.userId ?? DEFAULT_USER_ID;
  }

  async *run(input: DriverRun): AsyncGenerator<DriverEvent> {
    /*
     * The engine's history already contains this turn's user message, because
     * the log is written before the driver starts. The new message is passed to
     * ADK separately, so the opening events are not replayed twice.
     */
    const history = input.history.filter(
      (event) => turnIdOf(event) !== input.turnId,
    );
    const sessions = await this.sessionsFrom(
      input.sessionId,
      history,
      input.harness,
    );
    const context = await this.toolContextFor(input.harness, input.signal);
    const runner = this.runnerFor(
      input.harness,
      sessions,
      context,
      input.instruction,
    );
    yield* this.stream(runner, {
      sessionId: input.sessionId,
      harness: input.harness,
      signal: input.signal,
      message: {role: 'user', parts: [{text: input.text}]},
    });
  }

  async *resume(input: DriverResume): AsyncGenerator<DriverEvent> {
    const justDecided = new Set(
      input.decisions.map((decision) => decision.callId),
    );
    const history = input.history.filter(
      (event) =>
        !(event.type === 'approval.decided' && justDecided.has(event.callId)),
    );
    const parts = confirmationParts(history, input.decisions);
    if (parts.length === 0) {
      yield {
        type: 'error',
        message: 'There is no approval to resume; the conversation moved on.',
      };
      return;
    }
    const sessions = await this.sessionsFrom(
      input.sessionId,
      history,
      input.harness,
    );
    const context = await this.toolContextFor(input.harness, input.signal);
    const runner = this.runnerFor(
      input.harness,
      sessions,
      context,
      input.instruction,
    );
    yield* this.stream(runner, {
      sessionId: input.sessionId,
      harness: input.harness,
      signal: input.signal,
      message: {role: 'user', parts},
    });
  }

  private async sessionsFrom(
    sessionId: string,
    history: readonly SessionEvent[],
    harness: HarnessSpec,
  ): Promise<InMemorySessionService> {
    const service = new InMemorySessionService();
    const session = await service.createSession({
      appName: this.appName,
      userId: this.userId,
      sessionId,
    });
    const capped = capHistory(history);
    if (capped.omitted) {
      const note = createEvent({
        invocationId: 'history',
        timestamp: Date.now(),
        author: 'user',
        content: {
          role: 'user',
          parts: [
            {
              text:
                'Earlier parts of this conversation were omitted from the prompt ' +
                'to fit the model window. The full log is still on disk; ask the ' +
                'person if you need a detail from before this point.',
            },
          ],
        },
      });
      await service.appendEvent({session, event: note});
    }
    for (const event of capped.events) {
      const mapped = this.historyEvent(event, harness);
      if (mapped !== undefined) {
        await service.appendEvent({session, event: mapped});
      }
    }
    return service;
  }

  private historyEvent(
    event: SessionEvent,
    harness: HarnessSpec,
  ): ReturnType<typeof createEvent> | undefined {
    const author = adkAgentName(harness.id);
    const at = Date.parse(event.at);
    const timestamp = Number.isNaN(at) ? Date.now() : at;
    const turnId = turnIdOf(event);
    const invocationId = turnId ?? 'history';
    const base = {invocationId, timestamp};

    switch (event.type) {
      case 'user.message':
        return createEvent({
          ...base,
          author: 'user',
          content: {role: 'user', parts: [{text: event.text}]},
        });
      case 'assistant.message': {
        const parts: Part[] = [];
        if (event.reasoning !== undefined && event.reasoning.length > 0) {
          parts.push({text: event.reasoning, thought: true});
        }
        parts.push({text: event.text});
        return createEvent({
          ...base,
          author,
          content: {role: 'model', parts},
        });
      }
      case 'tool.call':
        return createEvent({
          ...base,
          author,
          content: {
            role: 'model',
            parts: [
              {
                functionCall: {
                  id: event.callId,
                  name: event.tool,
                  args: event.args,
                },
              },
            ],
          },
        });
      case 'approval.requested':
        return createEvent({
          ...base,
          author,
          content: {
            role: 'model',
            parts: [
              {
                functionCall: {
                  id: event.confirmationId ?? event.callId,
                  name: REQUEST_CONFIRMATION_FUNCTION_CALL_NAME,
                  args: {
                    originalFunctionCall: {
                      id: event.callId,
                      name: event.tool,
                      args: event.args,
                    },
                    toolConfirmation: {
                      hint: event.hint ?? '',
                      confirmed: false,
                    },
                  },
                },
              },
            ],
          },
        });
      case 'approval.decided':
        return createEvent({
          ...base,
          author: 'user',
          content: {
            role: 'user',
            parts: [
              {
                functionResponse: {
                  id: event.confirmationId ?? event.callId,
                  name: REQUEST_CONFIRMATION_FUNCTION_CALL_NAME,
                  response: {
                    confirmed: event.confirmed,
                    ...(event.payload === undefined
                      ? {}
                      : {payload: event.payload}),
                  },
                },
              },
            ],
          },
        });
      case 'tool.result':
        return createEvent({
          ...base,
          author,
          content: {
            role: 'user',
            parts: [
              {
                functionResponse: {
                  id: event.callId,
                  name: event.tool,
                  response: event.ok
                    ? {result: event.result}
                    : {
                        error:
                          typeof event.result === 'string'
                            ? event.result
                            : JSON.stringify(event.result),
                      },
                },
              },
            ],
          },
        });
      case 'session.created':
      case 'turn.started':
      case 'turn.completed':
      case 'turn.failed':
      case 'turn.aborted':
      case 'summary':
        return undefined;
    }
  }

  private runnerFor(
    harness: HarnessSpec,
    sessions: InMemorySessionService,
    context: ToolContext,
    instruction: string | undefined,
  ): Runner {
    const agent = new LlmAgent({
      name: adkAgentName(harness.id),
      description: harness.identity.role.slice(0, 200) || harness.identity.name,
      model: this.options.resolveModel(harness),
      /*
       * Read per request rather than once per turn: a memory write or a saved
       * skill should reach the very next request, which is the sentence those
       * tools give the model. The frozen spec does not move; what it is
       * surrounding itself with does.
       */
      instruction: async () => {
        const prompt = (await this.options.promptContext?.(harness)) ?? {};
        return composeHarnessInstruction(harness, {
          ...prompt,
          ...(instruction === undefined ? {} : {instruction}),
        });
      },
      tools: this.buildTools(harness, context),
    });
    return new Runner({
      appName: this.appName,
      agent,
      sessionService: sessions,
    });
  }

  private async toolContextFor(
    harness: HarnessSpec,
    signal: AbortSignal,
  ): Promise<ToolContext> {
    return (
      (await this.options.toolContext?.(harness, signal)) ?? {
        workspaceRoot: harness.workspaceRoot ?? '',
        signal,
      }
    );
  }

  private buildTools(
    harness: HarnessSpec,
    context: ToolContext,
  ): FunctionTool<never>[] {
    const definitions =
      this.options.toolDefinitions?.(harness) ??
      toolsFor(harness, {
        memory: context.memory !== undefined,
        skills: context.skills !== undefined,
        delegate: context.delegate !== undefined,
        task: context.delegateTask !== undefined,
        jobs: context.jobs !== undefined,
        webSearch: context.webSearch !== undefined,
      });
    return definitions.map((definition) => {
      const rule = strongerGate(
        definition.gate ?? 'never',
        gateFor(harness, definition.name),
      );
      return new FunctionTool({
        name: definition.name,
        description: definition.description,
        parameters: definition.parameters,
        requireConfirmation: this.confirmationFor(rule, harness),
        execute: async (
          args: Record<string, unknown>,
        ): Promise<ToolOutcome> => {
          try {
            return await definition.execute(args, context);
          } catch (error) {
            return {ok: false, result: describeToolError(error)};
          }
        },
      }) as unknown as FunctionTool<never>;
    });
  }

  private confirmationFor(
    rule: GateRule,
    harness: HarnessSpec,
  ): boolean | ((args: Record<string, unknown>) => boolean | Promise<boolean>) {
    if (rule === 'always' || rule === 'on-untrusted-server') {
      return true;
    }
    if (rule !== 'on-overwrite') {
      return false;
    }
    /*
     * `on-overwrite` is a gate over the arguments: creating a file is safe and
     * replacing one is not. The predicate is evaluated again when an approval
     * resumes the call, so the file can have changed while the card was open.
     */
    return async (args: Record<string, unknown>): Promise<boolean> => {
      const candidate = args.path;
      if (
        typeof candidate !== 'string' ||
        harness.workspaceRoot === undefined
      ) {
        return false;
      }
      try {
        const target = await resolveInsideWorkspace(
          harness.workspaceRoot,
          candidate,
        );
        return (await stat(target)).isFile();
      } catch {
        return false;
      }
    };
  }

  private async *stream(
    runner: Runner,
    input: {
      sessionId: string;
      harness: HarnessSpec;
      signal: AbortSignal;
      message: Content;
    },
  ): AsyncGenerator<DriverEvent> {
    let text = '';
    let reasoning = '';
    let sawTextPartial = false;
    let awaitingStep = false;
    let callCounter = 0;
    const emittedCalls = new Set<string>();

    yield {type: 'step'};

    for await (const event of runner.runAsync({
      userId: this.userId,
      sessionId: input.sessionId,
      newMessage: input.message,
      runConfig: {streamingMode: StreamingMode.SSE},
      abortSignal: input.signal,
    })) {
      if (input.signal.aborted) {
        return;
      }

      const usage = usageOf(event);
      if (usage !== undefined) {
        yield {type: 'usage', usage};
      }
      if (event.errorCode !== undefined || event.errorMessage !== undefined) {
        yield {
          type: 'error',
          ...(event.errorCode === undefined ? {} : {code: event.errorCode}),
          message: event.errorMessage ?? 'The model reported an error.',
        };
        return;
      }

      const parts = event.content?.parts ?? [];
      const confirmation = parts.some(
        (part) =>
          part.functionCall?.name === REQUEST_CONFIRMATION_FUNCTION_CALL_NAME,
      );
      const modelContent = parts.some(
        (part) =>
          typeof part.text === 'string' ||
          (part.functionCall !== undefined && !confirmation),
      );
      if (awaitingStep && modelContent) {
        yield {type: 'step'};
        awaitingStep = false;
      }

      const calls: DriverEvent[] = [];

      for (const part of parts) {
        if (part.thought === true && typeof part.text === 'string') {
          if (event.partial === true) {
            reasoning += part.text;
            yield {type: 'reasoning', text: part.text, partial: true};
          } else if (reasoning.length === 0) {
            reasoning = part.text;
          }
          continue;
        }
        if (typeof part.text === 'string' && part.text.length > 0) {
          if (event.partial === true) {
            text += part.text;
            sawTextPartial = true;
            yield {type: 'text', text: part.text, partial: true};
          } else if (text.length === 0) {
            text = part.text;
          }
          continue;
        }
        const call = part.functionCall;
        if (call !== undefined) {
          if (call.name === REQUEST_CONFIRMATION_FUNCTION_CALL_NAME) {
            const original = originalCallOf(call.args);
            const callId =
              original?.id ?? call.id ?? `call_${(callCounter += 1)}`;
            if (!emittedCalls.has(callId)) {
              emittedCalls.add(callId);
              calls.push({
                type: 'tool.call',
                callId,
                tool: original?.name ?? 'unknown',
                args: original?.args ?? {},
              });
            }
            calls.push({
              type: 'approval.request',
              callId,
              ...(call.id === undefined ? {} : {confirmationId: call.id}),
              tool: original?.name ?? 'unknown',
              args: original?.args ?? {},
              ...(original?.hint === undefined ? {} : {hint: original.hint}),
            });
            awaitingStep = true;
            continue;
          }
          const callId = call.id ?? `call_${(callCounter += 1)}`;
          emittedCalls.add(callId);
          calls.push({
            type: 'tool.call',
            callId,
            tool: call.name ?? 'unknown',
            args: call.args ?? {},
          });
          awaitingStep = true;
          continue;
        }
        const response = part.functionResponse;
        if (response !== undefined) {
          if (response.name === REQUEST_CONFIRMATION_FUNCTION_CALL_NAME) {
            continue;
          }
          const callId = response.id ?? `call_${(callCounter += 1)}`;
          const answer = toolAnswer(response.response);
          calls.push({
            type: 'tool.result',
            callId,
            tool: response.name ?? 'unknown',
            ok: answer.ok,
            result: answer.result,
          });
          awaitingStep = true;
        }
      }

      if (event.turnComplete === true) {
        if (text.trim().length > 0 || reasoning.trim().length > 0) {
          yield {
            type: 'message',
            text,
            ...(reasoning.length === 0 ? {} : {reasoning}),
          };
        }
        text = '';
        reasoning = '';
        sawTextPartial = false;
        for (const call of calls) {
          yield call;
        }
      } else {
        for (const call of calls) {
          yield call;
        }
      }
    }

    // A provider that never sends `turnComplete` still owes the engine the text
    // it streamed. Emitting it once at the end is better than losing the reply.
    if (sawTextPartial && text.trim().length > 0) {
      yield {
        type: 'message',
        text,
        ...(reasoning.length === 0 ? {} : {reasoning}),
      };
    }
  }
}

function originalCallOf(args: unknown): {
  id?: string;
  name?: string;
  args?: Record<string, unknown>;
  hint?: string;
} | null {
  if (args === null || typeof args !== 'object') {
    return null;
  }
  const record = args as {
    originalFunctionCall?: {
      id?: string;
      name?: string;
      args?: Record<string, unknown>;
    };
    toolConfirmation?: {hint?: string};
  };
  const original = record.originalFunctionCall;
  if (original === undefined) {
    return null;
  }
  return {
    ...(original.id === undefined ? {} : {id: original.id}),
    ...(original.name === undefined ? {} : {name: original.name}),
    ...(original.args === undefined ? {} : {args: original.args}),
    ...(record.toolConfirmation?.hint === undefined
      ? {}
      : {hint: record.toolConfirmation.hint}),
  };
}

function toolAnswer(response: unknown): {ok: boolean; result: unknown} {
  if (response === null || typeof response !== 'object') {
    return {ok: true, result: response};
  }
  const record = response as {
    result?: unknown;
    error?: unknown;
    ok?: unknown;
  };
  if (record.error !== undefined) {
    return {ok: false, result: record.error};
  }
  /*
   * ADK merges a tool's returned object into the function response rather than
   * nesting it under `result`. Both shapes are accepted here so a tool can
   * return an outcome and a plain string can still be a result.
   */
  if (typeof record.ok === 'boolean') {
    return {ok: record.ok, result: record.result};
  }
  const payload = record.result;
  if (payload !== null && typeof payload === 'object') {
    const outcome = payload as {ok?: unknown; result?: unknown};
    if (typeof outcome.ok === 'boolean') {
      return {ok: outcome.ok, result: outcome.result};
    }
  }
  return {ok: true, result: payload === undefined ? response : payload};
}

function usageOf(event: {
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
}): TokenUsage | undefined {
  const usage = event.usageMetadata;
  if (usage === undefined) {
    return undefined;
  }
  const promptTokens = usage.promptTokenCount ?? 0;
  const completionTokens = usage.candidatesTokenCount ?? 0;
  return {
    promptTokens,
    completionTokens,
    totalTokens: usage.totalTokenCount ?? promptTokens + completionTokens,
  };
}

function confirmationParts(
  history: readonly SessionEvent[],
  decisions: readonly {
    callId: string;
    confirmed: boolean;
    payload?: Record<string, unknown>;
  }[],
): Part[] {
  const parts: Part[] = [];
  for (const decision of decisions) {
    const gate = history.find(
      (event): event is Extract<SessionEvent, {type: 'approval.requested'}> =>
        event.type === 'approval.requested' && event.callId === decision.callId,
    );
    if (gate === undefined) {
      continue;
    }
    parts.push({
      functionResponse: {
        id: gate.confirmationId ?? gate.callId,
        name: REQUEST_CONFIRMATION_FUNCTION_CALL_NAME,
        response: {
          confirmed: decision.confirmed,
          ...(decision.payload === undefined
            ? {}
            : {payload: decision.payload}),
        },
      },
    });
  }
  return parts;
}


function capHistory(history: readonly SessionEvent[]): {
  events: readonly SessionEvent[];
  omitted: boolean;
} {
  let chars = 0;
  let start = history.length;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const event = history[index];
    if (event === undefined) {
      continue;
    }
    if (start < history.length && history.length - index > MAX_HISTORY_EVENTS) {
      break;
    }
    if (start < history.length && chars + eventChars(event) > MAX_HISTORY_CHARS) {
      break;
    }
    chars += eventChars(event);
    start = index;
  }
  if (start === 0) {
    return {events: history, omitted: false};
  }
  const nextUser = history.findIndex(
    (event, index) => index >= start && event.type === 'user.message',
  );
  return {
    events: history.slice(nextUser === -1 ? start : nextUser),
    omitted: true,
  };
}

function eventChars(event: SessionEvent): number {
  switch (event.type) {
    case 'user.message':
      return event.text.length;
    case 'assistant.message':
      return event.text.length + (event.reasoning?.length ?? 0);
    case 'tool.call':
      return JSON.stringify(event.args).length;
    case 'tool.result':
      return JSON.stringify(event.result ?? '').length;
    default:
      return 80;
  }
}
