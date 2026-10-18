/**
 * The folders every agent can work in.
 *
 * One document for the whole install rather than a list on each profile. A
 * folder is a place on the machine, and two agents asked about the same project
 * work in the same one; a per-profile list also made the rail depend on which
 * agent happened to be active, which is not a question a sidebar should be
 * asking.
 *
 * It is its own file rather than a corner of `settings.json`: it is user data
 * with a write path of its own, guarded by the same version machinery as every
 * other document (older upgraded, newer refused, corrupt moved aside).
 *
 * The conversations that name these folders live in the session index, which is
 * why removing one is a *forget* rather than a cascade: the id is left dangling
 * and the rail renders that as "Other chats", so nothing a user wrote is lost to
 * a tidy-up. The directory itself is never touched — never read, written or
 * deleted — with one deliberate exception: the starting folder this store
 * creates for an install that had none.
 */
import {randomUUID} from 'node:crypto';
import {mkdir, rename, writeFile} from 'node:fs/promises';
import {basename, dirname, resolve} from 'node:path';

import {
  assertWritable,
  DocumentTooNewError,
  quarantineDocument,
  readVersionedDocument,
} from '@marimo/agent';
import type {DocumentMigration} from '@marimo/agent';

import {workspaceSchema, workspacesFileSchema} from '@marimo/protocol';
import type {Workspace, WorkspacesFile} from '@marimo/protocol';

/**
 * The version of the workspaces document this build writes.
 *
 * Not `DOCUMENT_VERSION`: this is the one document whose version had to move for
 * a reason of its own. See `moveSeededHomeFolder`.
 */
export const WORKSPACES_VERSION = 2;

/**
 * What a pre-workspaces `profiles.json` held, flattened.
 *
 * The shape the migration reads, not one this build ever writes: the folders
 * used to be a field on each profile, and the sessions already on disk refer to
 * their ids.
 */
export interface LegacyWorkspaces {
  workspaces: Workspace[];
  activeWorkspaceId: string | null;
}

export interface WorkspaceStoreOptions {
  file: string;
  /** Where a fresh install's single folder points, and a folder this store creates. */
  defaultWorkspaceRoot: string;
  /**
   * Where that folder pointed before this build gave the app its own.
   *
   * The home directory, read by the v1 upgrade and nothing else. Absent means
   * "there is no seed to recognise", which is what a test that names its own
   * default wants.
   */
  formerDefaultWorkspaceRoot?: string;
  /**
   * The folders a `profiles.json` written before this store existed holds.
   *
   * Called only when there is no workspaces document at all, which is the one
   * moment the old list is the only copy. A callback rather than a store
   * reference so this module stays unaware of profiles.
   */
  adoptLegacy?: () => Promise<LegacyWorkspaces | undefined>;
  /**
   * Told once an adopted document has been written.
   *
   * After, not before: the fields the folders came from can only be dropped
   * safely once the document holding them exists, and a crash between the two
   * steps has to leave the folders somewhere.
   */
  onAdopted?: () => Promise<void>;
}

