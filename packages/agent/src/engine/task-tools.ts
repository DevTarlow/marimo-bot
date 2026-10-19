/**
 * `start_task`: another bot, another conversation, no waiting.
 *
 * A task is deliberately not `ask_agent`. `ask_agent` is a question in the
 * parent's conversation and is answered before the parent continues; a task gets
 * its own session, its own log and its own approval cards, and the parent is
 * told where to find it. That separation is what keeps a background writer from
 * sharing a conversation with the turn that started it.
 *
 * The task runs at depth one: the tool is absent from a task's own tool set, so
 * a task cannot start another task rather than being refused after trying.
 */
import {z} from 'zod';

import {
  describeToolError,
  outcome,
  type AnyToolDefinition,
  type ToolOutcome,
} from './tool-contract.js';

export const startTaskTool: AnyToolDefinition = {
  name: 'start_task',
  description:
    'Start another bot on a task in its own conversation. This returns ' +
    'immediately; the work continues there, and if it needs the person’s ' +
    'approval it waits in that conversation. Use it for work that will take a ' +
    'while or that should not fill this thread. Name the bot as it appears in ' +
    'the roster.',
  parameters: z.object({
    agent: z.string().describe('The bot name, as it appears in the roster.'),
    task: z.string().describe('What that bot should do, as a complete request.'),
  }),
  requiresTask: true,
  execute: async (args, context): Promise<ToolOutcome> => {
    const delegate = context.delegateTask;
    if (delegate === undefined) {
      return outcome(false, 'Tasks are not available in this turn.');
    }
    const agent = String(args.agent ?? '').trim();
    const task = String(args.task ?? '').trim();
    if (agent.length === 0 || task.length === 0) {
      return outcome(false, 'start_task needs a bot name and a task.');
    }
    try {
      const started = await delegate({agent, task});
      return started.ok
        ? outcome(true, started.result)
        : outcome(false, started.result);
    } catch (error) {
      return outcome(false, `Could not start that task: ${describeToolError(error)}`);
    }
  },
};
