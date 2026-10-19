/**
 * Where changes the bot asks for wait for an answer.
 *
 * Memory has its own document because it has a watermark and a refusal list that
 * only mean something to a review. This is the other half of the learning loop:
 * a capability the bot kept failing without, a harness setting it thinks is
 * wrong, and work it thinks should be done to its own notes. None of them is a
 * fact, and all of them change how later turns behave — which is exactly why
 * they are proposals rather than writes.
 *
 * **Nothing here is applied by being recorded.** The window draws a card from
 * one of these, the person answers it, and the answer is the write. A store that
 * could apply its own proposals would be a second path to the profile, and the
 * whole point of the card is that there is one.
 *
 * **The lessons are the other half of a refusal.** A dismissed memory fact is
 * recognised by its text. A dismissed grant is recognised by its subject —
 * `tool:read_file` — because "do not ask for that again" is about the capability
 * and not the sentence the model wrote around it. Recording the subject is what
 * stops a bot asking for the same tool every week in slightly different words.
 *
 * Versioned and locked like every other app-owned document: a newer build's file
 * must not be overwritten, and an unreadable one is moved aside before a write
 * rather than written over.
 */
import {randomUUID} from 'node:crypto';
import {mkdir, rename, writeFile} from 'node:fs/promises';
import {dirname} from 'node:path';

import {
  emptyLearningFile,
  learningFileSchema,
} from '@marimo/protocol';
import type {
  LearningFile,
  LearningLesson,
  LearningProposal,
} from '@marimo/protocol';

import {withFileLock} from './lock.js';
import {
  assertWritable,
  DocumentTooNewError,
  readVersionedDocument,
} from '@marimo/agent';
import type {ReadVersionedOptions} from '@marimo/agent';

/** How many proposals of every kind may wait at once. */
export const MAX_PENDING_LEARNING = 50;

/**
 * How many refusals are kept.
 *
 * The same judgement as the memory queue: a list read on every suggestion and
 * written on every refusal has to stay small, and the refusal from a phase the
 * user has moved past is the one most likely to be wrong now. Dropping the
 * oldest keeps the recent answers.
 */
export const MAX_LESSONS = 200;

export const LEARNING_VERSION = 1;

const READ_OPTIONS: ReadVersionedOptions = {
  label: 'The learning proposals file',
  current: LEARNING_VERSION,
  migrations: [],
};

/**
 * A proposal about to be recorded, before it has an id or a time.
 *
 * Distributive over the union on purpose: a plain `Omit<LearningProposal, ...>`
 * collapses to the keys every kind shares and silently drops `target`, `patch`
 * and `action`, which is the sort of type that compiles and then fails at the
 * call site with a field that should have been there.
 */
type WithoutIdentity<T> = T extends unknown
  ? Omit<T, 'id' | 'createdAt'>
  : never;

export type NewLearningProposal = WithoutIdentity<LearningProposal>;

export interface LearningProposalStoreOptions {
  file: string;
  now?: () => Date;
}

/**
 * What a proposal is *about*, in a form a refusal can match.
 *
 * The wording of `reason` changes every time a model writes it, so a lesson
 * keyed on that would never fire twice. The subject is stable: a tool has a
 * name, a policy has a patch, a maintenance action has a target.
 */
export function proposalSubject(
  proposal: NewLearningProposal | LearningProposal,
): string {
  switch (proposal.kind) {
    case 'grant':
      return `${proposal.target}:${proposal.name.trim().toLocaleLowerCase()}`;
    case 'policy':
      return `policy:${JSON.stringify(proposal.patch)}`;
    case 'maintenance':
      return `${proposal.action}:${proposal.target.trim().toLocaleLowerCase()}`;
  }
}

export class LearningProposalStore {
  private cache: LearningFile | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly now: () => Date;

  constructor(private readonly options: LearningProposalStoreOptions) {
    this.now = options.now ?? (() => new Date());
  }

  /**
   * The proposals and lessons.
   *
   * Lenient: an unreadable file answers as empty so the window still opens. The
   * write path is the strict one, and it refuses rather than repairing.
   */
  async load(): Promise<LearningFile> {
    if (this.cache) {
      return this.cache;
    }
    const read = await readVersionedDocument(this.options.file, READ_OPTIONS);
    if (read.state === 'too-new') {
      throw new DocumentTooNewError(
        'The learning proposals file',
        read.found,
        read.supported,
      );
    }
    if (read.state === 'current' || read.state === 'migrated') {
      const parsed = learningFileSchema.safeParse(read.document);
      if (parsed.success) {
        this.cache = parsed.data;
        return parsed.data;
      }
    }
    this.cache = emptyLearningFile();
    return this.cache;
  }

