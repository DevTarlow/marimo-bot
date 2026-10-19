/**
 * Handing work to a named agent.
 *
 * Every test here runs without a model, a provider or a network, because the
 * helper's own run is injected through the seam. What is under test is not "does
 * ADK work" but the things this file decides: what it refuses, how it is bounded,
 * what the parent is told, and how a helper's approval round trip is carried back
 * in.
 */
import type {Content} from '@google/genai';
import {describe, expect, it} from 'vitest';

import type {AgentUiEvent} from '@marimo/protocol';

import {createAskAgentTool} from './ask-agent-tool.js';
import type {
  AgentDelegation,
  AgentEvent,
  AgentGate,
  AgentTools,
} from './ask-agent-tool.js';

/** A context with only what the tool reads. */
function context(
  overrides: {
    aborted?: AbortSignal;
    /** Set on the run that answers a card this call raised. */
    confirmed?: boolean;
    /** Collects the hints of every card this call raised. */
    raised?: string[];
  } = {},
) {
  return {
    functionCallId: 'call-1',
    requestConfirmation: (request: {hint?: string}) => {
      overrides.raised?.push(request.hint ?? '');
    },
    invocationContext: {
      appName: 'marimo',
      userId: 'user',
      session: {id: 'session-1'},
      // Only its presence is checked; the run is injected.
      sessionService: {},
    },
    ...(overrides.confirmed === undefined
      ? {}
      : {
          toolConfirmation: {
            hint: 'the helper needs approval',
            confirmed: overrides.confirmed,
          },
        }),
    ...(overrides.aborted === undefined ? {} : {abortSignal: overrides.aborted}),
  } as never;
}

/** The helper the seam resolves to, with its run replaced. */
function helper(options: {
  agentId?: string;
  author?: string;
  name?: string;
  events?: AgentEvent[];
  runs?: string[];
}): AgentTools {
  const runs = options.runs ?? [];
  return {
    agentId: options.agentId ?? 'researcher',
    author: options.author ?? 'researcher',
    name: options.name ?? 'Researcher',
    run: (request) => {
      runs.push(textOf(request.newMessage));
      return (async function* () {
        for (const event of options.events ?? []) {
          yield event;
        }
      })();
    },
  };
}

function textOf(message: Content): string {
  return (message.parts ?? [])
    .map((part) => part.text ?? '')
    .join('');
}

/** One settled answer, which is also one finished model turn. */
function saying(author: string, text: string): AgentEvent {
  return {
    author,
    partial: false,
    turnComplete: true,
    content: {parts: [{text}]},
  };
}

/** One chunk of a streaming answer, as ADK emits it while the model writes. */
function chunk(author: string, text: string): AgentEvent {
  return {author, partial: true, content: {parts: [{text}]}};
}

/**
 * A seam that resolves to `tools`, recording what it was asked for.
 *
 * The three gate methods are a working stand-in of the host's: a card is raised
 * by setting `pending`, and the answer is what the window's click would have
 * stored. That is the whole of the round trip the tool takes part in.
 */
function seam(
  tools: AgentTools | {problem: string},
  overrides: Partial<AgentDelegation> = {},
): {deps: AgentDelegation; asked: Array<{agent: string; space?: string}>} {
  const asked: Array<{agent: string; space?: string}> = [];
  const pending: AgentGate[] = [];
  return {
    asked,
    deps: {
      start: async (request) => {
        asked.push({
          agent: request.agent,
          ...(request.space === undefined ? {} : {space: request.space}),
        });
        return tools;
      },
      pendingGates: async () => [...pending],
      ...overrides,
    },
  };
}

/** Runs the tool and answers what it returned. */
async function ask(
  deps: AgentDelegation,
  args: {agent: string; task: string; space?: string},
  ctx: unknown = context(),
): Promise<string> {
  const tool = createAskAgentTool(deps, deps);
  const execute = (
    tool as unknown as {
      execute: (a: unknown, c: unknown) => Promise<string>;
    }
  ).execute;
  return await execute(args, ctx);
}

