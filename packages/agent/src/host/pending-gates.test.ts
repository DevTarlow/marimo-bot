/**
 * Reading pending gates out of an event stream.
 *
 * The pure half of "a gate survives a restart", tested without a host, a
 * provider or a filesystem. This is where the awkward cases live: a gate that
 * was never given an id, a gate answered by a refusal, a round of several gates
 * where only some have been decided, and the turn the user simply walked away
 * from.
 *
 * The integration in `agent-host.test.ts` proves the mechanism end to end; this
 * proves the arithmetic, which is the part that would be wrong in a way an
 * end-to-end test only sometimes notices.
 */
import {describe, expect, it} from 'vitest';

import type {AdkEvent} from '../sessions/file-session-service.js';
import {gatesAskedBy, pendingGatesIn} from './gates.js';
import {buildCompactedEvent} from './compaction.js';

const GATE = 'adk_request_confirmation';

/** An event in one invocation, carrying the parts given. */
function event(
  invocationId: string,
  ...parts: Array<Record<string, unknown>>
): AdkEvent {
  return {
    invocationId,
    timestamp: 1_700_000_000_000,
    content: {parts},
  } as unknown as AdkEvent;
}

/** The same, with the author a delegated helper's gate needs. */
function from(
  author: string,
  invocationId: string,
  ...parts: Array<Record<string, unknown>>
): AdkEvent {
  return {...event(invocationId, ...parts), author};
}

/** A tool call that is not a gate, such as the parent's `ask_agent`. */
function call(id: string, name: string): Record<string, unknown> {
  return {functionCall: {id, name, args: {}}};
}

/** The call ADK makes when a tool needs approving. */
function gate(
  id: string | undefined,
  tool = 'run_shell',
  args: Record<string, unknown> = {},
  hint = '',
): Record<string, unknown> {
  return {
    functionCall: {
      ...(id === undefined ? {} : {id}),
      name: GATE,
      args: {
        originalFunctionCall: {name: tool, args},
        toolConfirmation: {hint},
      },
    },
  };
}

/** Any response that settles the call with this id. */
function answer(id: string, name = 'run_shell'): Record<string, unknown> {
  return {functionResponse: {id, name, response: {ok: true}}};
}

