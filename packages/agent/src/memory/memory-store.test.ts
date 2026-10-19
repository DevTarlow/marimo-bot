/**
 * Memory store tests.
 *
 * The merge logic is pure, so most of this runs without touching disk; the
 * persistence half is checked against a real temporary workspace because the
 * atomic-write and backup behaviour is the part worth proving.
 */
import {mkdtemp, readFile, rm, writeFile, mkdir} from 'node:fs/promises';
import {join} from 'node:path';

import {afterEach, beforeEach, describe, expect, it} from 'vitest';

import {
  AGENT_DATA_DIR,
  DEFAULT_PROFILE_ID,
  MAX_ENTRY_CHARS,
  MAX_MEMORY_BYTES,
  MAX_PROMPT_CHARS,
  MemoryStore,
  MemoryTooLargeError,
  applyUpdate,
  applyUpdateWithReport,
  resolveAgentDataDir,
  resolveMemoryFile,
  resolvePersonMemoryFile,
  splitMemory,
} from './memory-store.js';
import {MEMORY_SOFT_LIMIT_BYTES} from './size.js';

describe('memory paths', () => {
  it('keeps memory in an app-owned folder inside the workspace', () => {
    expect(resolveMemoryFile('/work/project')).toBe(
      join('/work/project', AGENT_DATA_DIR, DEFAULT_PROFILE_ID, 'memory.md'),
    );
  });

  it('gives each profile its own folder', () => {
    expect(resolveAgentDataDir('/work/project', 'research')).toBe(
      join('/work/project', AGENT_DATA_DIR, 'research'),
    );
    expect(resolveMemoryFile('/work/project', 'research')).not.toBe(
      resolveMemoryFile('/work/project'),
    );
  });

  it('refuses a profile id that is not a single path segment', () => {
    expect(resolveAgentDataDir('/work/project', '../../etc')).toBe(
      join('/work/project', AGENT_DATA_DIR, DEFAULT_PROFILE_ID),
    );
    expect(resolveAgentDataDir('/work/project', '..')).toBe(
      join('/work/project', AGENT_DATA_DIR, DEFAULT_PROFILE_ID),
    );
    expect(resolveAgentDataDir('/work/project', '')).toBe(
      join('/work/project', AGENT_DATA_DIR, DEFAULT_PROFILE_ID),
    );
  });

  /*
   * The person half lives under user data rather than inside the folder, which is
   * the whole reason it survives switching projects — and it keeps the same file
   * name as the workspace one, so a `.bak` beside either means the same thing.
   */
  it('keeps the person half under user data, one folder per profile', () => {
    expect(resolvePersonMemoryFile('/home/u/.config/Marimo Bot/memory')).toBe(
      join(
        '/home/u/.config/Marimo Bot/memory',
        DEFAULT_PROFILE_ID,
        'memory.md',
      ),
    );
    expect(
      resolvePersonMemoryFile('/home/u/.config/Marimo Bot/memory', 'research'),
    ).toBe(join('/home/u/.config/Marimo Bot/memory', 'research', 'memory.md'));
  });

  it('refuses a profile id that would escape the person folder', () => {
    expect(
      resolvePersonMemoryFile('/home/u/.config/Marimo Bot/memory', '../..'),
    ).toBe(
      join(
        '/home/u/.config/Marimo Bot/memory',
        DEFAULT_PROFILE_ID,
        'memory.md',
      ),
    );
  });
});

