/**
 * The turn state machine.
 *
 * One conversation runs one turn at a time. The engine owns the log, the gates,
 * the budgets and the outcome; the driver owns one model invocation. That split
 * is what makes the state machine testable without a provider, and it is what
 * lets the ADK adapter change without changing what a stored conversation means.
 *
 * The conversation on disk is the state machine. A gate is derived from the log,
 * a new turn abandons the last one's unanswered cards, and a process that
 * restarts can answer a card it never raised. Nothing here holds a paused turn
 * only in memory.
 */
import {randomUUID} from 'node:crypto';

import type {AgentModel} from '@marimo/protocol';

import {harnessHash} from '../harness/version.js';
import type {HarnessSpec} from '../harness/spec.js';
import type {DriverEvent, GateDecision, TurnDriver} from './driver.js';
import type {EventStore} from './event-store.js';
import {
  decisionsIn,
  newestTurnId,
  pendingGatesIn,
  roundDecided,
  turnIdOf,
} from './events.js';
import type {SessionEvent, TokenUsage} from './events.js';

export type EngineUpdate =
  | {type: 'delta'; channel: 'text' | 'reasoning'; text: string}
  | {type: 'event'; event: SessionEvent};

export interface RunParams {
  sessionId: string;
  profileId: string;
  text: string;
  harness: HarnessSpec;
  /** Session metadata, when this turn is the first in a new conversation. */
  session?: {title: string; spaceId?: string};
}

export interface ApproveParams {
  sessionId: string;
  callId: string;
  confirmed: boolean;
  payload?: Record<string, unknown>;
  /**
   * The resolved harness for the turn being resumed.
   *
   * The log records the version and hash, not the whole spec; the runtime owns
   * the version store and resolves it again. Passing it in keeps that ownership
   * where it belongs and means a resume cannot silently run under a newer spec
   * than the turn it is finishing.
   */
  harness: HarnessSpec;
}

export class TurnBusyError extends Error {
  constructor() {
    super('A turn is already running in this conversation.');
    this.name = 'TurnBusyError';
  }
}

export class GateNotFoundError extends Error {
  constructor(callId: string) {
    super(`No approval is waiting for call ${callId}.`);
    this.name = 'GateNotFoundError';
  }
}

interface TurnState {
  turnId: string;
  sessionId: string;
  profileId: string;
  controller: AbortController;
  timedOut: boolean;
  steps: number;
  toolCalls: number;
  gates: Set<string>;
  /** Calls that have been offered and have no result yet. */
  calls: Map<string, string>;
  text: string;
  reasoning: string;
  visibleText: boolean;
  usage?: TokenUsage;
  failure?: {message: string; code?: string};
}

export interface TurnEngineOptions {
  store: EventStore;
  driver: TurnDriver;
  now?: () => Date;
  createId?: () => string;
}

export class TurnEngine {
  private readonly store: EventStore;
  private readonly driver: TurnDriver;
  private readonly now: () => Date;
  private readonly createId: () => string;
  private readonly active = new Map<string, TurnState>();
  /**
   * Sessions with a run or approve that has started but has not yet reached
   * `drive`.
   *
   * `run` and `approve` both await the log before they own the session, so two
   * callers could otherwise pass the busy check together and both append an
   * opening. Reserving the session before the first await is what makes "one
   * turn at a time" a fact rather than a race.
   */
  private readonly starting = new Set<string>();

  constructor(options: TurnEngineOptions) {
    this.store = options.store;
    this.driver = options.driver;
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? (() => randomUUID());
  }

  isRunning(sessionId: string): boolean {
    return this.active.has(sessionId);
  }

  private isBusy(sessionId: string): boolean {
    return this.active.has(sessionId) || this.starting.has(sessionId);
  }

  async pendingGates(
    sessionId: string,
  ): Promise<ReturnType<typeof pendingGatesIn>> {
    return pendingGatesIn(await this.store.read(sessionId));
  }

  /** Stops the turn in flight, if there is one. */
  abort(sessionId: string): boolean {
    const state = this.active.get(sessionId);
    if (state === undefined) {
      return false;
    }
    state.controller.abort();
    return true;
  }

