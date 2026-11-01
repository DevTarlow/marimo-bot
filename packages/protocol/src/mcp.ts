/**
 * MCP servers: what one is, as the user configures it.
 *
 * These documents live in the contract rather than in the agent because they are
 * *stored* — the Settings window writes them, the main process holds them, and
 * the agent is handed one at connect time. Keeping the shape here is what stops
 * the window and the connection from disagreeing about what a field means.
 */
import {z} from 'zod';

/**
 * How a connector's secret is stored.
 *
 * `keychain` is the default: the OS encrypts it at rest. `plaintext` is the
 * per-connector consent that lets a scheduled job read it while the app is
 * closed, because the runner has no `app` object and therefore no keychain. The
 * two values used to live beside the provider catalogue; the catalogue is gone
 * and the choice is still the connector's own.
 */
export const secretStorageSchema = z.enum(['keychain', 'plaintext']);
export type SecretStorage = z.infer<typeof secretStorageSchema>;

/**
 * The characters a server name may use, and why they are so few.
 *
 * The name is not decoration: it becomes the prefix of every tool the server
 * offers (`mcp_<name>_<tool>`), and that name has to be a legal function name
 * for the model's API. Restricting it here means the prefix never needs
 * escaping, truncating or repairing later — the validation happens where the
 * user can still be told about it.
 *
 * Thirty-two characters, because the model-facing limit is 64 and the tool's own
 * name has to fit in what is left.
 */
export const MCP_SERVER_NAME_PATTERN = /^[a-z0-9][a-z0-9_]{0,31}$/u;

export const MCP_SERVER_NAME_HELP =
  'Lower-case letters, digits and underscores, up to 32 characters. ' +
  'It prefixes every tool the server offers.';

/**
 * How a server is reached.
 *
 * `stdio` spawns a command on this machine; `http` talks to an endpoint, which
 * may be local or remote. There is no third option on purpose: the SDK's
 * deprecated two-endpoint SSE transport is not something a new install should be
 * configured into.
 */
export const mcpTransportSchema = z.enum(['stdio', 'http']);
export type McpTransport = z.infer<typeof mcpTransportSchema>;

/**
 * A name whose value lives in the secret store rather than in this document.
 *
 * `target` says where the value is used when the server is started: injected
 * into its environment, or sent as a request header. The value itself is stored
 * separately and never travels to the window — the document records that a
 * secret *exists*, and where it goes, not what it is.
 */
export const mcpSecretRefSchema = z.object({
  target: z.enum(['env', 'header']),
  name: z
    .string()
    .trim()
    .min(1)
    .max(128)
    .describe('The environment variable or header name, e.g. "Authorization".'),
});

export type McpSecretRef = z.infer<typeof mcpSecretRefSchema>;

/**
 * The shape an endpoint has to have, without a URL parser.
 *
 * `new URL` would say this better, and it is not available: this package is
 * deliberately environment-neutral (`lib: ES2023`, no Node and no DOM types), so
 * that the main process, the renderer and the headless runner can all import it.
 * Pulling in a whole environment's type surface to validate one field would be
 * the wrong trade.
 *
 * This catches the mistakes a form actually makes — no scheme, the wrong scheme,
 * whitespace in the middle — and leaves the rest to the connection, which
 * reports what the server said about a URL it could not use.
 */
const HTTP_URL_PATTERN = /^https?:\/\/\S+$/iu;

