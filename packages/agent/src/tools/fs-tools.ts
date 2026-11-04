/**
 * Filesystem tools: `read_file`, `list_dir`, `write_file`, `move_file`,
 * `rename_file` and `delete_file`.
 *
 * All six are confined to the workspace root through `resolveInsideWorkspace`,
 * and the readers cap what they return so one large file cannot consume the
 * whole context window.
 *
 * Three of them can destroy something, and each is gated by what it would
 * actually destroy. `write_file` and `move_file` pause only when the target
 * already exists, so ordinary creation and moving do not turn into a wall of
 * dialogs. `delete_file` has no trash and no undo, so it pauses every time.
 * `rename_file` pauses never, because it refuses to replace anything at all.
 */
import {
  mkdir,
  readFile,
  readdir,
  rename,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import {dirname, join} from 'node:path';

import {FunctionTool} from '@google/adk';
import {z} from 'zod';

import {PathOutsideWorkspaceError, resolveInsideWorkspace} from './paths.js';

const MAX_READ_BYTES = 64 * 1024;
const MAX_ENTRIES = 500;
const MAX_WRITE_BYTES = 1024 * 1024;

export interface FileToolContext {
  workspaceRoot: string;
}

export function createReadFileTool(context: FileToolContext) {
  return new FunctionTool({
    name: 'read_file',
    description:
      "Read a UTF-8 text file from the user's workspace and return its contents. " +
      'Paths may be relative to the workspace root or absolute, but must stay ' +
      'inside it. Output is truncated at 64 KiB.',
    parameters: z.object({
      path: z
        .string()
        .describe(
          'File to read, e.g. "src/index.ts" or "/home/me/project/README.md".',
        ),
      offset: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe('Byte offset to start reading from. Defaults to 0.'),
    }),
    execute: async ({path: candidate, offset}) => {
      const resolved = await resolveInsideWorkspace(
        context.workspaceRoot,
        candidate,
      );
      const info = await stat(resolved);
      if (info.isDirectory()) {
        return `"${candidate}" is a directory. Use list_dir instead.`;
      }
      if (!info.isFile()) {
        return `"${candidate}" is not a regular file.`;
      }

      const raw = await readFile(resolved, 'utf8');
      if (raw.includes('\u0000')) {
        return `"${candidate}" looks like a binary file (${info.size} bytes); not returning its contents.`;
      }

      const start = Math.min(offset ?? 0, raw.length);
      const slice = raw.slice(start);
      const truncated = slice.length > MAX_READ_BYTES;
      const body = truncated ? slice.slice(0, MAX_READ_BYTES) : slice;

      const header = `${resolved} (bytes ${start}-${start + body.length} of ${info.size})`;
      return truncated
        ? `${header}\n\n${body}\n\n[truncated: re-read with a larger offset to continue]`
        : `${header}\n\n${body}`;
    },
  });
}

export function createListDirTool(context: FileToolContext) {
  return new FunctionTool({
    name: 'list_dir',
    description:
      "List the entries of a directory inside the user's workspace, with sizes " +
      'and whether each entry is a directory. Not recursive.',
    parameters: z.object({
      /*
       * Optional, because the description promises a default and the model
       * believes it: a call with no `path` used to fail Zod validation and end
       * the turn, so "list my workspace" — the commonest way to start — was the
       * one call the tool could not answer.
       */
      path: z
        .string()
        .optional()
        .describe('Directory to list. Defaults to the workspace root.'),
    }),
    execute: async ({path: candidate}) => {
      const resolved = await resolveInsideWorkspace(
        context.workspaceRoot,
        candidate ?? '.',
      );
      const entries = await readdir(resolved, {withFileTypes: true});
      entries.sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory()) {
          return a.isDirectory() ? -1 : 1;
        }
        return a.name.localeCompare(b.name);
      });

      const shown = entries.slice(0, MAX_ENTRIES);
      const lines = await Promise.all(
        shown.map(async (entry) => {
          if (entry.isDirectory()) {
            return `  ${entry.name}/`;
          }
          if (!entry.isFile()) {
            return `  ${entry.name} (special file)`;
          }
          try {
            const info = await stat(join(resolved, entry.name));
            return `  ${entry.name} (${info.size} bytes)`;
          } catch {
            return `  ${entry.name}`;
          }
        }),
      );

      const suffix =
        entries.length > shown.length
          ? `\n[${entries.length - shown.length} more entries not shown]`
          : '';
      const header = `${resolved}: ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}`;
      return `${header}\n${lines.join('\n')}${suffix}`;
    },
  });
}

