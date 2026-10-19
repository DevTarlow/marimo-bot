/**
 * Literal search over the Space, as a v2 tool.
 *
 * The walk is the same one recall indexes, so a file the agent can recall is a
 * file it can also quote. Matching is a substring test, not a regex: the query is
 * model-authored, and handing an arbitrary pattern to a regex engine is a
 * denial-of-service primitive.
 */
import {z} from 'zod';

import {searchWorkspace} from '../tools/knowledge-tools.js';
import {
  describeToolError,
  outcome,
  type AnyToolDefinition,
  type ToolOutcome,
} from './tool-contract.js';

export const searchKnowledgeBaseTool: AnyToolDefinition = {
  name: 'search_knowledge_base',
  description:
    'Find where a literal word or phrase appears in the workspace. Use it when ' +
    'you know the identifier or wording; use recall when you know only what a ' +
    'thing is about. The walk is bounded and says when a cap stopped it.',
  parameters: z.object({
    query: z.string().describe('The literal text to find, case-insensitive by default.'),
    start: z
      .string()
      .optional()
      .describe('File or folder to search, relative to the workspace root.'),
    maxResults: z.number().int().positive().max(50).optional(),
    caseSensitive: z.boolean().optional(),
  }),
  requiresWorkspace: true,
  execute: async (args, context): Promise<ToolOutcome> => {
    const query = String(args.query ?? '').trim();
    if (query.length === 0) {
      return outcome(false, 'search_knowledge_base needs a query.');
    }
    if (context.workspaceRoot.length === 0) {
      return outcome(false, 'There is no workspace to search.');
    }
    try {
      const found = await searchWorkspace(context.workspaceRoot, {
        query,
        ...(typeof args.start === 'string' ? {start: args.start} : {}),
        ...(typeof args.maxResults === 'number'
          ? {maxResults: args.maxResults}
          : {}),
        ...(typeof args.caseSensitive === 'boolean'
          ? {caseSensitive: args.caseSensitive}
          : {}),
      });
      if (found.matches.length === 0) {
        return outcome(
          true,
          `No matches for "${query}" in ${String(found.filesScanned)} file${found.filesScanned === 1 ? '' : 's'}.${
            found.truncated ? '\n[the walk was capped before it finished]' : ''
          }`,
        );
      }
      const lines = found.matches.map(
        (match) => `${match.file}:${String(match.line)}: ${match.text}`,
      );
      return outcome(
        true,
        `${found.matches.length} match${found.matches.length === 1 ? '' : 'es'} for "${query}" in ${String(found.filesScanned)} file${found.filesScanned === 1 ? '' : 's'}\n\n${lines.join('\n')}${
          found.truncated
            ? '\n[the result was capped; narrow the query or the start path for the rest]'
            : ''
        }`,
      );
    } catch (error) {
      return outcome(false, `Could not search: ${describeToolError(error)}`);
    }
  },
};

export const KNOWLEDGE_TOOLS: readonly AnyToolDefinition[] = [
  searchKnowledgeBaseTool,
];
