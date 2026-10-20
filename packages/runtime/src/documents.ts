/**
 * A Space's documents: the files in the folder it points at.
 *
 * A space is a folder the user loaded and this app does not own, so a document
 * is an ordinary file — no version field, no manifest, no copy inside user data.
 * The library lists every regular file in the folder, hidden ones included,
 * except the agent's own skip list; the editor opens the UTF-8 text ones and
 * refuses a binary file with a sentence rather than decoding it into mojibake.
 * What the app keeps is the *revision* a caller read, because the one thing an
 * editor must never do is write over a file that moved on while somebody had it
 * open.
 *
 * Every path arrives as text from a window and becomes a path inside the root
 * through `resolveInsideWorkspace` — the same guard the agent's own file tools
 * use — so `..`, an absolute path and a symlink that leaves the space are one
 * refusal with one sentence. This module deliberately owns no second checker.
 *
 * The service is over a *root* rather than over an id: the runtime resolves the
 * id through the workspaces document, which keeps "which folder is this"
 * answered in one place.
 */
import {randomUUID} from 'node:crypto';
import {open, readdir, rename, rm, stat, writeFile} from 'node:fs/promises';
import {dirname, join, relative, sep} from 'node:path';

import {resolveInsideWorkspace, SKIPPED_DIRECTORIES} from '@marimo/agent';
import type {
  DocumentEntry,
  DocumentRead,
  DocumentRevision,
  DocumentWrite,
} from '@marimo/protocol';

/** The largest document the editor will open, or save. */
export const MAX_DOCUMENT_BYTES = 1024 * 1024;

/** How many files one listing returns. */
export const MAX_DOCUMENTS = 500;

/** How far below the root a listing looks. */
export const MAX_DOCUMENT_DEPTH = 8;

/**
 * The name an atomic write gives its temporary, beside the file it will become.
 *
 * Hidden files are documents too, so the dot prefix alone cannot keep this out
 * of the library: the listing recognizes the exact shape instead. A user's own
 * `.tmp` file is still their file.
 */
const SCRATCH_FILE =
  /^\.marimo-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/u;

/**
 * The revision a caller sends for a document it believes does not exist yet.
 *
 * The protocol's write schema requires a revision, and "I am making this file"
 * has to be expressible in a shape of size and modification time — so zero bytes
 * and the epoch are the statement. A file written by anything real has a
 * different one, and a caller that read something and finds nothing there is
 * answered with the conflict rather than with the write.
 */
const NOT_YET_WRITTEN: DocumentRevision = Object.freeze({
  bytes: 0,
  modifiedAtMs: 0,
});

export interface DocumentList {
  files: DocumentEntry[];
  /**
   * What the listing could not show, in the app's own words.
   *
   * Both caps speak here: the number of files and the depth of the tree. A
   * library that stopped and said nothing reads as a folder that holds exactly
   * that much — invariant 7, and the window prints these rather than working out
   * for itself whether something was dropped.
   */
  notes: string[];
}

/** One message of a conversation, as the markdown is written. */
export interface ChatMessage {
  /** The name the words are written under: an agent's, or the person's. */
  author: string;
  text: string;
}

/**
 * A conversation ready to be rendered.
 *
 * Names rather than ids, because resolving an id to a name is the profile
 * store's job and this module has never heard of it.
 */
export interface ChatDocument {
  title: string;
  savedAt: Date;
  messages: readonly ChatMessage[];
}

export interface DocumentServiceOptions {
  /** The space's own folder, as the workspaces document resolved it. */
  root: string;
}

export class DocumentService {
  constructor(private readonly options: DocumentServiceOptions) {}

