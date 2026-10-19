/**
 * `ask_agent`: a bot asking another bot for its answer.
 *
 * This is a conversation, not a delegation of work. The other bot sees its own
 * Role, Persona and memory, not the caller's conversation, and it cannot use
 * tools — so a question that needs a file or a command belongs with `ask_agent`'s
 * old job in the main conversation, not here. The narrowness is deliberate: a
 * second bot that can act would need its own approval cards, its own turn and its
 * own failure reporting, which is the collaboration work this tool is not.
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
    'Ask another bot for its answer. It sees its own instructions and memory, ' +
    'not your conversation, and it cannot use tools — use it for a second ' +
    'opinion or a specialty, not for work that needs files or commands. Name ' +
    'the bot as it appears in the roster.',
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
      return outcome(false, `Could not ask that bot: ${describeToolError(error)}`);
    }
  },
};