describe('pendingGatesIn', () => {
  it('finds nothing in an empty conversation', () => {
    expect(pendingGatesIn([])).toEqual([]);
  });

  it('reports a gate that was asked and not answered', () => {
    const gates = pendingGatesIn([
      event('run-1', gate('call_1', 'run_shell', {command: 'ls'}, 'ls')),
    ]);

    expect(gates).toHaveLength(1);
    expect(gates[0]).toMatchObject({
      callId: 'call_1',
      tool: 'run_shell',
      args: {command: 'ls'},
      hint: 'ls',
    });
  });

  it('says when the question was asked', () => {
    // So a card can say how long it has waited, and a headless run can report
    // that a job has been parked since Tuesday rather than looking stuck.
    const gates = pendingGatesIn([event('run-1', gate('call_1', 'run_shell'))]);
    expect(gates[0]?.askedAt).toBe(
      new Date(1_700_000_000_000).toISOString(),
    );
  });

  it('stops reporting one that has been answered', () => {
    expect(
      pendingGatesIn([
        event('run-1', gate('call_1', 'run_shell')),
        event('run-2', answer('call_1')),
      ]),
    ).toEqual([]);
  });

  /*
   * A refusal is an answer. ADK settles a rejected confirmation with a function
   * response carrying the same id, so leaving it pending would put a card back
   * on screen for a decision the user already made — and answering it again
   * would send ADK a confirmation for a call it is no longer asking about.
   */
  it('counts a refusal as an answer', () => {
    const refused = {
      functionResponse: {id: 'call_1', name: GATE, response: {confirmed: false}},
    };
    expect(
      pendingGatesIn([
        event('run-1', gate('call_1', 'run_shell')),
        event('run-2', refused),
      ]),
    ).toEqual([]);
  });

  /*
   * The case that matters most and is easiest to get wrong.
   *
   * A turn is one invocation. Asking something else starts a new one, which
   * abandons the gate the old turn was waiting on — the app has always behaved
   * that way. A reader that looked for "unanswered anywhere" would resurrect
   * that card on every reload, and Approve on it would ask ADK to confirm a call
   * belonging to a turn that is over.
   */
  it('abandons the previous turn\'s gates when a new turn starts', () => {
    const gates = pendingGatesIn([
      event('run-1', gate('call_1', 'run_shell', {command: 'ls'})),
      event('run-2', {text: 'never mind, what is the weather'}),
    ]);

    expect(gates).toEqual([]);
  });

  it('abandons them even when the new turn asked nothing at all', () => {
    const gates = pendingGatesIn([
      event('run-1', gate('call_1', 'run_shell')),
      event('run-2'),
    ]);
    expect(gates).toEqual([]);
  });

  it('keeps a gate from the newest turn while it is undecided', () => {
    const gates = pendingGatesIn([
      event('run-1', gate('call_1', 'run_shell')),
      event('run-2', answer('call_1')),
      event('run-2', gate('call_2', 'write_file', {path: 'a'})),
    ]);

    expect(gates.map((entry) => entry.callId)).toEqual(['call_2']);
  });

  /*
   * The duplicate card, as it looked on screen: a helper parks on `write_file`,
   * the parent raises its own `ask_agent` card, and both were drawn — the child's
   * dead one and the parent's live one. The child's gate is still part of the
   * conversation, but once the parent's invocation is the newest, the parent's
   * card is the only question the user is being asked.
   */
  it('reports only the parent card when a helper has parked', () => {
    const events = [
      from('marimo', 'parent-1', {text: 'ask the helper'}),
      from('helper', 'child-1', gate('child-gate', 'write_file', {path: 'a'})),
      from(
        'marimo',
        'parent-1',
        gate('parent-gate', 'ask_agent', {agent: 'Writer'}),
      ),
    ];

    expect(pendingGatesIn(events).map((entry) => entry.callId)).toEqual([
      'parent-gate',
    ]);
  });

  /*
   * And the parent's tool still needs the child's call, because that is the one
   * ADK can execute with the user's decision. The two questions have different
   * answers, which is why there are two readers rather than one with a flag.
   */
  it('still finds the helper gate the parent card is about', () => {
    const events = [
      from('marimo', 'parent-1', {text: 'ask the helper'}),
      from('helper', 'child-1', gate('child-gate', 'write_file', {path: 'a'})),
      from(
        'marimo',
        'parent-1',
        gate('parent-gate', 'ask_agent', {agent: 'Writer'}),
      ),
    ];

    expect(gatesAskedBy(events, 'helper').map((entry) => entry.callId)).toEqual(
      ['child-gate'],
    );
  });

  it('stops reporting a helper gate once the decision answered it', () => {
    expect(
      gatesAskedBy(
        [
          from('helper', 'child-1', gate('child-gate', 'write_file')),
          from('user', 'parent-2', answer('child-gate')),
        ],
        'helper',
      ),
    ).toEqual([]);
  });

  /*
   * A gate from a delegation the user walked away from is still unanswered on
   * disk. A later click approves a different call, and executing the old one
   * because it happens to be in the same conversation would run an action
   * nobody is looking at — so the lookup is scoped to the current ask_agent
   * call, and a call the log cannot name yields nothing rather than everything.
   */
  it('ignores a helper gate from an abandoned delegation', () => {
    const events = [
      from('marimo', 'parent-1', call('old-ask', 'ask_agent')),
      from('helper', 'child-old', gate('old-gate', 'write_file')),
      from('marimo', 'parent-2', call('new-ask', 'ask_agent')),
      from('helper', 'child-new', gate('new-gate', 'write_file')),
    ];

    expect(
      gatesAskedBy(events, 'helper', 'new-ask').map((entry) => entry.callId),
    ).toEqual(['new-gate']);
    expect(gatesAskedBy(events, 'helper', 'missing-ask')).toEqual([]);
  });

  /*
   * A round of several gates is answered as *one message* — ADK reads the
   * confirmations from the newest message alone — so on disk the round stays
   * entirely undecided until the resume happens. Half-answered is a state that
   * exists only in memory, between two clicks, and it is not one the disk can
   * disagree with: a reload during it shows the round again, which is honest.
   */
  it('reports every gate of a round until the round is answered', () => {
    const gates = pendingGatesIn([
      event(
        'run-1',
        gate('call_1', 'write_file', {path: 'a'}),
        gate('call_2', 'write_file', {path: 'b'}),
        gate('call_3', 'write_file', {path: 'c'}),
      ),
    ]);

    expect(gates.map((entry) => entry.callId)).toEqual([
      'call_1',
      'call_2',
      'call_3',
    ]);
  });

  it('clears the whole round when it is answered as one message', () => {
    const gates = pendingGatesIn([
      event('run-1', gate('call_1'), gate('call_2'), gate('call_3')),
      event('run-2', answer('call_1'), answer('call_2'), answer('call_3')),
    ]);

    expect(gates).toEqual([]);
  });

  it('reports the ones a response in the same turn did not settle', () => {
    // Which is how ADK answers a call it is still asking about: the refusal
    // lands beside the gate.
    const gates = pendingGatesIn([
      event('run-1', gate('call_1'), answer('call_1'), gate('call_2')),
    ]);

    expect(gates.map((entry) => entry.callId)).toEqual(['call_2']);
  });

  it('keeps the order the questions were asked in', () => {
    // So a round of cards draws the same way every time it is read, rather than
    // reshuffling when the window reloads.
    const gates = pendingGatesIn([
      event(
        'run-1',
        gate('c', 'run_shell'),
        gate('a', 'run_shell'),
        gate('b', 'run_shell'),
      ),
    ]);
    expect(gates.map((entry) => entry.callId)).toEqual(['c', 'a', 'b']);
  });

  /*
   * A gate with no id cannot be answered — a response has nothing to match it
   * against — so it is left out rather than shown as a card that could never
   * work. ADK always sends an id; this is for a stream that has been through a
   * model or a proxy that did not.
   */
  it('skips a gate with no id', () => {
    expect(
      pendingGatesIn([event('run-1', gate(undefined, 'run_shell'))]),
    ).toEqual([]);
  });

  it('treats a malformed gate as an unknown tool rather than throwing', () => {
    // `readGate` is deliberately total: a card reading "unknown" is a bug worth
    // seeing, and an exception here would take the whole conversation with it.
    const gates = pendingGatesIn([
      event('run-1', {functionCall: {id: 'x', name: GATE}}),
    ]);
    expect(gates[0]).toMatchObject({callId: 'x', tool: 'unknown', args: {}});
  });

  it('ignores an event with no parts at all', () => {
    const empty = {invocationId: 'run-1', content: {}} as unknown as AdkEvent;
    expect(pendingGatesIn([empty])).toEqual([]);
  });

  it('ignores ordinary tool calls, which are not questions for a person', () => {
    const gates = pendingGatesIn([
      event('run-1', {
        functionCall: {id: 'auto', name: 'current_time', args: {}},
      }),
    ]);
    expect(gates).toEqual([]);
  });

  /*
   * An event with no invocation id abandons nothing. Older streams, or one
   * written by a build that did not record it, must not have their gates
   * silently dropped — a card that never appears is worse than one that is
   * merely late.
   */
  it('does not abandon a gate for an event that names no invocation', () => {
    const gates = pendingGatesIn([
      event('run-1', gate('call_1', 'run_shell')),
      {timestamp: 1, content: {parts: []}} as unknown as AdkEvent,
    ]);
    expect(gates.map((entry) => entry.callId)).toEqual(['call_1']);
  });

  /*
   * A compaction is appended to the same log as the turn it may be asking
   * about, and it belongs to no invocation. Read as one, it would clear the
   * pending set of the invocation that is actually waiting — and an approval
   * card would vanish from the window of somebody who had just compacted the
   * conversation it belongs to.
   */
  it('is not disturbed by a compaction appended after a waiting turn', () => {
    const waiting = [
      event('inv-1', gate('call-1')),
      {
        ...buildCompactedEvent({summary: 'earlier', startTime: 1, endTime: 2}),
        timestamp: 1_700_000_000_100,
      } as AdkEvent,
    ];

    expect(pendingGatesIn(waiting).map((entry) => entry.callId)).toEqual([
      'call-1',
    ]);
  });
});
