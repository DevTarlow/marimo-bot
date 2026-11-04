/**
 * Recall, as a caller uses it: ask a question, get lines back.
 *
 * This is the seam between the *process* that produces vectors and the things
 * that want them — the agent's tool, the window's search box, the memory block
 * that goes into a prompt. All three want the same three answers, so all three go
 * through here: which corpora exist, what a query found, and whether what was
 * found is still true.
 *
 * Three decisions in this file are worth reading before changing anything.
 *
 * **A search refreshes first.** Not on a timer and not behind a button: the
 * moment a caller asks a question, whatever changed since the last time is
 * brought up to date, within a budget, and the answer says what that cost
 * (`coverage`). A query against an index nobody has built is useless, and a query
 * against one built last week answers confidently about a folder that has moved
 * on.
 *
 * **A hit is verified, not trusted.** Each of the handful of results is read back
 * from its source and checked against the digest stored with its vector. That is
 * why a hit can carry its own text, and why a file that changed *between* the
 * refresh and the read is reported as `stale` rather than quoted from a copy that
 * no longer exists.
 *
 * **Memory is a corpus, not a special case.** It is indexed the same way, scored
 * in the same space, and returned through the same shape — which is the point of
 * the whole feature: a question about the user and a question about their code
 * are the same kind of question.
 */
import {readFile, stat} from 'node:fs/promises';
import {join, sep} from 'node:path';

import {splitMemory} from '@marimo/agent';

import {chunkText} from './chunk.js';
import type {TextChunk} from './chunk.js';
import {renderConversationText} from './conversations.js';
import type {
  ConversationEvent,
  ConversationWatermarkStore,
} from './conversations.js';
import {refreshIndex} from './indexer.js';
import type {
  ConversationSource,
  IndexCoverage,
  MediaSource,
} from './indexer.js';
import type {MediaKind} from './media.js';
import {documentText, queryText} from './prefixes.js';
import {DEFAULT_LIMIT, MAX_LIMIT, searchVectors} from './search.js';
import type {SearchHit} from './search.js';
import {
  INDEX_FILE,
  digestOf,
  previewOf,
  readIndex,
  removeIndex,
  writeIndex,
} from './store.js';
import type {FileStamp, IndexModel, IndexRecord} from './store.js';

/** The corpora this app can search. */
export type RecallScope = 'folder' | 'memory' | 'conversation' | 'media';

/** One hit, with its text read back and checked. */
export interface RecallHit {
  kind: 'text' | 'memory' | 'conversation' | 'media';
  /** Path relative to the folder, or `''` for a memory bullet. */
  path: string;
  /** Text only: the first and last line, 1-based and inclusive. */
  startLine?: number;
  endLine?: number;
  /** Memory only: the `##` heading the bullet lives under. */
  section?: string;
  /** Conversation only: which chat this passage came from. */
  sessionId?: string;
  /** Conversation only: the chat's title at the time it was indexed. */
  title?: string;
  /** Media only: which decoder produced this vector. */
  mediaKind?: MediaKind;
  preview: string;
  /** Cosine similarity against the query. */
  score: number;
  /** The text itself, current as of the read that verified it. */
  text: string;
  /**
   * True when the source no longer matches what was indexed.
   *
   * The hit is still returned, with its preview and no text: the file it came
   * from still has something worth looking at, and dropping it entirely would be
   * a search that finds nothing because somebody edited the wrong line.
   */
  stale: boolean;
}

export interface RecallQuery {
  query: string;
  /** Which corpora to search; absent means all of them. */
  scopes?: readonly RecallScope[];
  limit?: number;
  /**
   * The score a hit has to reach to come back at all.
   *
   * Absent means the index's own floor, which is what makes "nothing found" a
   * possible answer to a search. `0` is the other question a caller can ask —
   * what is nearest, whatever it scores — and it is how the window shows the
   * results a floor withheld.
   */
  minScore?: number;
}

export interface RecallIndexStatus {
  /** When the index was last written. */
  builtAt?: string;
  /** Vectors in it, and how they split. */
  records: number;
  chunks: number;
  memory: number;
  conversations: number;
  media: number;
  /** Files whose stamp no longer matches what was indexed. */
  changed: number;
}

