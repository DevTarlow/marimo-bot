/**
 * Skills the user made, one folder each under user data.
 *
 * A skill is `skills/<name>/SKILL.md`: YAML frontmatter naming it and saying
 * what it is for, then the instructions themselves. That is the shape the agent
 * ecosystem already uses, so a skill written for another harness can be dropped
 * into this folder and read, a skill can be edited in a text editor, and copying
 * one between machines is copying a folder.
 *
 * **The body is no longer prepended to every request.** `composeInstruction`
 * advertises the name and description, and the `load_skill` tool reads the body
 * when a task matches. A procedure can therefore be long enough to be useful —
 * the humanizer skill is 28 KB — without every turn paying for it.
 *
 * Plain markdown rather than a versioned document, for the reason `memory.md` is:
 * the user owns this file and may edit it by hand, so a version field would be a
 * lie about a document the app does not exclusively write. What the write path
 * does instead is refuse to overwrite a folder it could not read, and move a
 * replaced folder aside rather than deleting it in place.
 *
 * `save` upserts on the name rather than appending. Learning the same procedure
 * twice is the expected way to refine it — the second attempt has the benefit of
 * the first conversation — and two skills with one name would be
 * indistinguishable both in the checkboxes and to `enabledSkills`, which is by
 * name. The same rule is what makes the Settings editor a rename rather than an
 * edit-and-delete: the name is the identity, and everything that referred to the
 * old one is corrected by whoever called this.
 */
import {randomUUID} from 'node:crypto';
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import {join} from 'node:path';

import {
  SKILL_DESCRIPTION_MAX,
  SKILL_INSTRUCTIONS_MAX,
  skillsFileSchema,
} from '@marimo/protocol';
import type {SkillHistoryEntry, StoredSkill} from '@marimo/protocol';

/** The file one skill folder must hold. */
export const SKILL_FILE = 'SKILL.md';

export interface SkillStoreOptions {
  /** The folder holding one directory per skill. */
  root: string;
  /**
   * A `skills.json` from a build that stored them in one file.
   *
   * Imported into folders on the first read, then renamed aside. Present rather
   * than hard-coded so the store stays a store about a folder, and the path is
   * the runtime's to name.
   */
  legacyFile?: string;
  /**
   * Names the app already ships, which a saved skill may not take.
   *
   * Passed in rather than imported, because the names live in the agent package
   * and this store is about the folder. The rule belongs here anyway: the name is
   * the folder and the prompt's `## heading` in one string. A saved `memory`
   * would be filtered out of every prompt rather than shadowing anything —
   * `composeInstruction` gives a built-in name to the built-in — so the refusal
   * is what turns "your skill is carried but never sent" into a sentence the
   * user can act on.
   */
  reserved?: readonly string[];
}

/** Thrown when a draft takes a name the app already ships. */
export class ReservedSkillNameError extends Error {
  constructor(name: string) {
    super(
      `"${name}" is the name of a skill the app ships. Save this one under a different name.`,
    );
    this.name = 'ReservedSkillNameError';
  }
}

/**
 * Thrown when a skill is longer than the prompt or the file should carry.
 *
 * Refused here rather than only in the editor and in `save_skill`, because the
 * limit belongs to the format: the body is loaded into a request when the skill
 * is used, and a file large enough to crowd out the conversation is a cost the
 * user pays without seeing the bill however it got written.
 */
export class SkillTooLongError extends Error {
  constructor(length: number) {
    super(
      `Those instructions are ${length} characters, over the ${SKILL_INSTRUCTIONS_MAX}-character limit for a skill.`,
    );
    this.name = 'SkillTooLongError';
  }
}

/** Thrown when the one-line description is too long to advertise every turn. */
export class SkillDescriptionTooLongError extends Error {
  constructor(length: number) {
    super(
      `That description is ${length} characters, over the ${SKILL_DESCRIPTION_MAX}-character limit. It is carried in every request, so keep it to the line that says when to use the skill.`,
    );
    this.name = 'SkillDescriptionTooLongError';
  }
}

/**
 * Thrown when a rename would land on a name another skill already holds.
 *
 * A refusal rather than a merge: `enabledSkills` is a list of names, so two
 * skills with one name are two procedures behind one checkbox.
 */
export class DuplicateSkillNameError extends Error {
  constructor(name: string) {
    super(
      `"${name}" is already the name of another skill. Pick a different name, or edit that one instead.`,
    );
    this.name = 'DuplicateSkillNameError';
  }
}

export interface SkillDraft {
  name: string;
  description: string;
  instructions: string;
}

