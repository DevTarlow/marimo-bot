/**
 * The arithmetic behind the review card.
 *
 * The renderer has no DOM test environment, so this is where the decisions the
 * card makes are pinned: what a draft looks like with the starter role's
 * defaults filled in, which Role text it previews, and whether a card has
 * already made its bot.
 */
import {describe, expect, it} from 'vitest';

import {
  BOT_TEMPLATES,
  DEFAULT_BOT_PERSONA,
} from '@marimo/protocol';
import type {AgentProfile, ProfileCatalog} from '@marimo/protocol';

import {
  abilityLines,
  createdFrom,
  draftRole,
  parseBotDraft,
  resolveBotDraft,
} from '../src/renderer/bot-draft.js';

const WRITER = BOT_TEMPLATES.find((template) => template.id === 'writer')!;

describe('resolveBotDraft', () => {
  it('fills a name-and-template draft from the starter role', () => {
    const resolved = resolveBotDraft(
      {name: 'Writer', templateId: 'writer'},
      BOT_TEMPLATES,
    );
    expect(resolved.name).toBe('Writer');
    expect(resolved.persona).toBe(WRITER.persona);
    expect(resolved.tools).toEqual(WRITER.tools);
    expect(resolved.avatar).toBe(WRITER.avatar);
  });

  it('lets a Persona the model wrote win over the template', () => {
    const resolved = resolveBotDraft(
      {name: 'Writer', templateId: 'writer', persona: 'Dry and precise.'},
      BOT_TEMPLATES,
    );
    expect(resolved.persona).toBe('Dry and precise.');
  });

  it('falls back to the generic Persona for a custom bot', () => {
    const resolved = resolveBotDraft({name: 'Tax helper'}, BOT_TEMPLATES);
    expect(resolved.persona).toBe(DEFAULT_BOT_PERSONA);
    expect(resolved.templateId).toBeUndefined();
    expect(resolved.tools).toEqual([]);
  });

  /*
   * A model that sends `[]` instead of omitting the field must not make a bot
   * with no abilities. The role already knows what the job needs, and a Writer
   * card with an empty ability list would ask the person to grant by hand what
   * the starter role was for.
   */
  it('fills the starter role’s abilities when the model sent an empty list', () => {
    const resolved = resolveBotDraft(
      {name: 'Writer', templateId: 'writer', tools: []},
      BOT_TEMPLATES,
    );
    expect(resolved.tools).toEqual(WRITER.tools);
  });

  it('suggests the starter name when the draft has none', () => {
    const resolved = resolveBotDraft({templateId: 'writer'}, BOT_TEMPLATES);
    expect(resolved.name).toBe(WRITER.suggestedName);
  });
});

describe('draftRole', () => {
  it('previews the template Role, not the lead text', () => {
    const resolved = resolveBotDraft(
      {name: 'Writer', templateId: 'writer'},
      BOT_TEMPLATES,
    );
    const role = draftRole(resolved, BOT_TEMPLATES);
    expect(role).toContain('You are Writer.');
    expect(role).toContain('Your work is writing');
    expect(role).not.toContain('You are Marimo Bot');
  });
});

describe('createdFrom', () => {
  const profile = {
    id: 'writer',
    name: 'Writer',
    identity: '',
    enabledTools: [],
    enabledSkills: [],
    createdFromCall: 'call-1',
  } as AgentProfile;

  it('finds the bot a call made', () => {
    expect(createdFrom([profile], 'call-1')).toBe(profile);
  });

  it('answers nothing for a call that made none', () => {
    expect(createdFrom([profile], 'call-2')).toBeUndefined();
  });
});

describe('abilityLines', () => {
  it('names a tool when there is no catalogue to describe it', () => {
    const resolved = resolveBotDraft(
      {name: 'Writer', templateId: 'writer'},
      BOT_TEMPLATES,
    );
    expect(abilityLines(resolved, null)[0]).toEqual({
      name: WRITER.tools[0],
      blurb: WRITER.tools[0],
    });
  });

  it('uses the catalogue line when there is one', () => {
    const catalog = {
      tools: [{name: 'read_file', description: '', blurb: 'Open a file.', byDefault: true}],
    } as unknown as ProfileCatalog;
    expect(abilityLines({name: 'x', persona: '', tools: ['read_file']}, catalog))
      .toEqual([{name: 'read_file', blurb: 'Open a file.'}]);
  });
});

describe('parseBotDraft', () => {
  it('reads the arguments a draft call carries', () => {
    expect(parseBotDraft({name: 'Writer', templateId: 'writer'})).toEqual({
      name: 'Writer',
      templateId: 'writer',
    });
  });

  it('answers nothing for arguments that are not a draft', () => {
    expect(parseBotDraft({name: 4})).toBeUndefined();
  });
});
