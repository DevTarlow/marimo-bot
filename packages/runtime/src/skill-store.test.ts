/**
 * Skills on disk: one folder each, with `SKILL.md` inside.
 *
 * The rules worth pinning are the name — it becomes the folder, the prompt's
 * heading and a profile's grant, so two spellings have to be one skill — and the
 * promise that a file this build cannot read is never written over.
 */
import {mkdir, mkdtemp, readFile, rm, stat, writeFile} from 'node:fs/promises';
import {join} from 'node:path';

import {afterEach, beforeEach, describe, expect, it} from 'vitest';

import {SKILL_DESCRIPTION_MAX, SKILL_INSTRUCTIONS_MAX} from '@marimo/protocol';

import {
  DuplicateSkillNameError,
  normaliseName,
  parseSkillMarkdown,
  renderSkillMarkdown,
  ReservedSkillNameError,
  SkillDescriptionTooLongError,
  SkillStore,
  SkillTooLongError,
} from './skills.js';

describe('normaliseName', () => {
  it('turns whatever the model wrote into one name', () => {
    expect(normaliseName('Weekly Inbox Triage')).toBe('weekly-inbox-triage');
    expect(normaliseName('weekly_inbox_triage')).toBe('weekly-inbox-triage');
    expect(normaliseName('  weekly-inbox-triage  ')).toBe(
      'weekly-inbox-triage',
    );
    expect(normaliseName('Weekly  Inbox -- Triage')).toBe(
      'weekly-inbox-triage',
    );
  });

  it('never returns a name that would be a blank heading', () => {
    expect(normaliseName('***')).toBe('skill');
    expect(normaliseName('')).toBe('skill');
  });
});

describe('SKILL.md', () => {
  it('reads the ecosystem frontmatter, and ignores what it does not own', () => {
    const parsed = parseSkillMarkdown(
      [
        '---',
        'name: Humanizer',
        'description: |',
        '  Rewrite AI-sounding text so it reads like the writer.',
        'license: MIT',
        'metadata:',
        '  version: "3.0.0"',
        '---',
        '',
        '# Humanizer',
        '',
        'Rewrite the text.',
      ].join('\n'),
      'ignored',
    );

    expect(parsed?.name).toBe('humanizer');
    expect(parsed?.description).toBe(
      'Rewrite AI-sounding text so it reads like the writer.',
    );
    expect(parsed?.instructions).toBe('# Humanizer\n\nRewrite the text.');
  });

  it('reads a plain markdown file, using the folder and first line', () => {
    const parsed = parseSkillMarkdown(
      '# Triage\n\nSort the inbox.\n',
      'Weekly Inbox Triage',
    );
    expect(parsed?.name).toBe('weekly-inbox-triage');
    expect(parsed?.description).toBe('Triage');
    expect(parsed?.instructions).toBe('# Triage\n\nSort the inbox.');
  });

  it('accepts a quoted or folded description', () => {
    const folded = parseSkillMarkdown(
      '---\nname: triage\ndescription: >\n  Sort the inbox\n  every Monday.\n---\n\nDo it.',
      'triage',
    );
    expect(folded?.description).toBe('Sort the inbox every Monday.');

    const quoted = parseSkillMarkdown(
      '---\nname: triage\ndescription: "Sort the inbox."\n---\n\nDo it.',
      'triage',
    );
    expect(quoted?.description).toBe('Sort the inbox.');
  });

  it('round-trips what it writes', () => {
    const file = renderSkillMarkdown({
      name: 'weekly-inbox-triage',
      description: 'Sort the inbox every Monday.',
      instructions: '1. Read the unread mail.\n2. Group by sender.',
    });
    const parsed = parseSkillMarkdown(file, 'weekly-inbox-triage');
    expect(parsed).toEqual({
      name: 'weekly-inbox-triage',
      description: 'Sort the inbox every Monday.',
      instructions: '1. Read the unread mail.\n2. Group by sender.',
    });
  });

  it('refuses a file with no body', () => {
    expect(parseSkillMarkdown('---\nname: empty\n---\n', 'empty')).toBe(
      undefined,
    );
  });
});

