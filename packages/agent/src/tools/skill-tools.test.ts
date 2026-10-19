/**
 * The two skill tools: the writer and the reader.
 *
 * What matters for `save_skill` is that the gate is there at all, that the text is
 * not silently truncated, and that a refusal comes back as a sentence the model
 * can act on rather than as a failed turn. `load_skill` is the other half — it
 * returns the body only for a granted name, and says what exists when it does not.
 */
import type {BaseTool, Context} from '@google/adk';
import {describe, expect, it} from 'vitest';

import {
  SKILL_INSTRUCTIONS_MAX,
  createLoadSkillTool,
  createSaveSkillTool,
} from './skill-tools.js';
import type {SkillService} from './skill-tools.js';

interface Saved {
  name: string;
  description: string;
  instructions: string;
}

function harness(): {service: SkillService; saved: Saved[]} {
  const saved: Saved[] = [];
  return {
    saved,
    service: {
      save: async (input) => {
        saved.push(input);
        return {name: input.name, updated: false};
      },
    },
  };
}

/**
 * Runs a tool through ADK's own validation, as the runner does *after* an
 * approval.
 *
 * This tool is gated, so ADK refuses to execute it until the context carries a
 * confirmed approval — which is exactly the state the runner resumes from. The
 * gate itself is asserted separately, by asking the tool directly.
 */
async function run(
  tool: BaseTool,
  args: Record<string, unknown>,
): Promise<string> {
  const result = await tool.runAsync({
    args,
    toolContext: {
      sessionId: 'session-1',
      toolConfirmation: {confirmed: true},
    } as unknown as Context,
  });
  return typeof result === 'string' ? result : JSON.stringify(result);
}

const DRAFT = {
  name: 'weekly-inbox-triage',
  description: 'Sort the inbox every Monday.',
  instructions: '1. Read the unread mail.\n2. Group it by sender.',
};

describe('save_skill', () => {
  it('saves what it was given, and says it is on', async () => {
    const {service, saved} = harness();
    const result = await run(createSaveSkillTool({skills: service}), DRAFT);

    expect(saved).toEqual([DRAFT]);
    expect(result).toContain('weekly-inbox-triage');
    expect(result).toContain('next request');
  });

  it('says when it replaced a skill rather than adding one', async () => {
    const service: SkillService = {
      save: async (input) => ({name: input.name, updated: true}),
    };
    const result = await run(createSaveSkillTool({skills: service}), DRAFT);
    expect(result).toContain('Replaced');
  });

  /**
   * This text is prepended to every request from then on. It is a decision the
   * user makes, not one the model makes on their behalf, so a new tool has to
   * arrive without the gate by accident rather than with one.
   */
  it('is behind the approval gate', async () => {
    const tool = createSaveSkillTool({skills: harness().service});
    await expect(tool.checkRequireConfirmation(DRAFT)).resolves.toBe(true);
  });

  it('refuses empty instructions instead of saving a blank skill', async () => {
    const {service, saved} = harness();
    const result = await run(createSaveSkillTool({skills: service}), {
      ...DRAFT,
      instructions: '   ',
    });

    expect(saved).toEqual([]);
    expect(result).toContain('empty');
  });

  it('refuses instructions too long for every request', async () => {
    const {service, saved} = harness();
    const result = await run(createSaveSkillTool({skills: service}), {
      ...DRAFT,
      instructions: 'x'.repeat(SKILL_INSTRUCTIONS_MAX + 1),
    });

    expect(saved).toEqual([]);
    expect(result).toContain('over the');
  });

  it('reports a storage failure as something the model can react to', async () => {
    const service: SkillService = {
      save: async () => {
        throw new Error('skills.json is read-only');
      },
    };
    const result = await run(createSaveSkillTool({skills: service}), DRAFT);

    expect(result).toContain('Could not save the skill');
    expect(result).toContain('read-only');
  });
});

describe('load_skill', () => {
  const triage = {
    name: 'weekly-inbox-triage',
    description: 'Sort the inbox every Monday.',
    instructions: '1. Read the unread mail.\n2. Group it by sender.',
  };

  function library(
    found: typeof triage | null = triage,
    names = [triage.name],
  ) {
    return {
      load: async () => ({
        ...(found === null ? {} : {skill: found}),
        names,
      }),
    };
  }

  it('returns the whole procedure for one available skill', async () => {
    const result = await run(createLoadSkillTool({library: library()}), {
      name: 'weekly-inbox-triage',
    });
    expect(result).toContain('# weekly-inbox-triage');
    expect(result).toContain('1. Read the unread mail.');
    expect(result).toContain('2. Group it by sender.');
  });

  it('names what exists when the model asked for a name that does not', async () => {
    const result = await run(
      createLoadSkillTool({library: library(null)}),
      {name: 'inbox'},
    );
    expect(result).toContain('no available skill called "inbox"');
    expect(result).toContain('"weekly-inbox-triage"');
  });

  it('says so when this bot has nothing switched on', async () => {
    const result = await run(
      createLoadSkillTool({library: library(null, [])}),
      {name: 'inbox'},
    );
    expect(result).toContain('no skills available');
  });

  it('does not need an approval: reading a granted skill is the grant', async () => {
    const tool = createLoadSkillTool({library: library()});
    await expect(tool.checkRequireConfirmation({name: 'x'})).resolves.toBe(
      false,
    );
  });

  it('turns a read failure into a sentence', async () => {
    const result = await run(
      createLoadSkillTool({
        library: {
          load: async () => {
            throw new Error('the folder is gone');
          },
        },
      }),
      {name: 'x'},
    );
    expect(result).toContain('Could not load that skill');
    expect(result).toContain('the folder is gone');
  });
});