describe('applyUpdate', () => {
  it('creates the section when the document is empty', () => {
    expect(
      applyUpdate('', {section: 'Preferences', content: 'Prefers pnpm'}),
    ).toBe('## Preferences\n- Prefers pnpm\n');
  });

  it('appends a bullet to an existing section', () => {
    const current = '# Marimo Bot memory\n\n## Preferences\n- Prefers pnpm\n';
    const next = applyUpdate(current, {
      section: 'Preferences',
      content: 'Uses a dark theme',
    });
    expect(next).toBe(
      '# Marimo Bot memory\n\n## Preferences\n- Prefers pnpm\n- Uses a dark theme\n',
    );
  });

  it('drops a duplicate bullet instead of repeating it', () => {
    const current = '## Preferences\n- Prefers pnpm\n';
    expect(
      applyUpdate(current, {section: 'Preferences', content: 'prefers pnpm'}),
    ).toBe('## Preferences\n- Prefers pnpm\n');
  });

  it('creates a section that does not exist yet, keeping the others', () => {
    const current = '# Marimo Bot\n\n## Preferences\n- Prefers pnpm\n';
    const next = applyUpdate(current, {
      section: 'Environment',
      content: 'Node 22\n- pnpm 11',
    });
    expect(next).toBe(
      '# Marimo Bot\n\n## Preferences\n- Prefers pnpm\n\n## Environment\n- Node 22\n- pnpm 11\n',
    );
  });

  it('replaces a section body in place', () => {
    const current = '## A\n- one\n- two\n\n## B\n- keep\n';
    const next = applyUpdate(current, {
      section: 'A',
      content: 'three',
      mode: 'replace',
    });
    expect(next).toBe('## A\n- three\n\n## B\n- keep\n');
  });

  it('matches a section heading case-insensitively', () => {
    const next = applyUpdate('## preferences\n- a\n', {
      section: 'PREFERENCES',
      content: 'b',
    });
    expect(next).toBe('## preferences\n- a\n- b\n');
  });

  it('lands an unnamed update in the default section', () => {
    expect(applyUpdate('', {content: 'remember this'})).toBe(
      '## Notes\n- remember this\n',
    );
  });

  it('splits a multi-line update into one bullet per line', () => {
    expect(applyUpdate('', {content: 'one\ntwo\n\nthree'})).toBe(
      '## Notes\n- one\n- two\n- three\n',
    );
  });

  it('caps a single bullet', () => {
    const next = applyUpdate('', {content: 'x'.repeat(MAX_ENTRY_CHARS + 50)});
    const bullet = next.split('\n')[1] ?? '';
    expect(bullet.length).toBe(MAX_ENTRY_CHARS + 2);
  });
});