/** What one parsed `SKILL.md` says, before it becomes a stored skill. */
export interface SkillFileContents {
  name: string;
  description: string;
  instructions: string;
}

export class SkillStore {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: SkillStoreOptions) {}

  /**
   * The stored skills, or none.
   *
   * A missing folder reads as empty rather than throwing: a fresh install has no
   * skills, and refusing to open the app over one is not a trade anybody would
   * make. A file this build cannot parse is skipped rather than guessed at —
   * `save` is where a refusal belongs, because that is the moment something
   * would be overwritten.
   */
  async load(): Promise<StoredSkill[]> {
    await this.importLegacy();

    let entries;
    try {
      entries = await readdir(this.options.root, {withFileTypes: true});
    } catch (failure) {
      if (isMissing(failure)) {
        return [];
      }
      throw failure;
    }

    const skills: StoredSkill[] = [];
    const seen = new Set<string>();
    /*
     * Sorted so two folders declaring one name resolve the same way on every
     * read, and dot-directories are skipped: `discard` moves a replaced folder
     * to one while it removes it, and a half-removed skill must not come back.
     */
    for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) {
        continue;
      }
      const file = join(this.options.root, entry.name, SKILL_FILE);
      let text: string;
      try {
        text = await readFile(file, 'utf8');
      } catch {
        continue;
      }
      const parsed = parseSkillMarkdown(text, entry.name);
      if (parsed === undefined || seen.has(parsed.name)) {
        continue;
      }
      seen.add(parsed.name);
      const info = await stat(file).catch(() => undefined);
      skills.push({
        id: entry.name,
        name: parsed.name,
        description: parsed.description,
        instructions: parsed.instructions,
        createdAt: (info?.mtime ?? new Date()).toISOString(),
      });
    }
    return skills.sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Saves one skill, replacing any with the same name.
   *
   * The name is normalised here rather than trusted: it becomes the folder, the
   * prompt's heading and a member of a profile's `enabledSkills`, so "Weekly
   * Inbox Triage" and "weekly-inbox-triage" have to be the same skill.
   *
   * `id` names the folder being edited, and it is the only way to rename one: the
   * store's identity is the name, so a save under a different name would
   * otherwise insert a second skill rather than move the first. A save by name
   * and a save by id are the same operation from the caller's side — pass the id
   * you were handed and the skill keeps its folder, along with its creation time.
   */
  async save(
    draft: SkillDraft,
    id?: string,
  ): Promise<{skill: StoredSkill; updated: boolean; renamedFrom?: string}> {
    return await this.withLock(async () => {
      const name = normaliseName(draft.name);
      if (this.options.reserved?.includes(name)) {
        throw new ReservedSkillNameError(name);
      }
      const description = collapse(draft.description);
      if (description.length === 0) {
        throw new Error('A skill needs a one-line description.');
      }
      if (description.length > SKILL_DESCRIPTION_MAX) {
        throw new SkillDescriptionTooLongError(description.length);
      }
      const instructions = draft.instructions.trim();
      if (instructions.length === 0) {
        throw new Error('A skill needs instructions.');
      }
      if (instructions.length > SKILL_INSTRUCTIONS_MAX) {
        throw new SkillTooLongError(instructions.length);
      }

      const current = await this.load();
      const byName = current.find((skill) => skill.name === name);
      const byId =
        id === undefined ? undefined : current.find((skill) => skill.id === id);
      /*
       * Two skills may not share a name, because `enabledSkills` refers to them
       * by name: a profile would have one checkbox for two procedures. Renaming
       * onto a name that is already taken is refused rather than merged, because
       * silently discarding the other skill is a worse answer than saying so —
       * and the one that would be discarded is the one the user is not looking
       * at.
       */
      if (byId && byName && byName.id !== byId.id) {
        throw new DuplicateSkillNameError(name);
      }
      const existing = byId ?? byName;
      const folder = name;
      const target = join(this.options.root, folder);
      /*
       * A folder that is at the target but did not load is a file this build
       * could not read — a hand edit mid-sentence, a frontmatter typo, a body
       * over the cap. Writing over it would be the lenient-read-plus-write that
       * `AGENTS.md` calls how a user's data disappears, so it is refused with a
       * sentence instead.
       */
      if (existing === undefined) {
        const taken = await stat(target).catch(() => undefined);
        if (taken !== undefined) {
          throw new Error(
            `There is already a skill folder named "${folder}" that this build could not read. Fix or remove it before saving a skill by that name.`,
          );
        }
      } else if (existing.id !== folder) {
        const taken = await stat(target).catch(() => undefined);
        if (taken !== undefined) {
          throw new DuplicateSkillNameError(name);
        }
      }

      const skill: StoredSkill = {
        // The folder is the identity. A save that replaces keeps it, so anything
        // holding an id — the Settings list, a dialog left open — still names
        // the same skill afterwards.
        id: existing?.id ?? folder,
        name,
        description,
        instructions,
        createdAt: existing?.createdAt ?? new Date().toISOString(),
      };
      await this.writeSkill(folder, skill);
      /*
       * Written before the old folder goes, so a failure here leaves two copies
       * rather than none. The old one is moved to a dot-name first and then
       * removed: a rename is one operation even across the same filesystem, and
       * a removal that fails leaves something `load` already ignores.
       */
      if (existing !== undefined && existing.id !== folder) {
        await this.discard(existing.id);
      }
      return {
        skill,
        updated: existing !== undefined,
        ...(existing !== undefined && existing.name !== name
          ? {renamedFrom: existing.name}
          : {}),
      };
    });
  }

  /**
   * The bodies this skill had before its current one, newest first.
   *
   * A history file is the whole `SKILL.md` as it stood, so it can be parsed the
   * same way as the live one. An entry this build cannot parse is skipped rather
   * than guessed at; it stays on disk for a person to read.
   */
  async history(skillId: string): Promise<SkillHistoryEntry[]> {
    const folder = safeFolder(skillId);
    const history = join(this.options.root, folder, 'history');
    const names = await readdir(history).catch((failure: unknown) => {
      if (isMissing(failure)) {
        return [] as string[];
      }
      throw failure;
    });
    const entries: SkillHistoryEntry[] = [];
    for (const name of names.filter((entry) => entry.endsWith('.md')).sort().reverse()) {
      const file = join(history, name);
      const text = await readFile(file, 'utf8').catch(() => undefined);
      if (text === undefined) {
        continue;
      }
      let parsed: SkillFileContents | undefined;
      try {
        parsed = parseSkillMarkdown(text, folder);
      } catch {
        continue;
      }
      if (parsed === undefined) {
        continue;
      }
      const info = await stat(file).catch(() => undefined);
      entries.push({
        id: name,
        savedAt: (info?.mtime ?? new Date(0)).toISOString(),
        name: parsed.name,
        description: parsed.description,
        instructions: parsed.instructions,
      });
    }
    return entries;
  }

  /**
   * Puts one earlier body back, keeping the body it replaces in history.
   *
   * Restoring is a normal save in every respect, including the rename rules and
   * the history entry it makes of the current text, so a restore is itself
   * reversible.
   */
  async restore(
    skillId: string,
    entryId: string,
  ): Promise<{skill: StoredSkill; updated: boolean; renamedFrom?: string}> {
    if (
      entryId.length === 0 ||
      entryId.includes('/') ||
      entryId.includes('\\') ||
      !entryId.endsWith('.md')
    ) {
      throw new Error('That is not a saved skill version.');
    }
    const folder = safeFolder(skillId);
    const file = join(this.options.root, folder, 'history', entryId);
    const text = await readFile(file, 'utf8').catch(() => undefined);
    if (text === undefined) {
      throw new Error('That saved version no longer exists.');
    }
    const parsed = parseSkillMarkdown(text, folder);
    if (parsed === undefined) {
      throw new Error('That saved version is not a readable skill.');
    }
    return await this.save(
      {
        name: parsed.name,
        description: parsed.description,
        instructions: parsed.instructions,
      },
      skillId,
    );
  }

  /** Removes one skill by id, and answers with what is left. */
  async remove(skillId: string): Promise<StoredSkill[]> {
    return await this.withLock(async () => {
      await this.discard(skillId);
      return await this.load();
    });
  }

  private async writeSkill(
    folder: string,
    skill: Pick<StoredSkill, 'name' | 'description' | 'instructions'>,
  ): Promise<void> {
    const directory = join(this.options.root, folder);
    await mkdir(directory, {recursive: true});
    const file = join(directory, SKILL_FILE);
    /*
     * The previous body is kept before the replacement lands. A skill is prompt
     * text the agent follows, so "I improved the procedure" has to be
     * reversible: the user may prefer what the agent did before, and the file is
     * theirs to compare. The history folder is ignored by `load`, which reads
     * only `SKILL.md`.
     */
    const previous = await readFile(file, 'utf8').catch(() => undefined);
    if (previous !== undefined && previous.trim().length > 0) {
      const history = join(directory, 'history');
      await mkdir(history, {recursive: true});
      const stamp = `${Date.now()}-${randomUUID().slice(0, 8)}`;
      await writeFile(join(history, `${stamp}.md`), previous, 'utf8').catch(
        () => undefined,
      );
      const kept = (await readdir(history))
        .filter((entry) => entry.endsWith('.md'))
        .sort();
      for (const stale of kept.slice(0, Math.max(0, kept.length - 20))) {
        await rm(join(history, stale), {force: true}).catch(() => undefined);
      }
    }
    // Written to a sibling and renamed, so a crash mid-write cannot leave half a
    // file where the user's skill was.
    const temporary = `${file}.${randomUUID()}.tmp`;
    await writeFile(temporary, renderSkillMarkdown(skill), 'utf8');
    await rename(temporary, file);
  }

  private async discard(folder: string): Promise<void> {
    const safe = safeFolder(folder);
    const directory = join(this.options.root, safe);
    const aside = join(
      this.options.root,
      `.${safe}.${randomUUID()}.removed`,
    );
    try {
      await rename(directory, aside);
    } catch (failure) {
      if (isMissing(failure)) {
        return;
      }
      throw failure;
    }
    await rm(aside, {recursive: true, force: true}).catch(() => undefined);
  }

  /**
   * Brings a `skills.json` from an older build forward, once.
   *
   * The file is read through its schema rather than a bare `JSON.parse`, so a
   * file from a build this one does not understand is left exactly where it is
   * instead of being half-imported. A folder that already exists wins; the old
   * file is then renamed rather than deleted, because it is the user's data even
   * when its contents have moved.
   */
  private async importLegacy(): Promise<void> {
    const file = this.options.legacyFile;
    if (file === undefined) {
      return;
    }
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch {
      return;
    }
    let document: unknown;
    try {
      document = JSON.parse(text);
    } catch {
      return;
    }
    const parsed = skillsFileSchema.safeParse(document);
    if (!parsed.success) {
      return;
    }
    for (const stored of parsed.data.skills) {
      const name = normaliseName(stored.name);
      const directory = join(this.options.root, name);
      const exists = await stat(directory).catch(() => undefined);
      if (exists !== undefined) {
        continue;
      }
      try {
        await this.writeSkill(name, {
          name,
          description: collapse(stored.description).slice(
            0,
            SKILL_DESCRIPTION_MAX,
          ),
          instructions: stored.instructions,
        });
      } catch {
        return;
      }
    }
    const aside = `${file}.imported`;
    try {
      await rm(aside, {force: true});
      await rename(file, aside);
    } catch {
      // Left in place. The next read imports nothing (the folders exist) and
      // tries again; a read-only directory is the ordinary reason.
    }
  }

  private async withLock<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return await run;
  }
}