  /**
   * Every regular file in the space, sorted by path.
   *
   * Hidden files and directories are included: a person who opens this drawer
   * is looking at their own folder, and `.env` or `.github` is as much a file of
   * theirs as `README` is. What stays out is the agent's own skip list
   * (`SKIPPED_DIRECTORIES`) — `.marimo/<profile>/memory.md` is the agent's memory
   * rather than a document of the user's project, `.git` is history, and the
   * dependency and build folders are noise. That is the same list the agent's
   * walk uses, so a file the library shows is a file the agent can find and
   * quote. A second list would be a second answer to "which files are in this
   * folder", which shows up as a document the agent cannot mention.
   */
  async list(): Promise<DocumentList> {
    const base = await this.base();
    const files: DocumentEntry[] = [];
    /** A cap stopped the walk in each of the two ways it can. */
    let moreFiles = false;
    let deeperFolders = false;

    const walk = async (directory: string, depth: number): Promise<void> => {
      let entries;
      try {
        entries = await readdir(directory, {withFileTypes: true});
      } catch (error) {
        /*
         * A folder that has been moved or deleted is a thing the user did, and
         * the space's own root failing to list has to say so rather than answer
         * an empty library. A *sub*directory that cannot be listed is raced with
         * their file manager, and losing the rest of the space to that is worse.
         */
        if (directory === base) {
          throw new Error(
            `The folder this space points at could not be read: ${describe(error)}`,
          );
        }
        return;
      }

      for (const entry of entries) {
        if (entry.isDirectory()) {
          if (SKIPPED_DIRECTORIES.has(entry.name)) {
            continue;
          }
          if (depth >= MAX_DOCUMENT_DEPTH) {
            // Something may be down there, and the listing is not going to look.
            deeperFolders = true;
            continue;
          }
          await walk(join(directory, entry.name), depth + 1);
          continue;
        }
        /*
         * Symlinks are not documents, for the reason the agent's walk skips
         * them: one that points at a parent is a walk that never ends, and one
         * that leaves the space is a file `read` would refuse anyway.
         */
        if (!entry.isFile() || isScratchFile(entry.name)) {
          continue;
        }
        if (files.length >= MAX_DOCUMENTS) {
          moreFiles = true;
          return;
        }
        const path = join(directory, entry.name);
        const info = await stat(path).catch(() => undefined);
        if (info === undefined || !info.isFile()) {
          continue;
        }
        const relativePath = relativeToRoot(base, path);
        files.push({
          path: relativePath,
          name: entry.name,
          dir: folderOf(relativePath),
          bytes: info.size,
          modifiedAt: new Date(info.mtimeMs).toISOString(),
        });
      }
    };

    await walk(base, 0);
    files.sort((left, right) => left.path.localeCompare(right.path));

    const notes: string[] = [];
    if (moreFiles) {
      notes.push(
        `Showing the first ${MAX_DOCUMENTS} files in this space, and there are more.`,
      );
    }
    if (deeperFolders) {
      notes.push(
        `Folders more than ${MAX_DOCUMENT_DEPTH} levels below this space were not opened, so any files in them are not listed.`,
      );
    }
    return {files, notes};
  }

  /**
   * One document's text, with the revision that text belongs to.
   *
   * One handle for both, because the two have to belong together: a stat of the
   * path followed by a read of it can be separated by another writer's rename,
   * and a revision from a file the caller never saw would let their next save
   * overwrite the one they did not see. Reading through the handle that was
   * statted is what makes the pair one answer.
   *
   * Refuses a file that is not UTF-8 text, and anything over the cap: a binary
   * file decoded as text would be saved back as mojibake, an editor that is
   * handed a megabyte of text has to draw it, and the read that is refused with
   * a sentence is cheaper for the user than the read that arrives.
   */
  async read(path: string): Promise<DocumentRead> {
    const base = await this.base();
    const target = await this.documentPath(base, path);
    const handle = await open(target, 'r').catch((error: unknown) => {
      if (isNotFound(error)) {
        throw new Error(`There is no document at "${path}" in this space.`);
      }
      throw error;
    });
    try {
      const info = await handle.stat();
      if (info.isDirectory()) {
        throw new Error(`"${path}" is a folder, not a document.`);
      }
      if (!info.isFile()) {
        throw new Error(`"${path}" is not a regular file.`);
      }
      if (info.size > MAX_DOCUMENT_BYTES) {
        throw new Error(
          `Refusing to open "${path}": it is ${info.size} bytes, and a document is capped at ${MAX_DOCUMENT_BYTES} bytes.`,
        );
      }
      const bytes = await handle.readFile();
      // A file can grow between the stat above and this read, and the cap has
      // to be true of the bytes the editor is actually handed.
      if (bytes.byteLength > MAX_DOCUMENT_BYTES) {
        throw new Error(
          `Refusing to open "${path}": it is ${bytes.byteLength} bytes, and a document is capped at ${MAX_DOCUMENT_BYTES} bytes.`,
        );
      }
      if (bytes.includes(0)) {
        throw new Error(
          `"${path}" looks like a binary file (${bytes.byteLength} bytes); the editor opens UTF-8 text files only.`,
        );
      }
      let text: string;
      try {
        /*
         * `ignoreBOM` keeps a leading byte-order mark in the text. The default
         * strips it, which would make the first save quietly rewrite the file's
         * opening bytes.
         */
        text = new TextDecoder('utf-8', {
          fatal: true,
          ignoreBOM: true,
        }).decode(bytes);
      } catch {
        throw new Error(
          `"${path}" is not UTF-8 text (${bytes.byteLength} bytes); the editor opens UTF-8 text files only.`,
        );
      }
      return {
        path: relativeToRoot(base, target),
        text,
        revision: revisionOf(info),
      };
    } finally {
      await handle.close();
    }
  }