describe('superseding a fact', () => {
  /*
   * The correction path. A memory holding "always use npm" beside "always use
   * pnpm" is worse than one holding neither: the next session reads both and
   * has no way to tell which is current.
   */
  it('removes the old bullet and adds the new one', () => {
    const current = '## Preferences and tone\n- Always use npm.\n- Be terse.\n';
    const report = applyUpdateWithReport(current, {
      section: 'Preferences and tone',
      content: 'Always use pnpm.',
      replaces: 'Always use npm',
    });

    expect(report.content).toBe(
      '## Preferences and tone\n- Be terse.\n- Always use pnpm.\n',
    );
    expect(report.supersede).toEqual({
      outcome: 'removed',
      removed: '- Always use npm.',
    });
  });

  it('matches a leading substring however the model phrases the spacing', () => {
    const report = applyUpdateWithReport(
      '## Notes\n- Prefers   pnpm over npm\n',
      {
        content: 'Prefers pnpm.',
        replaces: 'prefers pnpm',
      },
    );
    expect(report.supersede.outcome).toBe('removed');
    expect(report.content).toBe('## Notes\n- Prefers pnpm.\n');
  });

  it('prefers an exact match over a shorter bullet that starts the same way', () => {
    const report = applyUpdateWithReport(
      '## Notes\n- Uses pnpm.\n- Uses pnpm for scripts.\n',
      {
        content: 'Uses bun.',
        replaces: 'Uses pnpm.',
      },
    );
    expect(report.supersede.removed).toBe('- Uses pnpm.');
    expect(report.content).toBe(
      '## Notes\n- Uses pnpm for scripts.\n- Uses bun.\n',
    );
  });

  /*
   * Refusing is the safe half of a correction. A prefix short enough to hit two
   * bullets is one the model has not actually identified, and deleting a fact
   * nobody named is the same failure as leaving both versions in place.
   */
  it('removes nothing when the target is not unique, and says how many it hit', () => {
    const current =
      '## Environment and conventions\n- Runs the app with pnpm\n- Runs the tests with vitest\n';
    const report = applyUpdateWithReport(current, {
      section: 'Environment and conventions',
      content: 'Runs everything with bun.',
      replaces: 'Runs the',
    });

    expect(report.supersede).toEqual({outcome: 'ambiguous', matches: 2});
    expect(report.content).toContain('- Runs the app with pnpm');
    expect(report.content).toContain('- Runs everything with bun.');
  });

  /*
   * The failure the report exists for: a silent no-op would let the model
   * believe it corrected something it did not.
   */
  it('reports a target that matched nothing instead of ignoring it', () => {
    const current = '## Boundaries\n- Never push.\n';
    const report = applyUpdateWithReport(current, {
      section: 'Boundaries',
      content: 'Never push to main.',
      replaces: 'Always use tabs',
    });

    expect(report.supersede).toEqual({outcome: 'absent', matches: 0});
    expect(report.content).toContain('- Never push.');
    expect(report.content).toContain('- Never push to main.');
  });

  it('reports a target in a section the document does not have', () => {
    const report = applyUpdateWithReport('## Notes\n- something\n', {
      section: 'Project pointers',
      content: 'See docs/state.md.',
      replaces: 'See README.md.',
    });
    expect(report.supersede.outcome).toBe('absent');
    expect(report.content).toBe(
      '## Notes\n- something\n\n## Project pointers\n- See docs/state.md.\n',
    );
  });

  it('says nothing was asked to be replaced when replaces is blank', () => {
    const report = applyUpdateWithReport('', {
      content: 'a fact',
      replaces: '  ',
    });
    expect(report.supersede).toEqual({outcome: 'none'});
    expect(report.content).toBe('## Notes\n- a fact\n');
  });

  it('can supersede the last bullet of a section without leaving a gap', () => {
    const report = applyUpdateWithReport(
      '## Notes\n- old\n\n## Other\n- keep\n',
      {
        content: '',
        replaces: 'old',
      },
    );
    expect(report.supersede.outcome).toBe('removed');
    expect(report.content).toBe('## Other\n- keep\n');
  });

  /*
   * Only the section this call emptied goes. A blank heading the user wrote is
   * still their file, and a replace aimed at a neighbour is not a reason to
   * tidy it away behind them.
   */
  it('leaves a blank heading it did not empty alone', () => {
    const report = applyUpdateWithReport('## To fill in\n\n## Facts\n- old\n', {
      section: 'Facts',
      content: 'new',
      mode: 'replace',
    });
    expect(report.content).toBe('## To fill in\n\n## Facts\n- new\n');
  });
});

describe('splitMemory', () => {
  it('keeps the preamble separate from the sections', () => {
    const blocks = splitMemory('# Title\n\n## A\n- x\n');
    expect(blocks).toHaveLength(2);
    expect(blocks[0]?.heading).toBeUndefined();
    expect(blocks[0]?.lines).toEqual(['# Title', '']);
    expect(blocks[1]?.heading).toBe('A');
  });
});

/*
 * The two-file half of memory.
 *
 * What is being pinned here is not the file layout — it is the behaviour a
 * person notices. A fact about them is there in every project. A repo rule is
 * there only in that repo. And an upgrade must not lose either, including if it
 * is interrupted halfway, which is the state nobody tests and everybody ships.
 */