/**
 * `write_file`: replace a file's contents, or create it.
 *
 * The confirmation predicate is evaluated by ADK both when the call is first
 * made and again when an approval resumes it, and ADK separately re-checks that
 * the approved arguments match the call it is about to run — so what the user
 * saw is what executes. A predicate that throws (an unreadable or escaping path,
 * for instance) counts as "no gate"; the tool then refuses in `execute`, so the
 * failure is a readable result rather than a broken turn.
 */
export function createWriteFileTool(context: FileToolContext) {
  return new FunctionTool({
    name: 'write_file',
    description:
      "Create, edit or replace a UTF-8 text file in the user's workspace; " +
      'replacing an existing file asks the person first. Read the file when it ' +
      'already exists, then send the complete new contents. Output is capped at ' +
      '1 MiB.',
    parameters: z.object({
      path: z
        .string()
        .describe(
          'File to write, e.g. "src/index.ts" or "/home/me/project/notes.md".',
        ),
      content: z.string().describe('The complete new contents of the file.'),
    }),
    requireConfirmation: async ({path: candidate}) => {
      try {
        const resolved = await resolveInsideWorkspace(
          context.workspaceRoot,
          candidate,
        );
        const info = await stat(resolved);
        return info.isFile();
      } catch {
        return false;
      }
    },
    execute: async ({path: candidate, content}) => {
      let resolved: string;
      try {
        resolved = await resolveInsideWorkspace(
          context.workspaceRoot,
          candidate,
        );
      } catch (error) {
        if (error instanceof PathOutsideWorkspaceError) {
          return error.message;
        }
        return `Could not resolve "${candidate}": ${describeError(error)}`;
      }

      const bytes = Buffer.byteLength(content, 'utf8');
      if (bytes > MAX_WRITE_BYTES) {
        return `Refusing to write ${bytes} bytes to "${candidate}": the limit is ${MAX_WRITE_BYTES} bytes.`;
      }

      let existing: Awaited<ReturnType<typeof stat>> | undefined;
      try {
        existing = await stat(resolved);
      } catch (error) {
        if (!isNotFound(error)) {
          return `Could not inspect "${candidate}": ${describeError(error)}`;
        }
      }
      if (existing?.isDirectory()) {
        return `"${candidate}" is a directory. Use a file path.`;
      }
      if (existing && !existing.isFile()) {
        return `"${candidate}" is not a regular file; refusing to overwrite it.`;
      }

      try {
        await mkdir(dirname(resolved), {recursive: true});
        await writeFile(resolved, content, 'utf8');
      } catch (error) {
        return `Could not write "${candidate}": ${describeError(error)}`;
      }

      return existing
        ? `Replaced ${resolved} (${existing.size} → ${bytes} bytes).`
        : `Wrote ${resolved} (${bytes} bytes, new file).`;
    },
  });
}

/**
 * `move_file`: rename or move one file, creating the destination folder.
 *
 * The gate is the destination, not the source: a move that lands on a file
 * already there destroys it, and a move to a free name destroys nothing. The
 * predicate resolves both paths so a destination outside the Space counts as
 * "no gate" and the tool refuses in `execute` with a readable sentence.
 */