  async *run(params: RunParams): AsyncGenerator<EngineUpdate> {
    if (this.isBusy(params.sessionId)) {
      throw new TurnBusyError();
    }
    this.starting.add(params.sessionId);
    try {
      /*
       * Starting a turn is what abandons the previous one's unanswered cards. The
       * synthetic results are written before the user's new message so the next
       * provider request replays a conversation in which every call was answered.
       */
      await this.closeAbandoned(params.sessionId);
      const before = await this.store.read(params.sessionId);
      const turnId = this.createId();

      const opening: SessionEvent[] = [];
      if (before.length === 0) {
        opening.push({
          ...this.stamp(params.sessionId),
          type: 'session.created',
          profileId: params.profileId,
          title: params.session?.title ?? titleFor(params.text),
          ...(params.session?.spaceId === undefined
            ? {}
            : {spaceId: params.session.spaceId}),
        });
      }
      opening.push(
        {
          ...this.stamp(params.sessionId),
          turnId,
          type: 'user.message',
          text: params.text,
        },
        {
          ...this.stamp(params.sessionId),
          turnId,
          type: 'turn.started',
          profileId: params.profileId,
          harnessVersion: params.harness.version,
          harnessHash: harnessHash(params.harness),
          model: modelPair(params.harness.model),
        },
      );
      await this.append(params.sessionId, opening);
      for (const event of opening) {
        yield {type: 'event', event};
      }

      yield* this.drive({
        sessionId: params.sessionId,
        turnId,
        profileId: params.profileId,
        harness: params.harness,
        history: [...before, ...opening],
        mode: 'run',
        text: params.text,
      });
    } finally {
      this.starting.delete(params.sessionId);
    }
  }

  async *approve(params: ApproveParams): AsyncGenerator<EngineUpdate> {
    if (this.isBusy(params.sessionId)) {
      throw new TurnBusyError();
    }
    this.starting.add(params.sessionId);
    try {
      const before = await this.store.read(params.sessionId);
      const turnId = newestTurnId(before);
      if (turnId === undefined) {
        throw new GateNotFoundError(params.callId);
      }
      const gate = pendingGatesIn(before).find(
        (candidate) => candidate.callId === params.callId,
      );
      if (gate === undefined) {
        throw new GateNotFoundError(params.callId);
      }

      const decision: SessionEvent = {
        ...this.stamp(params.sessionId),
        turnId,
        type: 'approval.decided',
        callId: params.callId,
        ...(gate.confirmationId === undefined
          ? {}
          : {confirmationId: gate.confirmationId}),
        confirmed: params.confirmed,
        ...(params.payload === undefined ? {} : {payload: params.payload}),
      };
      await this.append(params.sessionId, [decision]);
      yield {type: 'event', event: decision};

      const after = await this.store.read(params.sessionId);
      if (!roundDecided(after)) {
        // Other cards in this round are still unanswered. The click is recorded;
        // the turn resumes when the last one is.
        return;
      }
      const decisions: GateDecision[] = [...decisionsIn(after)].map(
        ([callId, decision]) => ({
          callId,
          confirmed: decision.confirmed,
          ...(decision.payload === undefined
            ? {}
            : {payload: decision.payload}),
        }),
      );
      const profileId = params.harness.id;
      const harness = params.harness;
      yield* this.drive({
        sessionId: params.sessionId,
        turnId,
        profileId,
        harness,
        history: after,
        mode: 'resume',
        decisions,
      });
    } finally {
      this.starting.delete(params.sessionId);
    }
  }

