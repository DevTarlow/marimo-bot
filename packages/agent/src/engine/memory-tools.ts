/**
 * The agent's notebook: read it, correct it, or prune it.
 *
 * None of these takes a path. Memory lives at one app-owned location per
 * profile, so the model cannot aim a memory write at an arbitrary file, and no
 * approval gate is needed for the agent's own notebook.
 *
 * The sentences are the v1 tools' sentences, because a model has learned what
 * they mean and the user has learned what to expect. What changed is only the
 * contract they are built on.
 */
import {z} from 'zod';

import {memorySizeWarning} from '../memory/size.js';
import type {MemoryStore} from '../memory/memory-store.js';
import {
  describeToolError,
  outcome,
  type AnyToolDefinition,
  type ToolContext,
  type ToolOutcome,
} from './tool-contract.js';

function memoryOf(context: ToolContext): MemoryStore | undefined {
  return context.memory;
}

function bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

export const readMemoryTool: AnyToolDefinition = {
  name: 'read_memory',
  description:
    "Return the current contents of the agent's long-term memory — the facts " +
    'about this person and the facts about this workspace, together. The same ' +
    'contents are already in your system prompt, so this is only for re-checking ' +
    'your own recent writes.',
  parameters: z.object({}),
  requiresMemory: true,
  execute: async (_args, context): Promise<ToolOutcome> => {
    const memory = memoryOf(context);
    if (memory === undefined) {
      return outcome(false, 'Memory is not available in this turn.');
    }
    try {
      const text = await memory.read();
      const size = bytes(text);
      const warning = memorySizeWarning(size, memory.softLimitBytes);
      if (text.trim().length === 0) {
        return outcome(
          true,
          `Memory is empty (${memory.location}). Use update_memory to record durable facts.`,
        );
      }
      return outcome(
        true,
        `${memory.location} (${size} bytes)\n\n${text}${warning ? `\n\n${warning}` : ''}`,
      );
    } catch (error) {
      return outcome(
        false,
        `Could not read memory: ${describeToolError(error)}`,
      );
    }
  },
};

