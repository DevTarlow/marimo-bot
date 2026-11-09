/**
 * The tools a turn can be offered in v2, before any profile grant is applied.
 *
 * This is the Phase 1 set: enough to read, create and replace a file, rename one
 * in place, move one, delete one, list a folder, ask the time, and run a command
 * behind the strongest gate. The
 * memory, skill, job, recall and connector tools follow with their stores.
 *
 * Every file path goes through `resolveInsideWorkspace`, the same guard the v1
 * tools used, so `..`, an absolute path and a symlink that leaves the Space are
 * one refusal with one sentence.
 */
import {exec} from 'node:child_process';
import {
  mkdir,
  open,
  readdir,
  rename,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import {dirname, join} from 'node:path';

import {z} from 'zod';

import type {GateRule, HarnessSpec} from '../harness/spec.js';
import {draftBotTool} from './bot-tools.js';
import {startTaskTool} from './task-tools.js';
import {askAgentTool} from './delegation-tools.js';
import {MEMORY_TOOLS} from './memory-tools.js';
import {JOB_TOOLS} from './job-tools.js';
import {KNOWLEDGE_TOOLS} from './knowledge-tool.js';
import {WEB_TOOLS} from './web-tools.js';
import {recallTool} from './recall-tool.js';
import {LEARNING_TOOLS} from './learning-tools.js';
import {SKILL_TOOLS} from './skill-tools.js';
import {
  describeToolError,
  outcome,
  type AnyToolDefinition,
  type ToolContext,
  type ToolDefinition,
  type ToolOutcome,
} from './tool-contract.js';
import {
  PathOutsideWorkspaceError,
  resolveInsideWorkspace,
} from '../tools/paths.js';

const MAX_READ_BYTES = 1024 * 1024;
const MAX_WRITE_CHARS = 1024 * 1024;
const MAX_LIST_ENTRIES = 200;
const MAX_SHELL_OUTPUT = 1024 * 1024;
const SHELL_TIMEOUT_MS = 120_000;

/** A tool erased to the one shape the adapter can call. */
export type {AnyToolDefinition} from './tool-contract.js';

function asAnyTool<Args>(definition: ToolDefinition<Args>): AnyToolDefinition {
  return definition as unknown as AnyToolDefinition;
}

async function resolved(
  context: ToolContext,
  candidate: string,
): Promise<{path: string} | {problem: string}> {
  try {
    return {
      path: await resolveInsideWorkspace(context.workspaceRoot, candidate),
    };
  } catch (error) {
    if (error instanceof PathOutsideWorkspaceError) {
      return {problem: error.message};
    }
    return {problem: describeToolError(error)};
  }
}

const currentTime = asAnyTool({
  name: 'current_time',
  description:
    'Return the current date and time in ISO 8601 form, with the local offset.',
  parameters: z.object({}),
  execute: async (): Promise<ToolOutcome> =>
    outcome(true, new Date().toISOString()),
});

const readFile = asAnyTool({
  name: 'read_file',
  description:
    'Read a UTF-8 text file inside the workspace. Output is capped at 1 MiB and ' +
    'says when it was truncated.',
  parameters: z.object({
    path: z.string().describe('File to read, relative to the workspace root.'),
  }),
  requiresWorkspace: true,
  execute: async (
    args: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolOutcome> => {
    const candidate = typeof args.path === 'string' ? args.path : '';
    if (candidate.length === 0) {
      return outcome(false, 'read_file needs a path.');
    }
    const target = await resolved(context, candidate);
    if ('problem' in target) {
      return outcome(false, target.problem);
    }
    try {
      const info = await stat(target.path);
      if (!info.isFile()) {
        return outcome(false, `${candidate} is not a file.`);
      }
      const handle = await open(target.path, 'r');
      try {
        const buffer = Buffer.alloc(Math.min(info.size, MAX_READ_BYTES) + 1);
        const {bytesRead} = await handle.read(
          buffer,
          0,
          Math.min(info.size, MAX_READ_BYTES) + 1,
          0,
        );
        const truncated = info.size > MAX_READ_BYTES;
        const body = buffer
          .subarray(0, Math.min(bytesRead, MAX_READ_BYTES))
          .toString('utf8');
        return outcome(
          true,
          truncated
            ? `${body}\n\n[truncated: the file is ${info.size} bytes; only the first ${MAX_READ_BYTES} were read]`
            : body,
        );
      } finally {
        await handle.close();
      }
    } catch (error) {
      return outcome(
        false,
        `Could not read "${candidate}": ${describeToolError(error)}`,
      );
    }
  },
});

const listDir = asAnyTool({
  name: 'list_dir',
  description:
    'List the entries in a folder inside the workspace. Output is capped at ' +
    '200 entries and says when the cap stopped it.',
  parameters: z.object({
    path: z
      .string()
      .describe(
        'Folder to list, relative to the workspace root. Use "." for the root.',
      ),
  }),
  requiresWorkspace: true,
  execute: async (
    args: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolOutcome> => {
    const candidate = typeof args.path === 'string' ? args.path : '.';
    const target = await resolved(context, candidate);
    if ('problem' in target) {
      return outcome(false, target.problem);
    }
    try {
      const info = await stat(target.path);
      if (!info.isDirectory()) {
        return outcome(false, `${candidate} is not a folder.`);
      }
      const entries = await readdir(target.path, {withFileTypes: true});
      entries.sort((left, right) => left.name.localeCompare(right.name));
      const shown = entries.slice(0, MAX_LIST_ENTRIES);
      const lines = shown.map(
        (entry) => `${entry.isDirectory() ? 'dir ' : 'file'} ${entry.name}`,
      );
      const suffix =
        entries.length > shown.length
          ? `\n[${entries.length - shown.length} more entries not shown]`
          : '';
      return outcome(
        true,
        `${candidate.trim().length === 0 ? '.' : candidate}: ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}\n${lines.join('\n')}${suffix}`,
      );
    } catch (error) {
      return outcome(
        false,
        `Could not list "${candidate}": ${describeToolError(error)}`,
      );
    }
  },
});

const writeFileTool = asAnyTool({
  name: 'write_file',
  description:
    'Create, edit or replace a UTF-8 text file inside the workspace; replacing ' +
    'an existing file asks the person first. Read the file when it already ' +
    'exists, then send the complete new contents. Renaming is move_file: a ' +
    'write leaves the original file in place. Output is capped at 1 MiB.',
  parameters: z.object({
    path: z.string().describe('File to write, relative to the workspace root.'),
    content: z.string().describe('The complete new contents of the file.'),
  }),
  gate: 'on-overwrite',
  requiresWorkspace: true,
  execute: async (
    args: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolOutcome> => {
    const candidate = typeof args.path === 'string' ? args.path : '';
    const content = typeof args.content === 'string' ? args.content : '';
    if (candidate.length === 0) {
      return outcome(false, 'write_file needs a path.');
    }
    if (content.length > MAX_WRITE_CHARS) {
      return outcome(
        false,
        `The content is ${content.length} characters; write_file accepts at most ${MAX_WRITE_CHARS}.`,
      );
    }
    const target = await resolved(context, candidate);
    if ('problem' in target) {
      return outcome(false, target.problem);
    }
    try {
      const existing = await stat(target.path).catch(() => undefined);
      if (existing?.isDirectory()) {
        return outcome(false, `${candidate} is a folder, not a file.`);
      }
      await mkdir(dirname(target.path), {recursive: true});
      await writeFile(target.path, content, 'utf8');
      return outcome(
        true,
        `${existing === undefined ? 'Created' : 'Replaced'} ${candidate} (${content.length} characters).`,
      );
    } catch (error) {
      return outcome(
        false,
        `Could not write "${candidate}": ${describeToolError(error)}`,
      );
    }
  },
});

const moveFileTool = asAnyTool({
  name: 'move_file',
  description:
    'Move or rename one file inside the workspace. To rename notes.txt to ' +
    'garden.txt call it with path "notes.txt" and to "garden.txt". A rename is ' +
    'this call: the file keeps one copy, and no text is written. The ' +
    'destination folder is created when it is missing; replacing a file that ' +
    'is already there asks the person first. Folders are not moved.',
  parameters: z.object({
    path: z
      .string()
      .describe('The file to move, relative to the workspace root.'),
    to: z
      .string()
      .describe(
        'Where it should end up, relative to the workspace root. Include the ' +
          'new file name, e.g. "notes/2026.md".',
      ),
  }),
  gate: 'on-overwrite',
  requiresWorkspace: true,
  execute: async (
    args: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolOutcome> => {
    const candidate = typeof args.path === 'string' ? args.path : '';
    const destination = typeof args.to === 'string' ? args.to : '';
    if (candidate.length === 0) {
      return outcome(false, 'move_file needs a path.');
    }
    if (destination.length === 0) {
      return outcome(false, 'move_file needs a destination in "to".');
    }
    const source = await resolved(context, candidate);
    if ('problem' in source) {
      return outcome(false, source.problem);
    }
    const target = await resolved(context, destination);
    if ('problem' in target) {
      return outcome(false, target.problem);
    }
    if (source.path === target.path) {
      return outcome(false, `${candidate} is already at that path.`);
    }
    try {
      const info = await stat(source.path);
      if (info.isDirectory()) {
        return outcome(
          false,
          `${candidate} is a folder. move_file moves one file at a time.`,
        );
      }
      if (!info.isFile()) {
        return outcome(false, `${candidate} is not a regular file.`);
      }
      const existing = await stat(target.path).catch(() => undefined);
      if (existing?.isDirectory()) {
        return outcome(
          false,
          `${destination} is a folder. Give move_file a file path.`,
        );
      }
      await mkdir(dirname(target.path), {recursive: true});
      await rename(source.path, target.path);
      return outcome(
        true,
        `${existing === undefined ? 'Moved' : 'Replaced'} ${candidate} → ${destination}.`,
      );
    } catch (error) {
      return outcome(
        false,
        `Could not move "${candidate}": ${describeToolError(error)}`,
      );
    }
  },
});

/**
 * `rename_file`: change a file's name, and nothing else.
 *
 * A separate tool rather than a second way to spell `move_file`, because it is a
 * smaller promise: the file stays in the folder it is already in, keeps its
 * contents, and a name that is taken is a refusal instead of a replacement.
 *
 * That is also why it carries no gate. The card exists for the thing that cannot
 * be undone, and this call has none: it cannot overwrite (it refuses instead) and
 * it cannot leave the folder, so the worst outcome is a name the person can type
 * back. A person who wants renaming without also granting the right to replace a
 * file at a destination has a switch that grants exactly that.
 */
const renameFileTool = asAnyTool({
  name: 'rename_file',
  description:
    'Rename one file inside its own folder. It keeps its contents and its ' +
    'folder, and it refuses a new name that is already taken, so nothing is ' +
    'replaced. Give the new name on its own, with no folder in it. Folders are ' +
    'not renamed.',
  parameters: z.object({
    path: z
      .string()
      .describe('The file to rename, relative to the workspace root.'),
    name: z
      .string()
      .describe(
        'The new name on its own, e.g. "garden.txt". It cannot name a folder.',
      ),
  }),
  requiresWorkspace: true,
  execute: async (
    args: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolOutcome> => {
    const candidate = typeof args.path === 'string' ? args.path : '';
    const name = typeof args.name === 'string' ? args.name.trim() : '';
    if (candidate.length === 0) {
      return outcome(false, 'rename_file needs a path.');
    }
    if (name.length === 0) {
      return outcome(false, 'rename_file needs the new name in "name".');
    }
    /*
     * A name with a separator is a move wearing the wrong word. Refused here
     * rather than quietly folded into a path, because the folder is the whole
     * difference between this tool and `move_file`, and a tool that silently
     * widens what it does is not the narrower switch the person turned on.
     */
    if (name === '.' || name === '..' || /[/\\]/.test(name)) {
      return outcome(
        false,
        `"${name}" is a path, not a name. rename_file keeps the file in its ` +
          'folder: give just the new file name.',
      );
    }
    const source = await resolved(context, candidate);
    if ('problem' in source) {
      return outcome(false, source.problem);
    }
    const target = await resolved(context, join(dirname(source.path), name));
    if ('problem' in target) {
      return outcome(false, target.problem);
    }
    if (source.path === target.path) {
      return outcome(false, `${candidate} is already named that.`);
    }
    try {
      const info = await stat(source.path);
      if (info.isDirectory()) {
        return outcome(
          false,
          `${candidate} is a folder. rename_file renames one file at a time.`,
        );
      }
      if (!info.isFile()) {
        return outcome(false, `${candidate} is not a regular file.`);
      }
      const existing = await stat(target.path).catch(() => undefined);
      if (existing?.isDirectory()) {
        return outcome(
          false,
          `${name} is a folder. Give rename_file a file name.`,
        );
      }
      if (existing !== undefined) {
        /*
         * Named as a refusal rather than described as an overwrite, and it never
         * names the tool that *could* overwrite: that tool may not be granted,
         * and a description that promises it is one the model repeats.
         */
        return outcome(
          false,
          `${name} already exists in that folder. rename_file will not replace ` +
            'it: choose another name, or move the existing file out of the way.',
        );
      }
      await rename(source.path, target.path);
      return outcome(true, `Renamed ${candidate} → ${name}.`);
    } catch (error) {
      return outcome(
        false,
        `Could not rename "${candidate}": ${describeToolError(error)}`,
      );
    }
  },
});

const deleteFileTool = asAnyTool({
  name: 'delete_file',
  description:
    'Delete one file inside the workspace. The person approves every delete, ' +
    'and it cannot be undone. Folders are not deleted.',
  parameters: z.object({
    path: z
      .string()
      .describe('The file to delete, relative to the workspace root.'),
  }),
  gate: 'always',
  requiresWorkspace: true,
  execute: async (
    args: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolOutcome> => {
    const candidate = typeof args.path === 'string' ? args.path : '';
    if (candidate.length === 0) {
      return outcome(false, 'delete_file needs a path.');
    }
    const target = await resolved(context, candidate);
    if ('problem' in target) {
      return outcome(false, target.problem);
    }
    try {
      const info = await stat(target.path);
      if (info.isDirectory()) {
        return outcome(
          false,
          `${candidate} is a folder. delete_file removes one file at a time.`,
        );
      }
      if (!info.isFile()) {
        return outcome(false, `${candidate} is not a regular file.`);
      }
      await unlink(target.path);
      return outcome(true, `Deleted ${candidate}.`);
    } catch (error) {
      return outcome(
        false,
        `Could not delete "${candidate}": ${describeToolError(error)}`,
      );
    }
  },
});

const runShell = asAnyTool({
  name: 'run_shell',
  description:
    'Run a shell command inside the workspace. The user must approve every ' +
    'command. Output is capped at 1 MiB and the command times out after two ' +
    'minutes.',
  parameters: z.object({
    command: z
      .string()
      .describe('The command to run, as a shell would see it.'),
  }),
  gate: 'always',
  requiresWorkspace: true,
  execute: async (
    args: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolOutcome> => {
    const command = typeof args.command === 'string' ? args.command : '';
    if (command.trim().length === 0) {
      return outcome(false, 'run_shell needs a command.');
    }
    if (context.signal.aborted) {
      return outcome(false, 'The command was stopped before it started.');
    }
    return await new Promise<ToolOutcome>((resolve) => {
      exec(
        command,
        {
          cwd: context.workspaceRoot,
          timeout: SHELL_TIMEOUT_MS,
          maxBuffer: MAX_SHELL_OUTPUT,
          signal: context.signal,
        },
        (error, stdout, stderr) => {
          if (context.signal.aborted) {
            resolve(outcome(false, 'The command was stopped.'));
            return;
          }
          const code =
            typeof error?.code === 'number' ? error.code : error ? 1 : 0;
          const timedOut =
            (error as {killed?: boolean; signal?: string} | null)?.killed ===
              true && (error as {signal?: string} | null)?.signal === 'SIGTERM';
          const body = [
            `Exit code: ${code}`,
            stdout.trim().length === 0 ? '' : `stdout:\n${stdout.trim()}`,
            stderr.trim().length === 0 ? '' : `stderr:\n${stderr.trim()}`,
            timedOut ? `[timed out after ${SHELL_TIMEOUT_MS} ms]` : '',
          ]
            .filter((part) => part.length > 0)
            .join('\n');
          resolve(
            outcome(
              code === 0 && !timedOut,
              body.length > 0 ? body : 'The command produced no output.',
            ),
          );
        },
      );
    });
  },
});

export const CORE_TOOLS: readonly AnyToolDefinition[] = [
  currentTime,
  readFile,
  listDir,
  writeFileTool,
  moveFileTool,
  renameFileTool,
  deleteFileTool,
  runShell,
  ...MEMORY_TOOLS,
  ...SKILL_TOOLS,
  askAgentTool,
  startTaskTool,
  ...LEARNING_TOOLS,
  recallTool,
  draftBotTool,
  ...JOB_TOOLS,
  ...WEB_TOOLS,
  ...KNOWLEDGE_TOOLS,
];

/**
 * The tools this harness may actually offer.
 *
 * The grant is the switch, and a workspace tool without a Space is not offered
 * at all: a tool that would fail on every call is a promise the model makes and
 * cannot keep.
 */
export interface ToolAvailability {
  memory?: boolean;
  skills?: boolean;
  delegate?: boolean;
  task?: boolean;
  recall?: boolean;
  jobs?: boolean;
  webSearch?: boolean;
  learning?: boolean;
}

export function toolsFor(
  harness: HarnessSpec,
  available: ToolAvailability = {},
): AnyToolDefinition[] {
  const granted = new Set(harness.tools.grants);
  return CORE_TOOLS.filter((tool) => {
    /*
     * `load_skill` is the reader, and its grant is the skill itself: the
     * library refuses every name the profile did not enable. Requiring a
     * `load_skill` grant as well made it unreachable — the Power preset never
     * names it, so a bot with skills switched on could not open one. The
     * writer, `save_skill`, is still a granted capability.
     */
    const offered =
      tool.name === 'load_skill'
        ? available.skills === true
        : granted.has(tool.name);
    return (
      offered &&
      (tool.requiresWorkspace !== true ||
        harness.workspaceRoot !== undefined) &&
      (tool.requiresMemory !== true || available.memory === true) &&
      (tool.requiresSkills !== true || available.skills === true) &&
      (tool.requiresDelegate !== true || available.delegate === true) &&
      (tool.requiresTask !== true || available.task === true) &&
      (tool.requiresRecall !== true || available.recall === true) &&
      (tool.requiresJobs !== true || available.jobs === true) &&
      (tool.requiresWebSearch !== true || available.webSearch === true) &&
      (tool.requiresLearning !== true || available.learning === true)
    );
  });
}

/** The gate policy for one tool, from the harness. */
export function gateFor(harness: HarnessSpec, toolName: string): GateRule {
  return harness.tools.policy.gates[toolName] ?? 'never';
}