export const mcpServerSchema = z
  .object({
    /** Stable identity. `mcp:<name>` when it names a server, so deletes and edits survive a rename. */
    id: z.string().trim().min(1),
    name: z
      .string()
      .trim()
      .regex(MCP_SERVER_NAME_PATTERN, MCP_SERVER_NAME_HELP),
    transport: mcpTransportSchema,
    /**
     * The executable to run, as one path or command name.
     *
     * Deliberately separate from `args` rather than one command line: splitting
     * a line on whitespace breaks the first time somebody's path contains a
     * space, and there is no way to quote around it after the fact.
     */
    command: z.string().trim().max(1_024).optional(),
    /** Its arguments, in order, each passed through untouched. */
    args: z.array(z.string().max(2_048)).max(64).optional(),
    /** Extra environment for a stdio server, for values that are not secrets. */
    env: z.record(z.string().max(128), z.string().max(4_096)).optional(),
    /** The endpoint for an HTTP server. */
    url: z.string().trim().max(2_048).optional(),
    /** Extra request headers for an HTTP server, for values that are not secrets. */
    headers: z.record(z.string().max(128), z.string().max(4_096)).optional(),
    /** Names whose values are in the secret store. */
    secrets: z.array(mcpSecretRefSchema).max(32).optional(),
    /*
     * How this connector's secrets are stored on disk.
     *
     * The same per-connector choice a provider's key has, and for the same
     * reason: a job runs in a process with no `app` object and therefore no
     * keychain, so a connector whose secret a scheduled job is meant to use has
     * to be readable by a process that has none. `plaintext` is the user saying
     * they accept that for *this* server; a machine with a keychain still writes
     * readable when asked, because silently encrypting anyway would be the app
     * deciding it knows better and the job would fail without saying why.
     *
     * Defaulted rather than required, and each half is doing work. Optional in
     * the *file*, because every connectors list written before this choice
     * existed has no such field, and a required one would fail the whole settings
     * schema for those installs — costing the user every other setting they had.
     * Answered by the parse, because the default has to be the same answer
     * everywhere an entry is read: `keychain`, the safe one, so an old entry does
     * not become readable because a later build asked the question and a machine
     * with no keychain refuses to store a secret rather than writing a token in
     * the clear.
     */
    secretStorage: secretStorageSchema.default('keychain'),
    /** Connect at launch, and reconnect when it drops. */
    enabled: z.boolean(),
    /**
     * Run its tools without asking.
     *
     * Off by default, and the default is the feature: an MCP server is software
     * the user did not write, offering tools that can do anything the process
     * can. Until they say otherwise, every call from it takes the same approval
     * path as `write_file` — one gate, not a second kind.
     */
    trusted: z.boolean(),
  })
  .superRefine((server, context) => {
    /*
     * The transport decides which fields are required, and the complaint is
     * attached to the field the user has to fill in rather than to the object —
     * a message on the whole form is a message about nothing in particular.
     */
    if (server.transport === 'stdio') {
      if (server.command === undefined || server.command.length === 0) {
        context.addIssue({
          code: 'custom',
          path: ['command'],
          message: 'A stdio server needs a command to run.',
        });
      }
      return;
    }

    if (server.url === undefined || server.url.length === 0) {
      context.addIssue({
        code: 'custom',
        path: ['url'],
        message: 'An HTTP server needs a URL.',
      });
      return;
    }

    if (!HTTP_URL_PATTERN.test(server.url)) {
      context.addIssue({
        code: 'custom',
        path: ['url'],
        message: 'The URL has to start with http:// or https://.',
      });
    }
  });

export type McpServer = z.infer<typeof mcpServerSchema>;

/*
 * There is no `mcpServersFileSchema` here, because MCP servers do not have a
 * file of their own: they are a list inside the settings document, beside the
 * Discord connection and for the same reason — one settings file, one place a
 * stale window can overwrite, one thing to migrate.
 *
 * The uniqueness rules that a per-file schema would have held live in
 * `settingsSchema`'s refinement, where the whole list is visible. They are worth
 * stating because they are not cosmetic: two servers with one name would offer
 * two sets of identically-named tools, and the second would silently shadow the
 * first.
 */

/**
 * The tool name a server's tool is offered under.
 *
 * Namespaced because the model sees one flat list: without the prefix, a
 * filesystem server's `read_file` and this app's own `read_file` would be two
 * different tools with one name, and the model would have no way to say which it
 * meant.
 */
export function mcpToolName(serverName: string, toolName: string): string {
  // The server's own name is bounded by the schema above; the tool's is whatever
  // the server calls it, so it is the part that needs folding.
  const safe = toolName.replace(/[^A-Za-z0-9_-]/gu, '_');
  return `${mcpToolPrefix(serverName)}${safe}`;
}

/** The fixed beginning of every tool name a server offers. */
export function mcpToolPrefix(serverName: string): string {
  return `mcp_${serverName}_`;
}

/**
 * Two servers may not share a name, and two may not share an id.
 *
 * Called from the settings schema rather than from the server schema, because
 * neither rule is a property of one entry — it takes the whole list to see a
 * duplicate.
 */
export function mcpServersAreDistinct(
  servers: readonly McpServer[],
): Array<{index: number; field: 'name' | 'id'; message: string}> {
  const byName = new Map<string, number>();
  const byId = new Map<string, number>();
  const problems: Array<{index: number; field: 'name' | 'id'; message: string}> =
    [];

  for (const [index, server] of servers.entries()) {
    if (byName.has(server.name)) {
      problems.push({
        index,
        field: 'name',
        message:
          `"${server.name}" is already used by another server. Two servers with ` +
          'one name would offer two tools with one name, and the second would ' +
          'silently shadow the first.',
      });
    } else {
      byName.set(server.name, index);
    }

    if (byId.has(server.id)) {
      problems.push({
        index,
        field: 'id',
        message:
          'Two servers cannot share an id — an edit or a delete would not know ' +
          'which one was meant.',
      });
    } else {
      byId.set(server.id, index);
    }
  }

  return problems;
}
