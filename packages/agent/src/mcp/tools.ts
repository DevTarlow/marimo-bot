/**
 * An MCP server's tools, as tools this agent can offer.
 *
 * Three things happen here, and each exists because of a way the naive version
 * goes wrong:
 *
 * 1. **Names are namespaced and collisions are refused.** The model sees one
 *    flat list of tools, so a filesystem server's `read_file` and this app's own
 *    `read_file` cannot both be called that. Names are prefixed
 *    (`mcp_<server>_<tool>`), and if two of them still land on the same name the
 *    connection fails loudly rather than letting the later one quietly shadow the
 *    earlier.
 * 2. **Gating is per server, through the same mechanism as everything else.** An
 *    untrusted server's tools are `requireConfirmation`, which is exactly what
 *    `write_file` and `run_shell` are — one kind of approval in this app, not a
 *    second one that behaves slightly differently.
 * 3. **Failures come back as text.** A server that has died is a routine,
 *    recoverable condition, and the model can act on "the server is not
 *    connected" — tell the user, try something else. Throwing would end the whole
 *    turn instead, which is the wrong size of response to a dropped pipe.
 */
import {FunctionTool} from '@google/adk';

import {mcpToolPrefix} from '@marimo/protocol';
import type {McpServer} from '@marimo/protocol';

import type {McpServerConnection, McpToolInfo} from './client.js';
import {McpError} from './client.js';
import {outcome} from '../engine/tool-contract.js';
import type {AnyToolDefinition} from '../engine/tool-contract.js';

/**
 * The longest tool name the model's API accepts.
 *
 * OpenAI-compatible endpoints cap function names at 64 characters, and a name
 * over the limit is refused at request time — which fails the entire turn, with
 * a complaint about the tool list rather than about the server that caused it.
 */
export const MAX_TOOL_NAME_CHARS = 64;

/**
 * The connectors a harness may use.
 *
 * `all` is every connected server, which is what a profile written before the
 * field existed carries. An array is the grant, and an empty array is a real
 * answer: this bot may use none of them. The filter is here rather than in the
 * runtime so the rule can be tested without a turn.
 */
export function grantedMcpSources<Source extends {server: {id: string}}>(
  granted: readonly string[] | 'all',
  sources: readonly Source[],
): Source[] {
  return granted === 'all'
    ? [...sources]
    : sources.filter((source) => granted.includes(source.server.id));
}

export interface McpToolBuildOptions {
  server: McpServer;
  connection: McpServerConnection;
  tools: readonly McpToolInfo[];
  /**
   * Names this app's own tools already use.
   *
   * Passed in rather than imported so this module does not have to know what the
   * rest of the tool set is; whoever assembles the final list is the one that
   * can see all of it.
   */
  reserved?: ReadonlySet<string>;
}

/**
 * Raised when a server's tools cannot be offered under distinct names.
 *
 * A configuration error, not a runtime one: it is fixed by renaming the server
 * or by not connecting it, and it is reported at connect time so the user finds
 * out while they are still looking at the form.
 */
export class McpToolNameError extends Error {
  constructor(
    readonly serverName: string,
    readonly detail: string,
  ) {
    super(`The MCP server "${serverName}" cannot be connected: ${detail}`);
    this.name = 'McpToolNameError';
  }
}

export function buildMcpTools(options: McpToolBuildOptions): FunctionTool[] {
  return planMcpTools(options).map((planned) =>
    createTool({
      server: options.server,
      connection: options.connection,
      tool: planned.tool,
      name: planned.name,
    }),
  );
}

/**
 * The same tools as engine definitions, for the v2 turn path.
 *
 * The two builders share the naming and collision rules rather than restating
 * them: a name that one path refuses must be refused by the other, or a
 * connector would work in an old conversation and fail in a new one.
 */
export function buildMcpToolDefinitions(
  options: McpToolBuildOptions,
): AnyToolDefinition[] {
  return planMcpTools(options).map((planned) =>
    createDefinition({
      server: options.server,
      connection: options.connection,
      tool: planned.tool,
      name: planned.name,
    }),
  );
}

interface PlannedMcpTool {
  tool: McpToolInfo;
  name: string;
}

/** Every tool with the name it will be offered under, or a collision error. */
function planMcpTools(options: McpToolBuildOptions): PlannedMcpTool[] {
  const {server, tools} = options;
  const reserved = options.reserved ?? new Set<string>();
  const taken = new Map<string, string>();
  const planned: PlannedMcpTool[] = [];

  for (const tool of tools) {
    const name = mcpToolNameFor(server.name, tool.name);

    if (reserved.has(name)) {
      throw new McpToolNameError(
        server.name,
        `its tool "${tool.name}" would be offered as "${name}", and this app ` +
          'already has a tool with that name. Rename the server.',
      );
    }

    const existing = taken.get(name);
    if (existing !== undefined) {
      throw new McpToolNameError(
        server.name,
        `two of its tools ("${existing}" and "${tool.name}") would both be ` +
          `offered as "${name}". One would silently replace the other.`,
      );
    }
    taken.set(name, tool.name);
    planned.push({tool, name});
  }

  return planned;
}