  /** Adds a proposal unless a lesson or a waiting one already covers it. */
  async record(input: NewLearningProposal): Promise<LearningFile> {
    return await this.mutate((current) => {
      const subject = proposalSubject(input);
      const refused = current.lessons.some(
        (lesson) =>
          lesson.profileId === input.profileId &&
          lesson.kind === input.kind &&
          lesson.summary === subject,
      );
      if (refused) {
        return current;
      }
      const waiting = current.proposals.some(
        (proposal) =>
          proposal.profileId === input.profileId &&
          proposalSubject(proposal) === subject,
      );
      if (waiting) {
        return current;
      }

      const proposal = {
        ...input,
        id: randomUUID(),
        createdAt: this.now().toISOString(),
      } as LearningProposal;
      /*
       * Capped by dropping the oldest. The newest suggestion is about the
       * conversation the user has just had; a queue nobody scrolls is not a
       * queue.
       */
      const combined = [...current.proposals, proposal];
      return {
        ...current,
        proposals:
          combined.length > MAX_PENDING_LEARNING
            ? combined.slice(combined.length - MAX_PENDING_LEARNING)
            : combined,
      };
    });
  }

  /**
   * Removes one proposal, and records the refusal when that is what it was.
   *
   * One write rather than two calls, for the reason the memory store does the
   * same: a crash between "removed" and "refused" would let the next turn ask
   * again, which is the behaviour the lesson exists to stop.
   */
  async remove(proposalId: string, dismissed = false): Promise<LearningFile> {
    return await this.mutate((current) => {
      const proposal = current.proposals.find(
        (entry) => entry.id === proposalId,
      );
      if (proposal === undefined) {
        return current;
      }
      const lessons = dismissed
        ? withLesson(
            current.lessons,
            {
              profileId: proposal.profileId,
              kind: proposal.kind,
              summary: proposalSubject(proposal),
            },
            this.now(),
          )
        : current.lessons;
      return {
        ...current,
        proposals: current.proposals.filter(
          (entry) => entry.id !== proposalId,
        ),
        lessons,
      };
    });
  }

  /** The refusals one bot should stop repeating. */
  async lessonsFor(profileId: string): Promise<LearningLesson[]> {
    const file = await this.load();
    return file.lessons.filter((lesson) => lesson.profileId === profileId);
  }

  /** Forgets every refusal, so the bot may ask again. */
  async clearLessons(): Promise<LearningFile> {
    return await this.mutate((current) => ({...current, lessons: []}));
  }

  /** Forgets a conversation's proposals, for when it is deleted. */
  async forget(sessionId: string): Promise<LearningFile> {
    return await this.mutate((current) => ({
      ...current,
      proposals: current.proposals.filter(
        (proposal) => proposal.sessionId !== sessionId,
      ),
    }));
  }

  /** Forgets a bot: what it asked for, and what the user turned down. */
  async forgetProfile(profileId: string): Promise<LearningFile> {
    return await this.mutate((current) => ({
      ...current,
      proposals: current.proposals.filter(
        (proposal) => proposal.profileId !== profileId,
      ),
      lessons: current.lessons.filter(
        (lesson) => lesson.profileId !== profileId,
      ),
    }));
  }

  private async mutate(
    edit: (current: LearningFile) => LearningFile,
  ): Promise<LearningFile> {
    return await this.withLock(async () => {
      return await withFileLock(`${this.options.file}.lock`, async () => {
        /*
         * Refused before anything is written. The lenient read above is what
         * lets the window open with a file this build cannot read; writing over
         * it would be the data loss that leniency is not allowed to cause.
         */
        await assertWritable(this.options.file, READ_OPTIONS);

        const current = await this.load();
        const next = edit(current);
        const validated = learningFileSchema.safeParse(next);
        if (!validated.success) {
          const detail = validated.error.issues
            .map((issue) => issue.path.join('.') || issue.message)
            .join('; ');
          throw new Error(
            `Refusing to store an invalid learning document: ${detail}`,
          );
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

/**
 * The lessons with one more on the end.
 *
 * Deduped on the subject within the profile, and capped by dropping the oldest,
 * which is the same judgement as the memory refusals: a repeated no is one no,
 * and the one from a year ago is the one most likely to be about a bot that has
 * since changed.
 */
function withLesson(
  existing: readonly LearningLesson[],
  lesson: {profileId: string; kind: LearningLesson['kind']; summary: string},
  now: Date,
): LearningLesson[] {
  const kept = existing.filter(
    (entry) =>
      !(
        entry.profileId === lesson.profileId &&
        entry.kind === lesson.kind &&
        entry.summary === lesson.summary
      ),
  );
  kept.push({
    id: randomUUID(),
    ...lesson,
    at: now.toISOString(),
  });
  return kept.length > MAX_LESSONS
    ? kept.slice(kept.length - MAX_LESSONS)
    : kept;
}