  /**
   * Writes a document, or refuses because it moved on since it was read.
   *
   * The refusal is a *value* rather than an error — see `DocumentWrite` — and
   * nothing is written on that path: the file on disk is what the caller's next
   * attempt has to be based on, so leaving it untouched is the whole answer. A
   * file that does not exist is written only by a caller whose revision is the
   * zero one (`NOT_YET_WRITTEN`), which is the statement "I believe this is
   * new"; a caller that read something and finds nothing there gets the conflict
   * back with the revision that is actually on disk.
   *
   * The parent folder is never created. A path whose folder is missing is a
   * stale or mistyped one, and inventing the tree it names would put a directory
   * in the user's project because a window asked — the folder is theirs to make.
   */
  async write(
    path: string,
    text: string,
    revision: DocumentRevision,
  ): Promise<DocumentWrite> {
    const base = await this.base();
    const target = await this.documentPath(base, path);
    this.requireWithinCap(path, text);

    const info = await stat(target).catch((error: unknown) => {
      if (!isNotFound(error)) {
        throw error;
      }
      return undefined;
    });
    if (info?.isDirectory()) {
      throw new Error(`"${path}" is a folder, not a document.`);
    }
    if (info !== undefined && !info.isFile()) {
      throw new Error(`"${path}" is not a regular file.`);
    }

    const current = info === undefined ? NOT_YET_WRITTEN : revisionOf(info);
    if (
      current.bytes !== revision.bytes ||
      current.modifiedAtMs !== revision.modifiedAtMs
    ) {
      return {ok: false, conflict: true, revision: current};
    }

    await this.requireFolder(base, target, path);
    await this.writeAtomically(target, text, path);
    return {ok: true, revision: revisionOf(await stat(target))};
  }

  /**
   * A new, empty document.
   *
   * Empty rather than seeded with a heading: what the file says is the user's,
   * and a new document that already contains a title they did not write is a
   * document they have to delete something from before starting.
   */
  async create(dir: string | undefined, name: string): Promise<DocumentRead> {
    const base = await this.base();
    const folder = (dir ?? '').trim();
    const documentName = name.trim();
    const problem = nameProblem(documentName);
    if (problem !== undefined) {
      throw new Error(problem);
    }
    const requested =
      folder.length === 0 ? documentName : `${folder}/${documentName}`;
    const target = await resolveInsideWorkspace(base, requested);
    const path = relativeToRoot(base, target);
    return await this.createNew(
      base,
      target,
      path,
      '',
      `"${path}" already exists in this space. Open it, or choose another name.`,
    );
  }

  /**
   * A conversation, written into the space as a document.
   *
   * Refuses a name that is already taken, and that is not tidiness: saving a
   * chat makes a document, the alternative is quietly replacing one the user
   * wrote, and a conversation saved twice is two files rather than one file with
   * the first version gone.
   */
  async saveChat(path: string, chat: ChatDocument): Promise<DocumentRead> {
    const base = await this.base();
    const target = await this.documentPath(base, path);
    /*
     * A saved conversation is markdown — the rendering below is the format. The
     * editor now opens any text file, so this is the one place that still needs
     * to say what the document it is making will be.
     */
    if (!isMarkdown(target)) {
      throw new Error(
        `"${path}" is not a markdown file: a saved conversation is written as markdown.`,
      );
    }
    const text = renderChatDocument(chat);
    this.requireWithinCap(path, text);
    const relativePath = relativeToRoot(base, target);
    return await this.createNew(
      base,
      target,
      relativePath,
      text,
      `"${relativePath}" already exists in this space, and saving a conversation never overwrites a document. Choose another name.`,
    );
  }

  /** The root, with symlinks resolved, as every path is judged against it. */
  private async base(): Promise<string> {
    return await resolveInsideWorkspace(this.options.root, '.');
  }

  /**
   * A file's absolute path, or the guard's own refusal.
   *
   * Resolution is the whole check. Every regular file is a document of the
   * space now, and whether it is text is the read's question rather than the
   * path's.
   */
  private async documentPath(base: string, path: string): Promise<string> {
    return await resolveInsideWorkspace(base, path);
  }

  /**
   * The folder a document goes into has to be one the user already has.
   *
   * A refusal rather than `mkdir -p`: a write that invents a directory hides a
   * mistyped or stale path behind a new tree in somebody's project, and the
   * folder is the user's. The root itself is the one folder this never asks
   * about, because it is the space.
   */
  private async requireFolder(
    base: string,
    target: string,
    path: string,
  ): Promise<void> {
    const parent = dirname(target);
    if (parent === base) {
      return;
    }
    const info = await stat(parent).catch(() => undefined);
    if (info?.isDirectory() !== true) {
      throw new Error(
        `"${path}" cannot be written: this space has no folder "${relativeToRoot(base, parent)}".`,
      );
    }
  }

