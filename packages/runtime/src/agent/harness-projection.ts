/**
 * Projecting the canonical log into the two shapes the window already speaks:
 * the live event stream of a turn, and the transcript a reload reads.
 *
 * This is the only bridge between v2's facts and v1's protocol. Keeping it pure
 * is what lets the desktop shell keep its event handling while the engine
 * underneath changes: a test can feed a log and assert exactly what the window
 * is asked to draw.
 */
import type {
  AgentUiEvent,
  PendingGate,
  TokenUsage,
  ToolCallRecord,
  TranscriptMessage,
} from '@marimo/protocol';

import {pendingGatesFromLog} from '@marimo/agent';
import type {EngineUpdate, SessionEvent} from '@marimo/agent';

/** A tool result as a sentence the window can put in a folded tool row. */
export function textOfResult(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (value === undefined) {
    return '';
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Turns the engine's updates into the window's events.
 *
 * `initialMessageId` is for a resumed turn: there is no `turn.started` event in
 * that stream because the turn began before the card was answered.
 */
export async function* projectTurn(
  updates: AsyncIterable<EngineUpdate>,
  sessionId: string,
  initialMessageId = '',
): AsyncGenerator<AgentUiEvent> {
  let messageId = initialMessageId;
  let sawTextDelta = false;

  for await (const update of updates) {
    if (update.type === 'delta') {
      if (messageId.length === 0) {
        continue;
      }
      if (update.channel === 'text') {
        sawTextDelta = true;
        yield {type: 'text.delta', sessionId, messageId, text: update.text};
      } else {
        yield {
          type: 'reasoning.delta',
          sessionId,
          messageId,
          text: update.text,
        };
      }
      continue;
    }

    const event = update.event;
    switch (event.type) {
      case 'turn.started':
        messageId = event.turnId;
        yield {type: 'turn.started', sessionId, messageId};
        break;
      case 'assistant.message':
        messageId = event.turnId;
        /*
         * A provider that streamed no deltas still produced words. The window
         * never saw them, so hand it the finished message as one delta.
         */
        if (!sawTextDelta && event.text.length > 0) {
          yield {type: 'text.delta', sessionId, messageId, text: event.text};
        }
        sawTextDelta = false;
        break;
      case 'tool.call':
        messageId = event.turnId;
        yield {
          type: 'tool.started',
          sessionId,
          messageId,
          callId: event.callId,
          tool: event.tool,
          args: event.args,
        };
        break;
      case 'tool.result':
        messageId = event.turnId;
        yield {
          type: 'tool.finished',
          sessionId,
          messageId,
          callId: event.callId,
          tool: event.tool,
          ok: event.ok,
          result: textOfResult(event.result),
        };
        break;
      case 'approval.requested':
        messageId = event.turnId;
        yield {
          type: 'approval.request',
          sessionId,
          messageId,
          callId: event.callId,
          tool: event.tool,
          args: event.args,
          hint: event.hint ?? '',
        };
        break;
      case 'turn.completed':
        messageId = event.turnId;
        yield {
          type: 'turn.completed',
          sessionId,
          messageId,
          ...(event.usage === undefined ? {} : {usage: event.usage}),
        };
        break;
      case 'turn.failed':
        messageId = event.turnId;
        yield {
          type: 'turn.failed',
          sessionId,
          messageId,
          ...(event.code === undefined ? {} : {code: event.code}),
          message: event.message,
        };
        break;
      case 'turn.aborted':
        messageId = event.turnId;
        yield {type: 'turn.aborted', sessionId, messageId};
        break;
      case 'approval.decided':
      case 'session.created':
      case 'summary':
        break;
    }
  }

  yield {type: 'session.changed', sessionId};
}

/** The pending cards for a conversation, in the protocol's shape. */
export function projectPendingGates(
  events: readonly SessionEvent[],
): PendingGate[] {
  return pendingGatesFromLog(events).map((gate) => ({
    callId: gate.callId,
    tool: gate.tool,
    args: gate.args,
    hint: gate.hint ?? '',
    askedAt: gate.askedAt,
  }));
}

/**
 * The transcript a reload draws.
 *
 * A tool call is attached to the assistant message it followed, because the
 * window draws them as one bubble with a folded row. A failure has no assistant
 * message of its own, so it gets one carrying only the error.
 */
export function transcriptFromEvents(
  events: readonly SessionEvent[],
): TranscriptMessage[] {
  const messages: TranscriptMessage[] = [];
  let current: TranscriptMessage | undefined;

  for (const event of events) {
    switch (event.type) {
      case 'user.message':
        current = undefined;
        messages.push({
          id: event.id,
          role: 'user',
          text: event.text,
          createdAt: event.at,
        });
        break;
      case 'assistant.message':
        current = {
          id: event.id,
          role: 'assistant',
          text: event.text,
          ...(event.reasoning === undefined
            ? {}
            : {reasoning: event.reasoning}),
          createdAt: event.at,
          invocationId: event.turnId,
        };
        messages.push(current);
        break;
      case 'tool.call': {
        if (current === undefined) {
          current = {
            id: `tool-${event.callId}`,
            role: 'assistant',
            text: '',
            createdAt: event.at,
            invocationId: event.turnId,
          };
          messages.push(current);
        }
        const record: ToolCallRecord = {
          callId: event.callId,
          tool: event.tool,
          args: event.args,
        };
        current.toolCalls = [...(current.toolCalls ?? []), record];
        break;
      }
      case 'tool.result': {
        const record = findToolCall(messages, event.callId);
        if (record !== undefined) {
          record.ok = event.ok;
          record.result = textOfResult(event.result);
        }
        break;
      }
      case 'turn.failed':
        current = undefined;
        messages.push({
          id: event.id,
          role: 'assistant',
          text: '',
          createdAt: event.at,
          error: event.message,
        });
        break;
      case 'approval.decided':
      case 'approval.requested':
      case 'session.created':
      case 'summary':
      case 'turn.completed':
      case 'turn.aborted':
      case 'turn.started':
        break;
    }
  }

  return messages;
}

function findToolCall(
  messages: readonly TranscriptMessage[],
  callId: string,
): ToolCallRecord | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const record = messages[index]?.toolCalls?.find(
      (candidate) => candidate.callId === callId,
    );
    if (record !== undefined) {
      return record;
    }
  }
  return undefined;
}

/** Tokens read from a turn, when the provider reported them. */
export type {TokenUsage};
