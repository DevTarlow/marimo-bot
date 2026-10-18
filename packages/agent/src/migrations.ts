/**
 * Bringing a stored document up to the shape this build expects.
 *
 * Every document the app owns carries a `version`. Today they are all version 1,
 * so there is nothing to migrate — which is exactly why this exists now. The
 * failure it prevents only appears the first time a version is bumped, and by
 * then it is in users' hands:
 *
 *   A store reads its file, the version does not match the schema's
 *   `z.literal(1)`, `safeParse` fails, and the store quietly returns an empty
 *   document. The user's jobs are gone from the screen. The next write — adding
 *   one job — then persists an empty document over the real one, and they are
 *   gone from the disk too.
 *
 * So there are two rules here, and the second is the one that matters:
 *
 * 1. **An older document is upgraded**, step by step, and the caller writes back
 *    the result under the current version.
 * 2. **A newer document is refused, never downgraded.** A file written by a later
 *    build means someone ran a newer Marimo Bot and came back, or restored a
 *    backup. Refusing to write is recoverable — their file is still there. An
 *    empty document written over it is not.
 */
import {readFile, rename} from 'node:fs/promises';

/**
 * The document version this build writes, for every document that has no reason
 * to move on its own.
 *
 * One number rather than one per file: these are read and written by the same
 * release, so a per-file counter would only create chances for them to disagree
 * about which release they came from. A document that does need its own version
 * passes `current` to `readVersionedDocument` instead of changing this — the
 * workspaces document is the one that has, because its upgrade had to mark that a
 * one-time move had already run.
 */
export const DOCUMENT_VERSION = 1;

/** One step up the ladder, from `from` to `to`. */
export interface DocumentMigration {
  readonly from: number;
  readonly to: number;
  /** One line for the log, in the past tense: "renamed `schedule` to `schedules`". */
  readonly summary: string;
  /** Returns the document as the next version understands it. */
  migrate(document: Record<string, unknown>): Record<string, unknown>;
}

/** What reading a versioned document found. */
export type DocumentRead =
  /** No file, or an empty one: a fresh install. */
  | {state: 'absent'}
  /** Understood as-is. */
  | {state: 'current'; document: Record<string, unknown>}
  /** Upgraded from an older version; the caller should persist the result. */
  | {
      state: 'migrated';
      document: Record<string, unknown>;
      from: number;
      steps: readonly string[];
    }
  /** Written by a newer build than this one. */
  | {state: 'too-new'; found: number; supported: number}
  /** Present but not a document this build can use. */
  | {state: 'unreadable'; reason: string};

/**
 * Thrown when a write would overwrite a document this build does not understand.
 *
 * A typed error rather than a silent no-op, because the caller's options differ:
 * a Settings save can show it, a background job run can record it as the reason
 * it did nothing, and a test can assert on it.
 */
export class DocumentTooNewError extends Error {
  constructor(
    readonly label: string,
    readonly found: number,
    readonly supported: number,
  ) {
    super(
      `${label} was written by a newer version of Marimo Bot (format ${found}; ` +
        `this build understands ${supported}). It has been left untouched. ` +
        'Update the app to open it.',
    );
    this.name = 'DocumentTooNewError';
  }
}

export interface ReadVersionedOptions {
  /** How the document is named in a message the user will read. */
  label: string;
  /** Ascending steps; each one is applied only when its `from` matches. */
  migrations?: readonly DocumentMigration[];
  /** Overrides the version this build expects, for a migration's own tests. */
  current?: number;
  /**
   * The version to assume when the document carries none.
   *
   * Absent by default, and that default is the safe one: guessing would let a
   * file belonging to some other program — or a truncated write — be accepted and
   * then overwritten.
   *
   * Set only where a version-less file is a format this app genuinely wrote. The
   * settings document is the case: it has never carried a version, so every
   * settings file in existence looks like this, and refusing them would reset
   * every user's providers, connectors and preferences on upgrade. Naming the
   * version they are is the migration.
   */
  missingVersion?: number;
}

