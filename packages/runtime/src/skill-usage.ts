/**
 * Which skills have actually been loaded, and when.
 *
 * A skill library with no usage record has one question nobody can answer: is
 * this procedure earning its place? The prompt advertises every granted skill on
 * every turn, and a skill that has not been loaded in months is still paid for in
 * the instructions — the same argument memory has, one layer over.
 *
 * The record is deliberately separate from `SKILL.md`. The skill is the user's
 * markdown and may be edited by hand; this is a fact about the app's use of it,
 * and putting a counter in the user's file would be the app writing its own
 * bookkeeping into somebody else's document.
 *
 * One increment per load, not per turn: `load_skill` is rare, and the count is
 * only ever read as "has this been used, and when last".
 */
import {randomUUID} from 'node:crypto';
import {mkdir, rename, writeFile} from 'node:fs/promises';
import {dirname} from 'node:path';

import {skillUsageFileSchema} from '@marimo/protocol';
import type {SkillUsageFile} from '@marimo/protocol';
import {
  assertWritable,
  DocumentTooNewError,
  readVersionedDocument,
} from '@marimo/agent';
import type {ReadVersionedOptions} from '@marimo/agent';

import {withFileLock} from './lock.js';

export const SKILL_USAGE_VERSION = 1;

const READ_OPTIONS: ReadVersionedOptions = {
  label: 'The skill usage file',
  current: SKILL_USAGE_VERSION,
  migrations: [],
};

function empty(): SkillUsageFile {
  return {version: 1, loads: {}};
}

export interface SkillUsageStoreOptions {
  file: string;
  now?: () => Date;
}

export class SkillUsageStore {
  private cache: SkillUsageFile | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly now: () => Date;

  constructor(private readonly options: SkillUsageStoreOptions) {
    this.now = options.now ?? (() => new Date());
  }

  /** Lenient: an unreadable file answers as "nothing loaded yet". */
  async load(): Promise<SkillUsageFile> {
    if (this.cache) {
      return this.cache;
    }
    const read = await readVersionedDocument(this.options.file, READ_OPTIONS);
    if (read.state === 'too-new') {
      throw new DocumentTooNewError(
        'The skill usage file',
        read.found,
        read.supported,
      );
    }
    if (read.state === 'current' || read.state === 'migrated') {
      const parsed = skillUsageFileSchema.safeParse(read.document);
      if (parsed.success) {
        this.cache = parsed.data;
        return parsed.data;
      }
    }
    this.cache = empty();
    return this.cache;
  }

  /** One load, counted. */
  async record(skillId: string): Promise<SkillUsageFile> {
    return await this.mutate((current) => {
      const existing = current.loads[skillId];
      return {
        ...current,
        loads: {
          ...current.loads,
          [skillId]: {
            count: (existing?.count ?? 0) + 1,
            lastAt: this.now().toISOString(),
          },
        },
      };
    });
  }

  /** Forgets a removed skill's count, so a reused id does not inherit it. */
  async forget(skillId: string): Promise<SkillUsageFile> {
    return await this.mutate((current) => {
      if (current.loads[skillId] === undefined) {
        return current;
      }
      const loads = {...current.loads};
      delete loads[skillId];
      return {...current, loads};
    });
  }

  async forgetAll(): Promise<SkillUsageFile> {
    return await this.mutate(() => empty());
  }

  private async mutate(
    edit: (current: SkillUsageFile) => SkillUsageFile,
  ): Promise<SkillUsageFile> {
    return await this.withLock(async () => {
      return await withFileLock(`${this.options.file}.lock`, async () => {
        await assertWritable(this.options.file, READ_OPTIONS);
        const current = await this.load();
        const next = edit(current);
        const validated = skillUsageFileSchema.safeParse(next);
        if (!validated.success) {
          throw new Error('Refusing to store an invalid skill usage document.');
        }
        await mkdir(dirname(this.options.file), {recursive: true});
        const temporary = `${this.options.file}.${randomUUID()}.tmp`;
        await writeFile(
          temporary,
          `${JSON.stringify(validated.data, null, 2)}\n`,
          'utf8',
        );
        await rename(temporary, this.options.file);
        this.cache = validated.data;
        return validated.data;
      });
    });
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
