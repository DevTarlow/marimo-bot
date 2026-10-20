/**
 * What the memory review has read, what it refused, and what could not be written.
 *
 * The **watermark** is the part that decides whether the feature is usable. It
 * records how many events of each conversation have been reviewed, so going idle
 * twice does not review the same exchange twice. A queue that refills itself with
 * things the user has already dismissed is one they stop opening, and a reviewer
 * that re-reads the same conversation forever is a model call nobody asked for.
 *
 * **Proposals are no longer the ordinary path.** A review writes its fact and
 * this store keeps no card for it. An entry still lands here in two cases: a
 * write that failed, so the fact is not silently lost, and an older build's queue
 * that has not been applied yet. Both are answers the person can still give.
 *
 * Versioned and locked like every other document here: it holds decisions the
 * user has not made yet, and a newer build's file must not be overwritten by
 * this one.
 */
import {randomUUID} from 'node:crypto';
import {mkdir, rename, writeFile} from 'node:fs/promises';
import {dirname} from 'node:path';

import {
  emptyMemoryProposals,
  memoryProposalsFileSchema,
} from '@marimo/protocol';
import type {
  DismissedMemory,
  MemoryProposal,
  MemoryProposalsFile,
} from '@marimo/protocol';

import {withFileLock} from './lock.js';
import {
  assertWritable,
  DocumentTooNewError,
  readVersionedDocument,
} from '@marimo/agent';
import type {DocumentMigration, ReadVersionedOptions} from '@marimo/agent';

/** How many proposals may wait at once. */
export const MAX_PENDING_PROPOSALS = 50;

/**
 * How many refusals are kept.
 *
 * Generous, because this is the half that makes the reviewer improve and a user
 * who says no forty times in a month is a user the feature is working for. A cap
 * at all because the list is read on every review and written on every refusal,
 * and a document that grows forever is one that eventually slows down the thing
 * that is supposed to be cheap. Past the cap the oldest go, which is the right
 * end to drop: a refusal is a statement about the reviewer's judgement at the
 * time, and the one from a phase the user has moved past is the one most likely
 * to be wrong now.
 */
export const MAX_DISMISSED = 200;

/**
 * The version this file writes, and the reason it is not `DOCUMENT_VERSION`.
 *
 * The shared constant is one number for every document because one release reads
 * them all — but this document moved to 2 while the rest are still 1, and saying
 * so is the whole point. It is what makes an older build refuse this file rather
 * than parse it, drop the one field it does not know, and write the refusals away.
 */
export const PROPOSALS_VERSION = 2;

/**
 * Version 1 to version 2: the refusals arrived.
 *
 * A migration rather than a default, even though the field it adds is a list, so
 * that a version 1 file is *upgraded and rewritten* rather than merely tolerated.
 * The difference matters the moment somebody goes back to an older build: an
 * upgraded file carries version 2 and is refused, while a tolerated one still
 * looks like version 1 and is overwritten.
 */
const ADD_DISMISSED: DocumentMigration = {
  from: 1,
  to: 2,
  summary: 'started recording the facts the user refused',
  migrate: (document) => ({...document, dismissed: []}),
};

const READ_OPTIONS: ReadVersionedOptions = {
  label: 'The memory proposals file',
  current: PROPOSALS_VERSION,
  migrations: [ADD_DISMISSED],
};

export interface MemoryProposalStoreOptions {
  file: string;
  now?: () => Date;
}

/** A proposal about to be recorded, before it has an id or a time. */
export interface NewProposal {
  sessionId: string | null;
  profileId: string;
  section: string;
  text: string;
  reason: string;
  /** The existing bullet this fact corrects, when the reviewer noticed one. */
  replaces?: string;
  /** The conversation words the reviewer checked the fact against. */
  evidence?: {quote: string; turnId?: string};
}

export class MemoryProposalStore {
  private cache: MemoryProposalsFile | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly now: () => Date;

  constructor(private readonly options: MemoryProposalStoreOptions) {
    this.now = options.now ?? (() => new Date());
  }

