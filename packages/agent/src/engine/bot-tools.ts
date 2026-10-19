/**
 * `draft_bot`: a proposal shaped like a tool call.
 *
 * The tool creates nothing. The window draws the draft from the call's own
 * arguments, the person edits it and presses Create, and that click is the only
 * thing that makes a profile. A profile with this tool cannot make a bot the
 * person has not seen, cannot change an existing one, and cannot write a file.
 */
import {
  BOT_DRAFT_PERSONA_MAX,
  BOT_TEMPLATES,
  DRAFT_BOT_TOOL,
  botDraftSchema,
  botTemplateById,
} from '@marimo/protocol';

import {
  outcome,
  type AnyToolDefinition,
  type ToolOutcome,
} from './tool-contract.js';

const TEMPLATE_CHOICES = BOT_TEMPLATES.map(
  (template) => `"${template.id}" (${template.label}: ${template.blurb})`,
).join('; ');

export const draftBotTool: AnyToolDefinition = {
  name: DRAFT_BOT_TOOL,
  description:
    'Draft a new bot for the person to review. This does not create the bot: ' +
    'the window shows the draft in a card, the person edits it, and they press ' +
    'Create. Use it only once you have talked through what the bot is for, what ' +
    'to call it, how it should sound and how the person wants to be spoken to. ' +
    `A starter role is a shortcut, not a requirement: ${TEMPLATE_CHOICES}. If ` +
    'none fits, omit templateId and write a persona that says what it is for. ' +
    'Omit tools to use the starter role’s default. Do not call it twice for the ' +
    'same bot; if the person wants changes, tell them to edit the card.',
  parameters: botDraftSchema,
  execute: async (args): Promise<ToolOutcome> => {
    const parsed = botDraftSchema.safeParse(args);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      return outcome(
        false,
        'That draft is not ready to show: ' +
          `${first?.path.join('.') || 'a field'} ${first?.message ?? 'is wrong'}. ` +
          'Ask the person for what is missing rather than guessing.',
      );
    }
    const value = parsed.data;
    if (
      value.templateId !== undefined &&
      botTemplateById(value.templateId) === undefined
    ) {
      return outcome(
        false,
        `There is no starter role called "${value.templateId}". Choose one of ` +
          `${TEMPLATE_CHOICES}, or omit templateId for a custom bot.`,
      );
    }
    if (
      value.persona !== undefined &&
      value.persona.length > BOT_DRAFT_PERSONA_MAX
    ) {
      return outcome(
        false,
        `That persona is ${value.persona.length} characters, over the ` +
          `${BOT_DRAFT_PERSONA_MAX}-character limit. Keep the part that changes ` +
          'how it behaves and leave the rest to the card.',
      );
    }
    const name = value.name ?? 'this bot';
    return outcome(
      true,
      `Draft shown to the person: ${name}. They can change the name, the ` +
        'persona and the abilities, and they press Create — you do not create ' +
        'it. Stop here and wait for them.',
    );
  },
};
