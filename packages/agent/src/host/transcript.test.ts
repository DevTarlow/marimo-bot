import {createEvent} from '@google/adk';
import {describe, expect, it} from 'vitest';

import type {AdkEvent} from '../sessions/file-session-service.js';
import {agentNameFor} from './agent-host.js';
import {buildCompactedEvent} from './compaction.js';
import {projectTranscript} from './transcript.js';

const GATE = 'adk_request_confirmation';

function user(text: string): AdkEvent {
  return createEvent({
    author: 'user',
    content: {role: 'user', parts: [{text}]},
  }) as AdkEvent;
}

function agent(parts: Array<Record<string, unknown>>): AdkEvent {
  return createEvent({
    author: 'marimo',
    content: {role: 'model', parts: parts as never},
  }) as AdkEvent;
}

/**
 * Another agent's event, under the name the profile it came from is built as.
 *
 * Through `agentNameFor` rather than the id itself, because that is what the host
 * builds the helper under — and the projection has to turn it back into the id,
 * which is the whole of the attribution.
 */
function helper(agentId: string, parts: Array<Record<string, unknown>>): AdkEvent {
  return createEvent({
    author: agentNameFor(agentId),
    content: {role: 'model', parts: parts as never},
  }) as AdkEvent;
}

describe('projectTranscript', () => {
  it('groups consecutive agent events into one assistant message', () => {
    const messages = projectTranscript([
      user('question'),
      agent([{text: 'part one '}]),
      agent([{text: 'part two'}]),
    ]);

    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({role: 'user', text: 'question'});
    expect(messages[1]).toMatchObject({
      role: 'assistant',
      text: 'part one part two',
    });
  });

  it('names the turn an answer belongs to', () => {
    /*
     * The join the correction document needs. A message id is the first event's
     * id and means nothing to the discovery log, while the invocation id is the
     * name both the stored events and a recorded tree carry — so "that answer
     * was wrong" can only become a fact about a turn if this is on the message.
     */
    const messages = projectTranscript([
      user('question'),
      createEvent({
        author: 'marimo',
        invocationId: 'turn-7',
        content: {role: 'model', parts: [{text: 'an answer'}]},
      }) as AdkEvent,
    ]);

    expect(messages[1]).toMatchObject({
      role: 'assistant',
      invocationId: 'turn-7',
    });
    // The user's own message is not a turn the agent took.
    expect(messages[0]?.invocationId).toBeUndefined();
  });

  it('starts a new assistant message after each user turn', () => {
    const messages = projectTranscript([
      user('one'),
      agent([{text: 'first answer'}]),
      user('two'),
      agent([{text: 'second answer'}]),
    ]);

    expect(messages.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
    ]);
    expect(messages[3]?.text).toBe('second answer');
  });

  it('pairs a tool call with its result and records failure', () => {
    const messages = projectTranscript([
      user('read it'),
      agent([
        {
          functionCall: {
            id: 'call_1',
            name: 'read_file',
            args: {path: 'a.txt'},
          },
        },
      ]),
      agent([
        {
          functionResponse: {
            id: 'call_1',
            name: 'read_file',
            response: {result: 'contents'},
          },
        },
      ]),
      agent([
        {functionCall: {id: 'call_2', name: 'run_shell', args: {command: 'x'}}},
      ]),
      agent([
        {
          functionResponse: {
            id: 'call_2',
            name: 'run_shell',
            response: {error: 'boom'},
          },
        },
      ]),
    ]);

    const assistant = messages[1];
    expect(assistant?.toolCalls).toHaveLength(2);
    expect(assistant?.toolCalls?.[0]).toMatchObject({
      callId: 'call_1',
      tool: 'read_file',
      result: 'contents',
      ok: true,
    });
    expect(assistant?.toolCalls?.[1]).toMatchObject({
      callId: 'call_2',
      tool: 'run_shell',
      ok: false,
    });
  });

  it('never renders the approval gate as a tool call', () => {
    const messages = projectTranscript([
      user('run it'),
      agent([
        {
          functionCall: {
            id: 'call_1',
            name: 'run_shell',
            args: {command: 'ls'},
          },
        },
      ]),
      agent([
        {
          functionCall: {
            id: 'gate_1',
            name: GATE,
            args: {
              originalFunctionCall: {id: 'call_1', name: 'run_shell', args: {}},
              toolConfirmation: {hint: 'approve?'},
            },
          },
        },
      ]),
    ]);

    expect(messages[1]?.toolCalls).toHaveLength(1);
    expect(messages[1]?.toolCalls?.[0]?.tool).toBe('run_shell');
  });

  it('flags a gate that was never answered as an interrupted turn', () => {
    const messages = projectTranscript([
      user('run it'),
      agent([
        {
          functionCall: {
            id: 'call_1',
            name: 'run_shell',
            args: {command: 'ls'},
          },
        },
      ]),
      agent([
        {
          functionCall: {
            id: 'gate_1',
            name: GATE,
            args: {
              originalFunctionCall: {id: 'call_1', name: 'run_shell', args: {}},
            },
          },
        },
      ]),
    ]);

    expect(messages[1]?.error).toMatch(/waiting for your approval/);
  });

  it('does not flag a gate that has an answer', () => {
    const messages = projectTranscript([
      user('run it'),
      agent([
        {
          functionCall: {
            id: 'call_1',
            name: 'run_shell',
            args: {command: 'ls'},
          },
        },
      ]),
      agent([
        {
          functionCall: {
            id: 'gate_1',
            name: GATE,
            args: {
              originalFunctionCall: {id: 'call_1', name: 'run_shell', args: {}},
            },
          },
        },
      ]),
      user('yes'),
      agent([
        {
          functionResponse: {
            id: 'gate_1',
            name: GATE,
            response: {confirmed: true},
          },
        },
      ]),
    ]);

    const last = messages[messages.length - 1];
    expect(last?.error).toBeUndefined();
  });

  /*
   * A helper's gate outlives the delegation it belonged to when the user walks
   * away from the card. Scanning for "any unanswered gate" put this note on the
   * last message of every later turn in that conversation — a healthy answer
   * described as a turn that stopped. Only the newest invocation's gate is live.
   */
  it('does not flag a later turn for a gate an earlier delegation abandoned', () => {
    const messages = projectTranscript([
      createEvent({
        author: 'user',
        invocationId: 'parent-1',
        content: {role: 'user', parts: [{text: 'ask the helper'}]},
      }) as AdkEvent,
      createEvent({
        author: agentNameFor('writer'),
        invocationId: 'child-1',
        content: {
          role: 'model',
          parts: [
            {
              functionCall: {
                id: 'old-gate',
                name: GATE,
                args: {
                  originalFunctionCall: {
                    id: 'old-call',
                    name: 'write_file',
                    args: {},
                  },
                },
              },
            },
          ] as never,
        },
      }) as AdkEvent,
      createEvent({
        author: 'user',
        invocationId: 'parent-2',
        content: {role: 'user', parts: [{text: 'never mind'}]},
      }) as AdkEvent,
      createEvent({
        author: 'marimo',
        invocationId: 'parent-2',
        content: {role: 'model', parts: [{text: 'Okay.'}]},
      }) as AdkEvent,
    ]);

    expect(messages[messages.length - 1]?.error).toBeUndefined();
  });

  it('records a model error on the assistant message', () => {
    const errorEvent = createEvent({
      author: 'marimo',
      errorMessage: 'rate limited',
    }) as AdkEvent;

    const messages = projectTranscript([user('hi'), errorEvent]);
    expect(messages[1]?.error).toBe('rate limited');
  });

  it('keeps reasoning separate from the answer text', () => {
    const messages = projectTranscript([
      user('why is the sky blue?'),
      agent([
        {text: 'Rayleigh scattering, most likely.', thought: true},
        {text: 'Because air scatters short wavelengths more.'},
      ]),
    ]);

    expect(messages[1]?.text).toBe(
      'Because air scatters short wavelengths more.',
    );
    expect(messages[1]?.reasoning).toBe('Rayleigh scattering, most likely.');
  });

  it('accumulates reasoning across a multi-step turn', () => {
    const messages = projectTranscript([
      user('do it'),
      agent([
        {text: 'First I need the time.', thought: true},
        {functionCall: {id: 'call_1', name: 'current_time', args: {}}},
      ]),
      agent([
        {text: 'Now I can answer.', thought: true},
        {text: 'It is noon.'},
      ]),
    ]);

    expect(messages[1]?.reasoning).toBe(
      'First I need the time.Now I can answer.',
    );
    expect(messages[1]?.text).toBe('It is noon.');
    expect(messages[1]?.toolCalls).toHaveLength(1);
  });

  /*
   * A compacted conversation, which is the one case where the transcript is
   * deliberately *not* the whole file: the messages are still there, and the
   * model is no longer sent them. A window showing them would be a window
   * showing a conversation the agent does not have.
   */
  it('replaces the messages a summary stands for with one card', () => {
    const older = [
      stamped(user('what does this file do?'), 1_000),
      stamped(agent([{text: 'It parses the config.'}]), 1_010),
      stamped(user('and this one?'), 1_020),
      stamped(agent([{text: 'It writes it back.'}]), 1_030),
    ];
    const summary = stamped(
      buildCompactedEvent({
        summary: 'They asked about two files and got answers.',
        startTime: 1_000,
        endTime: 1_030,
      }),
      2_000,
    );
    const later = [
      stamped(user('now change the second one'), 3_000),
      stamped(agent([{text: 'Changed.'}]), 3_010),
    ];

    const messages = projectTranscript([...older, summary, ...later]);

    expect(messages).toHaveLength(3);
    expect(messages[0]).toMatchObject({
      role: 'user',
      text: 'They asked about two files and got answers.',
      // Four messages were hidden, counted as *messages* rather than events: a
      // number of events would be one the user never saw.
      compacted: 4,
    });
    expect(messages[1]?.text).toBe('now change the second one');
    expect(messages[2]?.text).toBe('Changed.');
    // Nothing that was compacted away is drawn, and nothing is missing from the
    // tail that was kept.
    expect(messages.map((message) => message.text).join(' ')).not.toContain(
      'It parses the config.',
    );
  });

  it('shows one card after a second compaction', () => {
    const older = [
      stamped(user('one'), 1_000),
      stamped(agent([{text: 'first answer'}]), 1_010),
      stamped(user('two'), 1_020),
      stamped(agent([{text: 'second answer'}]), 1_030),
      stamped(user('three'), 1_040),
      stamped(agent([{text: 'third answer'}]), 1_050),
    ];
    const first = stamped(
      buildCompactedEvent({summary: 'the first two', startTime: 1_000, endTime: 1_030}),
      1_100,
    );
    const second = stamped(
      buildCompactedEvent({summary: 'all three of them', startTime: 1_000, endTime: 1_050}),
      1_200,
    );

    const messages = projectTranscript([...older, first, second]);

    expect(messages).toHaveLength(1);
    expect(messages[0]?.text).toBe('all three of them');
    /*
     * Six, and not seven: the card the first compaction wrote is not counted as
     * one of the messages replaced. It was never a message the user saw — it
     * stood in for four of them — so what the card reports is real messages, at
     * every number of passes.
     */
    expect(messages[0]?.compacted).toBe(6);
  });
});