export const updateMemoryTool: AnyToolDefinition = {
  name: 'update_memory',
  description:
    'Add, correct or replace a fact in long-term memory. Use it for durable ' +
    'things a future session should know: who the user is, how they want to be ' +
    'talked to, what they have asked you never to do — and, separately, this ' +
    "project's conventions, paths and quirks. When the user corrects something " +
    'you already remembered, pass the old bullet as "replaces" so the wrong ' +
    'version does not stay behind. Never store secrets, credentials, or ' +
    'transient output. Duplicate facts are dropped rather than repeated.',
  parameters: z.object({
    content: z
      .string()
      .min(1)
      .describe(
        'The fact to remember. One fact per line; each line becomes a bullet.',
      ),
    section: z
      .string()
      .optional()
      .describe(
        'Layer to write into, e.g. "About the user", "Preferences and tone", ' +
          '"Environment and conventions", "Project pointers", "Boundaries". ' +
          'Defaults to "Notes".',
      ),
    scope: z
      .enum(['person', 'workspace'])
      .optional()
      .describe(
        'Which memory this belongs in, for a layer the list does not name. ' +
          '"person" is true everywhere the user goes; "workspace" is true only ' +
          'inside the folder you are working in. Leave it out to let the section decide.',
      ),
    mode: z
      .enum(['append', 'replace'])
      .optional()
      .describe(
        'append (default) adds facts that are not already present; replace rewrites the whole section.',
      ),
    replaces: z
      .string()
      .optional()
      .describe(
        'When correcting a fact, the existing bullet to remove first — either ' +
          'the whole bullet or a leading substring of it, in the same section.',
      ),
  }),
  requiresMemory: true,
  execute: async (args, context): Promise<ToolOutcome> => {
    const memory = memoryOf(context);
    if (memory === undefined) {
      return outcome(false, 'Memory is not available in this turn.');
    }
    try {
      const report = await memory.update({
        content: String(args.content ?? ''),
        ...(typeof args.section === 'string' ? {section: args.section} : {}),
        ...(args.scope === 'person' || args.scope === 'workspace'
          ? {scope: args.scope}
          : {}),
        ...(args.mode === 'append' || args.mode === 'replace'
          ? {mode: args.mode}
          : {}),
        ...(typeof args.replaces === 'string' ? {replaces: args.replaces} : {}),
      });
      const size = bytes(report.content);
      const section =
        typeof args.section === 'string' && args.section.trim().length > 0
          ? args.section.trim()
          : 'Notes';
      let sentence: string;
      switch (report.supersede.outcome) {
        case 'removed':
          sentence = `Updated memory (now ${size} bytes). Replaced "${report.supersede.removed}". The new contents are in your prompt on the next request.`;
          break;
        case 'absent':
          sentence = `Updated memory (now ${size} bytes), but nothing in "${section}" matched "${String(args.replaces ?? '')}" so no old bullet was removed. The fact you were correcting may still be there under other words; check read_memory and retry if so.`;
          break;
        case 'ambiguous':
          sentence = `Updated memory (now ${size} bytes), but "${String(args.replaces ?? '')}" matched ${String(report.supersede.matches ?? 0)} bullets, so none was removed. Pass more of the bullet you mean, or use mode "replace" to rewrite the section.`;
          break;
        default:
          sentence = `Updated memory (now ${size} bytes). The new contents are in your prompt on the next request.`;
      }
      const warning = memorySizeWarning(size, memory.softLimitBytes);
      return outcome(
        true,
        warning.length > 0 ? `${sentence}\n\n${warning}` : sentence,
      );
    } catch (error) {
      return outcome(
        false,
        `Could not update memory: ${describeToolError(error)}`,
      );
    }
  },
};

export const pruneMemoryTool: AnyToolDefinition = {
  name: 'prune_memory',
  description:
    'Replace memory with a deduplicated, summarised rewrite: drop what is ' +
    'outdated or no longer true, merge repeats, and keep everything that still ' +
    'matters. Send the *whole* document — every layer you mean to keep, ' +
    'including the ones about the person. A layer you leave out is kept only if ' +
    'it is a person-level layer, and you are told when that happened. The ' +
    'previous contents are kept as memory.md.bak.',
  parameters: z.object({
    content: z
      .string()
      .min(1)
      .describe(
        'The complete replacement document, in the same markdown shape as the current memory.',
      ),
    reason: z
      .string()
      .optional()
      .describe('One line on why the prune was needed.'),
  }),
  requiresMemory: true,
  execute: async (args, context): Promise<ToolOutcome> => {
    const memory = memoryOf(context);
    if (memory === undefined) {
      return outcome(false, 'Memory is not available in this turn.');
    }
    try {
      const before = await memory.read();
      const report = await memory.prune({
        content: String(args.content ?? ''),
        ...(typeof args.reason === 'string' ? {reason: args.reason} : {}),
      });
      const kept = report.personUntouched
        ? '\n\nThe rewrite named no person-level layer (About the user, Preferences and tone, Boundaries), so that half of memory was left exactly as it was. Include those sections in the document if you meant to rewrite them too.'
        : '';
      const reason =
        typeof args.reason === 'string' && args.reason.length > 0
          ? ` Reason: ${args.reason}`
          : '';
      return outcome(
        true,
        `Pruned memory (${bytes(before)} → ${bytes(report.content)} bytes). Previous contents kept as memory.md.bak.${reason}${kept}`,
      );
    } catch (error) {
      return outcome(
        false,
        `Could not prune memory: ${describeToolError(error)}`,
      );
    }
  },
};

export const MEMORY_TOOLS: readonly AnyToolDefinition[] = [
  readMemoryTool,
  updateMemoryTool,
  pruneMemoryTool,
];