export function createMoveFileTool(context: FileToolContext) {
  return new FunctionTool({
    name: 'move_file',
    description:
      "Move or rename one file in the user's workspace. To rename notes.txt to " +
      'garden.txt call it with path "notes.txt" and to "garden.txt". A rename ' +
      'is this call: the file keeps one copy, and no text is written. The ' +
      'destination folder is created when it is missing; replacing a file that ' +
      'is already there asks the person first. Folders are not moved.',
    parameters: z.object({
      path: z.string().describe('The file to move, e.g. "notes/draft.md".'),
      to: z
        .string()
        .describe(
          'Where it should end up, including the new file name, e.g. ' +
            '"notes/2026/draft.md".',
        ),
    }),
    requireConfirmation: async ({path: candidate, to: destination}) => {
      try {
        const source = await resolveInsideWorkspace(
          context.workspaceRoot,
          candidate,
        );
        const target = await resolveInsideWorkspace(
          context.workspaceRoot,
          destination,
        );
        if (source === target) {
          return false;
        }
        const info = await stat(target);
        return info.isFile();
      } catch {
        return false;
      }
    },
    execute: async ({path: candidate, to: destination}) => {
      let source: string;
      let target: string;
      try {
        source = await resolveInsideWorkspace(context.workspaceRoot, candidate);
        target = await resolveInsideWorkspace(
          context.workspaceRoot,
          destination,
        );
      } catch (error) {
        if (error instanceof PathOutsideWorkspaceError) {
          return error.message;
        }
        return `Could not resolve the move: ${describeError(error)}`;
      }
      if (source === target) {
        return `"${candidate}" is already at that path.`;
      }

      let info: Awaited<ReturnType<typeof stat>>;
      try {
        info = await stat(source);
      } catch (error) {
        return `Could not inspect "${candidate}": ${describeError(error)}`;
      }
      if (info.isDirectory()) {
        return `"${candidate}" is a directory. move_file moves one file at a time.`;
      }
      if (!info.isFile()) {
        return `"${candidate}" is not a regular file.`;
      }

      let existing: Awaited<ReturnType<typeof stat>> | undefined;
      try {
        existing = await stat(target);
      } catch (error) {
        if (!isNotFound(error)) {
          return `Could not inspect "${destination}": ${describeError(error)}`;
        }
      }
      if (existing?.isDirectory()) {
        return `"${destination}" is a directory. Give move_file a file path.`;
      }

      try {
        await mkdir(dirname(target), {recursive: true});
        await rename(source, target);
      } catch (error) {
        return `Could not move "${candidate}": ${describeError(error)}`;
      }

      return existing
        ? `Replaced ${target} with ${source}.`
        : `Moved ${source} → ${target}.`;
    },
  });
}

/**
 * `rename_file`: change a file's name in the folder it is already in.
 *
 * Deliberately smaller than `move_file`, and that is the reason it exists as a
 * switch of its own: it cannot overwrite (a name that is taken is a refusal) and
 * it cannot leave the folder, so it is safe to offer with no card at all. The
 * wording is shared with the v2 definition in `engine/core-tools.ts`, which is
 * the copy a turn actually calls; this one is what the Settings screen shows and
 * what `describeTools` builds.
 */
export function createRenameFileTool(context: FileToolContext) {
  return new FunctionTool({
    name: 'rename_file',
    description:
      "Rename one file inside its own folder. It keeps the file's contents and " +
      'its folder, and it refuses a name that is already taken, so nothing is ' +
      'replaced. Give the new name on its own, with no folder in it. Folders ' +
      'are not renamed.',
    parameters: z.object({
      path: z.string().describe('The file to rename, e.g. "notes/draft.md".'),
      name: z
        .string()
        .describe(
          'The new name on its own, e.g. "2026-draft.md". It cannot name a ' +
            'folder.',
        ),
    }),
    execute: async ({path: candidate, name: raw}) => {
      const name = raw.trim();
      if (name.length === 0) {
        return 'rename_file needs the new name in "name".';
      }
      if (name === '.' || name === '..' || /[/\\]/.test(name)) {
        return (
          `"${name}" is a path, not a name. rename_file keeps the file in its ` +
          'folder: give just the new file name.'
        );
      }

      let source: string;
      let target: string;
      try {
        source = await resolveInsideWorkspace(context.workspaceRoot, candidate);
        target = await resolveInsideWorkspace(
          context.workspaceRoot,
          join(dirname(source), name),
        );
      } catch (error) {
        if (error instanceof PathOutsideWorkspaceError) {
          return error.message;
        }
        return `Could not resolve the rename: ${describeError(error)}`;
      }
      if (source === target) {
        return `"${candidate}" is already named that.`;
      }

      let info: Awaited<ReturnType<typeof stat>>;
      try {
        info = await stat(source);
      } catch (error) {
        return `Could not inspect "${candidate}": ${describeError(error)}`;
      }
      if (info.isDirectory()) {
        return `"${candidate}" is a directory. rename_file renames one file at a time.`;
      }
      if (!info.isFile()) {
        return `"${candidate}" is not a regular file.`;
      }

      let existing: Awaited<ReturnType<typeof stat>> | undefined;
      try {
        existing = await stat(target);
      } catch (error) {
        if (!isNotFound(error)) {
          return `Could not inspect "${name}": ${describeError(error)}`;
        }
      }
      if (existing?.isDirectory()) {
        return `"${name}" is a directory. Give rename_file a file name.`;
      }
      if (existing !== undefined) {
        return (
          `"${name}" already exists in that folder. rename_file will not ` +
          'replace it: choose another name, or move the existing file out of ' +
          'the way.'
        );
      }

      try {
        await rename(source, target);
      } catch (error) {
        return `Could not rename "${candidate}": ${describeError(error)}`;
      }
      return `Renamed ${source} → ${target}.`;
    },
  });
}