describe('the ask_agent tool', () => {
  it('is offered under a name the model can call', () => {
    const {deps} = seam(helper({}));
    const tool = createAskAgentTool(deps, deps);
    expect(tool.name).toBe('ask_agent');
    // The description has to carry the things a model gets wrong: that the helper
    // cannot see this conversation, cannot ask anything back, and cannot recurse.
    expect(tool.description).toMatch(/cannot see this conversation/u);
    expect(tool.description).toMatch(/cannot ask you/u);
    expect(tool.description).toMatch(/no helper can ask for one of its own/u);
  });

  /*
   * The three refusals a lead will actually meet. Each is a *sentence*: a tool
   * that throws ends the parent's turn, which turns "no such helper" into "your
   * request failed".
   */
  it('refuses an unknown agent and lists the ones that exist', async () => {
    const {deps, asked} = seam({problem: 'There is no agent called "ghost".'});

    const answer = await ask(deps, {agent: 'ghost', task: 'do a thing'});

    expect(answer).toContain('There is no agent called "ghost".');
    // The seam was asked — the resolution is its job — and nothing ran.
    expect(asked).toEqual([{agent: 'ghost'}]);
  });

  it('refuses a blank task without resolving anything', async () => {
    const {deps, asked} = seam(helper({}));

    const answer = await ask(deps, {agent: 'researcher', task: '   '});

    expect(answer).toMatch(/needs a task/u);
    expect(asked).toEqual([]);
  });

  /*
   * Without an invocation there is no conversation to run inside and no session
   * service to store the helper's events in — so a gate it raised would be a
   * question nobody could see.
   */
  it('refuses outside a conversation instead of throwing', async () => {
    const {deps} = seam(helper({}));
    expect(await ask(deps, {agent: 'researcher', task: 'x'}, {})).toMatch(
      /outside a conversation/u,
    );
  });

  it('refuses when there is no session service to record the helper in', async () => {
    const {deps} = seam(helper({}));
    const answer = await ask(deps, {agent: 'researcher', task: 'x'}, {
      invocationContext: {appName: 'marimo', userId: 'u', session: {id: 's'}},
    });
    expect(answer).toMatch(/outside a conversation/u);
  });

  it('passes the space the model named through to the seam', async () => {
    const {deps, asked} = seam(helper({events: [saying('researcher', 'ok')]}));
    await ask(deps, {agent: 'Researcher', task: 'x', space: 'Website'});
    expect(asked).toEqual([{agent: 'Researcher', space: 'Website'}]);
  });
});