  /** A document that must not already exist, written and answered as read. */
  private async createNew(
    base: string,
    target: string,
    path: string,
    text: string,
    taken: string,
  ): Promise<DocumentRead> {
    const existing = await stat(target).catch(() => undefined);
    if (existing !== undefined) {
      throw new Error(taken);
    }
    await this.requireFolder(base, target, path);
    await this.writeAtomically(target, text, path);
    return {path, text, revision: revisionOf(await stat(target))};
  }

  /** The size cap, as the read's own sentence from the other end. */
  private requireWithinCap(path: string, text: string): void {
    const bytes = Buffer.byteLength(text, 'utf8');
    if (bytes > MAX_DOCUMENT_BYTES) {
      throw new Error(
        `Refusing to write ${bytes} bytes to "${path}": a document is capped at ${MAX_DOCUMENT_BYTES} bytes.`,
      );
    }
  }

  /**
   * The text, written beside the document and moved into place.
   *
   * A crash between the two steps leaves the original exactly as it was and a
   * `.tmp` file nobody reads — which is the point: an editor saving a document
   * must never be the reason a file is half-written. The temporary name carries
   * the app's own marker, and the listing recognizes that exact shape, so it
   * cannot appear while it lives even though hidden files are documents too; it
   * is removed when the write itself fails rather than left in the user's
   * folder.
   */
  private async writeAtomically(
    target: string,
    text: string,
    path: string,
  ): Promise<void> {
    const temporary = join(dirname(target), `.marimo-${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, text, 'utf8');
      await rename(temporary, target);
    } catch (error) {
      await rm(temporary, {force: true}).catch(() => undefined);
      throw new Error(`"${path}" could not be written: ${describe(error)}`);
    }
  }
}

/**
 * A conversation as markdown: a title, the day it was saved, and each message
 * under the name of whoever said it.
 *
 * A message with no text is left out rather than written as an empty paragraph:
 * a turn that only called a tool is not something anybody said, and a document
 * full of blank headings reads as though words were lost.
 */
export function renderChatDocument(chat: ChatDocument): string {
  const title = chat.title.trim().replace(/\s+/gu, ' ') || 'A conversation';
  const lines = [`# ${title}`, '', `Saved on ${dateStamp(chat.savedAt)}.`];
  for (const message of chat.messages) {
    const text = message.text.trim();
    if (text.length === 0) {
      continue;
    }
    lines.push('', `## ${message.author}`, '', text);
  }
  return `${lines.join('\n')}\n`;
}

/** `2026-02-03`, from the machine's own calendar rather than from UTC. */
function dateStamp(when: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}`;
}

/** Why a name cannot be a file's, or nothing. */
function nameProblem(name: string): string | undefined {
  // A name is not a path, and `.` and `..` are the two names that would stop
  // being one if they were allowed.
  if (name.length === 0 || name === '.' || name === '..') {
    return `"${name}" is not a file name.`;
  }
  /*
   * The folder is `dir`, so a separator here is a path where a name goes — and
   * it is also the only way a caller could name something the folder it asked
   * for does not contain.
   */
  if (name.includes('/') || name.includes('\\') || name.includes('\u0000')) {
    return `"${name}" is not a file name: name the folder with "dir", and give a plain file name here.`;
  }
  return undefined;
}

/** Whether a path is markdown, which is the one format with a preview. */
function isMarkdown(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.endsWith('.md') || lower.endsWith('.markdown');
}

/** The app's own atomic-write debris rather than a file of the user's. */
function isScratchFile(name: string): boolean {
  return SCRATCH_FILE.test(name);
}

/** A path relative to the root, with forward slashes whatever the platform. */
function relativeToRoot(base: string, target: string): string {
  return relative(base, target).split(sep).join('/');
}

/** The directory part of a forward-slashed relative path, `''` at the top. */
function folderOf(relativePath: string): string {
  const cut = relativePath.lastIndexOf('/');
  return cut === -1 ? '' : relativePath.slice(0, cut);
}

function revisionOf(info: {size: number; mtimeMs: number}): DocumentRevision {
  return {bytes: info.size, modifiedAtMs: info.mtimeMs};
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as {code?: string}).code === 'ENOENT'
  );
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as {code?: string}).code;
    return code === undefined ? error.message : `${error.message} (${code})`;
  }
  return String(error);
}