/**
 * `delete_file`: remove one file, permanently, with a card every time.
 *
 * There is no trash and no undo, so the gate is `always` rather than
 * `on-overwrite`: the person sees the path before anything is removed. Folders
 * are refused rather than walked, because a recursive delete is a different
 * capability with a different card.
 */
export function createDeleteFileTool(context: FileToolContext) {
  return new FunctionTool({
    name: 'delete_file',
    description:
      "Delete one file in the user's workspace. The person approves every " +
      'delete, and it cannot be undone. Folders are not deleted.',
    parameters: z.object({
      path: z
        .string()
        .describe('The file to delete, e.g. "notes/old-draft.md".'),
    }),
    requireConfirmation: async () => true,
    execute: async ({path: candidate}) => {
      let target: string;
      try {
        target = await resolveInsideWorkspace(context.workspaceRoot, candidate);
      } catch (error) {
        if (error instanceof PathOutsideWorkspaceError) {
          return error.message;
        }
        return `Could not resolve "${candidate}": ${describeError(error)}`;
      }

      let info: Awaited<ReturnType<typeof stat>>;
      try {
        info = await stat(target);
      } catch (error) {
        return `Could not inspect "${candidate}": ${describeError(error)}`;
      }
      if (info.isDirectory()) {
        return `"${candidate}" is a directory. delete_file removes one file at a time.`;
      }
      if (!info.isFile()) {
        return `"${candidate}" is not a regular file.`;
      }

      try {
        await unlink(target);
      } catch (error) {
        return `Could not delete "${candidate}": ${describeError(error)}`;
      }
      return `Deleted ${target}.`;
    },
  });
}

export function createCurrentTimeTool() {
  return new FunctionTool({
    name: 'current_time',
    description:
      "Return the current local date and time, with the machine's UTC offset. " +
      'The local time is the answer and comes first; the UTC instant follows it.',
    parameters: z.object({}),
    execute: () => {
      const now = new Date();
      const offsetMinutes = -now.getTimezoneOffset();
      const sign = offsetMinutes >= 0 ? '+' : '-';
      const hours = String(Math.floor(Math.abs(offsetMinutes) / 60)).padStart(
        2,
        '0',
      );
      const minutes = String(Math.abs(offsetMinutes) % 60).padStart(2, '0');
      /*
       * The local time leads, and says that it is the local time.
       *
       * It used to be `${now.toISOString()} (local ${now.toString()}, UTC-07:00)`
       * and the model read the leading token: asked for the time at 23:37 local,
       * it answered "6:37 PM" — that instant's UTC reading, wearing the user's
       * timezone as a label. A tool result is read from the front, so the value
       * being asked for has to be the value that is there, and the ISO instant —
       * the one form a model cannot convert by eye — keeps only the job of a
       * footnote.
       *
       * `en-US` and an explicit shape rather than `toLocaleString`, because this
       * goes into a prompt: a machine's locale must not change what the model is
       * told the time is, and a test has to be able to assert on it.
       */
      const clock = now.toLocaleTimeString('en-US', {
        hour: 'numeric',
        minute: '2-digit',
      });
      const day = now.toLocaleDateString('en-US', {
        weekday: 'long',
        day: 'numeric',
        month: 'long',
        year: 'numeric',
      });
      return (
        `${clock} on ${day} — the machine's local time ` +
        `(UTC${sign}${hours}:${minutes}, ${now.toISOString()})`
      );
    },
  });
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as {code?: string}).code === 'ENOENT'
  );
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as {code?: string}).code;
    return code ? `${error.message} (${code})` : error.message;
  }
  return String(error);
}