/**
 * Whether the memory vectors describe the memory file as it is now.
 *
 * Three fields rather than a boolean, because the three states a caller might
 * want to say are different sentences: nothing has been indexed at all, memory
 * was indexed and has changed since, and memory is current.
 */
export interface MemoryIndexState {
  /** Memory vectors in the index. */
  vectors: number;
  /** Whether an index exists. False means nothing has been built here yet. */
  index: boolean;
  /** Whether the file has changed since its bullets were embedded. */
  behind: boolean;
}

export interface RecallAnswer {
  hits: RecallHit[];
  /** The corpora that were actually searched. */
  searched: RecallScope[];
  /** What the refresh on the way here did. */
  coverage: IndexCoverage;
  index: RecallIndexStatus;
  /** Anything the caller should be told, in sentences. */
  notes: string[];
}

export interface RecallServiceOptions {
  /** The folder being indexed. Absent means there is no folder corpus. */
  workspaceRoot?: string;
  /** Where the index lives — `<workspace>/.marimo/<profile>/recall`. */
  dir: string;
  /** The model that is pinned now; an index from another one is rebuilt. */
  model: IndexModel;
  /** Turns text into vectors. */
  embed: (texts: readonly string[]) => Promise<{vectors: Float32Array[]}>;
  /**
   * Gets the engine up without embedding anything.
   *
   * Separate from `embed` because the caller who wants it is warming rather than
   * asking: loading 310 MB of weights is seconds, which does not fit inside a
   * turn's retrieval deadline, so it has to happen at a moment somebody chose
   * rather than one they were waiting on.
   */
  warm?: () => Promise<void>;
  /**
   * The agent's memory file, read by whoever knows where it lives.
   *
   * Injected rather than derived, because memory's location is the
   * `MemoryStore`'s business and a second derivation here would be a second
   * opinion about which file the agent's memory is in.
   */
  readMemory?: () => Promise<string>;
  /**
   * The stored conversations, and how far each has been embedded.
   *
   * Both injected for the reason memory is: where a conversation lives is the
   * session store's business, and a second derivation here would be a second
   * opinion about which chat is which. `watermark` is a *store* rather than a
   * value because it has to survive the process: embedding the same exchange on
   * every search is the cost this exists to avoid.
   */
  conversations?: ConversationSource;
  watermark?: ConversationWatermarkStore;
  /**
   * The media decoder, when this install has the projector.
   *
   * Absent is the same kind of answer as `readMemory` being absent: images,
   * audio and video are not offered as a scope, because an engine without the
   * projector has no encoder for them and a scope that came back empty would be
   * a promise the tool made and broke.
   */
  media?: MediaSource;
  /**
   * Ask questions the model's code way.
   *
   * The user's answer about their folder, since a question cannot say whether it
   * is about prose or about code. Only the query prefix changes.
   */
  codeQueries?: boolean;
  /**
   * Never write: read an index somebody else built.
   *
   * The headless runner's mode. A scheduled job has no user watching it, can be
   * killed at any moment, and must not fight the window over the same files — so
   * it may start the engine to embed a *question* and is refused the refresh that
   * would build an index. With none to read, the search says so rather than
   * quietly reporting that the folder holds nothing.
   */
  readOnly?: boolean;
  /** Caps for one refresh, for a caller that has to answer quickly. */
  maxFiles?: number;
  maxChunks?: number;
  now?: () => Date;
}

export class RecallService {
  /**
   * The pass in flight, shared by everyone who asks for a refresh.
   *
   * A background catch-up after a turn and a search from the window can arrive
   * together, and each refresh reads the index before writing it. Two passes
   * interleaved would each decide what changed from the same stale read and the
   * last write would win. Joining the running pass gives the second caller the
   * same answer a search already gets, one index write instead of two.
   */
  private refreshing: Promise<IndexCoverage> | undefined;

  constructor(private readonly options: RecallServiceOptions) {}

