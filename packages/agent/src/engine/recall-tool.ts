/**
 * `recall`: find something by what it means.
 *
 * The result is deliberately honest about coverage: a cap that stopped the list,
 * a corpus that was not searched, an index that is behind. A model that reads a
 * short list as "the folder holds only this" is the failure the notes exist for.
 */
import {z} from 'zod';

import type {RecallHit} from '../tools/recall-tools.js';
import {
  outcome,
  type AnyToolDefinition,
  type ToolOutcome,
} from './tool-contract.js';

const DEFAULT_HITS = 8;
const MAX_OUTPUT_CHARS = 8 * 1024;
const MAX_HIT_CHARS = 1_200;

export const recallTool: AnyToolDefinition = {
  name: 'recall',
  description:
    'Find things by what they mean rather than by matching words: files in the ' +
    'workspace, your own long-term memory, and what was said in earlier ' +
    'conversations. Use it when you know what you are looking for but not the ' +
    'words the answer uses. Results carry their own text; a result marked as ' +
    'changed has to be read with read_file instead.',
  parameters: z.object({
    query: z
      .string()
      .describe('What you are looking for, as a question or a description.'),
    scope: z
      .enum(['folder', 'memory', 'conversation'])
      .optional()
      .describe(
        'Limit the search to one corpus. Omit to search what is available.',
      ),
  }),
  requiresRecall: true,
  execute: async (args, context): Promise<ToolOutcome> => {
    const recall = context.recall;
    if (recall === undefined) {
      return outcome(false, 'Recall is not available in this turn.');
    }
    const query = String(args.query ?? '').trim();
    if (query.length === 0) {
      return outcome(false, 'recall needs a query.');
    }
    const available = recall.scopes();
    const scope = typeof args.scope === 'string' ? args.scope : undefined;
    if (
      scope !== undefined &&
      !available.includes(scope as (typeof available)[number])
    ) {
      return outcome(
        false,
        `This install has not indexed "${scope}". It can search: ${available.join(', ')}.`,
      );
    }
    try {
      const answer = await recall.search({
        query,
        ...(scope === undefined
          ? {}
          : {scopes: [scope as (typeof available)[number]]}),
        limit: DEFAULT_HITS,
      });
      return outcome(
        true,
        render(query, answer.hits, answer.searched, answer.notes),
      );
    } catch (error) {
      return outcome(
        false,
        `Could not search: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  },
};

function render(
  query: string,
  hits: readonly RecallHit[],
  searched: readonly string[],
  notes: readonly string[],
): string {
  const where = searched.length === 0 ? '' : ` in ${searched.join(' and ')}`;
  const allNotes = [...notes];
  if (hits.length === 0) {
    return `Nothing found for "${query}"${where}.${
      allNotes.length > 0 ? `\n[${allNotes.join('; ')}]` : ''
    }`;
  }
  const lines: string[] = [];
  let used = 0;
  let shown = 0;
  for (const hit of hits) {
    const head = `${whereOf(hit)} (${hit.score.toFixed(2)})`;
    const body = hit.stale
      ? '  [changed since it was indexed — read it with read_file]'
      : indent(hit.text.slice(0, MAX_HIT_CHARS));
    const block = `${head}\n${body}`;
    if (used + block.length > MAX_OUTPUT_CHARS) {
      break;
    }
    lines.push(block);
    used += block.length + 1;
    shown += 1;
  }
  if (shown < hits.length) {
    allNotes.push(
      'the answer was cut at its size cap; narrow the question for the rest',
    );
  }
  return `${hits.length} result${hits.length === 1 ? '' : 's'} for "${query}"${where}\n\n${lines.join('\n\n')}${
    allNotes.length > 0 ? `\n[${allNotes.join('; ')}]` : ''
  }`;
}

function whereOf(hit: RecallHit): string {
  switch (hit.kind) {
    case 'memory':
      return `memory${hit.section === undefined ? '' : ` / ${hit.section}`}`;
    case 'conversation':
      return `conversation${hit.title === undefined ? '' : ` "${hit.title}"`}`;
    case 'media':
      return `media ${hit.path}`;
    default:
      return hit.startLine === undefined
        ? hit.path
        : `${hit.path}:${String(hit.startLine)}`;
  }
}

function indent(text: string): string {
  return text
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n');
}