/**
 * Reads and, if needed, upgrades one versioned document.
 *
 * Never throws: a missing file, unparseable JSON and an unknown version are all
 * answers, because every caller has a sensible response to each and an exception
 * would only be caught one frame later to be turned into the same answer.
 */
export async function readVersionedDocument(
  file: string,
  options: ReadVersionedOptions,
): Promise<DocumentRead> {
  const current = options.current ?? DOCUMENT_VERSION;

  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch {
    return {state: 'absent'};
  }
  if (raw.trim().length === 0) {
    return {state: 'absent'};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {state: 'unreadable', reason: `${options.label} is not valid JSON.`};
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return {
      state: 'unreadable',
      reason: `${options.label} is not an object.`,
    };
  }

  const document = {...(parsed as Record<string, unknown>)};
  const version = document['version'];

  /*
   * A document with no `version` is not treated as version 1. Guessing would
   * mean a file that is actually a different tool's, or a truncated write, gets
   * accepted and then overwritten. Saying so is the safer half of the trade.
   */
  if (
    (version === undefined || version === null) &&
    options.missingVersion !== undefined
  ) {
    return {state: 'migrated', document, from: 0, steps: []};
  }

  if (typeof version !== 'number' || !Number.isInteger(version)) {
    return {
      state: 'unreadable',
      reason: `${options.label} has no version field.`,
    };
  }

  if (version > current) {
    return {state: 'too-new', found: version, supported: current};
  }
  if (version === current) {
    return {state: 'current', document};
  }

  const steps: string[] = [];
  let working = document;
  let at = version;

  while (at < current) {
    const step = (options.migrations ?? []).find((entry) => entry.from === at);
    if (!step) {
      return {
        state: 'unreadable',
        reason:
          `${options.label} is format ${at} and this build has no way to bring ` +
          `it up to ${current}.`,
      };
    }
    working = step.migrate(working);
    steps.push(step.summary);
    at = step.to;
  }

  return {
    state: 'migrated',
    document: {...working, version: current},
    from: version,
    steps,
  };
}

/**
 * Refuses a write when the file on disk is a document this build cannot read.
 *
 * Called before every `writeFile` in a versioned store. The read is repeated
 * rather than remembered because the file can change between the read that
 * loaded the document and the write that saves it — the app and the headless
 * runner are two processes over one file, and the runner can finish a job
 * between them.
 */
export async function assertWritable(
  file: string,
  options: ReadVersionedOptions,
): Promise<void> {
  const read = await readVersionedDocument(file, options);
  if (read.state === 'too-new') {
    throw new DocumentTooNewError(
      options.label,
      read.found,
      read.supported,
    );
  }
}

/**
 * Moves a document this build cannot read out of the way, and says where to.
 *
 * The third answer, between "use it" and "refuse to write".
 *
 * A file from a newer build is refused: it is a valid document, a later Marimo Bot
 * Agent can read it, and overwriting it would destroy something still useful.
 * A *corrupt* file has neither of those properties — nothing can read it,
 * including the build that wrote it — and refusing it forever is worse than
 * either alternative, because the app can then never save anything again and the
 * user has no idea which file to delete.
 *
 * So it is kept rather than deleted: a fixed `.unreadable` suffix sits beside the
 * original, discoverable by anyone looking, and the store writes a fresh
 * document. A second quarantine replaces the first, which loses nothing — both
 * are unreadable by definition — and keeps the number of stray files bounded.
 *
 * Returns the path it was moved to, or undefined when there was nothing to move.
 */
export async function quarantineDocument(
  file: string,
): Promise<string | undefined> {
  const aside = `${file}.unreadable`;
  try {
    await rename(file, aside);
    return aside;
  } catch {
    // Nothing there, or it could not be moved. Either way the caller's write is
    // the thing that matters, and it proceeds: this is a courtesy to whoever
    // comes looking, not a precondition.
    return undefined;
  }
}