/**
 * A name that can be a folder, a heading and a list entry.
 *
 * Anything that is not a letter, a digit or a separator becomes a dash, runs of
 * dashes collapse, and the result is lower-cased — so a model that answers
 * "Weekly Inbox Triage" and one that answers "weekly_inbox_triage" produce the
 * same skill rather than two.
 */
export function normaliseName(raw: string): string {
  const name = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '');
  // A name that was entirely punctuation would be a blank heading; the tool
  // refuses one before this is reached, and this is the backstop.
  return name.length > 0 ? name : 'skill';
}

/**
 * The parsed contents of one `SKILL.md`, or `undefined` when it is not a skill.
 *
 * Two shapes are accepted: the ecosystem's frontmatter, and a plain markdown file
 * whose folder name is the skill's name. The second is not a convenience — a
 * user who writes `skills/triage/SKILL.md` and starts with `# Triage` should get
 * a skill, not a file the app silently ignores because it lacks a `---` line.
 */
export function parseSkillMarkdown(
  text: string,
  fallbackName: string,
): SkillFileContents | undefined {
  const normalised = text
    .replace(/^\uFEFF/u, '')
    .replace(/\r\n/gu, '\n');
  const frontmatter = /^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/u.exec(
    normalised,
  );
  if (frontmatter === null) {
    const instructions = normalised.trim();
    if (
      instructions.length === 0 ||
      instructions.length > SKILL_INSTRUCTIONS_MAX
    ) {
      return undefined;
    }
    const name = normaliseName(fallbackName);
    return {
      name,
      description: descriptionFromBody(instructions, name),
      instructions,
    };
  }

  const values = frontmatterValues(frontmatter[1] ?? '');
  const instructions = normalised.slice(frontmatter[0].length).trim();
  if (
    instructions.length === 0 ||
    instructions.length > SKILL_INSTRUCTIONS_MAX
  ) {
    return undefined;
  }
  const name = normaliseName(values.name ?? fallbackName);
  const described = collapse(values.description ?? '');
  return {
    name,
    description:
      described.length > 0
        ? described.slice(0, SKILL_DESCRIPTION_MAX)
        : descriptionFromBody(instructions, name),
    instructions,
  };
}