  private async *drive(params: {
    sessionId: string;
    turnId: string;
    profileId: string;
    harness: HarnessSpec;
    history: readonly SessionEvent[];
    mode: 'run' | 'resume';
    text?: string;
    decisions?: readonly GateDecision[];
  }): AsyncGenerator<EngineUpdate> {
    const state: TurnState = {
      turnId: params.turnId,
      sessionId: params.sessionId,
      profileId: params.profileId,
      controller: new AbortController(),
      timedOut: false,
      steps: 0,
      toolCalls: 0,
      gates: new Set(),
      calls: new Map(),
      text: '',
      reasoning: '',
      visibleText: false,
    };
    this.seedCalls(state, params.history);
    this.active.set(params.sessionId, state);

    const timer = setTimeout(() => {
      state.timedOut = true;
      state.controller.abort();
    }, params.harness.tools.budgets.timeoutMs);

    try {
      const source =
        params.mode === 'run'
          ? this.driver.run({
              sessionId: params.sessionId,
              turnId: params.turnId,
              profileId: params.profileId,
              text: params.text ?? '',
              harness: params.harness,
              history: params.history,
              signal: state.controller.signal,
            })
          : this.driver.resume({
              sessionId: params.sessionId,
              turnId: params.turnId,
              profileId: params.profileId,
              harness: params.harness,
              history: params.history,
              decisions: params.decisions ?? [],
              signal: state.controller.signal,
            });

      for await (const event of source) {
        if (event.type === 'done') {
          break;
        }
        yield* this.consume(event, state, params);
        if (state.failure !== undefined) {
          state.controller.abort();
          break;
        }
        if (state.controller.signal.aborted) {
          break;
        }
      }
    } catch (error) {
      if (!state.controller.signal.aborted) {
        state.failure = {message: describeError(error)};
      }
    } finally {
      clearTimeout(timer);
    }

    try {
      if (state.timedOut) {
        for (const event of await this.closeDangling(
          params.sessionId,
          params.turnId,
          'The turn ran out of time before this call returned.',
        )) {
          yield {type: 'event', event};
        }
        yield* this.fail(
          state,
          'timeout',
          'The turn ran out of time. Try a smaller request, or raise the time ' +
            'budget for this bot.',
        );
        return;
      }
      if (state.failure !== undefined) {
        for (const event of await this.closeDangling(
          params.sessionId,
          params.turnId,
          'The turn failed before this call returned.',
        )) {
          yield {type: 'event', event};
        }
        yield* this.fail(
          state,
          state.failure.code ?? 'turn',
          state.failure.message,
        );
        return;
      }
      if (state.controller.signal.aborted) {
        for (const event of await this.closeDangling(
          params.sessionId,
          params.turnId,
          'The turn was stopped before this call returned.',
        )) {
          yield {type: 'event', event};
        }
        const event: SessionEvent = {
          ...this.stamp(params.sessionId),
          turnId: params.turnId,
          type: 'turn.aborted',
        };
        await this.append(params.sessionId, [event]);
        yield {type: 'event', event};
        return;
      }
      if (state.gates.size > 0) {
        /*
         * Waiting is a real outcome, not a completion. The gate cards are in the
         * log; leaving the turn without a terminal event is what makes a reload
         * show the same cards and a new message abandon them.
         */
        return;
      }
      /*
       * A turn that offered no visible words and no card is the silence failure
       * from v1: ADK calls a reasoning-only turn complete, and the window would
       * draw an empty bubble. It is reported as a failure, not as an answer.
       */
      if (!state.visibleText) {
        for (const event of await this.closeDangling(
          params.sessionId,
          params.turnId,
          'The turn produced no reply.',
        )) {
          yield {type: 'event', event};
        }
        yield* this.fail(
          state,
          'silent',
          'The model returned no reply. Try again, or rephrase the request.',
        );
        return;
      }
      for (const event of await this.closeDangling(
        params.sessionId,
        params.turnId,
        'The turn ended before this call returned.',
      )) {
        yield {type: 'event', event};
      }
      const completed: SessionEvent = {
        ...this.stamp(params.sessionId),
        turnId: params.turnId,
        type: 'turn.completed',
        ...(state.usage === undefined ? {} : {usage: state.usage}),
      };
      await this.append(params.sessionId, [completed]);
      yield {type: 'event', event: completed};
    } finally {
      this.active.delete(params.sessionId);
    }
  }

  private async *fail(
    state: TurnState,
    code: string,
    message: string,
  ): AsyncGenerator<EngineUpdate> {
    const event: SessionEvent = {
      ...this.stamp(state.sessionId),
      turnId: state.turnId,
      type: 'turn.failed',
      code,
      message,
    };
    await this.append(state.sessionId, [event]);
    yield {type: 'event', event};
  }

