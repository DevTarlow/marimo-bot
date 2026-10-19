/**
 * What the user said about the agent's own answers.
 *
 * This is the smallest store in the app and it closes the largest gap. The agent
 * could already be told a fact, corrected on a fact, and asked to stop
 * suggesting something — but there was no way to say *that answer was wrong*.
 * That is the difference between a memory and a relationship: a fact is
 * something the agent knows, and "you had that wrong, it is like this" is the
 * thing that makes the next answer better.
 *
 * Three decisions shape it.
 *
 * **It holds the user's words, not the agent's judgement.** `correction` is
 * whatever they typed, verbatim and bounded. Nothing infers what they meant,
 * nothing rewrites it, and nothing here ever writes to memory directly — the
 * correction reaches the *review*, which proposes a fact, which the user still
 * accepts. A channel that could write memory would be a way to put a wrong belief
 * into every future prompt with one tap.
 *
 * **The excerpt is what the agent said, capped.** It travels to the reviewer so
 * a correction reads as being about an answer rather than floating free, and it
 * is capped because a stored answer can be any length and this one ends up in a
 * prompt.
 *
 * **It is capped, and oldest goes first.** A hundred corrections is a person who
 * uses the feature; a thousand is a document that slows down the thing it exists
 * to make cheap, and the ones from a year ago are about an agent that has since
 * been told.
 *
 * Versioned and locked like every other document here, and read leniently so a
 * corrupt file cannot stop the window opening.
 */
import {randomUUID} from 'node:crypto';
import {mkdir, rename, writeFile} from 'node:fs/promises';
import {dirname} from 'node:path';

import {emptyFeedbackFile, feedbackFileSchema, MAX_FEEDBACK_ENTRIES} from '@marimo/protocol';
import type {FeedbackEntry, FeedbackFile} from '@marimo/protocol';

import {
  assertWritable,
  DocumentTooNewError,
  quarantineDocument,
  readVersionedDocument,
} from '@marimo/agent';
import type {ReadVersionedOptions} from '@marimo/agent';

import {withFileLock} from './lock.js';

/** The version this store writes. The document is new, so there is no migration. */
export const FEEDBACK_VERSION = 1;

const READ_OPTIONS: ReadVersionedOptions = {
  label: 'The feedback file',
  current: FEEDBACK_VERSION,
  migrations: [],
};

/** What the caller has to hand over to record one. */
export interface NewFeedback {
  profileId: string;
  sessionId: string;
  messageId: string;
  /** The turn the message was, when the caller knows it. See the schema. */
  invocationId?: string;
  excerpt: string;
  correction?: string;
}

