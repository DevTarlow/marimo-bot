/**
 * The two tools that make a saved procedure usable.
 *
 * `save_skill` is granted like any other capability because it writes prompt
 * text that changes how the agent works later. It is gated: the user reads what
 * they are about to start following. `load_skill` needs no gate; the grant is
 * what made the skill available, and its body is the user's own text.
 */
import {z} from 'zod';

import {SKILL_INSTRUCTIONS_MAX} from '@marimo/protocol';

import {
  describeToolError,
  outcome,
  type AnyToolDefinition,
  type ToolOutcome,
} from './tool-contract.js';

export const loadSkillTool: AnyToolDefinition = {
  name: 'load_skill',
  description:
    'Read the full instructions of one of your skills. The prompt lists the ' +
    'skills by name and one line; call this when a task matches that line. If ' +
    'the name is not one you carry, the answer names the ones you do.',
  parameters: z.object({
    name: z.string().describe('The skill name, exactly as it is advertised.'),
  }),
  requiresSkills: true,
  execute: async (args, context): Promise<ToolOutcome> => {
    const skills = context.skills;
    if (skills === undefined) {
      return outcome(false, 'Skills are not available in this turn.');
    }
    try {
      const answer = await skills.load(String(args.name ?? ''));
      if (answer.skill === undefined) {
        const names =
          answer.names.length === 0
            ? 'You have no skills switched on.'
            : `You carry: ${answer.names.join(', ')}.`;
        return outcome(
          false,
          `There is no skill called "${String(args.name ?? '')}". ${names}`,
        );
      }
      return outcome(
        true,
        `## ${answer.skill.name}\n\n${answer.skill.instructions}`,
      );
    } catch (error) {
      return outcome(
        false,
        `Could not load the skill: ${describeToolError(error)}`,
      );
    }
  },
};

export const saveSkillTool: AnyToolDefinition = {
  name: 'save_skill',
  description:
    'Save a reusable skill and switch it on for this agent. A skill is a ' +
    'procedure you can load on a later task with `load_skill`; it is advertised ' +
    'to you by its name and one-line description, not carried in every request. ' +
    'Use it when the user asks you to remember a way of doing something and use ' +
    'it from now on. `name` is a short kebab-case label; saving a name that ' +
    'already exists replaces that skill. `description` is the one line that says ' +
    'when to use it. `instructions` is the procedure itself. The user has to ' +
    'approve it before it is saved.',
  parameters: z.object({
    name: z
      .string()
      .describe('Short kebab-case name, e.g. "weekly-inbox-triage".'),
    description: z.string().describe('One line saying when to use the skill.'),
    instructions: z
      .string()
      .describe(
        'The steps themselves, written as instructions to yourself. Write the ' +
          'method rather than this one case, so it works again.',
      ),
  }),
  gate: 'always',
  requiresSkills: true,
  execute: async (args, context): Promise<ToolOutcome> => {
    const skills = context.skills;
    if (skills === undefined) {
      return outcome(false, 'Skills are not available in this turn.');
    }
    const instructions = String(args.instructions ?? '');
    if (instructions.trim().length === 0) {
      return outcome(false, 'Nothing to save: the instructions were empty.');
    }
    if (instructions.length > SKILL_INSTRUCTIONS_MAX) {
      return outcome(
        false,
        `Those instructions are ${instructions.length} characters, over the ` +
          `${SKILL_INSTRUCTIONS_MAX}-character limit for a skill. Rewrite them ` +
          'as the steps that matter, without the background.',
      );
    }
    try {
      const saved = await skills.save({
        name: String(args.name ?? ''),
        description: String(args.description ?? ''),
        instructions,
      });
      return outcome(
        true,
        saved.updated
          ? `Replaced the skill "${saved.name}" and left it switched on. It is available from your next request.`
          : `Saved the skill "${saved.name}" and switched it on. It is available from your next request.`,
      );
    } catch (error) {
      return outcome(
        false,
        `Could not save the skill: ${describeToolError(error)}`,
      );
    }
  },
};

export const SKILL_TOOLS: readonly AnyToolDefinition[] = [
  loadSkillTool,
  saveSkillTool,
];