  private async *consume(
    event: DriverEvent,
    state: TurnState,
    params: {
      sessionId: string;
      turnId: string;
      harness: HarnessSpec;
    },
  ): AsyncGenerator<EngineUpdate> {
    switch (event.type) {
      case 'step': {
        state.steps += 1;
        if (state.steps > params.harness.tools.budgets.maxSteps) {
          state.failure = {
            code: 'steps',
            message:
              `The turn used its ${params.harness.tools.budgets.maxSteps} ` +
              'model steps before it finished.',
          };
        }
        return;
      }
      case 'text': {
        if (event.partial) {
          state.text += event.text;
          yield {type: 'delta', channel: 'text', text: event.text};
        } else {
          state.text = event.text;
        }
        return;
      }
      case 'reasoning': {
        if (event.partial) {
          state.reasoning += event.text;
          yield {type: 'delta', channel: 'reasoning', text: event.text};
        } else {
          state.reasoning = event.text;
        }
        return;
      }
      case 'message': {
        const text = event.text.trim().length > 0 ? event.text : state.text;
        const reasoning = event.reasoning ?? state.reasoning;
        if (text.trim().length === 0) {
          // A model response with no words is not persisted as an empty bubble.
          // The turn outcome decides whether it is silence or a tool-only step.
          state.text = '';
          state.reasoning = '';
          return;
        }
        state.visibleText = true;
        const assistant: SessionEvent = {
          ...this.stamp(params.sessionId),
          turnId: params.turnId,
          type: 'assistant.message',
          author: params.harness.identity.name,
          text,
          ...(reasoning.trim().length === 0 ? {} : {reasoning}),
        };
        await this.append(params.sessionId, [assistant]);
        state.text = '';
        state.reasoning = '';
        yield {type: 'event', event: assistant};
        return;
      }
      case 'tool.call': {
        state.toolCalls += 1;
        state.calls.set(event.callId, event.tool);
        if (state.toolCalls > params.harness.tools.budgets.maxToolCalls) {
          state.failure = {
            code: 'tools',
            message:
              `The turn used its ${params.harness.tools.budgets.maxToolCalls} ` +
              'tool calls before it finished.',
          };
        }
        const call: SessionEvent = {
          ...this.stamp(params.sessionId),
          turnId: params.turnId,
          type: 'tool.call',
          callId: event.callId,
          tool: event.tool,
          args: event.args,
          author: params.harness.identity.name,
        };
        await this.append(params.sessionId, [call]);
        yield {type: 'event', event: call};
        return;
      }
      case 'tool.result': {
        state.calls.delete(event.callId);
        state.gates.delete(event.callId);
        const result: SessionEvent = {
          ...this.stamp(params.sessionId),
          turnId: params.turnId,
          type: 'tool.result',
          callId: event.callId,
          tool: event.tool,
          ok: event.ok,
          result: event.result,
        };
        await this.append(params.sessionId, [result]);
        yield {type: 'event', event: result};
        return;
      }
      case 'approval.request': {
        state.toolCalls += 1;
        state.gates.add(event.callId);
        state.calls.set(event.callId, event.tool);
        if (state.toolCalls > params.harness.tools.budgets.maxToolCalls) {
          state.failure = {
            code: 'tools',
            message:
              `The turn used its ${params.harness.tools.budgets.maxToolCalls} ` +
              'tool calls before it finished.',
          };
        }
        const gate: SessionEvent = {
          ...this.stamp(params.sessionId),
          turnId: params.turnId,
          type: 'approval.requested',
          callId: event.callId,
          ...(event.confirmationId === undefined
            ? {}
            : {confirmationId: event.confirmationId}),
          tool: event.tool,
          args: event.args,
          ...(event.hint === undefined ? {} : {hint: event.hint}),
          author: params.harness.identity.name,
        };
        await this.append(params.sessionId, [gate]);
        yield {type: 'event', event: gate};
        return;
      }
      case 'usage': {
        state.usage = event.usage;
        return;
      }
      case 'error': {
        state.failure = {
          message: event.message,
          ...(event.code === undefined ? {} : {code: event.code}),
        };
        return;
      }
      case 'done': {
        return;
      }
    }
  }