export class WorkspaceStore {
  private cache: WorkspacesFile | undefined;
  /**
   * The upgrades this document has had, built from the two roots the caller
   * handed in.
   *
   * Constructed once rather than per read so the same step cannot be described
   * twice, and passed to `assertWritable` as well: a write after a lenient read
   * must accept the version it is about to replace.
   */
  private readonly migrations: DocumentMigration[];
  /**
   * The read in flight, memoised as a promise rather than a value.
   *
   * Two callers arriving before the first read finishes would both find no file,
   * both seed, and the loser's folder list — with a different random id for the
   * same path — would be the one left on disk while the winner's window went on
   * using the other. That is the same race the profiles store documents, and it
   * has the same answer.
   */
  private loading: Promise<WorkspacesFile> | undefined;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: WorkspaceStoreOptions) {
    this.migrations = [
      {
        from: 1,
        to: WORKSPACES_VERSION,
        summary: 'gave the install a starting folder of its own',
        migrate: (document) => this.migrateFromOne(document),
      },
    ];
  }

  async load(): Promise<WorkspacesFile> {
    if (this.cache) {
      return this.cache;
    }
    const inFlight = (this.loading ??= this.readOrCreate());
    try {
      return await inFlight;
    } finally {
      if (this.loading === inFlight) {
        this.loading = undefined;
      }
    }
  }

  async workspaces(): Promise<Workspace[]> {
    return (await this.load()).workspaces;
  }

  async activeWorkspaceId(): Promise<string | null> {
    return (await this.load()).activeWorkspaceId;
  }

  /** The folder a new conversation is filed under, if there is one. */
  async active(): Promise<Workspace | undefined> {
    const file = await this.load();
    return file.workspaces.find((entry) => entry.id === file.activeWorkspaceId);
  }

  async byId(workspaceId: string): Promise<Workspace | undefined> {
    const file = await this.load();
    return file.workspaces.find((entry) => entry.id === workspaceId);
  }

  /**
   * Adds a folder and makes it current. A path that is already listed is
   * selected rather than duplicated, so loading the same folder twice is
   * harmless — and it keeps the id the conversations filed under it refer to.
   */
  async add(path: string, name?: string): Promise<Workspace> {
    return await this.withLock(async () => {
      const file = await this.load();
      const absolute = resolve(path);
      const existing = file.workspaces.find((entry) => entry.path === absolute);
      const workspace: Workspace = existing ?? {
        id: randomUUID(),
        name: name?.trim() || workspaceLabel(absolute),
        path: absolute,
      };
      await this.writeFile({
        ...file,
        workspaces: existing
          ? file.workspaces
          : [...file.workspaces, workspace],
        activeWorkspaceId: workspace.id,
      });
      return workspace;
    });
  }

  async select(workspaceId: string): Promise<Workspace> {
    return await this.withLock(async () => {
      const file = await this.load();
      const workspace = requireWorkspace(file, workspaceId);
      await this.writeFile({...file, activeWorkspaceId: workspace.id});
      return workspace;
    });
  }

  async rename(workspaceId: string, name: string): Promise<Workspace> {
    const trimmed = name.trim();
    if (trimmed.length === 0) {
      // Writing a blank label would persist a file its own schema rejects, and
      // the next read would take the whole document down with it.
      throw new Error('A workspace name cannot be empty.');
    }
    return await this.withLock(async () => {
      const file = await this.load();
      const workspace = requireWorkspace(file, workspaceId);
      const renamed: Workspace = {...workspace, name: trimmed};
      await this.writeFile({
        ...file,
        workspaces: file.workspaces.map((entry) =>
          entry.id === workspaceId ? renamed : entry,
        ),
      });
      return renamed;
    });
  }

  /**
   * Forgets a folder, and nothing else.
   *
   * The conversations filed under it are deliberately left naming an id that is
   * no longer listed: the index is another document, rewriting it would be a
   * second thing that can go wrong in a tidy-up, and "Other chats" is already
   * how a dangling id renders. The directory is not touched at all.
   *
   * The current folder moves to the first one left, or to none — which is the
   * honest state of an install whose last folder was just forgotten.
   */
  async remove(workspaceId: string): Promise<WorkspacesFile> {
    return await this.withLock(async () => {
      const file = await this.load();
      requireWorkspace(file, workspaceId);
      const remaining = file.workspaces.filter(
        (entry) => entry.id !== workspaceId,
      );
      const next: WorkspacesFile = {
        version: WORKSPACES_VERSION,
        workspaces: remaining,
        activeWorkspaceId:
          file.activeWorkspaceId === workspaceId
            ? (remaining[0]?.id ?? null)
            : file.activeWorkspaceId,
      };
      await this.writeFile(next);
      return next;
    });
  }

  private async readOrCreate(): Promise<WorkspacesFile> {
    if (this.cache) {
      return this.cache;
    }

    const read = await readVersionedDocument(this.options.file, {
      label: 'The workspaces file',
      current: WORKSPACES_VERSION,
      migrations: this.migrations,
    });
    if (read.state === 'too-new') {
      throw new DocumentTooNewError(
        'The workspaces file',
        read.found,
        read.supported,
      );
    }
    if (read.state === 'unreadable') {
      /*
       * Moved aside before a fresh document replaces it. The conversations name
       * folders by id, and the ids are in this file, so a parse bug must not be
       * the end of the rail.
       */
      await quarantineDocument(this.options.file);
      return await this.seed();
    }
    if (read.state === 'current' || read.state === 'migrated') {
      const parsed = workspacesFileSchema.safeParse(read.document);
      if (parsed.success) {
        if (read.state === 'migrated') {
          /*
           * The upgrade may have moved the starting folder, so it is made real
           * before the document naming it is written. Written back now rather
           * than at the next edit, so an upgrade does not run again on every
           * launch. The cache is set by the write, not here: a folder that could
           * not be created must leave the next read to try again rather than
           * answering from a document that was never written.
           */
          await this.ensureStartingFolder(parsed.data);
          await this.writeFile(parsed.data);
        } else {
          this.cache = parsed.data;
        }
        return parsed.data;
      }
      await quarantineDocument(this.options.file);
    }
    return await this.seed();
  }

  /**
   * The first document this install has.
   *
   * Two ways in, and the order matters: a profiles file that still carries
   * folders is the only copy of them, so it is adopted; only an install with no
   * such file gets the default folder. An adopted list can still be the old
   * single-home seed — a profiles file that predates this store entirely — so
   * the same move is applied to it.
   */
  private async seed(): Promise<WorkspacesFile> {
    const legacy = await this.options.adoptLegacy?.();
    const seeded =
      legacy === undefined
        ? freshWorkspaces(this.options.defaultWorkspaceRoot)
        : adoptLegacy(legacy, this.options.defaultWorkspaceRoot);
    const moved = moveSeededHomeFolder(
      seeded.workspaces,
      this.options.formerDefaultWorkspaceRoot,
      this.options.defaultWorkspaceRoot,
    );
    const document =
      moved === undefined ? seeded : {...seeded, workspaces: moved};
    await this.ensureStartingFolder(document);
    await this.writeFile(document);
    if (legacy !== undefined) {
      await this.options.onAdopted?.();
    }
    return document;
  }

  /**
   * The v1 document, brought up to this build.
   *
   * Parsed entry by entry rather than by the v2 schema, which would refuse the
   * version this is here to upgrade. An entry that will not parse is left alone
   * and the v2 parse on the way out quarantines the file as it would have
   * before; the move is only ever attempted on a list that is entirely folders.
   */
  private migrateFromOne(
    document: Record<string, unknown>,
  ): Record<string, unknown> {
    const raw = document['workspaces'];
    if (!Array.isArray(raw)) {
      return document;
    }
    const parsed = raw.map((entry) => workspaceSchema.safeParse(entry));
    const workspaces: Workspace[] = [];
    for (const entry of parsed) {
      if (!entry.success) {
        return document;
      }
      workspaces.push(entry.data);
    }
    const moved = moveSeededHomeFolder(
      workspaces,
      this.options.formerDefaultWorkspaceRoot,
      this.options.defaultWorkspaceRoot,
    );
    return moved === undefined ? document : {...document, workspaces: moved};
  }

  /**
   * Makes the starting folder exist.
   *
   * A Space is a folder the person's files live in, so the one the app seeds has
   * to be real before the document names it: an agent confined to a path that is
   * not there can read nothing and write nothing, and Documents would show an
   * empty list that reads like an empty project rather than a missing folder.
   *
   * Only the default is created — a folder the person picked is required to
   * exist by the picker — and only when this document actually names it, so
   * adopting an old list does not leave an unused folder behind. A failure is
   * thrown rather than papered over: falling back to the home directory would
   * silently undo the containment this exists for.
   */
  private async ensureStartingFolder(document: WorkspacesFile): Promise<void> {
    const root = resolve(this.options.defaultWorkspaceRoot);
    if (!document.workspaces.some((entry) => entry.path === root)) {
      return;
    }
    try {
      await mkdir(root, {recursive: true});
    } catch (failure) {
      const reason =
        failure instanceof Error ? failure.message : String(failure);
      throw new Error(
        `The starting folder ${root} could not be created: ${reason}`,
      );
    }
  }

  private async writeFile(file: WorkspacesFile): Promise<void> {
    /*
     * Refused before anything is written. Every other store here follows the
     * same rule, and for the same reason: the read above is lenient, and a
     * lenient read plus a write is how a user's data disappears.
     */
    await assertWritable(this.options.file, {
      label: 'The workspaces file',
      current: WORKSPACES_VERSION,
      migrations: this.migrations,
    });
    await mkdir(dirname(this.options.file), {recursive: true});
    const temporary = `${this.options.file}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(file, null, 2)}\n`, 'utf8');
    await rename(temporary, this.options.file);
    this.cache = file;
  }

  private withLock<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    // Keep the chain alive even when a caller's write fails.
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

