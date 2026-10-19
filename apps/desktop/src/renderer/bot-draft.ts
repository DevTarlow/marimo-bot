/**
 * The arithmetic behind the bot review card, out of the component.
 *
 * Three decisions here are worth pinning and none of them needs a DOM: what a
 * draft looks like once the starter role's defaults are filled in, which Role
 * text it will get, and whether a card has already made its bot. The renderer
 * has no DOM test environment, so a decision buried in `BotDraftCard` is one
 * only a real window can check.
 */
import {
  botDraftSchema,
  botRoleFor,
  DEFAULT_BOT_PERSONA,
} from '@marimo/protocol';
import type {
  AgentProfile,
  BotDraft,
  BotTemplate,
  ProfileCatalog,
} from '@marimo/protocol';

/** A draft with the starter role's defaults filled in, for the card to edit. */
export interface ResolvedBotDraft {
  name: string;
  templateId?: string;
  persona: string;
  tools: string[];
  avatar?: string;
}

/**
 * Fills a draft from its starter role.
 *
 * The model is allowed to send only a name and a template; the card should still
 * show the Persona and abilities that bot would have rather than three empty
 * fields. A model-written Persona wins over the template's because the model has
 * just talked to the person; the template is the floor, not a ceiling.
 */
export function resolveBotDraft(
  draft: BotDraft,
  templates: readonly BotTemplate[],
): ResolvedBotDraft {
  const template = templates.find((entry) => entry.id === draft.templateId);
  const persona = draft.persona?.trim() ?? '';
  const avatar = draft.avatar ?? template?.avatar;
  return {
    name: draft.name ?? template?.suggestedName ?? '',
    ...(template === undefined ? {} : {templateId: template.id}),
    persona:
      persona.length > 0
        ? (draft.persona ?? '')
        : (template?.persona ?? DEFAULT_BOT_PERSONA),
    /*
     * An empty list from the model is not a decision to grant nothing. A small
     * model that omits the field and one that sends `[]` mean the same thing
     * here — "use the role's abilities" — and a Writer card that showed no
     * ability would make the person grant by hand what the role already knew it
     * needed. A list the person clears in the card is different: the card sends
     * that empty list on Create, and the runtime honours it.
     */
    tools: [
      ...(draft.tools !== undefined && draft.tools.length > 0
        ? draft.tools
        : (template?.tools ?? [])),
    ],
    ...(avatar === undefined ? {} : {avatar}),
  };
}

/**
 * The Role the card previews: the app's text for the name and starter role.
 *
 * Read-only in the card because it is the app's brief, not a field the person is
 * being asked to write here. Settings has the editor, and Reset there restores
 * exactly this text.
 */
export function draftRole(
  draft: ResolvedBotDraft,
  templates: readonly BotTemplate[],
): string {
  return botRoleFor(
    draft.name,
    templates.find((entry) => entry.id === draft.templateId),
  );
}

/**
 * The bot this card already made, if it made one.
 *
 * The transcript keeps a tool call forever, so a card revisited after a reload
 * would otherwise offer to make the same bot again. The profile records the call
 * that made it; this is the check that turns the button into a receipt.
 */
export function createdFrom(
  profiles: readonly AgentProfile[],
  callId: string,
): AgentProfile | undefined {
  return profiles.find((profile) => profile.createdFromCall === callId);
}

/**
 * The tools a draft carries, with the catalogue's plain-language line.
 *
 * Names rather than the tool's own description: the card is for a person who is
 * deciding what the bot may do, and `read_file` is not a sentence.
 */
export function abilityLines(
  draft: ResolvedBotDraft,
  catalog: ProfileCatalog | null,
): Array<{name: string; blurb: string}> {
  if (catalog === null) {
    return draft.tools.map((name) => ({name, blurb: name}));
  }
  return draft.tools.map((name) => {
    const tool = catalog.tools.find((entry) => entry.name === name);
    return {name, blurb: tool?.blurb ?? name};
  });
}

/** Parses a `draft_bot` call's arguments, or `undefined` when they are not one. */
export function parseBotDraft(args: unknown): BotDraft | undefined {
  const parsed = botDraftSchema.safeParse(args);
  return parsed.success ? parsed.data : undefined;
}
