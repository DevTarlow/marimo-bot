/**
 * Handing work to another agent by name.
 *
 * A delegation is a *tool call*, not a second conversation. The lead asks for one
 * of the agents this install has, by name and task, that agent runs, and what
 * comes back is the tool result. That framing decides almost everything below.
 *
 * **The helper runs in the parent's conversation.** This is not tidiness — it is
 * what makes approval work. A gate is recorded in the conversation it belongs to
 * and the window finds it by reading that conversation's log; a helper writing to
 * its own session would ask a question nobody could see, and the turn would wait
 * for an answer that could never arrive. Sharing the session means a helper's
 * `write_file` raises exactly the card a lead's would, in the thread the user is
 * looking at.
 *
 * **Depth is one, by construction.** The helper is built by the host without this
 * tool, so recursion is not something a runaway model can talk its way into. A
 * depth limit that is a number to compare is a limit that can be got wrong.
 *
 * **It is bounded four ways.** Steps, wall-clock time, the size of what it hands
 * back, and how many helpers one turn may ask for. A helper is the one part of a
 * turn the user cannot watch closely, so it is the one part that most needs a
 * ceiling.
 *
 * **Nothing here throws.** Every refusal — an unknown agent, a blank task, a
 * space that does not exist, a helper that failed — comes back as the tool's
 * answer. A tool that throws ends the parent's turn, which would turn "no such
 * helper" into "your request failed".
 *
 * **The helper's approval is this tool's own gate.** A helper that reaches a card
 * cannot be followed from inside one call: ADK ends the invocation at the gate,
 * and a tool that waited would leave the model's own call unanswered in the
 * conversation — a request every provider refuses on the next turn. So the call
 * raises a card of its own, through ADK's `requestConfirmation`, and the user's
 * answer resumes *this* tool. It is then the one place the two sides can be
 * joined: the card the user clicked belongs to this call, and the work that has
 * to carry on belongs to the helper, which is told what was decided and runs
 * again.
 *
 * The user sees one card and clicks it once. The helper's own gate is still in the
 * conversation beside it — the child's runner put it there, and that is what stops
 * the child mid-call — but it is not a second thing to answer.
 */
import {FunctionTool} from '@google/adk';
import type {Context, ToolConfirmation} from '@google/adk';
import type {Content} from '@google/genai';
import {z} from 'zod';

import type {AgentUiEvent} from '@marimo/protocol';

import {describeToolResult, hasError} from '../host/tool-result.js';

/** The bounds a helper runs under. */
export interface AgentLimits {
  /** How many model turns the helper may take before it is stopped. */
  maxSteps: number;
  /** How long it may take, including any time the user spends on a card. */
  timeoutMs: number;
  /** How much of its answer may reach the parent's context. */
  maxResultChars: number;
  /** How many helpers one turn may ask for. */
  maxPerTurn: number;
}

export const DEFAULT_AGENT_LIMITS: AgentLimits = {
  /*
   * Turns, not events. This counted every event once, which was already an
   * approximation and became a defect when answers started streaming: a
   * reasoning model emits one partial event per token, so the budget was spent
   * on the *thinking* of the first request. A helper could be stopped before it
   * had called a single tool — with its work already on disk and the lead told
   * it had failed. Sixty real turns is generous enough for the work and still
   * catches the loop this exists for.
   */
  maxSteps: 60,
  timeoutMs: 5 * 60_000,
  maxResultChars: 8_000,
  maxPerTurn: 3,
};

/**
 * One helper step, as this file needs to see it.
 *
 * A narrower shape than ADK's event on purpose: the tool reads the author and
 * the text and nothing else, and narrowing it here is what lets the whole of the
 * tool's behaviour — the limits, the gate round trip, the refusal — be tested
 * without a model, a runner or a provider.
 */
