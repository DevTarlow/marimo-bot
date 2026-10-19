/**
 * Reading approval gates out of a conversation.
 *
 * A gate is raised by an ADK function call and settled by a function response
 * carrying the same id, so "still pending" is exactly "asked, and no response
 * with that id since". Reading it out of the event stream rather than out of
 * memory is what lets a card survive a relaunch: the process that raised it is
 * gone, and the conversation is the only thing that is not.
 *
 * Two readers live here because the app asks two different questions of the same
 * log. `pendingGatesIn` asks what the newest turn is waiting on, which is what
 * the window draws as cards. `gatesAskedBy` asks what *one helper* stopped on,
 * which is what the parent's `ask_agent` tool needs in order to answer the exact
 * call the user just decided about. They are not the same set once a helper has
 * parked, and using one for the other either loses the helper's call or asks the
 * user twice.
 */
import {
  isCompactedEvent,
  REQUEST_CONFIRMATION_FUNCTION_CALL_NAME,
} from '@google/adk';

import type {PendingGate} from '@marimo/protocol';

import type {AdkEvent} from '../sessions/file-session-service.js';

export interface GateDetails {
  tool: string;
  args: unknown;
  hint: string;
}

export function readGate(args: unknown): GateDetails {
  if (!args || typeof args !== 'object') {
    return {tool: 'unknown', args: {}, hint: ''};
  }
  const record = args as {
    originalFunctionCall?: {name?: string; args?: unknown};
    toolConfirmation?: {hint?: string};
  };
  return {
    tool: record.originalFunctionCall?.name ?? 'unknown',
    args: record.originalFunctionCall?.args ?? {},
    hint: record.toolConfirmation?.hint ?? '',
  };
}

/**
 * The gates a conversation has been asked and not yet answered.
 *
 * **Only the newest invocation counts.** A turn is one invocation, and starting
 * a new one abandons whatever the previous turn was waiting on — the app has
 * always behaved that way, it just had nothing on disk to say so. Without this,
 * a gate the user walked away from would come back as a card every time the
 * window reloaded, and pressing Approve on it would ask ADK to confirm a call
 * belonging to a turn that is over.
 *
 * That rule is what keeps a delegated helper from asking the user twice. The
 * helper's run is a second invocation inside its parent's turn; when the parent's
 * own id appears again it is raising the `ask_agent` card, and *that* is the
 * question the user is being asked. The child's gate is still in the log —
 * `gatesAskedBy` is how the parent's tool finds it and answers the exact call the
 * user just decided about — but it is not a second card. An earlier version kept
 * a gate whose invocation id it had seen before, on the theory that the parent
 * was "resuming"; ADK gives a resume a new invocation id, so what that kept was
 * the child's dead card beside the parent's live one.
 *
 * Note the shape of a real approval: the question is asked in one invocation and
 * answered in the *next* one, because resuming is a new turn carrying the
 * confirmation. That is why this tracks the newest invocation rather than
 * looking for gates with no answer anywhere — after an approval, the newest
 * invocation is the one that answered it, and it has nothing pending.
 *
 * Order is the order the questions were asked, so a round of several gates draws
 * its cards the same way every time it is read.
 */
export function pendingGatesIn(events: readonly AdkEvent[]): PendingGate[] {
  let invocation: string | undefined;
  let asked = new Map<string, PendingGate>();
  let answered = new Set<string>();

  for (const event of events) {
    /*
     * A compaction is not a turn and carries no invocation id. The empty id
     * would read as "a new invocation" below and clear the cards of the turn
     * that is actually waiting — a live approval silently disappearing when
     * somebody compacted the conversation it belongs to.
     */
    if (isCompactedEvent(event)) {
      continue;
    }

    if (event.invocationId !== undefined && event.invocationId !== invocation) {
      invocation = event.invocationId;
      asked = new Map();
      answered = new Set();
    }

    for (const part of event.content?.parts ?? []) {
      const call = part.functionCall;
      if (call?.name === REQUEST_CONFIRMATION_FUNCTION_CALL_NAME) {
        /*
         * A gate with no id cannot be answered — there is nothing for a response
         * to match — so it is left out rather than shown as a card that could
         * never work.
         */
        if (call.id) {
          const gate = readGate(call.args);
          asked.set(call.id, {
            callId: call.id,
            tool: gate.tool,
            args: gate.args,
            hint: gate.hint,
            askedAt: new Date(event.timestamp).toISOString(),
          });
        }
        continue;
      }

      // Any response settles its call, whatever it answers: a refusal is an
      // answer, and so is a tool result that came back after approval.
      const response = part.functionResponse;
      if (response?.id) {
        answered.add(response.id);
      }
    }
  }

  return [...asked.values()].filter((gate) => !answered.has(gate.callId));
}

/**
 * The gates *one agent* has asked and not yet been answered, wherever they sit.
 *
 * This is deliberately not `pendingGatesIn`. That answers "what is the newest
 * invocation waiting on", which after a helper parks is the parent's `ask_agent`
 * card, not the child's call. The parent's tool needs the child's call alone, so
 * it can answer it with the decision the user just made: ADK resumes a gated call
 * by finding the confirmation named in the newest message, binding it to the
 * original call in the session and executing it. A sentence could not do that,
 * which is why the helper used to wake up, re-plan and ask again.
 *
 * Gates are matched to responses across the whole log rather than by invocation:
 * the child's gate outlives the child's invocation, and the parent's click is a
 * different invocation entirely. Answers are read from every author because the
 * confirmation response is written as the user's.
 *
 * `afterCallId` is the parent's `ask_agent` call, and it is what keeps an
 * abandoned delegation out of a later one. A helper's gate from a turn the user
 * walked away from is still unanswered on disk; answering it because a later
 * click approved a different call would execute an action nobody is looking at.
 * Scoping to the current call means only the gate this click is about can be
 * resumed. If the call is not in the log — compacted away, say — the answer is
 * nothing, and the caller falls back to the sentence rather than guessing.
 */
export function gatesAskedBy(
  events: readonly AdkEvent[],
  author: string,
  afterCallId?: string,
): PendingGate[] {
  let scoped: readonly AdkEvent[] = events;
  if (afterCallId !== undefined) {
    const start = events.findIndex((event) =>
      (event.content?.parts ?? []).some(
        (part) => part.functionCall?.id === afterCallId,
      ),
    );
    if (start < 0) {
      return [];
    }
    scoped = events.slice(start);
  }

  const asked = new Map<string, PendingGate>();
  const answered = new Set<string>();

  for (const event of scoped) {
    if (isCompactedEvent(event)) {
      continue;
    }
    for (const part of event.content?.parts ?? []) {
      const call = part.functionCall;
      if (
        event.author === author &&
        call?.name === REQUEST_CONFIRMATION_FUNCTION_CALL_NAME &&
        call.id
      ) {
        const gate = readGate(call.args);
        asked.set(call.id, {
          callId: call.id,
          tool: gate.tool,
          args: gate.args,
          hint: gate.hint,
          askedAt: new Date(event.timestamp).toISOString(),
        });
      }
      const response = part.functionResponse;
      if (response?.id) {
        answered.add(response.id);
      }
    }
  }

  return [...asked.values()].filter((gate) => !answered.has(gate.callId));
}