export class FeedbackStore {
  private cache: FeedbackFile | undefined;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: {file: string; now?: () => Date}) {}

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  /**
   * Everything on record, newest last.
   *
   * Lenient by design: an unreadable file answers as empty so the window still
   * opens, and only the write path is strict.
   */
  async load(): Promise<FeedbackFile> {
    if (this.cache) {
      return this.cache;
    }
    const read = await readVersionedDocument(this.options.file, READ_OPTIONS);
    if (read.state === 'too-new') {
      throw new DocumentTooNewError(
        'The feedback file',
        read.found,
        read.supported,
      );
    }
    if (read.state === 'current' || read.state === 'migrated') {
      const parsed = feedbackFileSchema.safeParse(read.document);
      if (parsed.success) {
        this.cache = parsed.data;
        return parsed.data;
      }
    }
    this.cache = emptyFeedbackFile();
    return this.cache;
  }

  /**
   * One profile's corrections, oldest first.
   *
   * Scoped to the profile because a correction is about *this* agent's answer:
   * one agent being told it was wrong about a deployment is not a fact about the
   * other one, and a shared list would have every agent apologising for
   * something it never said.
   */
  async forProfile(profileId: string, limit = MAX_FEEDBACK_ENTRIES): Promise<FeedbackEntry[]> {
    const file = await this.load();
    const mine = file.entries.filter((entry) => entry.profileId === profileId);
    return mine.slice(Math.max(0, mine.length - limit));
  }

  /**
   * One conversation's corrections, oldest first.
   *
   * Not narrowed by profile, unlike `forProfile`, because the question here is
   * about a conversation rather than an agent: the window records a correction
   * under the *active* profile, and a transcript read for the conversation's own
   * owner would then miss a note the user plainly made on that very message. A
   * session id is one conversation, and that is the narrower, more truthful scope
   * for "was this answer marked wrong".
   */
  async forSession(
    sessionId: string,
    limit = MAX_FEEDBACK_ENTRIES,
  ): Promise<FeedbackEntry[]> {
    const file = await this.load();
    const mine = file.entries.filter((entry) => entry.sessionId === sessionId);
    return mine.slice(Math.max(0, mine.length - limit));
  }

  /** Records one, dropping the oldest past the cap. */
  async record(entry: NewFeedback): Promise<FeedbackFile> {
    const correction = (entry.correction ?? '').trim().slice(0, 400);
    return await this.mutate((current) => {
      const added: FeedbackEntry = {
        id: randomUUID(),
        profileId: entry.profileId,
        sessionId: entry.sessionId,
        messageId: entry.messageId,
        ...(entry.invocationId === undefined
          ? {}
          : {invocationId: entry.invocationId}),
        excerpt: entry.excerpt.trim().slice(0, 400),
        correction,
        createdAt: this.now().toISOString(),
      };
      const combined = [...current.entries, added];
      return {
        version: FEEDBACK_VERSION,
        entries:
          combined.length > MAX_FEEDBACK_ENTRIES
            ? combined.slice(combined.length - MAX_FEEDBACK_ENTRIES)
            : combined,
      };
    });
  }

  /**
   * Forgets everything.
   *
   * Total rather than per-entry, for the reason `clearDismissed` is: the list
   * exists to make the reviewer quieter, and clearing it is a person saying those
   * judgements no longer hold. Deleting them one at a time would mean scrolling a
   * list of things they already read.
   */
  async clear(): Promise<FeedbackFile> {
    return await this.mutate(() => emptyFeedbackFile());
  }

  /**
   * Forgets one bot's corrections, for when the bot is removed.
   *
   * Kept rather than cleared wholesale: the other bots' corrections are still
   * about conversations that exist, and a removal is not a request to forget
   * everybody's.
   */
  async forgetProfile(profileId: string): Promise<FeedbackFile> {
    return await this.mutate((current) => ({
      ...current,
      entries: current.entries.filter(
        (entry) => entry.profileId !== profileId,
      ),
    }));
  }

  private async mutate(
    edit: (current: FeedbackFile) => FeedbackFile,
  ): Promise<FeedbackFile> {
    const run = this.queue.then(async () => {
      /*
       * The filesystem lock as well as the queue above, because the queue is only
       * this process's: the window records a correction while a headless run
       * could be reading the same file.
       */
      return await withFileLock(`${this.options.file}.lock`, async () => {
        /*
         * Refused before anything is written. The read above is lenient so the
         * window opens; a lenient read plus an unguarded write is how a user's
         * data disappears.
         */
        await assertWritable(this.options.file, READ_OPTIONS);
        /*
         * And a file nothing can read is moved aside rather than written over.
         * The read above is lenient so the window opens with a corrupt file; that
         * leniency plus an unguarded write is exactly how the evidence of what
         * went wrong disappears. The suffix is discoverable and bounded, and the
         * write below proceeds either way — this is a courtesy to whoever comes
         * looking, not a precondition.
         */
        const state = await readVersionedDocument(
          this.options.file,
          READ_OPTIONS,
        );
        if (state.state === 'unreadable') {
          await quarantineDocument(this.options.file);
        }

        const next = edit(await this.load());
        const validated = feedbackFileSchema.safeParse(next);
        if (!validated.success) {
          const detail = validated.error.issues
            .map((issue) => issue.path.join('.') || issue.message)
            .join('; ');
          throw new Error(
            `Refusing to store an invalid feedback document: ${detail}`,
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
    // Keep the chain alive even when a task rejects.
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return await run;
  }
}