  /**
   * Every call the turn offered and never answered becomes a synthetic result.
   *
   * The provider refuses a conversation whose assistant message carries a call
   * with no result, on this turn and every later one. A stopped turn, a failed
   * one and a gate the user walked away from are exactly the cases where the
   * result never arrived, so closing them is what keeps the next turn possible.
   * `synthetic` is how the user can tell the tool did not answer.
   */
  private async closeDangling(
    sessionId: string,
    turnId: string,
    message: string,
  ): Promise<SessionEvent[]> {
    const events = await this.store.read(sessionId);
    const turn = events.filter((event) => turnIdOf(event) === turnId);
    const answered = new Set(
      turn
        .filter((event) => event.type === 'tool.result')
        .map((event) => event.callId),
    );
    const decided = new Set(
      turn
        .filter((event) => event.type === 'approval.decided')
        .map((event) => event.callId),
    );

    /*
     * A card nobody answered is declined, not left open. The confirmation call
     * is a provider-level function call like any other; without a response the
     * next request is invalid. The tool call beside it then gets a result too,
     * because the provider also requires one per issued call.
     */
    const decisions: SessionEvent[] = turn
      .filter(
        (event): event is Extract<SessionEvent, {type: 'approval.requested'}> =>
          event.type === 'approval.requested' && !decided.has(event.callId),
      )
      .map((event) => ({
        ...this.stamp(sessionId),
        turnId,
        type: 'approval.decided',
        callId: event.callId,
        ...(event.confirmationId === undefined
          ? {}
          : {confirmationId: event.confirmationId}),
        confirmed: false,
        synthetic: true,
      }));

    const calls = new Map<string, string>();
    for (const event of turn) {
      if (
        (event.type === 'tool.call' || event.type === 'approval.requested') &&
        !answered.has(event.callId)
      ) {
        calls.set(event.callId, event.tool);
      }
    }
    const results: SessionEvent[] = [...calls].map(([callId, tool]) => ({
      ...this.stamp(sessionId),
      turnId,
      type: 'tool.result',
      callId,
      tool,
      ok: false,
      result: message,
      synthetic: true,
    }));
    if (decisions.length === 0 && results.length === 0) {
      return [];
    }
    const closing = [...decisions, ...results];
    await this.append(sessionId, closing);
    return closing;
  }

  /**
   * Closes the previous turn's unanswered calls before a new turn begins.
   *
   * This is the "a new message abandons the card" rule from the other side: the
   * card is not just hidden, its call is answered on the wire so the next
   * request is valid.
   */
  private async closeAbandoned(sessionId: string): Promise<void> {
    const events = await this.store.read(sessionId);
    const turnId = newestTurnId(events);
    if (turnId === undefined) {
      return;
    }
    const turn = events.filter((event) => turnIdOf(event) === turnId);
    if (
      turn.some(
        (event) =>
          event.type === 'turn.completed' ||
          event.type === 'turn.failed' ||
          event.type === 'turn.aborted',
      )
    ) {
      return;
    }
    await this.closeDangling(
      sessionId,
      turnId,
      'The user moved on before this call was answered.',
    );
  }

  private seedCalls(state: TurnState, history: readonly SessionEvent[]): void {
    const turn = history.filter((event) => turnIdOf(event) === state.turnId);
    const answered = new Set(
      turn
        .filter((event) => event.type === 'tool.result')
        .map((event) => event.callId),
    );
    for (const event of turn) {
      if (
        (event.type === 'tool.call' || event.type === 'approval.requested') &&
        !answered.has(event.callId)
      ) {
        state.calls.set(event.callId, event.tool);
      }
    }
  }

  private stamp(sessionId: string): {
    id: string;
    sessionId: string;
    at: string;
  } {
    return {
      id: this.createId(),
      sessionId,
      at: this.now().toISOString(),
    };
  }

  private async append(
    sessionId: string,
    events: readonly SessionEvent[],
  ): Promise<void> {
    if (events.length > 0) {
      await this.store.append(sessionId, events);
    }
  }
}

function modelPair(model: AgentModel): AgentModel {
  return {provider: model.provider, model: model.model};
}

function titleFor(text: string): string {
  const title = text.replace(/\s+/g, ' ').trim().slice(0, 80);
  return title.length === 0 ? 'New chat' : title;
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as {cause?: unknown}).cause;
    if (cause instanceof Error && cause.message.length > 0) {
      return `${error.message} (${cause.message})`;
    }
    return error.message;
  }
  return String(error);
}
