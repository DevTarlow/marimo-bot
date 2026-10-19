/**
 * The two tools that let a bot ask for a capability, without getting one.
 *
 * The rule the whole learning loop is built on is that the bot proposes and the
 * person decides. A tool that granted itself would invert that rule, so these
 * tools do not grant: they write a proposal into the learning inbox, and the
 * person's click is the only path from there to the profile.
 *
 * **`run_shell` is not requestable.** It is the broadest capability in the app
 * and the one whose damage is not confined to a Space, so a bot asking for it is
 * a sentence the person reads in the transcript rather than a card they might
 * click. The runtime refuses the name as well as the prompt omitting it, because
 * a model can name anything.
 *
 * Nothing here throws. An empty name or a missing reason is a sentence the model
 * can act on; an exception would end the user's turn and turn "ask properly" into
 * "your request failed", the same rule `draft_bot` and `ask_agent` follow.
 */
import {z} from 'zod';

import {harnessPolicySchema} from '@marimo/protocol';

import type {ToolDefinition} from './tool-contract.js';
import {outcome} from './tool-contract.js';

export const REQUEST_TOOL = 'request_tool';
export const REQUEST_CONNECTOR = 'request_connector';
export const PROPOSE_POLICY = 'propose_policy';

export interface LearningRequestInput {
  target: 'tool' | 'connector';
  name: string;
  reason: string;
  /** Evidence the model wants to attach, in its own words. */
  evidence?: string;
}

export interface LearningPolicyInput {
  /** Any subset of the safe policy; the runtime merges it over the profile's. */
  patch: z.infer<typeof harnessPolicySchema>;
  reason: string;
  evidence?: string;
}

export interface LearningToolService {
  /**
   * Records the proposal and answers with a sentence for the model.
   *
   * The runtime owns the store and the active profile, so the tool cannot name
   * the agent it is asking for — that is the turn's fact, not the model's.
   */
  request(input: LearningRequestInput): Promise<{ok: boolean; result: string}>;
  /**
   * Records a change to how the bot runs.
   *
   * Separate from `request` because the payload is a policy rather than a name,
   * and because the runtime validates it against the same bounds the profile
   * schema does — a proposal is not a way around the schema.
   */
  proposePolicy(
    input: LearningPolicyInput,
  ): Promise<{ok: boolean; result: string}>;
}

const parameters = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .describe(
      'The exact capability name, as it appears in the capabilities list in ' +
        'your instructions. Do not invent one.',
    ),
  reason: z
    .string()
    .trim()
    .min(1)
    .max(400)
    .describe(
      'What you could not do without it, and what it cost the person. One or ' +
        'two sentences, in their terms.',
    ),
  evidence: z
    .string()
    .trim()
    .max(300)
    .optional()
    .describe(
      'A short note about the turn that shows the gap — for example the tool ' +
        'you had to use instead, or the file you could not open.',
    ),
});

function describeRequest(
  target: 'tool' | 'connector',
  name: string,
): string {
  const label = target === 'tool' ? 'tool' : 'connector';
  return (
    `Asked the person for the ${label} "${name}". It is in the learning inbox, ` +
    'waiting for them; you do not have it yet, so do not use it in this turn. ' +
    'If they approve it, it will be available from your next turn.'
  );
}

function refusal(target: 'tool' | 'connector', name: string): string | undefined {
  const folded = name.trim().toLocaleLowerCase();
  if (folded.length === 0) {
    return 'A request needs a name. Use the capability name from your instructions.';
  }
  /*
   * A name the person would have to approve anyway, but one the bot may never
   * ask for. The prompt says so and the runtime refuses it; this is the earliest
   * of the three, and the cheapest place to say no.
   */
  if (target === 'tool' && folded === 'run_shell') {
    return (
      'run_shell is never requested. If the work needs a command, say what you ' +
      'would run and why, and let the person decide in Settings.'
    );
  }
  return undefined;
}