  /**
   * The proposals waiting, and how far each conversation has been reviewed.
   *
   * Lenient: a file that cannot be read answers as empty so the window still
   * opens. Only the write path has to be strict, and it is.
   */
  async load(): Promise<MemoryProposalsFile> {
    if (this.cache) {
      return this.cache;
    }
    const read = await readVersionedDocument(this.options.file, READ_OPTIONS);
    if (read.state === 'too-new') {
      throw new DocumentTooNewError(
        'The memory proposals file',
        read.found,
        read.supported,
      );
    }
    if (read.state === 'current' || read.state === 'migrated') {
      const parsed = memoryProposalsFileSchema.safeParse(read.document);
      if (parsed.success) {
        this.cache = parsed.data;
        return parsed.data;
      }
    }
    this.cache = emptyMemoryProposals();
    return this.cache;
  }

  /**
   * How many events of a conversation have already been reviewed.
   *
   * The caller compares this against the stored conversation to decide what is
   * new. Kept here rather than in the caller because it has to survive a
   * restart: reviewing the same exchange on every launch is the behaviour this
   * exists to prevent.
   */
  async reviewedUpTo(sessionId: string): Promise<number> {
    const file = await this.load();
    return file.reviewed[sessionId] ?? 0;
  }

  /** Adds proposals, and moves the watermark, in one write. */
  async record(
    sessionId: string,
    reviewed: number,
    proposals: readonly NewProposal[],
  ): Promise<MemoryProposalsFile> {
    return await this.mutate((current) => {
      const existing = new Set(
        current.proposals.map(
          (proposal) => `${proposal.profileId}\u0000${proposal.text}`,
        ),
      );

      const added: MemoryProposal[] = [];
      for (const proposal of proposals) {
        const key = `${proposal.profileId}\u0000${proposal.text}`;
        // A proposal already waiting is not added again. The reviewer filters
        // against memory.md; this filters against the queue, which is the other
        // way the same fact arrives twice.
        if (existing.has(key)) {
          continue;
        }
        existing.add(key);
        added.push({
          id: randomUUID(),
          ...proposal,
          createdAt: this.now().toISOString(),
        });
      }

      /*
       * Capped by dropping the *oldest*. A queue that grows without bound is one
       * nobody scrolls, and the newest suggestions are the ones about the
       * conversation the user has just had.
       */
      const combined = [...current.proposals, ...added];
      const kept =
        combined.length > MAX_PENDING_PROPOSALS
          ? combined.slice(combined.length - MAX_PENDING_PROPOSALS)
          : combined;

      return {
        version: PROPOSALS_VERSION,
        proposals: kept,
        // Moved whether or not anything was proposed: "I looked and found
        // nothing" is the answer most of the time, and not recording it means
        // looking again on every idle moment forever.
        reviewed: {...current.reviewed, [sessionId]: reviewed},
        // Carried rather than rebuilt: this write is about the queue and the
        // watermark, and a record function that dropped the refusals would make
        // every review quietly undo every "no" the user had given.
        dismissed: current.dismissed,
      };
    });
  }

  /**
   * Remembers that the user refused something.
   *
   * Stored with the profile rather than globally: one agent's no is not
   * another's, and a fact a user refused in their work agent may be exactly what
   * they want their personal one to know. Deduped on the text alone within that
   * profile, because refusing the same phrasing twice is one refusal — the
   * timestamps would differ and nothing else would.
   */
  async dismiss(dismissal: {
    profileId: string;
    text: string;
  }): Promise<MemoryProposalsFile> {
    const text = dismissal.text.trim();
    if (text.length === 0) {
      return await this.load();
    }
    return await this.mutate((current) => ({
      ...current,
      dismissed: withRefusal(
        current.dismissed,
        dismissal.profileId,
        text,
        this.now(),
      ),
    }));
  }

  /**
   * Forgets every refusal, so the reviewer may propose them again.
   *
   * The undo for the whole feature, and deliberately total rather than
   * per-entry: the list exists to make the reviewer quieter, and a user clearing
   * it is saying the reviewer's judgement was being held back by decisions they
   * no longer stand behind. Restoring them one at a time would mean scrolling a
   * list of things they already read and refused.
   */
  async clearDismissed(): Promise<MemoryProposalsFile> {
    return await this.mutate((current) => ({...current, dismissed: []}));
  }