/** Renders one skill back to the file it came from. */
export function renderSkillMarkdown(skill: {
  name: string;
  description: string;
  instructions: string;
}): string {
  const description = collapse(skill.description);
  return [
    '---',
    `name: ${skill.name}`,
    'description: |',
    `  ${description}`,
    '---',
    '',
    skill.instructions.trim(),
    '',
  ].join('\n');
}

/**
 * The `name` and `description` keys of a frontmatter block.
 *
 * Deliberately not a YAML parser: the two keys this file owns are parsed by the
 * rules YAML writers actually use for them — a plain scalar, a quoted scalar, and
 * the `|` and `>` block scalars — and every other key is left to whoever wrote
 * it. That keeps a dependency out of the app for two fields, and it means a
 * `license:` or `metadata:` block in a skill written elsewhere survives being
 * read even though this store never writes one.
 */
export function frontmatterValues(block: string): {
  name?: string;
  description?: string;
} {
  const lines = block.split('\n');
  const values: {name?: string; description?: string} = {};
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^([A-Za-z0-9_-]+):[ \t]*(.*)$/u.exec(lines[index] ?? '');
    if (match === null) {
      continue;
    }
    const key = match[1] ?? '';
    if (key !== 'name' && key !== 'description') {
      continue;
    }
    const rest = (match[2] ?? '').trim();
    if (rest === '|' || rest === '>') {
      const collected: string[] = [];
      let cursor = index + 1;
      for (; cursor < lines.length; cursor += 1) {
        const line = lines[cursor] ?? '';
        if (line.trim().length === 0) {
          collected.push('');
          continue;
        }
        if (!/^[ \t]/u.test(line)) {
          break;
        }
        collected.push(line);
      }
      const indent = Math.min(
        ...collected
          .filter((line) => line.trim().length > 0)
          .map((line) => /^[ \t]*/u.exec(line)?.[0].length ?? 0),
      );
      const stripped = collected.map((line) =>
        line.trim().length === 0 ? '' : line.slice(Number.isFinite(indent) ? indent : 0),
      );
      values[key] =
        rest === '|' ? stripped.join('\n') : folded(stripped);
      index = cursor - 1;
      continue;
    }
    let value = unquote(rest);
    /*
     * A plain scalar may continue on indented lines. This is how a hand-written
     * `description:` wraps without the `|`, and joining it here is the same
     * answer the block form gets.
     */
    const continued: string[] = [];
    let cursor = index + 1;
    for (; cursor < lines.length; cursor += 1) {
      const line = lines[cursor] ?? '';
      if (line.trim().length === 0) {
        break;
      }
      if (!/^[ \t]/u.test(line)) {
        break;
      }
      continued.push(line.trim());
    }
    if (continued.length > 0) {
      value = [value, ...continued].filter((part) => part.length > 0).join(' ');
      index = cursor - 1;
    }
    values[key] = value;
  }
  return values;
}