  /**
   * The corpora that can be searched right now.
   *
   * Answered rather than assumed, because a caller that offers a scope the
   * service cannot honour is a search that comes back empty for a reason nobody
   * can see. No folder means no folder corpus; no memory reader means no memory.
   */
  scopes(): RecallScope[] {
    const scopes: RecallScope[] = [];
    const root = this.options.workspaceRoot;
    if (root !== undefined && root.length > 0) {
      scopes.push('folder');
    }
    if (this.options.readMemory !== undefined) {
      scopes.push('memory');
    }
    if (
      this.options.conversations !== undefined &&
      (this.options.readOnly === true || this.options.watermark !== undefined)
    ) {
      /*
       * A read-only service has no watermark because it never writes one, and it
       * does not need one to read: the records are already in the index, and the
       * only thing a watermark decides is what a *refresh* still has to embed.
       */
      scopes.push('conversation');
    }
    if (this.options.media !== undefined) {
      scopes.push('media');
    }
    return scopes;
  }

  /** What is indexed, without refreshing and without embedding anything. */
  async status(): Promise<RecallIndexStatus> {
    const data = await readIndex(this.options.dir, this.options.model);
    if (data === undefined) {
      return {
        records: 0,
        chunks: 0,
        memory: 0,
        conversations: 0,
        media: 0,
        changed: 0,
      };
    }
    return {
      builtAt: data.file.builtAt,
      records: data.file.count,
      chunks: data.file.records.filter((record) => record.kind === 'text')
        .length,
      memory: data.file.records.filter((record) => record.kind === 'memory')
        .length,
      conversations: data.file.records.filter(
        (record) => record.kind === 'conversation',
      ).length,
      media: data.file.records.filter((record) => record.kind === 'media')
        .length,
      changed: await this.changedCount(data.file.files),
    };
  }