  /**
   * Removes one proposal, and records the refusal when that is what it was.
   *
   * The two happen in one write rather than two calls from the caller, because
   * they are one decision and the store is the only thing that can make them
   * atomic: a crash between "removed from the queue" and "remembered as refused"
   * would leave the suggestion gone and its refusal unrecorded, so the next
   * review would propose it again — which is the behaviour this exists to stop.
   *
   * `dismissed` is absent for an acceptance. Nothing is recorded there, because
   * the fact lands in `memory.md` and the reviewer already filters against that:
   * a second list of things the user said *yes* to would be a copy of the memory
   * file, free to drift from it.
   */
  async remove(
    proposalId: string,
    dismissed?: {profileId: string; text: string},
  ): Promise<MemoryProposalsFile> {
    const text = dismissed?.text.trim() ?? '';
    return await this.mutate((current) => ({
      ...current,
      proposals: current.proposals.filter(
        (proposal) => proposal.id !== proposalId,
      ),
      ...(dismissed === undefined || text.length === 0
        ? {}
        : {
            dismissed: withRefusal(
              current.dismissed,
              dismissed.profileId,
              text,
              this.now(),
            ),
          }),
    }));
  }

  /** Forgets a conversation's watermark, for when it is deleted. */
  async forget(sessionId: string): Promise<MemoryProposalsFile> {
    return await this.mutate((current) => {
      const reviewed = {...current.reviewed};
      delete reviewed[sessionId];
      return {
        ...current,
        reviewed,
        proposals: current.proposals.filter(
          (proposal) => proposal.sessionId !== sessionId,
        ),
      };
    });
  }

  /**
   * Forgets a bot: what it was about to remember, and what the user turned down.
   *
   * By profile rather than by conversation, because a proposal can be recorded
   * with no conversation at all — and a dismissal never had one. Both are keyed
   * by a profile id that nothing will name again once the bot is gone, so
   * leaving them is keeping a suggestion the app can never show.
   */
  async forgetProfile(profileId: string): Promise<MemoryProposalsFile> {
    return await this.mutate((current) => ({
      ...current,
      proposals: current.proposals.filter(
        (proposal) => proposal.profileId !== profileId,
      ),
      dismissed: current.dismissed.filter(
        (dismissal) => dismissal.profileId !== profileId,
      ),
    }));
  }

  private async mutate(
    edit: (current: MemoryProposalsFile) => MemoryProposalsFile,
  ): Promise<MemoryProposalsFile> {
    return await this.withLock(async () => {
      /*
       * The filesystem lock as well as the queue above, because the queue is
       * only this process's. A review running while the app writes its own
       * dismissals would otherwise lose one of the two.
       */
      return await withFileLock(`${this.options.file}.lock`, async () => {
        /*
         * Refused before anything is written. A lenient read plus a write is
         * how a user's data disappears, and the leniency above is deliberate —
         * it is what lets the window open with an unreadable file rather than
         * refusing to start.
         */
        await assertWritable(this.options.file, READ_OPTIONS);

        const current = await this.load();
        const next = edit(current);
        const validated = memoryProposalsFileSchema.safeParse(next);
        if (!validated.success) {
          const detail = validated.error.issues
            .map((issue) => issue.path.join('.') || issue.message)
            .join('; ');
          throw new Error(
            `Refusing to store an invalid proposals document: ${detail}`,
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
 * The refusals, with one more on the end.
 *
 * Deduped on the text within the profile and capped by dropping the oldest, which
 * is the same judgement twice: a list read on every review has to stay small, and
 * the refusal a user has moved past is the one at the front.
 */
function withRefusal(
  existing: readonly DismissedMemory[],
  profileId: string,
  text: string,
  now: Date,
): DismissedMemory[] {
  const kept = existing.filter(
    (entry) =>
      !(
        entry.profileId === profileId &&
        comparable(entry.text) === comparable(text)
      ),
  );
  kept.push({profileId, text, at: now.toISOString()});
  return kept.length > MAX_DISMISSED
    ? kept.slice(kept.length - MAX_DISMISSED)
    : kept;
}

/**
 * Lowercased with every run of whitespace reduced to one space.
 *
 * The same comparison `isNewProposal` makes when it decides whether a proposal is
 * one memory already holds. A refusal is recognised by the same rule for the same
 * reason: a model that re-proposed the fact with different spacing said the same
 * thing, and holding both is holding one refusal twice.
 */
function comparable(text: string): string {
  return text.trim().toLowerCase().replaceAll(/\s+/gu, ' ');
}
