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
import {
  CORE_TOOLS,
  gateFor,
  toolsFor,
  type AnyToolDefinition,
} from './core-tools.js';
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

/**
 * The smallest shape of ADK's tool context this driver uses. Kept structural
 * because only the ADK side may name ADK's types.
 */
interface AdkToolContext {
  functionCallId?: string;
  toolConfirmation?: {confirmed: boolean; payload?: Record<string, unknown>};
  requestConfirmation?: (request: {hint?: string}) => void;
  abortSignal?: AbortSignal;
}

/** A bot another bot may ask, and the context its own turn runs with. */
export interface HelperTarget {
  harness: HarnessSpec;
  model: BaseLlm;
  promptContext: HarnessPromptContext;
  toolContext: ToolContext;
  name: string;
}

export interface AdkDriverOptions {
  /** Builds the model client for a harness. May throw if a key is missing. */
  resolveModel: (harness: HarnessSpec) => BaseLlm;
  /** Injected for tests; the app uses the v2 core tool set. */
  toolDefinitions?: (harness: HarnessSpec) => readonly AnyToolDefinition[];
  /**
   * A connector's tools for this harness, read fresh for each turn.
   *
   * Separate from `toolDefinitions` because they are not the app's own tools:
   * they come and go with a server connection, and the caller that owns the
   * manager is the one that knows which are up. They are appended after the
   * built-ins so a built-in name always wins, and the reserved-name check in
   * the manager is what keeps the two lists from meeting.
   */
  mcpTools?: (harness: HarnessSpec) => readonly AnyToolDefinition[];
  /** The turn's memory and skill index, read fresh for each request. */
  promptContext?: (
    harness: HarnessSpec,
  ) => HarnessPromptContext | Promise<HarnessPromptContext>;
  /** The services tools may use this turn. */
  toolContext?: (
    harness: HarnessSpec,
    signal: AbortSignal,
    turnId?: string,
  ) => ToolContext | Promise<ToolContext>;
  /** The ADK session a parked helper left behind, when one exists. */
  resumeSessions?: (sessionId: string) => unknown;
  /** Remembers the ADK session of a parked helper for the approval resume. */
  rememberSessions?: (sessionId: string, sessions: unknown) => void;
  /** Resolves a helper by the name the parent used. */
  resolveHelper?: (
    agent: string,
    signal: AbortSignal,
  ) => Promise<HelperTarget | {problem: string}>;
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
    const cached = this.options.resumeSessions?.(input.sessionId);
    const sessions =
      cached === undefined
        ? await this.sessionsFrom(input.sessionId, history, input.harness)
        : (cached as InMemorySessionService);
    const context = await this.toolContextFor(
      input.harness,
      input.signal,
      input.turnId,
    );
    const runner = this.runnerFor(
      input.harness,
      sessions,
      context,
      input.instruction,
      input.sessionId,
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
    const cached = this.options.resumeSessions?.(input.sessionId);
    const sessions =
      cached === undefined
        ? await this.sessionsFrom(input.sessionId, history, input.harness)
        : (cached as InMemorySessionService);
    const context = await this.toolContextFor(
      input.harness,
      input.signal,
      input.turnId,
    );
    const runner = this.runnerFor(
      input.harness,
      sessions,
      context,
      input.instruction,
      input.sessionId,
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
    /*
     * A summary stands in for everything through its `coversThrough` event. The
     * events before that are still in the canonical log for the window and for
     * audit; they are not replayed into the provider, or compaction would cost a
     * model call and change nothing.
     */
    const summary = [...history].reverse().find((event) => event.type === 'summary');
    const through =
      summary === undefined
        ? -1
        : history.findIndex((event) => event.id === summary.coversThrough);
    const working =
      summary === undefined || through === -1
        ? history
        : history.filter(
            (event, index) => index > through && event.type !== 'summary',
          );
    if (summary !== undefined && through !== -1) {
      await service.appendEvent({
        session,
        event: createEvent({
          invocationId: 'summary',
          timestamp: Date.now(),
          author: 'user',
          content: {
            role: 'user',
            parts: [
              {
                text: `[Conversation so far — summary]\n${summary.text}`,
              },
            ],
          },
        }),
      });
    }
    const capped = capHistory(working);
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
      case 'task.result': {
        /*
         * A task's posted result is part of the conversation's history. It is a
         * model message from the other bot, prefixed so the parent can tell it
         * from its own words; without it a later question about the task has no
         * answer in the window's context.
         */
        const prefix = event.ok ? '' : 'The task is waiting or failed: ';
        return createEvent({
          ...base,
          author: event.agentName,
          content: {
            role: 'model',
            parts: [
              {
                text: `[Task result from ${event.agentName}]\n${prefix}${event.text}`,
              },
            ],
          },
        });
      }
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
    sessionId: string,
    promptContext?: HarnessPromptContext,
    omitTools?: ReadonlySet<string>,
    model?: BaseLlm,
  ): Runner {
    const agent = new LlmAgent({
      name: adkAgentName(harness.id),
      description: harness.identity.role.slice(0, 200) || harness.identity.name,
      model: model ?? this.options.resolveModel(harness),
      /*
       * Read per request rather than once per turn: a memory write or a saved
       * skill should reach the very next request, which is the sentence those
       * tools give the model. The frozen spec does not move; what it is
       * surrounding itself with does.
       */
      instruction: async () => {
        const prompt =
          promptContext ??
          (await this.options.promptContext?.(harness)) ??
          {};
        return composeHarnessInstruction(harness, {
          ...prompt,
          catalogue: this.requestCatalogue(harness),
          ...(instruction === undefined ? {} : {instruction}),
        });
      },
      tools: this.buildTools(harness, context, sessions, sessionId, omitTools),
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
    turnId?: string,
  ): Promise<ToolContext> {
    return (
      (await this.options.toolContext?.(harness, signal, turnId)) ?? {
        workspaceRoot: harness.workspaceRoot ?? '',
        signal,
      }
    );
  }

  /**
   * Runs one helper inside the parent's ADK session.
   *
   * The helper is a real ADK agent with its own tools, so a gate it hits ends its
   * invocation. This tool then raises a parent card and, on approval, wakes the
   * helper with the confirmation response for the exact call it stopped on — the
   * same handoff the old host did, now without a second session service.
   */
  private async runHelper(
    args: Record<string, unknown>,
    adk: AdkToolContext,
    sessions: InMemorySessionService,
    sessionId: string,
    signal: AbortSignal,
  ): Promise<ToolOutcome> {
    const agent = String(args.agent ?? '').trim();
    const task = String(args.task ?? '').trim();
    if (agent.length === 0 || task.length === 0) {
      return {ok: false, result: 'ask_agent needs a bot name and a task.'};
    }
    if (this.options.resolveHelper === undefined) {
      return {ok: false, result: 'There is no other bot to ask in this turn.'};
    }

    let target: HelperTarget;
    try {
      const resolved = await this.options.resolveHelper(agent, signal);
      if ('problem' in resolved) {
        return {ok: false, result: resolved.problem};
      }
      target = resolved;
    } catch (error) {
      return {ok: false, result: describeToolError(error)};
    }

    const callId = adk.functionCallId ?? 'ask_agent';
    const decision = adk.toolConfirmation;
    const gate =
      decision === undefined
        ? undefined
        : (
            await this.helperGates(
              sessions,
              sessionId,
              adkAgentName(target.harness.id),
              callId,
            )
          )[0];
    const parts: Part[] = [];
    if (gate !== undefined && decision !== undefined) {
      parts.push({
        functionResponse: {
          id: gate.id,
          name: REQUEST_CONFIRMATION_FUNCTION_CALL_NAME,
          response: {
            confirmed: decision.confirmed,
            ...(decision.payload === undefined
              ? {}
              : {payload: decision.payload}),
          },
        },
      });
    } else if (decision !== undefined) {
      /*
       * A store that cannot name the gate is still worth waking: the task is
       * repeated so the helper has not lost what it was approved to do.
       */
      const news = decision.confirmed
        ? 'The user approved this. Carry on and finish the task, then report the result.'
        : 'The user declined this. Stop and say what you had done so far.';
      parts.push({text: `${news}

Your task:
${task}`});
    } else {
      parts.push({text: task});
    }

    const runner = this.runnerFor(
      target.harness,
      sessions,
      target.toolContext,
      undefined,
      sessionId,
      target.promptContext,
      new Set(['ask_agent']),
      target.model,
    );

    let answer = '';
    let streamed = false;
    try {
      for await (const event of runner.runAsync({
        userId: this.userId,
        sessionId,
        newMessage: {role: 'user', parts},
        runConfig: {streamingMode: StreamingMode.SSE},
        abortSignal: signal,
      })) {
        if (signal.aborted) {
          return {ok: false, result: 'The turn was stopped.'};
        }
        const eventParts = event.content?.parts ?? [];
        const text = eventParts
          .map((part) => part.text ?? '')
          .filter((part) => part.length > 0)
          .join('');
        if (text.length > 0 && event.author === adkAgentName(target.harness.id)) {
          if (event.partial === true) {
            streamed = true;
            answer += text;
          } else {
            if (!streamed) {
              answer = text;
            }
            streamed = false;
          }
        }
      }
    } catch (error) {
      return {
        ok: false,
        result: `The helper "${target.name}" did not finish: ${describeToolError(error)}`,
      };
    }

    const waiting = await this.helperGates(
      sessions,
      sessionId,
      adkAgentName(target.harness.id),
      callId,
    );
    if (waiting.length > 0) {
      this.options.rememberSessions?.(sessionId, sessions);
      adk.requestConfirmation?.({
        hint: `${target.name} wants to continue. Approving lets it carry on where it stopped.`,
      });
      return {
        ok: false,
        result: `Waiting for your approval before "${target.name}" continues.`,
      };
    }
    if (answer.trim().length === 0) {
      return {
        ok: false,
        result: `The helper "${target.name}" finished without producing an answer.`,
      };
    }
    return {ok: true, result: answer.trim()};
  }

  /** The unanswered helper gates raised after one parent ask_agent call. */
  private async helperGates(
    sessions: InMemorySessionService,
    sessionId: string,
    author: string,
    afterCallId: string,
  ): Promise<Array<{id: string; hint?: string}>> {
    const session = await sessions.getSession({
      appName: this.appName,
      userId: this.userId,
      sessionId,
    });
    const events = session?.events ?? [];
    const start = events.findIndex((event) =>
      (event.content?.parts ?? []).some(
        (part) => part.functionCall?.id === afterCallId,
      ),
    );
    if (start < 0) {
      return [];
    }
    const asked = new Map<string, {id: string; hint?: string}>();
    const answered = new Set<string>();
    for (const event of events.slice(start)) {
      for (const part of event.content?.parts ?? []) {
        const call = part.functionCall;
        if (
          event.author === author &&
          call?.name === REQUEST_CONFIRMATION_FUNCTION_CALL_NAME &&
          call.id !== undefined
        ) {
          const args = call.args as
            | {toolConfirmation?: {hint?: string}}
            | undefined;
          asked.set(call.id, {
            id: call.id,
            ...(args?.toolConfirmation?.hint === undefined
              ? {}
              : {hint: args.toolConfirmation.hint}),
          });
        }
        if (part.functionResponse?.id !== undefined) {
          answered.add(part.functionResponse.id);
        }
      }
    }
    return [...asked.values()].filter((entry) => !answered.has(entry.id));
  }

  private buildTools(
    harness: HarnessSpec,
    context: ToolContext,
    sessions: InMemorySessionService,
    sessionId: string,
    omitTools?: ReadonlySet<string>,
  ): FunctionTool<never>[] {
    const definitions = [
      ...(this.options.toolDefinitions?.(harness) ??
        toolsFor(harness, {
          memory: context.memory !== undefined,
          skills: context.skills !== undefined,
          delegate: context.delegate !== undefined,
          task: context.delegateTask !== undefined,
          jobs: context.jobs !== undefined,
          webSearch: context.webSearch !== undefined,
          learning: context.learning !== undefined,
        })),
      ...(this.options.mcpTools?.(harness) ?? []),
    ].filter((definition) => omitTools?.has(definition.name) !== true);
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
          adkContext: unknown,
        ): Promise<ToolOutcome> => {
          try {
            if (
              definition.name === 'ask_agent' &&
              this.options.resolveHelper !== undefined
            ) {
              return await this.runHelper(
                args,
                adkContext as AdkToolContext,
                sessions,
                sessionId,
                context.signal,
              );
            }
            return await definition.execute(args, context);
          } catch (error) {
            return {ok: false, result: describeToolError(error)};
          }
        },
      }) as unknown as FunctionTool<never>;
    });
  }

  /**
   * The capabilities this bot could ask for, in the words the catalogue uses.
   *
   * Only when it has `request_tool`: advertising a list of things the bot cannot
   * request is the prompt-invites-a-call-it-cannot-make failure. The shell is
   * removed here as well as refused by the tool and the runtime, because this is
   * the sentence the model reads before it decides to ask.
   */
  private requestCatalogue(
    harness: HarnessSpec,
  ): Array<{name: string; description: string}> {
    if (!harness.tools.grants.includes('request_tool')) {
      return [];
    }
    const granted = new Set(harness.tools.grants);
    return CORE_TOOLS.filter(
      (tool) =>
        !granted.has(tool.name) &&
        tool.name !== 'run_shell' &&
        tool.name !== 'request_tool' &&
        tool.name !== 'request_connector' &&
        tool.name !== 'propose_policy',
    ).map((tool) => ({
      name: tool.name,
      description: firstSentence(tool.description),
    }));
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


/**
 * The first sentence of a tool description, bounded.
 *
 * The catalogue is paid on every turn, so a full description of every ungranted
 * tool would be a context tax on the one feature that is supposed to reduce the
 * person's explaining. The first sentence is what distinguishes one capability
 * from another; the schema the model gets when it is granted says the rest.
 */
function firstSentence(text: string): string {
  const end = text.indexOf('. ');
  const sentence = (end < 0 ? text : text.slice(0, end + 1)).trim();
  return sentence.length > 140 ? `${sentence.slice(0, 137)}...` : sentence;
}