/** One line, whatever shape the author wrote it in. */
function collapse(text: string): string {
  return text.replace(/\s+/gu, ' ').trim();
}

/** A `>` block: adjacent lines join, a blank line becomes a paragraph break. */
function folded(lines: readonly string[]): string {
  return lines
    .join('\n')
    .split(/\n{2,}/u)
    .map((paragraph) =>
      paragraph
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .join(' '),
    )
    .filter((paragraph) => paragraph.length > 0)
    .join('\n');
}

function unquote(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}

/** A file with no frontmatter still needs a line for the prompt. */
function descriptionFromBody(instructions: string, name: string): string {
  const first = instructions
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (first === undefined) {
    return name;
  }
  return first.replace(/^#+\s*/u, '').slice(0, SKILL_DESCRIPTION_MAX);
}

/**
 * A folder name that came from an id, checked before it is joined.
 *
 * Loose on purpose: a hand-written folder need not be a normalised name, and
 * refusing `Triage` would make a skill visible in Settings that could not be
 * edited or removed. What is refused is anything that is not one path segment,
 * so `..` and a separator cannot leave the skills root.
 */
function safeFolder(folder: string): string {
  if (
    folder.length === 0 ||
    folder.startsWith('.') ||
    folder.includes('/') ||
    folder.includes('\\') ||
    folder.includes('\0')
  ) {
    throw new Error(`"${folder}" is not a skill folder.`);
  }
  return folder;
}

function isMissing(failure: unknown): boolean {
  return (failure as NodeJS.ErrnoException).code === 'ENOENT';
}