describe('where the helper runs', () => {
  /*
   * The property that makes approval work at all. A gate is recorded in the
   * conversation it belongs to and the window finds it by reading that
   * conversation's log; a helper in its own session would ask a question nobody
   * could see, and the turn would wait for an answer that could never arrive.
   */
  it('runs with the task it was given, and answers with its words', async () => {
    const runs: string[] = [];
    const {deps} = seam(helper({events: [saying('researcher', 'the answer')], runs}));

    const answer = await ask(deps, {agent: 'researcher', task: ' read the logs '});

    expect(runs).toEqual(['read the logs']);
    expect(answer).toBe('the answer');
  });

  it('answers with the helper’s last words, not its first', async () => {
    const {deps} = seam(
      helper({
        events: [saying('researcher', 'let me look'), saying('researcher', 'the answer')],
      }),
    );
    expect(await ask(deps, {agent: 'researcher', task: 'x'})).toBe('the answer');
  });

  /*
   * The streaming case, which is the one that is easy to get wrong in either
   * direction: a model that streams emits chunks *and then* a settled event
   * carrying everything it said. Adding the settled text to the chunks hands the
   * lead the paragraph twice; assigning each chunk over the last hands it the
   * final fragment. And the window must hear each chunk once — a settled event
   * whose text already went out as deltas is not a fourth thing to draw.
   */
  it('joins a streamed answer without saying it twice', async () => {
    const seen: string[] = [];
    const {deps} = seam(
      helper({
        events: [
          chunk('researcher', 'the '),
          chunk('researcher', 'answer '),
          chunk('researcher', 'is 42'),
          saying('researcher', 'the answer is 42'),
        ],
      }),
      {onEvent: (event) => {
        if (event.type === 'delegate.event') {
          seen.push(event.text);
        }
      }},
    );

    expect(await ask(deps, {agent: 'researcher', task: 'x'})).toBe(
      'the answer is 42',
    );
    // Three chunks, and the settled event silent: its text is already there.
    expect(seen).toEqual(['the ', 'answer ', 'is 42']);
  });

  /*
   * The helper's *doing*, which the window draws inside its thread the way the
   * lead's own calls are drawn in the turn. Without this the fold has a blank
   * stretch and then a paragraph, and a user watching a helper work sees nothing
   * happen — which is the state this whole feature exists to avoid.
   */
  it('forwards the helper’s calls as ordinary tool events', async () => {
    const seen: AgentUiEvent[] = [];
    const {deps} = seam(
      helper({
        events: [
          {
            author: 'researcher',
            content: {
              parts: [
                {
                  functionCall: {
                    id: 'call-1',
                    name: 'read_file',
                    args: {path: 'notes.md'},
                  },
                },
              ],
            },
          },
          {
            author: 'researcher',
            content: {
              parts: [
                {
                  functionResponse: {
                    id: 'call-1',
                    name: 'read_file',
                    response: {result: 'the notes'},
                  },
                },
              ],
            },
          },
        ],
      }),
      {onEvent: (event) => seen.push(event)},
    );

    await ask(deps, {agent: 'researcher', task: 'x'});

    /*
     * Matched on the fields that decide where the window puts it, not on the
     * whole event: the message id is the parent's call id with a suffix, which is
     * this file's business, and pinning it here would make a rename of that
     * convention look like a broken thread.
     */
    expect(seen).toContainEqual(
      expect.objectContaining({
        type: 'tool.started',
        sessionId: 'session-1',
        callId: 'call-1',
        tool: 'read_file',
        args: {path: 'notes.md'},
      }),
    );
    expect(seen).toContainEqual(
      expect.objectContaining({
        type: 'tool.finished',
        sessionId: 'session-1',
        callId: 'call-1',
        tool: 'read_file',
        ok: true,
        result: 'the notes',
      }),
    );
  });

  it('says so when the helper produced nothing', async () => {
    const {deps} = seam(helper({events: []}));
    expect(await ask(deps, {agent: 'researcher', task: 'x'})).toMatch(
      /finished without producing an answer/u,
    );
  });

  it('reports a failure as the helper’s answer rather than throwing', async () => {
    const {deps} = seam(helper({}), {
      start: async () => ({
        agentId: 'researcher',
        author: 'researcher',
        name: 'Researcher',
        run: () =>
          (async function* () {
            throw new Error('DeepSeek needs an API key.');
          })(),
      }),
    });

    const answer = await ask(deps, {agent: 'researcher', task: 'x'});
    // The parent's turn continues and can explain itself, rather than the whole
    // request failing because a helper could not start.
    expect(answer).toBe(
      'The helper "Researcher" did not finish: DeepSeek needs an API key.',
    );
  });
});