  /**
   * Bring the index up to date, then answer the question.
   *
   * The order is the design: ranking first would answer about a folder from
   * before the change that prompted the question.
   */
  async search(request: RecallQuery): Promise<RecallAnswer> {
    const available = this.scopes();
    const wanted = available.filter(
      (scope) => request.scopes === undefined || request.scopes.includes(scope),
    );
    const notes: string[] = [];
    const empty: IndexCoverage = {
      files: 0,
      evicted: 0,
      chunks: 0,
      memory: 0,
      conversations: 0,
      media: 0,
      embedded: 0,
      pending: 0,
      pendingConversations: 0,
      truncated: false,
      skipped: 0,
    };

    const query = request.query.trim();
    if (query.length === 0 || wanted.length === 0) {
      return {
        hits: [],
        searched: [],
        coverage: empty,
        index: await this.status(),
        notes:
          wanted.length === 0 ? ['Nothing is available to search yet.'] : [],
      };
    }

    let coverage = empty;
    if (this.options.readOnly === true) {
      /*
       * The runner's path: no refresh, and the sentence that says why. Reported
       * before ranking so that "found nothing" is never mistaken for "read
       * nothing".
       */
      const existing = await readIndex(this.options.dir, this.options.model);
      if (existing === undefined || existing.file.count === 0) {
        notes.push(
          'Nothing is indexed for this space yet, and a scheduled run does not ' +
            'build an index. Open the app and search once.',
        );
        return {
          hits: [],
          searched: wanted,
          coverage: empty,
          index: await this.status(),
          notes,
        };
      }
    } else {
      try {
        coverage = await this.refresh();
        if (coverage.truncated) {
          /*
           * Two budgets can stop a refresh, and they mean different things: a
           * folder still being sliced, and conversations whose newest exchange has
           * not been embedded yet. Saying "the folder is large" about a chat would
           * send the reader looking in the wrong place.
           */
          notes.push(
            'The index is built in slices, and ' +
              `${String(coverage.pending)} file(s) and ` +
              `${String(coverage.pendingConversations)} conversation(s) are not ` +
              'indexed yet. Ask again to continue.',
          );
        }
        if (coverage.skipped > 0) {
          notes.push(
            `${String(coverage.skipped)} file(s) could not be read or embedded.`,
          );
        }
        if (coverage.evicted > 0) {
          /*
           * Said out loud, because the alternative is a search that answers about
           * part of a folder while reading as though it read all of it.
           */
          notes.push(
            `The index is full, so ${String(coverage.evicted)} file(s) were dropped ` +
              'to stay within it. The ones kept are the most recently changed.',
          );
        }
      } catch (failure) {
        /*
         * A folder that cannot be indexed is not a search that failed. Memory may
         * still be searchable, and the sentence says which half is missing rather
         * than reporting "no results" for both.
         */
        notes.push(`The space could not be indexed: ${describe(failure)}.`);
      }
    }

    const data = await readIndex(this.options.dir, this.options.model);
    const index = await this.status();
    if (data === undefined || data.file.count === 0) {
      return {hits: [], searched: wanted, coverage, index, notes};
    }

    const answer = await this.options.embed([
      queryText(query, this.options.codeQueries === true ? 'code' : 'search'),
    ]);
    const vector = answer.vectors[0];
    if (vector === undefined) {
      notes.push('The question could not be turned into a vector.');
      return {hits: [], searched: wanted, coverage, index, notes};
    }

    /*
     * Ranked over the whole index and filtered afterwards, rather than ranking a
     * filtered copy: the record order *is* the vector order, so a filter that
     * renumbered anything would attach every score to the wrong text.
     */
    const limit = Math.min(request.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
    const ranked = searchVectors({
      vectors: data.vectors,
      dims: data.file.model.dims,
      records: data.file.records,
      query: vector,
      limit,
      ...(request.minScore === undefined ? {} : {minScore: request.minScore}),
    }).filter((hit) => wanted.includes(scopeOf(hit)));

    const hits: RecallHit[] = [];
    /*
     * Memory is read once for the whole answer rather than once per hit. A search
     * that returns eight memory bullets would otherwise read and split the same
     * file eight times — and the file a caller is most likely to have just
     * written is the one where that cost is paid inside a turn's retrieval
     * deadline.
     */
    const memory =
      this.options.readMemory === undefined
        ? ''
        : await this.options.readMemory();
    for (const hit of ranked) {
      hits.push(await this.read(hit, memory));
    }

    /*
     * Why the list is empty, when it is because of the floor.
     *
     * "Nothing found" and "nothing near enough" are different answers and a
     * caller acts on them differently: the first says the words are not in the
     * folder, the second says the folder has something and this question did not
     * reach it. So the nearest vector is asked for once more, unsifted, and its
     * score is what the sentence carries. The second pass costs one more ranking
     * over an index that is already in memory, and only on the path where there
     * is nothing else to do.
     */
    if (hits.length === 0 && request.minScore !== 0) {
      const nearest = searchVectors({
        vectors: data.vectors,
        dims: data.file.model.dims,
        records: data.file.records,
        query: vector,
        limit,
        minScore: 0,
      }).filter((hit) => wanted.includes(scopeOf(hit)))[0];
      if (nearest !== undefined) {
        notes.push(
          `Nothing was close enough to show as a result: the nearest was ` +
            `${nearest.score.toFixed(2)}.`,
        );
      }
    }

    return {hits, searched: wanted, coverage, index, notes};
  }

  /**
   * Brings the index up to date without answering anything.
   *
   * What the button in the card does, and why it is separate from `search`: a
   * user who has just switched recall on wants the folder indexed *now*, and the
   * honest way to do that is the same bounded refresh a search would have done,
   * with a count at the end instead of a result list.
   */
  async reindex(): Promise<RecallIndexStatus> {
    if (this.options.readOnly === true) {
      /*
       * Read-only is the runner's mode, and it is refused the write for the
       * reason the option documents: a scheduled run has nobody watching it,
       * can be killed mid-write, and must not fight the window over the same
       * files. Answered as a status rather than an error, because "there is
       * nothing for this service to write" is not a failure to report.
       */
      return await this.status();
    }
    await this.refresh();
    return await this.status();
  }

  /** Throws the index away, so the next search builds it again. */
  async forget(): Promise<void> {
    await removeIndex(this.options.dir);
    /*
     * And the watermark with it. Leaving the mark behind would make the rebuild
     * that follows skip every conversation it had already read — the index would
     * come back missing exactly the words the user just asked to be re-embedded,
     * and nothing about the result would say why.
     */
    await this.options.watermark?.save({});
  }

  /**
   * Drops particular conversations from the index, without a rebuild.
   *
   * Used when a conversation is deleted: its vectors describe text that no longer
   * exists, and a search that returned it would quote a chat the user removed.
   * The refresh would drop it on the next pass anyway — a session that is gone is
   * not in the list — but "on the next pass" can be a day away, and a deleted
   * conversation is the one hit that must not come back even once.
   *
   * One index is reached here, because a service is one profile and one folder.
   * Another folder's index for the same profile is settled by its own next
   * refresh, which is the same rule every other deletion in this file follows.
   */
  async forgetSessions(sessionIds: readonly string[]): Promise<void> {
    const ids = new Set(sessionIds);
    if (ids.size === 0) {
      return;
    }

    const data = await readIndex(this.options.dir, this.options.model);
    if (data !== undefined) {
      const dims = data.file.model.dims;
      const records: IndexRecord[] = [];
      const vectors: Float32Array[] = [];
      for (const [at, record] of data.file.records.entries()) {
        const gone =
          record.kind === 'conversation' &&
          record.sessionId !== undefined &&
          ids.has(record.sessionId);
        if (gone) {
          continue;
        }
        records.push(record);
        vectors.push(
          new Float32Array(data.vectors.subarray(at * dims, (at + 1) * dims)),
        );
      }

      if (records.length !== data.file.records.length) {
        const flat = new Float32Array(vectors.length * dims);
        for (const [index, vector] of vectors.entries()) {
          flat.set(vector, index * dims);
        }
        await writeIndex(this.options.dir, {
          file: {
            ...data.file,
            builtAt: (this.options.now?.() ?? new Date()).toISOString(),
            count: records.length,
            records,
          },
          vectors: flat,
        });
      }
    }

    await this.options.watermark?.forget([...ids]);
  }

  /**
   * One refresh at a time, shared by whoever asks for one.
   *
   * The reason is a race rather than a speed: `refreshOnce` reads the index,
   * decides what changed, and writes it back. Two of those interleaved would
   * both decide from the same stale read. A caller who arrives during a pass
   * gets that pass's answer, which is what a search that started a moment
   * earlier would have got anyway.
   */
  private async refresh(): Promise<IndexCoverage> {
    if (this.refreshing !== undefined) {
      return await this.refreshing;
    }
    const run = this.refreshOnce();
    this.refreshing = run;
    try {
      return await run;
    } finally {
      this.refreshing = undefined;
    }
  }

  private async refreshOnce(): Promise<IndexCoverage> {
    const memory =
      this.options.readMemory === undefined
        ? ''
        : await this.options.readMemory();
    const watermark =
      this.options.watermark === undefined
        ? undefined
        : await this.options.watermark.load();
    const result = await refreshIndex({
      workspaceRoot: this.options.workspaceRoot ?? '',
      dir: this.options.dir,
      model: this.options.model,
      embed: this.options.embed,
      memory,
      ...(this.options.conversations === undefined
        ? {}
        : {conversations: this.options.conversations}),
      ...(watermark === undefined ? {} : {watermark}),
      ...(this.options.media === undefined ? {} : {media: this.options.media}),
      ...(this.options.maxFiles === undefined
        ? {}
        : {maxFiles: this.options.maxFiles}),
      ...(this.options.maxChunks === undefined
        ? {}
        : {maxChunks: this.options.maxChunks}),
      ...(this.options.now === undefined ? {} : {now: this.options.now}),
    });
    /*
     * Written *after* the index, which is the commit point. A crash between the
     * two writes leaves a mark that is behind the index, and the next refresh
     * embeds that stretch again — a duplicate vector is untidy. The other order
     * would advance the mark past vectors that were never written, and those
     * words would be missing from the index with nothing to say so.
     */
    await this.options.watermark?.save(result.watermark);
    return result.coverage;
  }

  /**
   * A hit's text, read from its source and checked against the digest.
   *
   * The chunk is found by cutting the file again with the same function that cut
   * it the first time, rather than by arithmetic on offsets: the stored lines
   * describe a range, and the digest was taken over the text of that range. A
   * file that has changed in any way that matters has no chunk at those lines,
   * which is what `stale` reports.
   */
  private async read(hit: SearchHit, memory: string): Promise<RecallHit> {
    const base = {
      kind: hit.kind,
      path: hit.path,
      ...(hit.startLine === undefined ? {} : {startLine: hit.startLine}),
      ...(hit.endLine === undefined ? {} : {endLine: hit.endLine}),
      ...(hit.section === undefined ? {} : {section: hit.section}),
      ...(hit.sessionId === undefined ? {} : {sessionId: hit.sessionId}),
      ...(hit.title === undefined ? {} : {title: hit.title}),
      ...(hit.mediaKind === undefined ? {} : {mediaKind: hit.mediaKind}),
      score: hit.score,
    };

    /*
     * The preview is rendered from the text the read just verified, rather than
     * kept in the index. The index holds positions and digests; the one line a
     * list shows is derived from the source at the moment the source is checked,
     * which is the same moment, and it means the file on disk carries no copy of
     * anybody's code.
     */
    if (hit.kind === 'memory') {
      const bullet = memoryBullets(memory).find(
        (entry) =>
          entry.section === hit.section && digestOf(entry.text) === hit.sha256,
      );
      return bullet === undefined
        ? {...base, preview: '', text: '', stale: true}
        : {
            ...base,
            preview: previewOf(bullet.text),
            text: bullet.text,
            stale: false,
          };
    }

    if (hit.kind === 'conversation') {
      return await this.readConversation(hit, base);
    }

    if (hit.kind === 'media') {
      return await this.readMedia(hit, base);
    }

    const root = this.options.workspaceRoot;
    if (root === undefined || root.length === 0) {
      return {...base, preview: '', text: '', stale: true};
    }
    let text: string;
    try {
      text = await readFile(join(root, hit.path.split('/').join(sep)), 'utf8');
    } catch {
      return {...base, preview: '', text: '', stale: true};
    }
    const chunk = chunkText(text).find(
      (entry) =>
        entry.startLine === hit.startLine &&
        entry.endLine === hit.endLine &&
        digestOf(entry.text) === hit.sha256,
    );
    return chunk === undefined
      ? {...base, preview: '', text: '', stale: true}
      : {
          ...base,
          preview: previewOf(chunk.text),
          text: chunk.text,
          stale: false,
        };
  }

  /**
   * A conversation passage, rendered again from the stored events.
   *
   * The events are re-read and the same stretch re-rendered, and the digest is
   * over that render. A transcript is append-only, so an old range renders
   * exactly as it did — which is what makes a digest of a *derived* text as
   * trustworthy as one of a file's bytes. A range that no longer renders the same
   * is reported as changed rather than quoted, the same answer a file gets.
   */
  private async readConversation(
    hit: SearchHit,
    base: Omit<RecallHit, 'preview' | 'text' | 'stale'>,
  ): Promise<RecallHit> {
    const source = this.options.conversations;
    const sessionId = hit.sessionId;
    if (source === undefined || sessionId === undefined) {
      return {...base, preview: '', text: '', stale: true};
    }

    let read: {title: string; events: readonly ConversationEvent[]} | undefined;
    try {
      read = await source.read(sessionId);
    } catch {
      read = undefined;
    }
    if (read === undefined) {
      return {...base, preview: '', text: '', stale: true};
    }

    const start = Math.max(0, hit.startEvent ?? 0);
    const end = Math.min(
      hit.endEvent ?? read.events.length,
      read.events.length,
    );
    const text = renderConversationText(read.events.slice(start, end));
    return digestOf(text) === hit.sha256
      ? {...base, preview: previewOf(text), text, stale: false}
      : {...base, preview: '', text: '', stale: true};
  }

  /**
   * A media file, checked by the stamp it was embedded from.
   *
   * There is no text to quote, so the hit carries no text and the read is a
   * question rather than an answer: has this file changed since it was indexed?
   * The same size and modification time the incremental refresh trusts are the
   * evidence, which is the honest bound — hashing a clip on every search is the
   * cost this design exists to avoid.
   */
  private async readMedia(
    hit: SearchHit,
    base: Omit<RecallHit, 'preview' | 'text' | 'stale'>,
  ): Promise<RecallHit> {
    const root = this.options.workspaceRoot;
    const label = hit.mediaKind ?? 'media';
    if (root === undefined || root.length === 0) {
      return {
        ...base,
        preview: `[${label}] ${hit.path}`,
        text: '',
        stale: true,
      };
    }
    try {
      const info = await stat(join(root, hit.path.split('/').join(sep)));
      const fresh =
        digestOf(`${String(info.size)}:${String(info.mtimeMs)}`) === hit.sha256;
      return {
        ...base,
        preview: `[${label}] ${hit.path}`,
        text: '',
        stale: !fresh,
      };
    } catch {
      return {
        ...base,
        preview: `[${label}] ${hit.path}`,
        text: '',
        stale: true,
      };
    }
  }

  /**
   * Whether the memory file's bullets are the ones the index holds.
   *
   * The answer a caller needs to say "this fact is not searchable yet" honestly,
   * and the reason it is a question rather than a flag: retrieval refreshes the
   * index on the way through, so the state that matters is always the one on
   * disk right now — the file's digest against the digest the vectors were built
   * from. A tool result that claimed freshness from a flag it set itself would be
   * the one thing worth knowing, guessed at.
   *
   * `vectors` counts the memory records in the index. Zero with `index: false`
   * means no index has been built, which is different from one built before
   * memory.md had anything in it.
   */
  async memoryState(): Promise<MemoryIndexState> {
    if (this.options.readMemory === undefined) {
      return {vectors: 0, behind: false, index: false};
    }
    const memory = await this.options.readMemory();
    const data = await readIndex(this.options.dir, this.options.model);
    if (data === undefined) {
      return {
        vectors: 0,
        behind: memoryBullets(memory).length > 0,
        index: false,
      };
    }
    return {
      vectors: data.file.records.filter((record) => record.kind === 'memory')
        .length,
      behind: data.file.memoryHash !== digestOf(memory),
      index: true,
    };
  }

  /**
   * Brings the embedding engine up, and answers nothing.
   *
   * Called by whoever has just changed memory, so the next turn's refresh is a
   * few hundred milliseconds of embedding rather than seconds of loading behind
   * a retrieval deadline that would give up and inject the whole file instead.
   * Deliberately not a hint about *what* to embed: the refresh a search performs
   * decides that from the file's digest, and a second opinion here would be a
   * second place for the two to disagree.
   */
  async warm(): Promise<void> {
    await this.options.warm?.();
  }

  /** How many indexed files no longer match the stamp they were built from. */
  private async changedCount(files: readonly FileStamp[]): Promise<number> {
    const root = this.options.workspaceRoot;
    if (root === undefined || root.length === 0) {
      return 0;
    }
    let changed = 0;
    for (const file of files) {
      try {
        const info = await stat(join(root, file.path.split('/').join(sep)));
        if (info.size !== file.size || info.mtimeMs !== file.mtimeMs) {
          changed += 1;
        }
      } catch {
        // Gone counts as changed.
        changed += 1;
      }
    }
    return changed;
  }
}

/** Which corpus a record belongs to. */
function scopeOf(record: IndexRecord): RecallScope {
  switch (record.kind) {
    case 'memory':
      return 'memory';
    case 'conversation':
      return 'conversation';
    case 'media':
      return 'media';
    default:
      return 'folder';
  }
}

/**
 * A memory file's bullets, with their headings.
 *
 * Read through the agent package's splitter, which is the same one
 * `update_memory` writes through, so a fact the tool stored is a fact the index
 * can find. `indexer.ts` does the same for embedding; both are one small loop
 * over `splitMemory` rather than a parser of their own.
 */
function memoryBullets(memory: string): Array<{section: string; text: string}> {
  const bullets: Array<{section: string; text: string}> = [];
  for (const block of splitMemory(memory)) {
    const section = block.heading ?? 'memory.md';
    for (const line of block.lines) {
      const match = /^\s*[-*]\s+(.*)$/u.exec(line);
      const text = match?.[1]?.trim() ?? '';
      if (text.length > 0) {
        bullets.push({section, text});
      }
    }
  }
  return bullets;
}

/** The index's file name, so a caller can report or clear the right path. */
export const RECALL_INDEX_FILE = INDEX_FILE;

/** Where one profile's folder index lives, given the agent's data directory. */
export function recallIndexDir(agentDataDir: string): string {
  return join(agentDataDir, 'recall');
}

export {documentText, queryText};
export type {IndexRecord, TextChunk};

function describe(failure: unknown): string {
  return failure instanceof Error ? failure.message : String(failure);
}
