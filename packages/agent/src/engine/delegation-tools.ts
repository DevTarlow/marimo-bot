/**
 * `ask_agent`: a bot asking another bot for its answer.
 *
 * The helper runs in the caller's ADK session, with its own Role, Persona,
 * memory and the tools its profile grants. A tool it needs to gate raises a card
 * in the caller's conversation; approving it wakes the helper on the exact call
 * it stopped on. Depth is one: the helper is built without `ask_agent`.
 */
import {z} from 'zod';

import {
  describeToolError,
  outcome,
  type AnyToolDefinition,
  type ToolOutcome,
} from './tool-contract.js';

export const askAgentTool: AnyToolDefinition = {
  name: 'ask_agent',
  description:
    'Ask another bot to do work. It sees its own instructions, memory and ' +
    'granted tools, not your conversation; if it needs approval, this chat asks ' +
    'you. Name the bot as it appears in the roster.',
  parameters: z.object({
    agent: z.string().describe('The bot name, as it appears in the roster.'),
    task: z.string().describe('What you want that bot to answer or advise on.'),
  }),
  requiresDelegate: true,
  execute: async (args, context): Promise<ToolOutcome> => {
    const delegate = context.delegate;
    if (delegate === undefined) {
      return outcome(false, 'There is no other bot to ask in this turn.');
    }
    const agent = String(args.agent ?? '').trim();
    const task = String(args.task ?? '').trim();
    if (agent.length === 0 || task.length === 0) {
      return outcome(false, 'ask_agent needs a bot name and a task.');
    }
    try {
      const answer = await delegate({agent, task});
      return answer.ok
        ? outcome(true, answer.result)
        : outcome(false, answer.result);
    } catch (error) {
      return outcome(
        false,
        `Could not ask that bot: ${describeToolError(error)}`,
      );
    }
  },
};