/**
 * The name one of a server's tools is offered under.
 *
 * The prefix is never truncated — it is what tells the model which server a tool
 * came from, and losing it would make two servers' tools indistinguishable. When
 * the server's own name is too long to fit, it is folded and given a short hash of
 * the original, so two long names cannot fold onto one.
 */
export function mcpToolNameFor(
  serverName: string,
  toolName: string,
): string {
  const prefix = mcpToolPrefix(serverName);
  const safe = foldToolName(toolName);
  const whole = `${prefix}${safe}`;

  if (whole.length <= MAX_TOOL_NAME_CHARS) {
    return whole;
  }

  const suffix = shortHash(toolName);
  const room = MAX_TOOL_NAME_CHARS - prefix.length - suffix.length - 1;
  /*
   * `room` can go non-positive if a server's own name is long enough to fill the
   * budget. The schema bounds that name at 32 characters, so this is a guard
   * against a hand-edited file rather than a reachable state — and it still has
   * to produce a usable name rather than `mcp_x_-1a3f`.
   */
  const trimmed = safe.slice(0, Math.max(room, 0));
  return `${prefix}${trimmed}${trimmed.length > 0 ? '_' : ''}${suffix}`;
}

/** Everything outside the safe set becomes an underscore. */
function foldToolName(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]/gu, '_');
}

/**
 * Four base-36 characters of FNV-1a.
 *
 * Not a security hash and not trying to be: its job is to keep two long tool
 * names from folding onto one another, and 1.6 million values is far more than
 * any real server's tool list will need.
 */
function shortHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36).padStart(4, '0').slice(-4);
}

/**
 * The words the model sees for a connector's tool.
 *
 * The server's own description is followed by a note about who is offering it.
 * Without it the model cannot tell that this tool is not part of the app, which
 * matters when explaining to the user where an answer came from — and matters
 * more when the user is deciding whether to trust it.
 */
function describeMcpTool(server: McpServer, tool: McpToolInfo): string {
  return [
    tool.description.trim().length > 0
      ? tool.description.trim()
      : `The tool "${tool.name}" from the MCP server "${server.name}".`,
    `Offered by the MCP server "${server.name}"${server.trusted ? '' : ', which you have not been told to trust: every call needs the user\'s approval'}.`,
  ].join('\n\n');
}

function createDefinition(options: {
  server: McpServer;
  connection: McpServerConnection;
  tool: McpToolInfo;
  name: string;
}): AnyToolDefinition {
  const {server, connection, tool, name} = options;
  return {
    name,
    description: describeMcpTool(server, tool),
    /*
     * The adapter hands a non-Zod object to the declaration unchanged, the same
     * way the v1 builder does. A connector's schema arrives as JSON because that
     * is the protocol's language; converting it to Zod would be a second parser
     * for a shape the server already described.
     */
    parameters: tool.inputSchema as never,
    /*
     * The gate is the definition's, and the harness policy may only strengthen
     * it. An untrusted server's every call is a card; a trusted one's is not,
     * unless the person has added a stronger rule for that tool.
     */
    gate: server.trusted ? 'never' : 'always',
    execute: async (args) => {
      try {
        return outcome(true, await connection.callTool(tool.name, args));
      } catch (error) {
        const detail =
          error instanceof McpError
            ? error.message
            : error instanceof Error
              ? error.message
              : String(error);
        /*
         * In-band: a dropped connector is something to report and carry on
         * from, not something to end the turn over.
         */
        return outcome(
          false,
          `The MCP server "${server.name}" could not run "${tool.name}": ${detail}`,
        );
      }
    },
  };
}

function createTool(options: {
  server: McpServer;
  connection: McpServerConnection;
  tool: McpToolInfo;
  name: string;
}): FunctionTool {
  const {server, connection, tool, name} = options;

  const description = describeMcpTool(server, tool);

  return new FunctionTool({
    name,
    description,
    // The sanitised JSON Schema, passed through: `FunctionTool` hands a
    // non-Zod object to the declaration unchanged, and the OpenAI mapping
    // normalises it again on the way out.
    parameters: tool.inputSchema as never,
    /*
     * The gate. A trusted server runs freely; an untrusted one asks every time,
     * through the same confirmation flow `write_file` uses, so the approval card
     * the user sees is one they already know how to read.
     */
    requireConfirmation: !server.trusted,
    execute: async (args: unknown) => {
      try {
        return await connection.callTool(tool.name, args);
      } catch (error) {
        /*
         * In-band, not thrown: a dropped server is something to report and
         * carry on from, not something to end the turn over.
         */
        if (error instanceof McpError) {
          return `The MCP server "${server.name}" could not run "${tool.name}": ${error.message}`;
        }
        const detail = error instanceof Error ? error.message : String(error);
        return `The MCP server "${server.name}" could not run "${tool.name}": ${detail}`;
      }
    },
  });
}