/**
 * The folder one turn runs in.
 *
 * The conversation's own folder wins, because that is what the rail shows and
 * what the user chose when they filed it. The current folder is the fallback for
 * a conversation that has none (one from before folders existed) or whose folder
 * has been forgotten.
 *
 * Pure, and outside the store, because it is a decision about a document rather
 * than an operation on a file — and it is the rule the whole feature rests on.
 */
export function workspaceRootFor(
  file: WorkspacesFile,
  sessionWorkspaceId?: string | null,
): string | undefined {
  if (sessionWorkspaceId !== undefined && sessionWorkspaceId !== null) {
    const filed = file.workspaces.find(
      (entry) => entry.id === sessionWorkspaceId,
    );
    if (filed !== undefined) {
      return filed.path;
    }
  }
  return file.workspaces.find((entry) => entry.id === file.activeWorkspaceId)
    ?.path;
}

/**
 * An install with no folders yet gets the folder the app created for it.
 *
 * `root` is the app's own starting folder (`<home>/Marimo`), not the home
 * directory: confining an agent to everything a person owns, and presenting home
 * as if it were a project, was the default this replaced. The caller is what
 * makes the folder exist; this only writes the document that names it.
 */
function freshWorkspaces(root: string): WorkspacesFile {
  const path = resolve(root);
  const workspace: Workspace = {
    id: randomUUID(),
    name: workspaceLabel(path),
    path,
  };
  return {
    version: WORKSPACES_VERSION,
    workspaces: [workspace],
    activeWorkspaceId: workspace.id,
  };
}