describe('what the window sees', () => {
  it('opens, streams and closes a group', async () => {
    const seen: AgentUiEvent[] = [];
    const {deps} = seam(
      helper({events: [saying('researcher', 'thinking'), saying('researcher', 'done')]}),
      {onEvent: (event) => seen.push(event)},
    );

    await ask(deps, {agent: 'researcher', task: 'read the logs'});

    expect(seen.map((event) => event.type)).toEqual([
      'delegate.started',
      'delegate.event',
      'delegate.event',
      'delegate.finished',
    ]);
    expect(seen[0]).toMatchObject({
      agentId: 'researcher',
      name: 'Researcher',
      callId: 'call-1',
      task: 'read the logs',
    });
    expect(seen[3]).toMatchObject({agentId: 'researcher', ok: true});
  });

  /*
   * Only the helper's own words. ADK emits events for its bookkeeping as well —
   * and for the parent's, since both share one session — so forwarding them would
   * make the live view say more than the transcript it is a preview of.
   */
  it('forwards the helper’s words and nothing else', async () => {
    const seen: AgentUiEvent[] = [];
    const {deps} = seam(
      helper({
        events: [
          saying('researcher', 'mine'),
          saying('marimo', 'not mine'),
          {author: 'researcher', content: {parts: []}},
        ],
      }),
      {onEvent: (event) => seen.push(event)},
    );

    await ask(deps, {agent: 'researcher', task: 'x'});

    const streamed = seen.filter((event) => event.type === 'delegate.event');
    expect(streamed).toHaveLength(1);
    expect(streamed[0]).toMatchObject({text: 'mine'});
  });

  it('closes the group with the reason when the helper fails', async () => {
    const seen: AgentUiEvent[] = [];
    const {deps} = seam(helper({}), {
      onEvent: (event) => seen.push(event),
      start: async () => ({
        agentId: 'researcher',
        author: 'researcher',
        name: 'Researcher',
        run: () =>
          (async function* () {
            throw new Error('the provider refused');
          })(),
      }),
    });

    await ask(deps, {agent: 'researcher', task: 'x'});

    expect(seen[seen.length - 1]).toMatchObject({
      type: 'delegate.finished',
      ok: false,
      error: 'the provider refused',
    });
  });
});

describe('how it is bounded', () => {
  it('stops at its step budget and says so', async () => {
    const many = Array.from({length: 20}, () => saying('researcher', 'tick'));
    const {deps} = seam(helper({events: many}), {limits: {maxSteps: 3}});

    const answer = await ask(deps, {agent: 'researcher', task: 'x'});

    expect(answer).toMatch(/whole budget of 3 steps/u);
  });

  /*
   * A streamed answer is one turn written a token at a time, not one step per
   * token. Counting events here stopped a helper after sixty chunks — its work
   * already on disk and the lead told the handoff had failed — which is worse
   * than any loop the budget exists to catch.
   */
  it('does not spend its step budget on a streamed answer', async () => {
    const many = Array.from({length: 200}, () => chunk('researcher', 'tick'));
    const {deps} = seam(
      helper({events: [...many, saying('researcher', 'done')]}),
      {limits: {maxSteps: 3}},
    );

    expect(await ask(deps, {agent: 'researcher', task: 'x'})).toBe('done');
  });

  it('stops at its wall clock and says so', async () => {
    const {deps} = seam(helper({}), {
      limits: {timeoutMs: 5},
      start: async () => ({
        agentId: 'researcher',
        author: 'researcher',
        name: 'Researcher',
        run: (request) =>
          (async function* () {
            // Longer than the whole budget, and it never finishes: the tool has
            // to stop it rather than wait for it.
            await new Promise((resolve, reject) => {
              const timer = setTimeout(resolve, 1_000);
              request.signal.addEventListener('abort', () => {
                clearTimeout(timer);
                reject(new Error('the helper was stopped'));
              });
            });
            yield saying('researcher', 'too late');
          })(),
      }),
    });

    const answer = await ask(deps, {agent: 'researcher', task: 'x'});

    expect(answer).toMatch(/ran for longer than/u);
  });

  /*
   * A silent cut reads as a complete answer, which is the same failure the step
   * budget exists to prevent.
   */
  it('truncates a long answer and says that it did', async () => {
    const long = 'x'.repeat(500);
    const {deps} = seam(helper({events: [saying('researcher', long)]}), {
      limits: {maxResultChars: 100},
    });

    const answer = await ask(deps, {agent: 'researcher', task: 'x'});

    expect(answer).toContain('[cut at 100 characters]');
    expect(answer.length).toBeLessThan(long.length);
  });

  /*
   * The count is of a *turn*, which is why the tool is asked four times through
   * one instance here: a fresh tool per call would make the limit unobservable,
   * and a counter that was never cleared would refuse the user's next message.
   */
  it('refuses the fourth delegation in one turn', async () => {
    const {deps} = seam(helper({events: [saying('researcher', 'done')]}));
    const tool = createAskAgentTool(deps, deps);
    const execute = (
      tool as unknown as {
        execute: (a: unknown, c: unknown) => Promise<string>;
      }
    ).execute;

    const answers: string[] = [];
    for (let index = 0; index < 4; index += 1) {
      answers.push(await execute({agent: 'researcher', task: `task ${String(index)}`}, context()));
    }

    expect(answers[0]).toBe('done');
    expect(answers[1]).toBe('done');
    expect(answers[2]).toBe('done');
    expect(answers[3]).toMatch(/already asked 3 helpers/u);

    // And a new turn gets its three back.
    tool.reset();
    expect(await execute({agent: 'researcher', task: 'again'}, context())).toBe(
      'done',
    );
  });

  /*
   * The parent's stop has to reach the helper. Without this, pressing Stop leaves
   * a helper running and spending, and the turn it belonged to looks finished.
   */
  it('stops the helper when the parent is stopped', async () => {
    const parent = new AbortController();
    let sawAbort = false;

    const {deps} = seam(helper({}), {
      start: async () => ({
        agentId: 'researcher',
        author: 'researcher',
        name: 'Researcher',
        run: (request) =>
          (async function* () {
            parent.abort();
            sawAbort = request.signal.aborted;
            yield saying('researcher', 'partial');
          })(),
      }),
    });

    await ask(deps, {agent: 'researcher', task: 'x'}, context({aborted: parent.signal}));

    expect(sawAbort).toBe(true);
  });
});