export interface AgentEvent {
  author?: string;
  /**
   * Whether this is a chunk of a streaming answer or the settled one.
   *
   * Load-bearing, and the reason it is on this narrow shape rather than left to
   * the caller: ADK emits the helper's words as partial events and *then* an
   * aggregated one, so a collector that ignores the flag either keeps only the
   * last chunk or counts the whole answer twice. The host's own turn loop reads
   * exactly this field for exactly this reason.
   */
  partial?: boolean;
  /**
   * Whether this event is the settled end of one model turn.
   *
   * This, rather than the event's own arrival, is what the step budget counts.
   * The two are not the same number: a streamed turn is dozens or hundreds of
   * partial events and exactly one of these, so counting events makes the
   * budget a limit on how much the model may *say* rather than on how many times
   * it asks.
   */
  turnComplete?: boolean;
  content?: {
    parts?: Array<{
      text?: string;
      functionCall?: {id?: string; name?: string; args?: Record<string, unknown>};
      functionResponse?: {id?: string; name?: string; response?: unknown};
    }>;
  };
}

/** One gate a conversation has been asked and not yet answered. */
export interface AgentGate {
  callId: string;
  /** The tool the user is being asked about, for the sentence that parks. */
  tool: string;
}

/**
 * A helper, resolved and ready to run.
 *
 * `run` is over the *parent's* session service and session id, which is what puts
 * the helper's approval cards in the conversation the user is reading.
 */
export interface AgentTools {
  /** The profile the helper is, which is the id its reply is attributed to. */
  agentId: string;
  /**
   * The name ADK built the helper under.
   *
   * Its events carry *this* rather than the id, so it is what the tool watches for
   * when it decides whether a line is the helper's own words. Kept beside the id
   * instead of derived here, because the encoding is the host's business and a
   * second implementation of it would be a helper whose words nobody collects.
   */
  author: string;
  /** The name the user will read in the conversation. */
  name: string;
  /** Streams the helper's steps, from wherever it stopped. */
  run: (request: {
    sessionId: string;
    newMessage: Content;
    signal: AbortSignal;
  }) => AsyncIterable<AgentEvent>;
}

/**
 * What the host gives the tool so it can build and follow a helper.
 *
 * Injected rather than done here, because naming an agent and choosing the space
 * it works in means reading documents — the profiles, the spaces, and the key
 * for the service that answers — all of which belong to the runtime, and none of
 * which this file should have an opinion about.
 */
export interface AgentDelegation {
  /**
   * Resolves the name and builds the helper, or says what is wrong.
   *
   * The failure is a return value rather than a throw because it becomes the
   * tool's answer: the model is told which agents do exist and carries on, where
   * an exception would end the user's whole turn.
   */
  start: (request: {
    agent: string;
    space?: string;
    /** The conversation asking, so the helper can default to its Space. */
    sessionId: string;
  }) => Promise<AgentTools | {problem: string}>;
  /** The gates a conversation has been asked and not yet answered. */
  pendingGates: (sessionId: string) => Promise<AgentGate[]>;
  /** How the helper's work reaches the window while the turn is suspended. */
  onEvent?: (event: AgentUiEvent) => void;
  limits?: Partial<AgentLimits>;
}

/**
 * The tool, which is also the seam it was built from.
 *
 * `reset` is the one thing beyond ADK's interface: a way to say "a new turn has
 * started", so the count above is a count of a turn rather than of a session.
 */
export type AskAgentTool = FunctionTool & AgentDelegation & {reset: () => void};

/** The tool's arguments. */
const parameters = z.object({
  agent: z
    .string()
    .describe(
      'The name of the agent to hand the work to, as it is listed in Settings. ' +
        'Only agents that exist on this computer can be asked.',
    ),
  task: z
    .string()
    .describe(
      'What the helper should do, in full. It cannot see this conversation, so ' +
        'write it as a complete instruction including anything it needs to know, ' +
        'and say what a good answer looks like.',
    ),
  space: z
    .string()
    .optional()
    .describe(
      'The name of the Space the helper should work in, when it should not be ' +
        'this conversation’s own. Its file tools are confined there.',
    ),
});

/**
 * What the tool that hands work to another agent is called.
 *
 * Exported because somebody outside this package has to name it: the window's
 * setup flow offers to grant it to the lead, so that Marimo Bot can give a bot
 * something to do. A second spelling of the string out there would grant a name
 * no tool answers to, and the failure is silent — a profile's grant naming
 * nothing is filtered away at the host rather than refused, so the box would
 * tick and the capability would not arrive.
 */