/**
 * The one folder an older install was seeded with, moved to this build's.
 *
 * The first Space used to be the home directory itself, so a document with
 * exactly one folder whose path is that old default is the app's own seed rather
 * than a choice somebody made. **The id is kept**, which is the whole point: the
 * session index files conversations by id, so replacing the entry would move
 * every chat to "Other chats" while this leaves them filed under the Space they
 * were started in. The name is changed only when it is still the seed's own
 * (`workspaceLabel(formerRoot)`); a label somebody typed is theirs and survives.
 *
 * A folder that is not the old seed, or a list with more than one, is left
 * alone — "only the seeded one" is all the evidence the document holds, and
 * moving a folder somebody picked would be the app deciding what their project
 * is. Returns `undefined` when there is nothing to move.
 */
function moveSeededHomeFolder(
  workspaces: readonly Workspace[],
  formerRoot: string | undefined,
  newRoot: string,
): Workspace[] | undefined {
  if (formerRoot === undefined) {
    return undefined;
  }
  if (workspaces.length !== 1) {
    return undefined;
  }
  const only = workspaces[0]!;
  const former = resolve(formerRoot);
  const next = resolve(newRoot);
  if (former === next || resolve(only.path) !== former) {
    return undefined;
  }
  const seedName = workspaceLabel(former);
  return [
    {
      ...only,
      path: next,
      name: only.name === seedName ? workspaceLabel(next) : only.name,
    },
  ];
}

/**
 * The folders a pre-workspaces profiles file held, as this store's document.
 *
 * Unioned **by id**, not by path. Two profiles seeded on the same machine both
 * got their own id for the same home directory, and a conversation refers to its
 * folder by id — so merging those into one entry would quietly unfile every chat
 * that named the loser. Two groups for one path after an upgrade is the visible
 * cost of keeping them, and the rail's own "remove from list" is how a user
 * cleans that up; losing conversations to the "Other chats" bucket is not.
 *
 * A document whose lists were all empty is an install that had no folder: it
 * falls back to the default, which is where a fresh install starts.
 */
function adoptLegacy(
  legacy: LegacyWorkspaces,
  fallbackRoot: string,
): WorkspacesFile {
  const seen = new Set<string>();
  const workspaces: Workspace[] = [];
  for (const workspace of legacy.workspaces) {
    if (seen.has(workspace.id)) {
      continue;
    }
    seen.add(workspace.id);
    workspaces.push({...workspace});
  }
  if (workspaces.length === 0) {
    return freshWorkspaces(fallbackRoot);
  }
  const active = workspaces.some(
    (entry) => entry.id === legacy.activeWorkspaceId,
  )
    ? legacy.activeWorkspaceId
    : workspaces[0]!.id;
  return {version: WORKSPACES_VERSION, workspaces, activeWorkspaceId: active};
}

function requireWorkspace(
  file: WorkspacesFile,
  workspaceId: string,
): Workspace {
  const workspace = file.workspaces.find((entry) => entry.id === workspaceId);
  if (!workspace) {
    throw new Error(`Unknown workspace: ${workspaceId}`);
  }
  return workspace;
}

/** `project` for a path, or the path itself when it has no last segment. */
export function workspaceLabel(path: string): string {
  const label = basename(resolve(path));
  return label.length > 0 ? label : resolve(path);
}
