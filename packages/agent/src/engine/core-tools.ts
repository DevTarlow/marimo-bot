/**
 * The tools a turn can be offered in v2, before any profile grant is applied.
 *
 * This is the Phase 1 set: enough to read, create and replace a file, list a
 * folder, ask the time, and run a command behind the strongest gate. The
 * memory, skill, job, recall and connector tools follow with their stores.
 *
 * Every file path goes through `resolveInsideWorkspace`, the same guard the v1
 * tools used, so `..`, an absolute path and a symlink that leaves the Space are
 * one refusal with one sentence.
 */
import {exec} from 'node:child_process';
import {mkdir, open, readdir, stat, writeFile} from 'node:fs/promises';
import {dirname} from 'node:path';

import {z} from 'zod';

import type {GateRule, HarnessSpec} from '../harness/spec.js';
import {draftBotTool} from './bot-tools.js';
import {askAgentTool} from './delegation-tools.js';
import {MEMORY_TOOLS} from './memory-tools.js';
import {JOB_TOOLS} from './job-tools.js';
import {recallTool} from './recall-tool.js';
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
    'Write UTF-8 text to a file inside the workspace, replacing it if it exists ' +
    'or creating it and its parent folders if it does not. Replacing an existing ' +
    'file requires approval. Output is capped at 1 MiB.',
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
  runShell,
  ...MEMORY_TOOLS,
  ...SKILL_TOOLS,
  askAgentTool,
  recallTool,
  draftBotTool,
  ...JOB_TOOLS,
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
  recall?: boolean;
  jobs?: boolean;
}

export function toolsFor(
  harness: HarnessSpec,
  available: ToolAvailability = {},
): AnyToolDefinition[] {
  const granted = new Set(harness.tools.grants);
  return CORE_TOOLS.filter(
    (tool) =>
      granted.has(tool.name) &&
      (tool.requiresWorkspace !== true ||
        harness.workspaceRoot !== undefined) &&
      (tool.requiresMemory !== true || available.memory === true) &&
      (tool.requiresSkills !== true || available.skills === true) &&
      (tool.requiresDelegate !== true || available.delegate === true) &&
      (tool.requiresRecall !== true || available.recall === true) &&
      (tool.requiresJobs !== true || available.jobs === true),
  );
}

/** The gate policy for one tool, from the harness. */
export function gateFor(harness: HarnessSpec, toolName: string): GateRule {
  return harness.tools.policy.gates[toolName] ?? 'never';
}