export const ASK_AGENT_TOOL = 'ask_agent';

/**
 * The tool, and the seam it was built from, as one object.
 *
 * The same dependency twice, deliberately: it is what decides whether the tool
 * exists at all — `createTools` is handed it — and it is what the tool *is*, since
 * the host keeps the built tool so a new turn can clear its count. One object
 * because two would be two answers to "can this install delegate", and the one the
 * model saw would be the wrong one.
 */
export function createAskAgentTool(
  deps: AgentDelegation,
  seam: AgentDelegation,
): AskAgentTool {
  const limits: AgentLimits = {...DEFAULT_AGENT_LIMITS, ...deps.limits};
  /*
   * Counted per *turn*, not per session. The tool object outlives a turn — it is
   * built with the runner, which is cached — so the count is cleared by the host
   * when a turn ends, through the property attached below. Without that, the
   * fourth helper of a conversation would be refused rather than the fourth of a
   * turn, and the user would meet a limit they had not reached.
   */
  let asked = 0;

  const tool = new FunctionTool({
    name: ASK_AGENT_TOOL,
    description:
      'Hand a self-contained piece of work to another agent on this computer ' +
      'and get its answer back. Use it for work that is separable and would ' +
      'otherwise fill this conversation with detail — reading through many ' +
      'files, researching a question, drafting something long. The helper ' +
      'starts fresh: it cannot see this conversation and it cannot ask you ' +
      'anything, so give it everything it needs in `task`. Anything it needs ' +
      'your approval for is asked here, in this conversation. At most ' +
      `${String(limits.maxPerTurn)} helpers per turn, and no helper can ask ` +
      'for one of its own.',
    parameters,
    execute: async (
      args: {agent: string; task: string; space?: string},
      toolContext?: Context,
    ): Promise<string> => {
      asked += 1;
      return await runAgent(args, toolContext, {deps, limits, count: asked});
    },
  });

  /*
   * Attached rather than kept beside the tool because the host builds the tool
   * and has nowhere else to hold it: what it needs is a way to say "a new turn
   * has started", and the tool is the only object that knows the count.
   */
  return Object.assign(tool, seam, {
    reset: (): void => {
      asked = 0;
    },
  });
}