describe('MemoryStore, split by layer', () => {
  let workDir: string;
  let personDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(process.cwd(), '.marimo-memory-'));
    personDir = join(workDir, 'userdata', 'memory');
  });

  afterEach(async () => {
    await rm(workDir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 20,
    });
  });

  function store(profileId?: string): MemoryStore {
    return new MemoryStore({
      workspaceRoot: workDir,
      personMemoryRoot: personDir,
      ...(profileId === undefined ? {} : {profileId}),
    });
  }

  it('writes a person-level layer into the person file', async () => {
    const memory = store();
    await memory.update({section: 'About the user', content: 'Has a dog'});

    expect(await readFile(memory.personFile ?? '', 'utf8')).toContain(
      '- Has a dog',
    );
    // And not into the workspace file, which is the whole point: the fact has to
    // survive the folder changing.
    await expect(readFile(memory.file, 'utf8')).rejects.toThrow();
  });

  it('writes a workspace-level layer into the workspace file', async () => {
    const memory = store();
    await memory.update({
      section: 'Environment and conventions',
      content: 'Uses pnpm',
    });

    expect(await readFile(memory.file, 'utf8')).toContain('- Uses pnpm');
    await expect(readFile(memory.personFile ?? '', 'utf8')).rejects.toThrow();
  });

  it('keeps a fact about the person across a change of folder', async () => {
    const first = store();
    await first.update({section: 'About the user', content: 'Has a dog'});
    await first.update({
      section: 'Project pointers',
      content: 'State in TODO.md',
    });

    // A different project: new workspace root, same person directory.
    const otherRoot = await mkdtemp(join(process.cwd(), '.marimo-project-'));
    try {
      const second = new MemoryStore({
        workspaceRoot: otherRoot,
        personMemoryRoot: personDir,
      });
      const text = await second.read();
      expect(text).toContain('- Has a dog');
      expect(text).not.toContain('State in TODO.md');
    } finally {
      await rm(otherRoot, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 20,
      });
    }
  });

  it('reads the person half before the project half', async () => {
    const memory = store();
    await memory.update({
      section: 'Project pointers',
      content: 'State in TODO.md',
    });
    await memory.update({section: 'About the user', content: 'Has a dog'});

    const text = await memory.read();
    expect(text.indexOf('Has a dog')).toBeLessThan(
      text.indexOf('State in TODO.md'),
    );
  });

  it('lets an explicit scope place a heading the app never named', async () => {
    const memory = store();
    await memory.update({
      section: 'Recipes I like',
      content: 'Miso soup',
      scope: 'person',
    });

    expect(await readFile(memory.personFile ?? '', 'utf8')).toContain(
      '- Miso soup',
    );
  });

  it('puts a heading the app never named in the workspace by default', async () => {
    const memory = store();
    await memory.update({section: 'Recipes I like', content: 'Miso soup'});

    expect(await readFile(memory.file, 'utf8')).toContain('- Miso soup');
  });

  it('gives each profile its own person file', async () => {
    const first = store('default');
    const second = store('research');
    await first.update({section: 'About the user', content: 'Has a dog'});

    expect(await second.read()).not.toContain('Has a dog');
    expect(second.personFile).not.toBe(first.personFile);
  });

  it('shares one person file between two projects of the same profile', async () => {
    const otherRoot = await mkdtemp(join(process.cwd(), '.marimo-project-'));
    try {
      const here = store();
      const there = new MemoryStore({
        workspaceRoot: otherRoot,
        personMemoryRoot: personDir,
      });
      await here.update({section: 'Preferences and tone', content: 'No emoji'});

      expect(await there.read()).toContain('- No emoji');
    } finally {
      await rm(otherRoot, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 20,
      });
    }
  });

  it('counts both files in the size it reports', async () => {
    const memory = store();
    await memory.update({section: 'About the user', content: 'Has a dog'});
    await memory.update({
      section: 'Project pointers',
      content: 'State in TODO.md',
    });

    const merged = await memory.read();
    expect(await memory.bytes()).toBe(Buffer.byteLength(merged, 'utf8'));
    expect(merged).toContain('Has a dog');
    expect(merged).toContain('State in TODO.md');
  });

  it('names both files when it says where memory lives', async () => {
    const memory = store();
    expect(memory.location).toContain(memory.personFile ?? '');
    expect(memory.location).toContain(memory.file);
  });

  /*
   * Bullet dates.
   *
   * Memory stops accepting facts at a hard cap, so the question a person has when
   * they look at a year of it is "what in here is stale?" — and the bullets are
   * plain lines with nowhere to put an age. What is asserted here is that the
   * dates survive the things that happen to memory: a rewrite of the same fact,
   * a correction, a prune, and the one-time seeding of an install that predates
   * the document.
   */
  describe('when each bullet was written', () => {
    it('dates a fact as it is written', async () => {
      const memory = store();
      await memory.update({section: 'About the user', content: 'Has a dog'});

      const entries = await memory.provenance();
      expect(entries).toHaveLength(1);
      expect(entries[0]?.text).toBe('Has a dog');
      expect(entries[0]?.scope).toBe('person');
      expect(entries[0]?.section).toBe('About the user');
      expect(entries[0]?.source).toBe('tool');
      expect(Number.isNaN(new Date(entries[0]?.at ?? '').getTime())).toBe(
        false,
      );
    });

    it('says whether the user asked for the fact or agreed to a suggestion', async () => {
      const memory = store();
      await memory.update(
        {section: 'Notes', content: 'From a suggestion'},
        'review',
      );

      expect((await memory.provenance())[0]?.source).toBe('review');
    });

    /*
     * The store drops a line it already holds, so the write is a no-op — and the
     * date has to be the original one, not the moment somebody repeated
     * themselves. Otherwise "when was this written" answers "the last time the
     * subject came up".
     */
    it('keeps the original date when the same fact is written again', async () => {
      const memory = store();
      await memory.update({section: 'About the user', content: 'Has a dog'});
      const first = (await memory.provenance())[0]?.at;

      await memory.update({section: 'About the user', content: 'Has a dog'});

      const entries = await memory.provenance();
      expect(entries).toHaveLength(1);
      expect(entries[0]?.at).toBe(first);
    });

    it('forgets the date of a bullet a correction removed', async () => {
      const memory = store();
      await memory.update({
        section: 'Preferences and tone',
        content: 'Uses npm',
      });
      await memory.update({
        section: 'Preferences and tone',
        content: 'Uses pnpm',
        replaces: 'Uses npm',
      });

      const entries = await memory.provenance();
      expect(entries.map((entry) => entry.text)).toEqual(['Uses pnpm']);
    });

    it('dates what survives a prune', async () => {
      const memory = store();
      await memory.update({section: 'About the user', content: 'Has a dog'});
      await memory.update({
        section: 'Project pointers',
        content: 'State in TODO.md',
      });
      const kept = (await memory.provenance()).find(
        (entry) => entry.text === 'Has a dog',
      )?.at;

      await memory.prune({
        content: '## About the user\n- Has a dog\n',
      });

      const entries = await memory.provenance();
      expect(entries.map((entry) => entry.text)).toEqual(['Has a dog']);
      expect(entries[0]?.at).toBe(kept);
    });

    /*
     * The upgrade case. This document did not exist when the bullets were
     * written, and inventing today's date for all of them would be a worse lie
     * than an honest "we did not know then".
     */
    it('marks what it finds already there as adopted', async () => {
      await mkdir(join(workDir, AGENT_DATA_DIR, DEFAULT_PROFILE_ID), {
        recursive: true,
      });
      await writeFile(
        join(workDir, AGENT_DATA_DIR, DEFAULT_PROFILE_ID, 'memory.md'),
        '## Project pointers\n- State in TODO.md\n',
        'utf8',
      );

      const entries = await store().provenance();
      expect(entries).toHaveLength(1);
      expect(entries[0]?.source).toBe('adopted');
    });

    it('offers nothing when there is no place to keep dates', async () => {
      const memory = new MemoryStore({workspaceRoot: workDir});
      await memory.update({content: 'Has a dog'});

      expect(memory.provenanceFile).toBeUndefined();
      expect(await memory.provenance()).toEqual([]);
    });

    it('describes both files in one list', async () => {
      const memory = store();
      await memory.update({section: 'About the user', content: 'Has a dog'});
      await memory.update({
        section: 'Project pointers',
        content: 'State in TODO.md',
      });

      const scopes = (await memory.provenance())
        .map((entry) => entry.scope)
        .sort();
      expect(scopes).toEqual(['person', 'workspace']);
    });
  });

  describe('adoption of a file written before the split', () => {
    /** A workspace file in the old one-file layout. */
    async function seedOldLayout(text: string): Promise<void> {
      const at = join(workDir, AGENT_DATA_DIR, DEFAULT_PROFILE_ID, 'memory.md');
      await mkdir(join(workDir, AGENT_DATA_DIR, DEFAULT_PROFILE_ID), {
        recursive: true,
      });
      await writeFile(at, text, 'utf8');
    }

    it('moves person-level sections out on the first read', async () => {
      await seedOldLayout(
        '## About the user\n- Has a dog\n\n' +
          '## Environment and conventions\n- Uses pnpm\n\n' +
          '## Boundaries\n- Never force-push\n',
      );
      const memory = store();

      const text = await memory.read();

      expect(text).toContain('- Has a dog');
      expect(text).toContain('- Uses pnpm');
      expect(text).toContain('- Never force-push');
      const person = await readFile(memory.personFile ?? '', 'utf8');
      expect(person).toContain('- Has a dog');
      expect(person).toContain('- Never force-push');
      expect(person).not.toContain('- Uses pnpm');
      const workspace = await readFile(memory.file, 'utf8');
      expect(workspace).toContain('- Uses pnpm');
      expect(workspace).not.toContain('- Has a dog');
    });

    it('is idempotent, and does nothing at all the second time', async () => {
      await seedOldLayout('## About the user\n- Has a dog\n');
      const memory = store();
      await memory.read();

      const afterFirst = await readFile(memory.personFile ?? '', 'utf8');
      await memory.read();
      expect(await readFile(memory.personFile ?? '', 'utf8')).toBe(afterFirst);
      expect(await memory.read()).toBe('## About the user\n- Has a dog\n');
    });

    /*
     * The crash nobody tests: the person file was written and the workspace file
     * was not rewritten. The fact is then legitimately in both, and the prompt has
     * to show it once — a doubled sentence reads as emphasis, and the model has no
     * way to tell which copy is real.
     *
     * The duplication is set up where adoption cannot clean it: the workspace
     * copy is under a heading the app never named, so it stays in the workspace
     * file and the merged read is what has to collapse it.
     */
    it('shows a fact once when it is in both files', async () => {
      await seedOldLayout('## Recipes I like\n- Has a dog\n');
      await mkdir(join(personDir, DEFAULT_PROFILE_ID), {recursive: true});
      await writeFile(
        join(personDir, DEFAULT_PROFILE_ID, 'memory.md'),
        '## About the user\n- Has a dog\n',
        'utf8',
      );

      const text = await store().read();

      expect(text.match(/Has a dog/gu)).toHaveLength(1);
      // And the heading that held it is still there, because a heading is
      // structure rather than a fact and dropping one would edit the user's file.
      expect(text).toContain('## Recipes I like');
      expect(text).toContain('## About the user');
    });

    it('leaves a heading the app never named in the workspace file', async () => {
      await seedOldLayout('## Recipes I like\n- Miso soup\n');
      const memory = store();

      await memory.read();

      expect(await readFile(memory.file, 'utf8')).toContain('- Miso soup');
      await expect(readFile(memory.personFile ?? '', 'utf8')).rejects.toThrow();
    });

    it('writes nothing when there is nothing to adopt', async () => {
      await seedOldLayout('## Project pointers\n- State in TODO.md\n');
      const memory = store();
      await memory.read();
      // No person file at all: the steady state costs no write.
      await expect(readFile(memory.personFile ?? '', 'utf8')).rejects.toThrow();
    });

    it('merges into a person file that already has the layer', async () => {
      await mkdir(join(personDir, DEFAULT_PROFILE_ID), {recursive: true});
      await writeFile(
        join(personDir, DEFAULT_PROFILE_ID, 'memory.md'),
        '## About the user\n- Lives in Berlin\n',
        'utf8',
      );
      await seedOldLayout('## About the user\n- Has a dog\n');

      const text = await store().read();

      expect(text).toContain('- Lives in Berlin');
      expect(text).toContain('- Has a dog');
    });
  });

  describe('prune across two files', () => {
    it('routes each half of the document to its own file', async () => {
      const memory = store();
      await memory.update({section: 'About the user', content: 'Has a dog'});
      await memory.update({
        section: 'Project pointers',
        content: 'old pointer',
      });

      const report = await memory.prune({
        content:
          '## About the user\n- Has a dog and a cat\n\n' +
          '## Project pointers\n- State in docs/STATE.md\n',
      });

      expect(report.personUntouched).toBe(false);
      const person = await readFile(memory.personFile ?? '', 'utf8');
      expect(person).toContain('Has a dog and a cat');
      expect(person).not.toContain('- old pointer');
      const workspace = await readFile(memory.file, 'utf8');
      expect(workspace).toContain('State in docs/STATE.md');
      expect(workspace).not.toContain('Has a dog and a cat');
    });

    /*
     * The failure this guard exists for: a rewrite that only speaks for the
     * project would otherwise delete everything the agent knows about the
     * person, and nothing could reconstruct it.
     */
    it('refuses to empty the person file for a document that never mentions it', async () => {
      const memory = store();
      await memory.update({section: 'About the user', content: 'Has a dog'});
      await memory.update({
        section: 'Project pointers',
        content: 'old pointer',
      });

      const report = await memory.prune({
        content: '## Project pointers\n- State in docs/STATE.md\n',
      });

      expect(report.personUntouched).toBe(true);
      expect(await readFile(memory.personFile ?? '', 'utf8')).toContain(
        '- Has a dog',
      );
      expect(await memory.read()).toContain('- Has a dog');
    });

    /*
     * And the way to say it on purpose: naming the layer with nothing under it.
     * A guard with no escape hatch would be a layer that could never be cleared.
     */
    it('lets a prune clear a person layer by naming it empty', async () => {
      const memory = store();
      await memory.update({section: 'About the user', content: 'Has a dog'});

      const report = await memory.prune({
        content: '## About the user\n\n## Notes\n- nothing personal yet\n',
      });

      expect(report.personUntouched).toBe(false);
      expect(await memory.read()).not.toContain('- Has a dog');
    });

    it('keeps one backup beside each file it rewrote', async () => {
      const memory = store();
      await memory.update({section: 'About the user', content: 'Has a dog'});
      await memory.update({
        section: 'Project pointers',
        content: 'old pointer',
      });

      await memory.prune({
        content:
          '## About the user\n- Has a cat\n\n## Project pointers\n- new pointer\n',
      });

      expect(
        await readFile(`${memory.personFile ?? ''}.bak`, 'utf8'),
      ).toContain('- Has a dog');
      expect(await readFile(`${memory.file}.bak`, 'utf8')).toContain(
        '- old pointer',
      );
    });
  });
});