describe('SkillStore', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(process.cwd(), '.marimo-skills-'));
  });

  afterEach(async () => {
    await rm(dir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 20,
    });
  });

  function root(): string {
    return join(dir, 'skills');
  }

  function store(extra: {reserved?: string[]; legacyFile?: string} = {}) {
    return new SkillStore({
      root: root(),
      ...(extra.reserved === undefined ? {} : {reserved: extra.reserved}),
      ...(extra.legacyFile === undefined ? {} : {legacyFile: extra.legacyFile}),
    });
  }

  const draft = {
    name: 'Weekly Inbox Triage',
    description: 'Sort the inbox every Monday.',
    instructions: '1. Read the unread mail.',
  };

  it('starts empty', async () => {
    expect(await store().load()).toEqual([]);
  });

  it('writes one folder per skill, with the body in SKILL.md', async () => {
    const {skill, updated} = await store().save(draft);

    expect(updated).toBe(false);
    expect(skill.name).toBe('weekly-inbox-triage');
    expect(skill.id).toBe('weekly-inbox-triage');
    expect(skill.description).toBe('Sort the inbox every Monday.');
    expect(skill.instructions).toBe('1. Read the unread mail.');
    expect(skill.createdAt).toBeTruthy();

    const file = await readFile(
      join(root(), 'weekly-inbox-triage', 'SKILL.md'),
      'utf8',
    );
    expect(file).toContain('name: weekly-inbox-triage');
    expect(file).toContain('description: |');
    expect(file).toContain('1. Read the unread mail.');
  });

  it('replaces a skill saved under another spelling of the same name', async () => {
    const first = await store().save(draft);
    const second = await store().save({
      ...draft,
      name: 'weekly_inbox_triage',
      instructions: '1. Read the unread mail.\n2. Group by sender.',
    });

    expect(second.updated).toBe(true);
    expect(second.skill.id).toBe(first.skill.id);
    const stored = await store().load();
    expect(stored).toHaveLength(1);
    expect(stored[0]?.instructions).toBe(
      '1. Read the unread mail.\n2. Group by sender.',
    );
  });

  it('keeps two different skills apart', async () => {
    await store().save(draft);
    await store().save({...draft, name: 'standup-notes'});
    expect((await store().load()).map((skill) => skill.name)).toEqual([
      'standup-notes',
      'weekly-inbox-triage',
    ]);
  });

  it('removes one by id and leaves the rest', async () => {
    const first = await store().save(draft);
    await store().save({...draft, name: 'standup-notes'});

    const remaining = await store().remove(first.skill.id);
    expect(remaining.map((skill) => skill.name)).toEqual(['standup-notes']);
    await expect(
      stat(join(root(), 'weekly-inbox-triage')),
    ).rejects.toMatchObject({code: 'ENOENT'});
  });

  it('answers with the list unchanged when the id names nothing', async () => {
    await store().save(draft);
    const remaining = await store().remove('nope');
    expect(remaining).toHaveLength(1);
  });

  it('refuses a folder id that is not one', async () => {
    await store().save(draft);
    await expect(store().remove('../escaped')).rejects.toThrow(
      /not a skill folder/u,
    );
  });

  /**
   * A saved skill is switched on by name, in the same list as the built-ins, so a
   * saved `memory` would shadow the app's own memory skill rather than sit beside
   * it. Refused before anything is written.
   */
  it('refuses a name the app already ships', async () => {
    const reserved = store({reserved: ['reasoning', 'memory', 'knowledge']});
    await expect(
      reserved.save({...draft, name: 'Memory'}),
    ).rejects.toBeInstanceOf(ReservedSkillNameError);
    expect(await reserved.load()).toEqual([]);
  });

  it('allows anything the app does not ship', async () => {
    const reserved = store({reserved: ['reasoning', 'memory', 'knowledge']});
    const {skill} = await reserved.save({...draft, name: 'memory-notes'});
    expect(skill.name).toBe('memory-notes');
  });

  it('refuses instructions longer than the limit, writing nothing', async () => {
    await expect(
      store().save({
        ...draft,
        instructions: 'x'.repeat(SKILL_INSTRUCTIONS_MAX + 1),
      }),
    ).rejects.toBeInstanceOf(SkillTooLongError);
    expect(await store().load()).toEqual([]);
  });

  it('accepts instructions exactly at the limit', async () => {
    const {skill} = await store().save({
      ...draft,
      instructions: 'x'.repeat(SKILL_INSTRUCTIONS_MAX),
    });
    expect(skill.instructions).toHaveLength(SKILL_INSTRUCTIONS_MAX);
  });

  it('refuses a description longer than the line the prompt carries', async () => {
    await expect(
      store().save({
        ...draft,
        description: 'x'.repeat(SKILL_DESCRIPTION_MAX + 1),
      }),
    ).rejects.toBeInstanceOf(SkillDescriptionTooLongError);
    expect(await store().load()).toEqual([]);
  });

  it('edits a skill in place, keeping its id', async () => {
    const first = await store().save(draft);
    const edited = await store().save(
      {...draft, description: 'Sort the inbox every Tuesday.'},
      first.skill.id,
    );
    expect(edited.skill.id).toBe(first.skill.id);
    expect(edited.skill.description).toBe('Sort the inbox every Tuesday.');
    expect(await store().load()).toHaveLength(1);
  });

  it('renames a skill by saving it under the new name, by id', async () => {
    const first = await store().save(draft);
    const renamed = await store().save(
      {...draft, name: 'Tuesday Triage'},
      first.skill.id,
    );

    expect(renamed.skill.name).toBe('tuesday-triage');
    expect(renamed.renamedFrom).toBe('weekly-inbox-triage');
    expect((await store().load()).map((skill) => skill.name)).toEqual([
      'tuesday-triage',
    ]);
    await expect(
      stat(join(root(), 'weekly-inbox-triage')),
    ).rejects.toMatchObject({code: 'ENOENT'});
  });

  it('refuses a rename onto a name another skill holds', async () => {
    await store().save(draft);
    const second = await store().save({...draft, name: 'standup-notes'});
    await expect(
      store().save({...draft, name: 'weekly-inbox-triage'}, second.skill.id),
    ).rejects.toBeInstanceOf(DuplicateSkillNameError);
  });

  it('treats an id that names nothing as an insert', async () => {
    const {updated} = await store().save(draft, 'no-such-id');
    expect(updated).toBe(false);
    expect(await store().load()).toHaveLength(1);
  });

  /*
   * The whole reason a folder that did not load is treated as taken: a
   * hand-edited file with a typo is not an empty slot, and saving over it would
   * be the lenient-read-plus-write that loses the user's text.
   */
  it('refuses to overwrite a folder it could not read', async () => {
    await mkdir(join(root(), 'broken'), {recursive: true});
    // Empty: a file with no procedure is not a skill this build can load.
    await writeFile(join(root(), 'broken', 'SKILL.md'), '', 'utf8');

    await expect(store().save({...draft, name: 'Broken'})).rejects.toThrow(
      /could not read/u,
    );
    expect(await readFile(join(root(), 'broken', 'SKILL.md'), 'utf8')).toBe('');
  });

  it('reads a hand-written markdown file with no frontmatter', async () => {
    await mkdir(join(root(), 'triage'), {recursive: true});
    await writeFile(
      join(root(), 'triage', 'SKILL.md'),
      '# Triage\n\nSort the inbox.\n',
      'utf8',
    );

    const [skill] = await store().load();
    expect(skill?.name).toBe('triage');
    expect(skill?.description).toBe('Triage');
    expect(skill?.instructions).toBe('# Triage\n\nSort the inbox.');
  });

  /*
   * The old build kept skills in one JSON file. It is imported once and renamed,
   * not deleted: the file is still the user's, and a write that failed halfway
   * must not leave the only copy gone.
   */
  it('imports a skills.json from an older build, once', async () => {
    const legacyFile = join(dir, 'skills.json');
    await writeFile(
      legacyFile,
      JSON.stringify({
        version: 1,
        skills: [
          {
            id: 'old-id',
            name: 'weekly-inbox-triage',
            description: 'Sort the inbox every Monday.',
            instructions: '1. Read the unread mail.',
            createdAt: '2026-01-01T00:00:00.000Z',
          },
        ],
      }),
      'utf8',
    );

    const loaded = await store({legacyFile}).load();
    expect(loaded.map((skill) => skill.name)).toEqual(['weekly-inbox-triage']);
    await expect(stat(legacyFile)).rejects.toMatchObject({code: 'ENOENT'});
    await expect(stat(`${legacyFile}.imported`)).resolves.toBeTruthy();

    // A second read is the folders, not a second import.
    expect(await store({legacyFile}).load()).toHaveLength(1);
  });

  it('leaves a corrupt legacy file alone', async () => {
    const legacyFile = join(dir, 'skills.json');
    await writeFile(legacyFile, '{"version": 1, "skills": [', 'utf8');
    expect(await store({legacyFile}).load()).toEqual([]);
    expect(await readFile(legacyFile, 'utf8')).toBe(
      '{"version": 1, "skills": [',
    );
  });
});
