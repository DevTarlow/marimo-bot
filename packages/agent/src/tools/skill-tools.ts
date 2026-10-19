/**
 * The two tools that turn a saved skill into something the agent can use.
 *
 * `save_skill` exists for `/learn` and for a direct request: the user points at a
 * conversation, or asks for a way of working, and the agent — which already has
 * the context — writes the procedure down. It is a *granted* capability like
 * every other tool now, because a skill is prompt text that changes how the agent
 * works on later turns, and an install should not be able to start writing those
 * without somebody saying yes.
 *
 * `load_skill` is the other half. A granted skill is advertised in the prompt by
 * its name and one-line description; the full instructions arrive only when the
 * model asks for them. That is what lets a skill be 28 KB without every request
 * paying for it, and it is why the prompt says *available* rather than *these are
 * your instructions*.
 *
 * The save gate is not ceremony. Everything else the agent writes is data it will
 * read again; this is prompt text that changes how it works, so the card is the
 * user's only chance to read what they are about to start following. Loading one
 * needs no gate: it is the user's own text, and the grant is what made it
 * available.
 */
import {FunctionTool} from '@google/adk';
import {z} from 'zod';

import {SKILL_INSTRUCTIONS_MAX} from '@marimo/protocol';

import type {Skill} from '../skills/types.js';

/** What the save tool needs from whoever owns the skill files. */
export interface SkillService {
  /**
   * Stores the skill and switches it on for the agent that asked.
   *
   * One call rather than "save" plus "enable": a skill saved but not enabled is
   * invisible, and the whole point of asking for it is to use it. `updated` says
   * whether this replaced a skill of the same name, which the model repeats back
   * so the user knows their earlier version was not kept.
   */
  save(input: {
    name: string;
    description: string;
    instructions: string;
  }): Promise<{name: string; updated: boolean}>;
}

/**
 * What `load_skill` needs: one granted skill's text, and the names it could have
 * asked for.
 *
 * The list is returned on a miss as well as a hit, so a refusal can say what does
 * exist instead of leaving the model to guess at a spelling. It is the *granted*
 * set, not everything on disk: a skill the person switched off must be as absent
 * as a tool they never enabled.
 */
export interface SkillLibrary {
  load(name: string): Promise<{skill?: Skill; names: string[]}>;
}

export interface SkillToolContext {
  skills: SkillService;
}

/**
 * The longest instructions worth putting in a prompt.
 *
 * Re-exported from the protocol rather than declared here: the Settings editor
 * enforces the same number while the user types, and it may not import this
 * package. The store refuses an over-long skill as well, so the limit holds
 * whether the text arrives from a turn, from the editor or from a hand-edited
 * file.
 */
export {SKILL_INSTRUCTIONS_MAX};

export function createSaveSkillTool(context: SkillToolContext) {
  return new FunctionTool({
    name: 'save_skill',
    description:
      'Save a reusable skill and switch it on for this agent. A skill is a ' +
      'procedure you can load on a later task with `load_skill`; it is ' +
      'advertised to you by its name and one-line description, not carried in ' +
      'every request. Use it when the user runs /learn, or when they ask you to ' +
      'remember a way of doing something and use it from now on. `name` is a ' +
      'short kebab-case label ("weekly-inbox-triage"); saving a name that ' +
      'already exists replaces that skill. `description` is the one line that ' +
      'says when to use it. `instructions` is the procedure itself, in the ' +
      'imperative, naming the tools it uses. The user has to approve it before ' +
      'it is saved.',
    parameters: z.object({
      name: z
        .string()
        .describe('Short kebab-case name, e.g. "weekly-inbox-triage".'),
      description: z
        .string()
        .describe('One line saying when to use the skill.'),
      instructions: z
        .string()
        .describe(
          'The steps themselves, written as instructions to yourself. Write the ' +
            'method rather than this one case, so it works again.',
        ),
    }),
    requireConfirmation: true,
    execute: async ({name, description, instructions}) => {
      if (instructions.trim().length === 0) {
        return 'Nothing to save: the instructions were empty.';
      }
      if (instructions.length > SKILL_INSTRUCTIONS_MAX) {
        // Refused rather than stored: the body is loaded into a request when the
        // skill is used, and a file large enough to crowd out the conversation
        // is a cost the user pays without seeing the bill.
        return (
          `Those instructions are ${instructions.length} characters, over the ` +
          `${SKILL_INSTRUCTIONS_MAX}-character limit for a skill. Rewrite them ` +
          'as the steps that matter, without the background.'
        );
      }
      try {
        const saved = await context.skills.save({
          name,
          description,
          instructions,
        });
        return saved.updated
          ? `Replaced the skill "${saved.name}" and left it switched on. It is available from your next request.`
          : `Saved the skill "${saved.name}" and switched it on. It is available from your next request.`;
      } catch (error) {
        return `Could not save the skill: ${describe(error)}`;
      }
    },
  });
}

/**
 * The load half: read one granted skill's instructions into this turn.
 *
 * The result is the whole body rather than a summary, because the body *is* the
 * skill. A refusal lists what does exist, in the same sentence, so a model that
 * guessed a spelling can correct itself without another round trip.
 */
export function createLoadSkillTool(context: {library: SkillLibrary}) {
  return new FunctionTool({
    name: 'load_skill',
    description:
      'Load the full instructions of one of your available skills by name. Your ' +
      'prompt lists them with a one-line description; call this before doing a ' +
      'task one of them covers, then follow what it says. Loading a skill gives ' +
      'you the procedure, not a summary of it.',
    parameters: z.object({
      name: z.string().describe('The skill name exactly as the prompt lists it.'),
    }),
    execute: async ({name}) => {
      try {
        const found = await context.library.load(name);
        if (found.skill !== undefined) {
          return `# ${found.skill.name}\n\n${found.skill.instructions}`;
        }
        if (found.names.length === 0) {
          return 'There are no skills available to this bot.';
        }
        return (
          `There is no available skill called "${name.trim()}". The ones you ` +
          `have are ${found.names.map((entry) => `"${entry}"`).join(', ')}.`
        );
      } catch (error) {
        return `Could not load that skill: ${describe(error)}`;
      }
    },
  });
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