async function runAgent(
  args: {agent: string; task: string; space?: string},
  toolContext: Context | undefined,
  parts: {deps: AgentDelegation; limits: AgentLimits; count: number},
): Promise<string> {
  const {deps, limits, count} = parts;

  const task = args.task.trim();
  if (task.length === 0) {
    return 'A helper needs a task. Say what it should do.';
  }
  if (count > limits.maxPerTurn) {
    return (
      `This turn has already asked ${String(limits.maxPerTurn)} helpers, which ` +
      'is the limit. Do the rest of the work yourself, or ask the user to send ' +
      'another message.'
    );
  }

  /*
   * Without an invocation there is no conversation to run inside, and no session
   * service to store the helper's events in. Refused in words rather than
   * thrown: a tool that throws ends the parent's turn, which would turn "the
   * helper could not start" into "your whole request failed".
   */
  const invocation = toolContext?.invocationContext;
  const sessionService = invocation?.sessionService;
  if (invocation === undefined || sessionService === undefined) {
    return 'A helper cannot be started outside a conversation.';
  }
  const sessionId = invocation.session.id;
  const callId = toolContext?.functionCallId ?? 'ask_agent';

  const started = Date.now();
  const controller = new AbortController();

  const resolved = await deps.start({
    agent: args.agent,
    ...(args.space === undefined ? {} : {space: args.space}),
    sessionId,
  });
  if ('problem' in resolved) {
    return resolved.problem;
  }
  const helper = resolved;

  /*
   * The decision the user gave, when there is one. ADK hands it to the tool it is
   * resuming, which is the only place the two sides can be joined: the card the
   * user clicked belongs to *this* call, and the work that has to carry on belongs
   * to the helper. Absent on a first run, and `confirmed: false` on a refusal.
   */
  const decision = toolContext?.toolConfirmation;

  deps.onEvent?.({
    type: 'delegate.started',
    sessionId,
    callId,
    agentId: helper.agentId,
    name: helper.name,
    task,
  });

  let steps = 0;
  let answer = '';
  /** Whether the turn being read has already reached the window as deltas. */
  let streamed = false;
  let stopped: string | undefined;
  /** Set when the helper parked on a card that is now this call's to raise. */
  let parked = false;

  /* The parent's abort must reach the helper, or "stop" leaves it running. */
  const relay = (): void => {
    controller.abort();
  };
  toolContext?.abortSignal?.addEventListener('abort', relay, {once: true});

  const timer = setTimeout(() => {
    stopped = `The helper ran for longer than ${describeDuration(limits.timeoutMs)} and was stopped.`;
    controller.abort();
  }, limits.timeoutMs);

  try {
    for await (const event of helper.run({
      sessionId,
      newMessage: messageFor(task, decision),
      signal: controller.signal,
    })) {
      /*
       * One step is one finished model turn, not one event. With SSE a thought
       * arrives a token at a time, so an event count is a limit on how much the
       * helper may *say* before it has done anything — sixty partial chunks can
       * be two sentences of reasoning and no tool call at all. The settled event
       * is the turn; the chunks that produced it are not.
       */
      if (event.partial !== true && event.turnComplete === true) {
        steps += 1;
      }
      const text = textOf(event);
      /*
       * The helper's words, as it writes them, and only its own: ADK emits events
       * for its bookkeeping too, and forwarding those would make the live view
       * say more than the transcript it is a preview of.
       *
       * Three facts about an ADK stream decide this shape, and getting any of
       * them wrong is quiet.
       *
       * A partial event is a *chunk*; a settled one carries everything the helper
       * said in that turn. So the answer is accumulated while it streams and then
       * *replaced* by the settled text — adding the settled event to the deltas
       * that produced it would hand the lead the same paragraph twice, and
       * assigning each chunk over the last would hand it only the final fragment
       * of a helper that streamed.
       *
       * The window, meanwhile, must hear each chunk exactly once: a settled event
       * whose text already went out as deltas is not forwarded again.
       *
       * And a helper with several turns says something in each. The answer the
       * lead is given is the last turn's, which is its conclusion; the earlier
       * prose is in the thread above it.
       */
      if (text.length > 0 && event.author === helper.author) {
        if (event.partial === true) {
          streamed = true;
          answer += text;
          emitHelperText(deps, {sessionId, callId, helper, text});
        } else {
          if (!streamed) {
            emitHelperText(deps, {sessionId, callId, helper, text});
          }
          streamed = false;
          answer = text;
        }
      }

      /*
       * What the helper is *doing*, which is not the same as what it says.
       *
       * Forwarded as the ordinary tool events the window already draws, so a
       * helper's `read_file` appears inside its thread the way the lead's own
       * calls appear in the turn — and so the fold has steps in it rather than a
       * blank stretch and then a paragraph. The ids are the helper's, because
       * they are what its results come back under; the session is the parent's,
       * because that is the conversation these are happening in.
       */
      for (const part of event.content?.parts ?? []) {
        if (part.functionCall?.name !== undefined) {
          deps.onEvent?.({
            type: 'tool.started',
            sessionId,
            messageId: `${callId}:helper`,
            callId: part.functionCall.id ?? part.functionCall.name,
            tool: part.functionCall.name,
            args: part.functionCall.args ?? {},
          });
        } else if (part.functionResponse?.name !== undefined) {
          deps.onEvent?.({
            type: 'tool.finished',
            sessionId,
            messageId: `${callId}:helper`,
            callId: part.functionResponse.id ?? part.functionResponse.name,
            tool: part.functionResponse.name,
            ok: !hasError(part.functionResponse.response),
            result: describeToolResult(part.functionResponse.response),
          });
        }
      }

      /*
       * `>` rather than `>=`: a turn that reaches the budget is allowed to
       * finish, because its answer may be the one the lead asked for. The turn
       * after it is the loop this bound exists to stop.
       */
      if (steps > limits.maxSteps) {
        stopped = `The helper used its whole budget of ${String(limits.maxSteps)} steps and was stopped.`;
        controller.abort();
        break;
      }
    }

    if (stopped === undefined) {
      const waiting = (await deps.pendingGates(sessionId)).filter(
        (gate) => gate.tool !== ASK_AGENT_TOOL,
      );
      if (waiting.length > 0) {
        /*
         * The helper is stopped at a card, so this call raises one of its own.
         *
         * That is what makes the child's gate answerable: the child's runner ends
         * its invocation at the gate, which leaves a card in the conversation that
         * nothing would click — the model's own call here is the one ADK can
         * resume, and its result is what has to exist before the next turn.
         */
        parked = true;
        toolContext?.requestConfirmation({
          hint:
            `"${helper.name}" needs your approval to use ` +
            `${waiting.map((gate) => gate.tool).join(', ')}. Approving this ` +
            'lets it carry on where it stopped.',
        });
      }
    }
  } catch (error) {
    /*
     * A refusal from the provider is the ordinary way a helper fails — no key, a
     * rate limit — and it is reported as the helper's answer rather than thrown.
     */
    if (stopped === undefined) {
      stopped = error instanceof Error ? error.message : String(error);
    }
  } finally {
    clearTimeout(timer);
    toolContext?.abortSignal?.removeEventListener('abort', relay);
    deps.onEvent?.({
      type: 'delegate.finished',
      sessionId,
      callId,
      agentId: helper.agentId,
      name: helper.name,
      ok: stopped === undefined && !parked,
      ms: Date.now() - started,
      ...(stopped === undefined ? {} : {error: stopped}),
    });
  }

  if (stopped !== undefined) {
    return `The helper "${helper.name}" did not finish: ${stopped}`;
  }
  if (parked) {
    /*
     * Nothing the model should read: the confirmation ADK raised is what the user
     * answers, and the answer re-runs this tool. A sentence here would be a second
     * thing said about the same card, and the user has not decided yet anyway.
     */
    return `Waiting for your approval before "${helper.name}" continues.`;
  }
  if (answer.trim().length === 0) {
    return `The helper "${helper.name}" finished without producing an answer.`;
  }
  return truncate(answer.trim(), limits.maxResultChars);
}