describe('MemoryStore', () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(process.cwd(), '.marimo-memory-'));
  });

  afterEach(async () => {
    await rm(workDir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 20,
    });
  });

  it('reads an empty string before the file exists', async () => {
    const store = new MemoryStore({workspaceRoot: workDir});
    expect(await store.read()).toBe('');
    expect(await store.readForPrompt()).toBe('');
  });

  it('writes and reads back, creating the profile folder', async () => {
    const store = new MemoryStore({workspaceRoot: workDir});
    await store.update({section: 'Preferences', content: 'Prefers pnpm'});
    expect(store.file).toBe(
      join(workDir, AGENT_DATA_DIR, DEFAULT_PROFILE_ID, 'memory.md'),
    );
    expect(await store.read()).toContain('- Prefers pnpm');
  });

  it('keeps two profiles in separate files', async () => {
    const first = new MemoryStore({workspaceRoot: workDir});
    const second = new MemoryStore({
      workspaceRoot: workDir,
      profileId: 'research',
    });
    await first.update({content: 'one'});
    await second.update({content: 'two'});
    expect(await first.read()).toContain('one');
    expect(await first.read()).not.toContain('two');
    expect(await second.read()).toContain('two');
  });

  it('follows the workspace when it changes', async () => {
    const other = await mkdtemp(join(process.cwd(), '.marimo-memory-'));
    try {
      const store = new MemoryStore({workspaceRoot: workDir});
      await store.update({content: 'here'});
      store.setWorkspaceRoot(other);
      expect(await store.read()).toBe('');
      await store.update({content: 'there'});
      expect(await store.read()).toContain('there');
    } finally {
      await rm(other, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 20,
      });
    }
  });

  it('lets every bullet from concurrent updates land', async () => {
    const store = new MemoryStore({workspaceRoot: workDir});
    await Promise.all(
      Array.from({length: 8}, (_value, index) =>
        store.update({section: 'Facts', content: `fact ${index}`}),
      ),
    );
    const text = await store.read();
    for (let index = 0; index < 8; index += 1) {
      expect(text).toContain(`- fact ${index}`);
    }
  });

  it('refuses a write over the cap', async () => {
    const store = new MemoryStore({workspaceRoot: workDir});
    await expect(
      store.write(`- ${'x'.repeat(MAX_MEMORY_BYTES)}`),
    ).rejects.toBeInstanceOf(MemoryTooLargeError);
  });

  it('truncates an oversized file for the prompt instead of failing', async () => {
    const store = new MemoryStore({workspaceRoot: workDir});
    await mkdir(join(workDir, AGENT_DATA_DIR, DEFAULT_PROFILE_ID), {
      recursive: true,
    });
    await writeFile(store.file, 'x'.repeat(MAX_PROMPT_CHARS + 100), 'utf8');
    const prompt = await store.readForPrompt();
    expect(prompt).toContain('[memory truncated');
    expect(prompt.length).toBeLessThan(MAX_PROMPT_CHARS + 200);
  });

  it('reports an unreadable file instead of throwing into the prompt', async () => {
    const store = new MemoryStore({workspaceRoot: workDir});
    // A directory where the file should be is an unreadable memory file.
    await mkdir(store.file, {recursive: true});
    expect(await store.readForPrompt()).toContain('could not be read');
  });

  it('keeps a backup when pruning', async () => {
    const store = new MemoryStore({workspaceRoot: workDir});
    await store.update({content: 'old fact'});
    await store.prune({content: '## Facts\n- new fact\n', reason: 'dedupe'});
    expect(await store.read()).toBe('## Facts\n- new fact\n');
    expect(await readFile(`${store.file}.bak`, 'utf8')).toContain('old fact');
  });

  it('writes the file whole, never partially', async () => {
    const store = new MemoryStore({workspaceRoot: workDir});
    await store.update({content: 'a'});
    await store.update({content: 'b'});
    const text = await store.read();
    expect(text).toContain('- a');
    expect(text).toContain('- b');
  });

  /*
   * The soft limit is store state rather than a module constant because the user
   * moves it. Reading it back is also what the host and the window's readout do,
   * so a setter that quietly ignored its argument would be a setting that looks
   * applied and is not.
   */
  it('carries a soft limit from construction and from the setter', async () => {
    const store = new MemoryStore({workspaceRoot: workDir});
    expect(store.softLimitBytes).toBe(MEMORY_SOFT_LIMIT_BYTES);

    store.setSoftLimitBytes(16 * 1024);
    expect(store.softLimitBytes).toBe(16 * 1024);

    const configured = new MemoryStore({
      workspaceRoot: workDir,
      softLimitBytes: 4 * 1024,
    });
    expect(configured.softLimitBytes).toBe(4 * 1024);
  });

  it('reports the size the warning is measured against', async () => {
    const store = new MemoryStore({workspaceRoot: workDir});
    expect(await store.bytes()).toBe(0);
    await store.update({content: 'one fact'});
    expect(await store.bytes()).toBe(
      Buffer.byteLength(await store.read(), 'utf8'),
    );
  });

  it('lands a correction on disk with only the new version left', async () => {
    const store = new MemoryStore({workspaceRoot: workDir});
    await store.update({
      section: 'Preferences and tone',
      content: 'Always use npm',
    });
    const report = await store.update({
      section: 'Preferences and tone',
      content: 'Always use pnpm',
      replaces: 'Always use npm',
    });

    expect(report.supersede.outcome).toBe('removed');
    const text = await store.read();
    expect(text).toContain('- Always use pnpm');
    expect(text).not.toContain('- Always use npm');
  });
});
