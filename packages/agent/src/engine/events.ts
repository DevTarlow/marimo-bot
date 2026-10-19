/**
 * The canonical event log.
 *
 * A conversation is an append-only list of facts. The UI projects them, the
 * learning loop reads them, and a restarted process rebuilds the turn state from
 * them. Streaming deltas are not facts and are never stored: the finished
 * message is.
 *
 * The shapes here are deliberately smaller than ADK's event objects. ADK is one
 * way to produce a turn; the log is the contract every producer and consumer
 * shares, so an engine change cannot change what a stored conversation means.
 */
import {z} from 'zod';

import {agentModelSchema} from '@marimo/protocol';

export const tokenUsageSchema = z.object({
  promptTokens: z.number().int().nonnegative(),
  completionTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
});

export type TokenUsage = z.infer<typeof tokenUsageSchema>;

const base = {
  id: z.string().min(1),
  sessionId: z.string().min(1),
  at: z.string().min(1),
};

const turnBase = {
  ...base,
  turnId: z.string().min(1),
};

export const sessionCreatedSchema = z.object({
  ...base,
  type: z.literal('session.created'),
  profileId: z.string().min(1),
  title: z.string().min(1),
  spaceId: z.string().min(1).optional(),
});

export const userMessageSchema = z.object({
  ...turnBase,
  type: z.literal('user.message'),
  text: z.string().min(1),
});

export const turnStartedSchema = z.object({
  ...turnBase,
  type: z.literal('turn.started'),
  profileId: z.string().min(1),
  harnessVersion: z.number().int().positive(),
  harnessHash: z.string().min(1),
  model: agentModelSchema,
  /** Prompt text for this turn only, so a resume can replay it. */
  instruction: z.string().min(1).optional(),
});

export const assistantMessageSchema = z.object({
  ...turnBase,
  type: z.literal('assistant.message'),
  /** The agent name the reply is attributed to. */
  author: z.string().min(1),
  /** The profile that answered, when it is not the conversation's owner. */
  agentId: z.string().min(1).optional(),
  text: z.string().min(1),
  /** Persisted because the next request has to replay it. */
  reasoning: z.string().min(1).optional(),
});

export const toolCallSchema = z.object({
  ...turnBase,
  type: z.literal('tool.call'),
  callId: z.string().min(1),
  tool: z.string().min(1),
  args: z.record(z.string(), z.unknown()),
  author: z.string().min(1),
  agentId: z.string().min(1).optional(),
});

export const toolResultSchema = z.object({
  ...turnBase,
  type: z.literal('tool.result'),
  callId: z.string().min(1),
  tool: z.string().min(1),
  ok: z.boolean(),
  result: z.unknown(),
  agentId: z.string().min(1).optional(),
  /**
   * True when the engine wrote the result to close a call nobody answered — an
   * aborted turn, a gate the user walked away from. The model has to see an
   * answer; the user must be able to tell it was not the tool's.
   */
  synthetic: z.boolean().optional(),
});

export const approvalRequestedSchema = z.object({
  ...turnBase,
  type: z.literal('approval.requested'),
  /** The tool call being gated; the tool result later uses this id. */
  callId: z.string().min(1),
  /**
   * The provider's confirmation call id, when the provider wraps gates.
   *
   * ADK does; a scripted driver may not. Absent means the decision answers the
   * tool call directly, which is the simpler shape and what the fake driver uses.
   */
  confirmationId: z.string().min(1).optional(),
  tool: z.string().min(1),
  args: z.record(z.string(), z.unknown()),
  hint: z.string().min(1).optional(),
  author: z.string().min(1),
  agentId: z.string().min(1).optional(),
});

export const approvalDecidedSchema = z.object({
  ...turnBase,
  type: z.literal('approval.decided'),
  callId: z.string().min(1),
  confirmationId: z.string().min(1).optional(),
  confirmed: z.boolean(),
  /** True when the engine declined the gate to close a turn nobody resumed. */
  synthetic: z.boolean().optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
});

export const turnCompletedSchema = z.object({
  ...turnBase,
  type: z.literal('turn.completed'),
  usage: tokenUsageSchema.optional(),
});

export const turnFailedSchema = z.object({
  ...turnBase,
  type: z.literal('turn.failed'),
  code: z.string().min(1).optional(),
  message: z.string().min(1),
});

export const turnAbortedSchema = z.object({
  ...turnBase,
  type: z.literal('turn.aborted'),
});

export const participantsChangedSchema = z.object({
  ...base,
  type: z.literal('participants.changed'),
  /** The full list of agents in the conversation, after the change. */
  agentIds: z.array(z.string().min(1)),
  /** Who made the change, for a log that has to explain itself later. */
  by: z.string().min(1),
});

export const summarySchema = z.object({
  ...base,
  type: z.literal('summary'),
  text: z.string().min(1),
  /** The last event the summary stands in for. */
  coversThrough: z.string().min(1),
  turnId: z.string().min(1).optional(),
});