/**
 * What the helper is sent: its task, or what the user decided about its card.
 *
 * A sentence rather than a confirmation response, and that is a deliberate
 * retreat from what the ADK documentation suggests. Resuming a *child* by
 * function response was tried and does not hold: a confirmation is bound to the
 * call that raised it, and a helper's gate belongs to an invocation that has
 * already ended by the time the user clicks — the child re-asks, and the loop
 * never converges. What the child needs is not a protocol message but the news,
 * and a sentence is the one form of it that cannot be misread.
 *
 * It does mean the helper is told *what was approved* rather than being resumed
 * mid-call, so a helper that had several steps planned should be written a task
 * that survives being interrupted. The tool's description says as much.
 */
function messageFor(task: string, decision: ToolConfirmation | undefined): Content {
  if (decision === undefined) {
    return {role: 'user', parts: [{text: task}]};
  }
  return {
    role: 'user',
    parts: [
      {
        text: decision.confirmed
          ? 'The user approved this. Carry on and finish the task, then report ' +
            'the result.'
          : 'The user declined this. Stop what you were doing and say what you ' +
            'had done so far.',
      },
    ],
  };
}

/** One line of a helper's answer, as the window hears it. */
function emitHelperText(
  deps: AgentDelegation,
  parts: {
    sessionId: string;
    callId: string;
    helper: AgentTools;
    text: string;
  },
): void {
  deps.onEvent?.({
    type: 'delegate.event',
    sessionId: parts.sessionId,
    callId: parts.callId,
    agentId: parts.helper.agentId,
    name: parts.helper.name,
    text: parts.text,
  });
}

function textOf(event: {content?: {parts?: Array<{text?: string}>}}): string {
  const parts = event.content?.parts ?? [];
  return parts
    .map((part) => part.text ?? '')
    .filter((text) => text.length > 0)
    .join('');
}

/** Cut to the ceiling, and say so — a silent cut reads as a complete answer. */
function truncate(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, max)}\n\n[cut at ${String(max)} characters]`;
}

function describeDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  return minutes >= 1 ? `${String(minutes)} minutes` : `${String(Math.round(ms / 1000))} seconds`;
}