/*
 * The half of the feature that no other test can reach without a model: a helper
 * stops at its approval gate, the user answers the card in the *parent's*
 * conversation, and the helper carries on.
 *
 * Two tool *calls*, because that is what the conversation makes of it: the first
 * parks and gives the parent's turn back, the user's approval is a new user
 * message, and the second call resumes the helper with the confirmation. The
 * third thing asserted here is the one that would otherwise be invisible — the
 * parked call still answers the model, because a tool call ADK has already written
 * into the conversation and never got a result for is a request every provider
 * refuses.
 */
describe('a helper that needs approval', () => {
  /** The gate the helper parks on, and the answer the user gives it. */
  const GATE = {callId: 'gate-1', tool: 'write_file'};

  /**
   * A helper that asks for a file write, and answers once it is resumed.
   *
   * `messages` is what each of its runs was sent, so the resume can be checked to
   * be the confirmations *alone*: repeating the task would read as the user asking
   * again, and would put the first attempt back in front of the model as
   * something to redo.
   */
  function gated(options: {messages: Content[]}): AgentTools {
    return {
      agentId: 'researcher',
      author: 'researcher',
      name: 'Researcher',
      run: (request) => {
        options.messages.push(request.newMessage);
        // The decision arrives as news rather than as a confirmation response:
        // see `messageFor` for why a resumed child is told rather than replayed.
        const told = textOf(request.newMessage);
        return (async function* () {
          if (told.includes('The user approved')) {
            yield saying('researcher', 'Written.');
            return;
          }
          if (told.includes('The user declined')) {
            yield saying('researcher', 'I stopped before writing it.');
            return;
          }
          yield saying('researcher', 'I need to write a file.');
        })();
      },
    };
  }

  /** A seam whose card is up until `answerIt` is called. */
  function withCard(options: {messages: Content[]}): {
    deps: AgentDelegation;
    answerIt: () => void;
  } {
    const pending: AgentGate[] = [GATE];

    const deps: AgentDelegation = {
      start: async () => gated(options),
      pendingGates: async () => [...pending],
    };
    return {
      deps,
      answerIt: () => {
        // The click answers the card *this tool* raised, which is what ADK hands
        // the resumed call back as `toolConfirmation` — the helper's own gate is
        // not what resumes, and the test says so by clearing it here.
        pending.length = 0;
      },
    };
  }

  /** One tool call, through a fresh tool — which is what a turn is. */
  async function call(
    deps: AgentDelegation,
    task: string,
    ctx: unknown = context(),
  ): Promise<string> {
    return await ask(deps, {agent: 'researcher', task}, ctx);
  }

  it('parks on the card it raised, and resumes with the confirmation', async () => {
    const messages: Content[] = [];
    const raised: string[] = [];
    const {deps, answerIt} = withCard({messages});

    const parked = await call(deps, 'write it', context({raised}));

    // The card is this call's own, so the conversation has nothing dangling for
    // the provider to refuse — and the hint says which helper is waiting.
    expect(raised).toHaveLength(1);
    expect(raised[0]).toContain('Researcher');
    expect(raised[0]).toContain('write_file');
    expect(parked).toMatch(/Waiting for your approval/u);
    expect(messages).toHaveLength(1);
    expect(textOf(messages[0]!)).toBe('write it');

    // The user clicks, and the next turn reaches the same tool again — with the
    // confirmation ADK resumes it by.
    answerIt();
    const resumed = await call(deps, 'write it', context({confirmed: true}));

    expect(resumed).toBe('Written.');
    expect(messages).toHaveLength(2);
    // With no gate store to read, the fallback carries the task as well as the
    // decision. A helper is built with `includeContents: 'none'`, so a resume
    // that repeated nothing would wake up with nothing to do — which is exactly
    // how it came to ask the person what the task was.
    expect(textOf(messages[1]!)).toContain('The user approved this');
    expect(textOf(messages[1]!)).toContain('write it');
  });

  /*
   * The path the host uses: the session can name the call the helper stopped on,
   * so the resume is a confirmation response for *that* call. ADK binds it to the
   * original call and executes it, which is what lets the helper carry on rather
   * than re-plan and re-ask.
   */
  it('resumes the exact call the helper parked on when the gate can be read', async () => {
    const messages: Content[] = [];
    const gates: AgentGate[] = [{callId: 'gate-1', tool: 'write_file'}];
    const deps: AgentDelegation = {
      start: async () => ({
        agentId: 'researcher',
        author: 'researcher',
        name: 'Researcher',
        run: (request) => {
          messages.push(request.newMessage);
          return (async function* () {
            const confirmed = (request.newMessage.parts ?? []).some(
              (part) => part.functionResponse?.id === 'gate-1',
            );
            yield confirmed
              ? saying('researcher', 'Written.')
              : saying('researcher', 'I need to write a file.');
          })();
        },
      }),
      pendingGates: async () =>
        messages.length === 1 ? [{callId: 'gate-1', tool: 'write_file'}] : [],
      helperGates: async () => (messages.length === 1 ? gates : []),
    };

    const parked = await call(deps, 'write it', context({raised: []}));
    expect(parked).toMatch(/Waiting for your approval/u);

    const resumed = await call(deps, 'write it', context({confirmed: true}));

    expect(resumed).toBe('Written.');
    expect(messages).toHaveLength(2);
    expect(messages[1]!.parts).toEqual([
      {
        functionResponse: {
          id: 'gate-1',
          name: 'adk_request_confirmation',
          response: {confirmed: true},
        },
      },
    ]);
  });

  it('reports a declined request as the helper’s outcome', async () => {
    const messages: Content[] = [];
    const {deps, answerIt} = withCard({messages});

    await call(deps, 'write it');
    answerIt();
    const resumed = await call(deps, 'write it', context({confirmed: false}));

    // It ran again carrying the refusal — the model asked for something the user
    // said no to, and the helper's job is to hear that and stop asking.
    expect(resumed).toBe('I stopped before writing it.');
    expect(messages).toHaveLength(2);
    expect(textOf(messages[1]!)).toContain('The user declined this');
  });
});