export const sessionEventSchema = z.discriminatedUnion('type', [
  sessionCreatedSchema,
  userMessageSchema,
  turnStartedSchema,
  assistantMessageSchema,
  toolCallSchema,
  toolResultSchema,
  approvalRequestedSchema,
  approvalDecidedSchema,
  turnCompletedSchema,
  turnFailedSchema,
  turnAbortedSchema,
  participantsChangedSchema,
  summarySchema,
]);

export type SessionEvent = z.infer<typeof sessionEventSchema>;

export type SessionEventType = SessionEvent['type'];

/** A parsed event, or a sentence naming why it cannot be trusted. */
export function parseSessionEvent(
  value: unknown,
): {ok: true; event: SessionEvent} | {ok: false; problem: string} {
  const parsed = sessionEventSchema.safeParse(value);
  if (!parsed.success) {
    return {ok: false, problem: parsed.error.issues[0]?.message ?? 'invalid'};
  }
  return {ok: true, event: parsed.data};
}

/** The turn a turn-scoped event belongs to. */
export function turnIdOf(event: SessionEvent): string | undefined {
  return 'turnId' in event ? event.turnId : undefined;
}

/** Every event of the newest turn, in order. */
export function newestTurnEvents(
  events: readonly SessionEvent[],
): SessionEvent[] {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === 'turn.started') {
      return events.filter((entry) => turnIdOf(entry) === event.turnId);
    }
  }
  return [];
}

/** The newest turn's id, when the log has one. */
export function newestTurnId(
  events: readonly SessionEvent[],
): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === 'turn.started') {
      return event.turnId;
    }
  }
  return undefined;
}

/**
 * Everyone in the conversation: the owner plus the agents the latest
 * participants event names. An empty list means just the owner.
 */
export function participantsIn(events: readonly SessionEvent[]): string[] {
  const owner =
    events.find((event) => event.type === 'session.created')?.profileId ??
    events.find((event) => event.type === 'turn.started')?.profileId;
  let listed: string[] = [];
  for (const event of events) {
    if (event.type === 'participants.changed') {
      listed = event.agentIds;
    }
  }
  const all = owner === undefined ? [...listed] : [owner, ...listed];
  return [...new Set(all)];
}

/**
 * The gates the newest turn is waiting on.
 *
 * A gate is requested and not yet decided. A decided gate that has not resumed
 * yet is not pending: the user has answered it, and the round is waiting for the
 * other cards rather than for this one. A gate from an older turn is never
 * returned, which is the rule that stops a card the user walked away from
 * coming back on every reload.
 */
export function pendingGatesIn(events: readonly SessionEvent[]): Array<{
  turnId: string;
  callId: string;
  confirmationId?: string;
  tool: string;
  args: Record<string, unknown>;
  hint?: string;
  author: string;
  agentId?: string;
  askedAt: string;
}> {
  const turn = newestTurnEvents(events);
  if (turn.length === 0) {
    return [];
  }
  const decided = new Set(
    turn
      .filter((event) => event.type === 'approval.decided')
      .map((event) => event.callId),
  );
  const answered = new Set(
    turn
      .filter((event) => event.type === 'tool.result')
      .map((event) => event.callId),
  );
  return turn
    .filter(
      (event): event is Extract<SessionEvent, {type: 'approval.requested'}> =>
        event.type === 'approval.requested',
    )
    .filter(
      (event) => !decided.has(event.callId) && !answered.has(event.callId),
    )
    .map((event) => ({
      turnId: event.turnId,
      callId: event.callId,
      ...(event.confirmationId === undefined
        ? {}
        : {confirmationId: event.confirmationId}),
      tool: event.tool,
      args: event.args,
      ...(event.hint === undefined ? {} : {hint: event.hint}),
      author: event.author,
      ...(event.agentId === undefined ? {} : {agentId: event.agentId}),
      askedAt: event.at,
    }));
}

/** The decisions already given for the newest turn, by call id. */
export function decisionsIn(
  events: readonly SessionEvent[],
): Map<string, {confirmed: boolean; payload?: Record<string, unknown>}> {
  const turn = newestTurnEvents(events);
  const decisions = new Map<
    string,
    {confirmed: boolean; payload?: Record<string, unknown>}
  >();
  for (const event of turn) {
    if (event.type === 'approval.decided') {
      decisions.set(event.callId, {
        confirmed: event.confirmed,
        ...(event.payload === undefined ? {} : {payload: event.payload}),
      });
    }
  }
  return decisions;
}

/** Whether every gate of the newest turn has a decision. */
export function roundDecided(events: readonly SessionEvent[]): boolean {
  const turn = newestTurnEvents(events);
  const requested = turn.filter(
    (event): event is Extract<SessionEvent, {type: 'approval.requested'}> =>
      event.type === 'approval.requested',
  );
  if (requested.length === 0) {
    return false;
  }
  if (
    turn.some(
      (event) =>
        event.type === 'turn.completed' ||
        event.type === 'turn.failed' ||
        event.type === 'turn.aborted',
    )
  ) {
    return false;
  }
  const decisions = decisionsIn(events);
  return requested.every((event) => decisions.has(event.callId));
}
