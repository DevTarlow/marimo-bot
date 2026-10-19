/**
 * The half of a skill that is a profile grant.
 *
 * A file saved but not switched on is invisible, and the agent's save is
 * supposed to leave nothing invisible. A rename has to carry every bot that had
 * the old name, and a removal has to take the grant with it — a grant for a name
 * no file holds reads as on over nothing.
 */
import {mkdtemp, rm} from 'node:fs/promises';
import {join} from 'node:path';

import {afterEach, beforeEach, describe, expect, it} from 'vitest';

import {DEFAULT_AGENT_PERSONA} from '@marimo/protocol';

import {ProfileStore} from './profiles.js';
import {RuntimeSkillService} from './skill-service.js';
import {SkillStore} from './skills.js';

describe('RuntimeSkillService', () => {
  let dir: string;
  let profiles: ProfileStore;
  let service: RuntimeSkillService;

  beforeEach(async () => {
    dir = await mkdtemp(join(process.cwd(), '.marimo-skill-service-'));
    profiles = new ProfileStore({
      file: join(dir, 'profiles.json'),
      defaultRole: 'You are an agent.',
      defaultPersona: DEFAULT_AGENT_PERSONA,
      defaultTools: ['read_file'],
      defaultSkills: [],
    });
    service = new RuntimeSkillService({
      skills: new SkillStore({root: join(dir, 'skills')}),
      profiles,
    });
  });

  afterEach(async () => {
    await rm(dir, {recursive: true, force: true});
  });

  const draft = {
    name: 'Weekly Inbox Triage',
    description: 'Sort the inbox every Monday.',
    instructions: '1. Read the unread mail.',
  };

  async function lead() {
    return await profiles.activeProfile();
  }

  it('writes the file and switches it on for the bot that asked', async () => {
    const profile = await lead();
    const saved = await service.saveFromAgent(draft, profile.id);

    expect(saved).toEqual({name: 'weekly-inbox-triage', updated: false});
    const after = await lead();
    expect(after.enabledSkills).toEqual(['weekly-inbox-triage']);
    expect((await service.list()).map((skill) => skill.name)).toEqual([
      'weekly-inbox-triage',
    ]);
  });

  it('does not grant a skill saved by the editor', async () => {
    await service.saveFromEditor(draft);
    expect((await lead()).enabledSkills).toEqual([]);
    expect(await service.list()).toHaveLength(1);
  });

  it('carries a rename through every bot that had the old name', async () => {
    const first = await lead();
    await service.saveFromAgent(draft, first.id);
    const second = await profiles.create({
      name: 'Writer',
      role: (called) => `You are ${called}.`,
      persona: 'A test persona.',
    });
    await profiles.update(second.id, {
      enabledSkills: ['weekly-inbox-triage'],
    });

    const saved = await service.saveFromEditor(
      {...draft, name: 'Tuesday Triage'},
      'weekly-inbox-triage',
    );
    expect(saved.saved.name).toBe('tuesday-triage');

    const stored = await profiles.profiles();
    for (const profile of stored) {
      expect(profile.enabledSkills).toContain('tuesday-triage');
      expect(profile.enabledSkills).not.toContain('weekly-inbox-triage');
    }
  });

  it('drops the grant from every bot when a skill is removed', async () => {
    const first = await lead();
    await service.saveFromAgent(draft, first.id);
    const second = await profiles.create({
      name: 'Writer',
      role: (called) => `You are ${called}.`,
      persona: 'A test persona.',
    });
    await profiles.update(second.id, {
      enabledSkills: ['weekly-inbox-triage'],
    });

    await service.remove('weekly-inbox-triage');

    for (const profile of await profiles.profiles()) {
      expect(profile.enabledSkills).toEqual([]);
    }
    expect(await service.list()).toEqual([]);
  });

  it('loads only what the profile was granted, and lists the rest', async () => {
    const profile = await lead();
    await service.saveFromEditor(draft);
    await service.saveFromEditor({
      ...draft,
      name: 'standup-notes',
    });
    await profiles.update(profile.id, {
      enabledSkills: ['standup-notes'],
    });

    const found = await service.load(profile.id, 'Standup Notes');
    expect(found.skill?.name).toBe('standup-notes');
    expect(found.names).toEqual(['standup-notes']);

    const refused = await service.load(profile.id, 'weekly-inbox-triage');
    expect(refused.skill).toBeUndefined();
    expect(refused.names).toEqual(['standup-notes']);
  });

  it('answers with no skill when the profile no longer exists', async () => {
    expect(await service.load('gone', 'anything')).toEqual({
      names: [],
    });
  });
});
