/**
 * MCP servers, from this agent's side.
 *
 * `client.ts` is one connection to one server; `tools.ts` turns what it offers
 * into tools this agent can call. Neither knows where the configuration came
 * from or where the secrets live — both are handed in — which is what lets the
 * app and the headless runner use the same code with different sources.
 */
export {
  McpError,
  McpServerConnection,
  renderResult,
  sanitiseSchema,
} from './client.js';
export type {
  McpConnectionOptions,
  McpErrorKind,
  McpResolvedSecrets,
  McpToolInfo,
} from './client.js';

export {
  buildMcpToolDefinitions,
  buildMcpTools,
  grantedMcpSources,
  MAX_TOOL_NAME_CHARS,
  McpToolNameError,
  mcpToolNameFor,
} from './tools.js';
export type {McpToolBuildOptions} from './tools.js';