/*
 * A helper agent runs in the parent's conversation — it has to, because that is
 * where its approval requests have to be visible — so without attribution its
 * words and the lead's would merge into one bubble and read as a single answer
 * from a single mind. The user would have no way to tell which of them said the
 * thing they are looking at.
 */
describe('a helper agent in the conversation', () => {
  it('is attributed, and the conversation’s own agent is not', () => {
    const messages = projectTranscript([
      user('look into it'),
      helper('researcher', [{text: 'I read the logs.'}]),
    ]);

    expect(messages[1]).toMatchObject({
      role: 'assistant',
      agentId: 'researcher',
      text: 'I read the logs.',
    });
  });

  it('leaves the lead unattributed', () => {
    const messages = projectTranscript([user('hi'), agent([{text: 'hello'}])]);
    expect(messages[1]?.agentId).toBeUndefined();
  });

  /*
   * The bubble breaks when the speaker changes. Two agents in one bubble is the
   * failure this exists to prevent, and it is worse when the switch is
   * invisible: the lead's summary reads as the helper's finding.
   */
  it('starts a new bubble when a helper takes over', () => {
    const messages = projectTranscript([
      user('look into it'),
      agent([{text: 'Let me hand this over. '}]),
      helper('researcher', [{text: 'Here is what I found.'}]),
    ]);

    expect(messages).toHaveLength(3);
    expect(messages[1]).toMatchObject({text: 'Let me hand this over. '});
    expect(messages[1]?.agentId).toBeUndefined();
    expect(messages[2]).toMatchObject({
      agentId: 'researcher',
      text: 'Here is what I found.',
    });
  });

  it('starts a new bubble when the lead takes the conversation back', () => {
    const messages = projectTranscript([
      user('look into it'),
      helper('researcher', [{text: 'Found three problems.'}]),
      agent([{text: 'So: three problems.'}]),
    ]);

    expect(messages).toHaveLength(3);
    expect(messages[1]?.agentId).toBe('researcher');
    expect(messages[2]?.agentId).toBeUndefined();
    expect(messages[2]?.text).toBe('So: three problems.');
  });

  it('keeps two different helpers apart', () => {
    const messages = projectTranscript([
      user('do both'),
      helper('researcher', [{text: 'from research'}]),
      helper('writer', [{text: 'from writing'}]),
    ]);

    expect(messages.map((message) => message.agentId)).toEqual([
      undefined,
      'researcher',
      'writer',
    ]);
  });

  it('keeps one helper’s consecutive events in one bubble', () => {
    const messages = projectTranscript([
      user('look into it'),
      helper('researcher', [{text: 'First, '}]),
      helper('researcher', [{text: 'the answer.'}]),
    ]);

    expect(messages).toHaveLength(2);
    expect(messages[1]).toMatchObject({
      agentId: 'researcher',
      text: 'First, the answer.',
    });
  });
});

/** An event at a chosen moment: compaction compares timestamps strictly. */
function stamped(event: AdkEvent, timestamp: number): AdkEvent {
  return {...event, timestamp};
}