function requestDefinition(
  target: 'tool' | 'connector',
): ToolDefinition<Record<string, unknown>> {
  const label = target === 'tool' ? 'tool' : 'connector';
  return {
    name: target === 'tool' ? REQUEST_TOOL : REQUEST_CONNECTOR,
    description:
      `Ask the person to give you a ${label} you do not have. This does not ` +
      `give it to you: it puts a proposal in the learning inbox, with your ` +
      `reason and the turn it came from, and the person decides. Use it when ` +
      `you have hit the same gap more than once and can name it — not for a ` +
      `one-off convenience. ${
        target === 'tool'
          ? 'run_shell is never requested.'
          : 'A connector is a server the person has configured, not one you can add.'
      }`,
    parameters,
    requiresLearning: true,
    execute: async (args, context) => {
      const name = String(args.name ?? '').trim();
      const reason = String(args.reason ?? '').trim();
      const evidence = String(args.evidence ?? '').trim();
      const refused = refusal(target, name);
      if (refused !== undefined) {
        return outcome(false, refused);
      }
      if (reason.length === 0) {
        return outcome(
          false,
          'A request needs a reason. Say what you could not do and what it cost.',
        );
      }
      if (context.learning === undefined) {
        return outcome(false, 'This turn cannot ask for capabilities.');
      }
      try {
        const answer = await context.learning.request({
          target,
          name,
          reason,
          ...(evidence.length === 0 ? {} : {evidence}),
        });
        return outcome(answer.ok, answer.result || describeRequest(target, name));
      } catch (error) {
        return outcome(
          false,
          `Could not record the request: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    },
  };
}

export const requestToolTool = requestDefinition('tool');
export const requestConnectorTool = requestDefinition('connector');

/**
 * Propose a change to how the bot runs.
 *
 * The three fields are the whole safe half of the harness. Role, Persona, the
 * contract and the tool gates are not here and cannot be reached through this
 * tool: the rule is that the bot may improve how it works without rewriting who
 * it is, and the schema is where that is enforced rather than the prompt.
 */
export const proposePolicyTool: ToolDefinition<Record<string, unknown>> = {
  name: PROPOSE_POLICY,
  description:
    'Propose a change to how you run: whether memory is recalled whole or by ' +
    'relevance, how much room a turn has before it is compacted, or how many ' +
    'tool calls a turn may spend. This changes nothing by itself — the person ' +
    'sees the proposal and decides. You cannot propose a change to your Role, ' +
    'your Persona, the app’s rules, or a tool’s approval gate.',
  parameters: harnessPolicySchema.extend({
    reason: z
      .string()
      .trim()
      .min(1)
      .max(400)
      .describe('What the current setting costs, in the person’s terms.'),
    evidence: z
      .string()
      .trim()
      .max(300)
      .optional()
      .describe('A short note about the turn that shows the problem.'),
  }),
  requiresLearning: true,
  execute: async (args, context) => {
    const reason = String(args.reason ?? '').trim();
    const evidence = String(args.evidence ?? '').trim();
    const patch = {
      ...(typeof args.memoryPolicy === 'string'
        ? {memoryPolicy: args.memoryPolicy as 'all' | 'relevant'}
        : {}),
      ...(typeof args.maxContextTokens === 'number'
        ? {maxContextTokens: args.maxContextTokens}
        : {}),
      ...(typeof args.maxToolCalls === 'number'
        ? {maxToolCalls: args.maxToolCalls}
        : {}),
    };
    if (reason.length === 0) {
      return outcome(
        false,
        'A proposal needs a reason. Say what the current setting costs.',
      );
    }
    if (Object.keys(patch).length === 0) {
      return outcome(
        false,
        'A proposal needs at least one setting to change.',
      );
    }
    if (context.learning === undefined) {
      return outcome(false, 'This turn cannot propose a change.');
    }
    try {
      const answer = await context.learning.proposePolicy({
        patch,
        reason,
        ...(evidence.length === 0 ? {} : {evidence}),
      });
      return outcome(answer.ok, answer.result);
    } catch (error) {
      return outcome(
        false,
        `Could not record the proposal: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  },
};

export const LEARNING_TOOLS = [
  requestToolTool,
  requestConnectorTool,
  proposePolicyTool,
] as const;
