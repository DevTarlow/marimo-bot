/**
 * An MCP server's tools, as the model ends up seeing them.
 *
 * Three properties are tested here and each is a way this goes wrong quietly:
 * the name the model is offered (because a collision silently replaces a tool),
 * whether the call is gated (because getting that wrong is a security bug that
 * looks like convenience), and what a dead server produces (because it is the
 * common case, not the exceptional one).
 */
import {describe, expect, it} from 'vitest';

import type {McpServer} from '@marimo/protocol';

import {McpError} from './client.js';
import type {McpServerConnection, McpToolInfo} from './client.js';
import {
  buildMcpToolDefinitions,
  buildMcpTools,
  grantedMcpSources,
  MAX_TOOL_NAME_CHARS,
  McpToolNameError,
  mcpToolNameFor,
} from './tools.js';

function server(overrides: Partial<McpServer> = {}): McpServer {
  return {
    id: 'mcp:notes',
    name: 'notes',
    transport: 'stdio',
    command: 'notes-server',
    args: [],
    enabled: true,
    secretStorage: 'keychain',
    trusted: false,
    ...overrides,
  };
}

function tool(name: string, inputSchema: Record<string, unknown> = {}): McpToolInfo {
  return {name, description: `${name} does a thing.`, inputSchema};
}

/** The part of a connection the tool layer uses. */
function connection(
  call: (name: string, args: unknown) => Promise<string>,
): McpServerConnection {
  return {callTool: call} as unknown as McpServerConnection;
}

describe('mcpToolNameFor', () => {
  it('namespaces a tool under its server', () => {
    expect(mcpToolNameFor('notes', 'search')).toBe('mcp_notes_search');
  });

  it('folds the characters a function name cannot contain', () => {
    // Servers name tools with slashes, dots and colons; the endpoint accepts
    // only letters, digits, underscores and dashes.
    expect(mcpToolNameFor('fs', 'read/file.txt')).toBe('mcp_fs_read_file_txt');
    expect(mcpToolNameFor('fs', 'ns:do.thing')).toBe('mcp_fs_ns_do_thing');
  });

  it('stays inside the length the endpoints accept', () => {
    const long = mcpToolNameFor('notes', 'a'.repeat(200));
    expect(long.length).toBeLessThanOrEqual(MAX_TOOL_NAME_CHARS);
  });

  it('keeps the server prefix when folding a long name', () => {
    // The prefix is what says which server a tool came from. Losing it would
    // make two servers' tools indistinguishable in the list the model sees.
    const folded = mcpToolNameFor('notes', 'x'.repeat(200));
    expect(folded.startsWith('mcp_notes_')).toBe(true);
  });

  it('gives two long names different results', () => {
    // Truncation alone would map both of these onto one name, and the second
    // would silently replace the first.
    const first = mcpToolNameFor('notes', 'a'.repeat(200));
    const second = mcpToolNameFor('notes', `${'a'.repeat(199)}b`);
    expect(first).not.toBe(second);
  });

  it('is stable for a given name', () => {
    expect(mcpToolNameFor('notes', 'x'.repeat(200))).toBe(
      mcpToolNameFor('notes', 'x'.repeat(200)),
    );
  });
});

describe('buildMcpTools', () => {
  it('builds one tool per server tool', () => {
    const tools = buildMcpTools({
      server: server(),
      connection: connection(async () => 'ok'),
      tools: [tool('search'), tool('write')],
    });
    expect(tools.map((entry) => entry.name)).toEqual([
      'mcp_notes_search',
      'mcp_notes_write',
    ]);
  });

  it('carries the server description into what the model reads', () => {
    const [built] = buildMcpTools({
      server: server({name: 'notes'}),
      connection: connection(async () => 'ok'),
      tools: [tool('search')],
    });
    expect(built?.description).toContain('search does a thing.');
    // So the model can say where an answer came from.
    expect(built?.description).toContain('notes');
  });

  it('passes the sanitised schema into the declaration the model sees', () => {
    const [built] = buildMcpTools({
      server: server(),
      connection: connection(async () => 'ok'),
      tools: [
        tool('search', {
          type: 'object',
          properties: {q: {type: 'string'}},
          required: ['q'],
        }),
      ],
    });

    const declaration = built?._getDeclaration();
    expect(declaration?.parameters).toMatchObject({
      type: 'object',
      properties: {q: {type: 'string'}},
      required: ['q'],
    });
  });

  /*
   * The collision cases. Both end the connection with a message rather than
   * dropping a tool, because a silently missing tool is indistinguishable from a
   * server that never offered it.
   */
  it('refuses a name this app already uses', () => {
    expect(() =>
      buildMcpTools({
        server: server(),
        connection: connection(async () => 'ok'),
        tools: [tool('search')],
        reserved: new Set(['mcp_notes_search']),
      }),
    ).toThrow(McpToolNameError);
  });

  it('refuses two of the server tools that fold onto one name', () => {
    // `read/file` and `read:file` both fold to `read_file`. Offering both would
    // mean one of them could never be called.
    expect(() =>
      buildMcpTools({
        server: server(),
        connection: connection(async () => 'ok'),
        tools: [tool('read/file'), tool('read:file')],
      }),
    ).toThrow(/silently replace|both/u);
  });

  it('names the server in a collision, because that is what to rename', () => {
    expect(() =>
      buildMcpTools({
        server: server({name: 'notes'}),
        connection: connection(async () => 'ok'),
        tools: [tool('search')],
        reserved: new Set(['mcp_notes_search']),
      }),
    ).toThrow(/"notes"/u);
  });
});

describe('gating', () => {
  /*
   * The whole point of the trust switch, and the one thing here that is a
   * security property rather than a correctness one. An MCP server is software
   * the user did not write; until they say otherwise every call goes through the
   * same approval as `write_file`.
   */
  it('asks before running a tool from a server that is not trusted', async () => {
    const [built] = buildMcpTools({
      server: server({trusted: false}),
      connection: connection(async () => 'ok'),
      tools: [tool('search')],
    });

    await expect(
      built?.checkRequireConfirmation({q: 'x'}),
    ).resolves.toBe(true);
  });

  it('runs freely once the server is trusted', async () => {
    const [built] = buildMcpTools({
      server: server({trusted: true}),
      connection: connection(async () => 'ok'),
      tools: [tool('search')],
    });

    await expect(
      built?.checkRequireConfirmation({q: 'x'}),
    ).resolves.toBe(false);
  });

  it('says on the card that the server is not trusted', () => {
    const [untrusted] = buildMcpTools({
      server: server({trusted: false}),
      connection: connection(async () => 'ok'),
      tools: [tool('search')],
    });
    expect(untrusted?.description).toMatch(/not been told to trust/u);
  });
});

/**
 * A tool context good enough for ADK to run a tool with.
 *
 * A gated tool calls `toolContext.requestConfirmation(...)` rather than
 * executing, so a bare `{}` fails with a message about the context rather than
 * about the tool. Only what ADK actually touches is provided.
 */
function context(): never {
  return {
    requestConfirmation: () => undefined,
    actions: {},
  } as never;
}

describe('running a tool', () => {
  it('returns what the server said', async () => {
    const [built] = buildMcpTools({
      server: server({trusted: true}),
      connection: connection(async (name, args) => `${name}:${JSON.stringify(args)}`),
      tools: [tool('echo')],
    });

    const result = await built?.runAsync({
      args: {text: 'hi'},
      toolContext: context(),
    });
    expect(result).toBe('echo:{"text":"hi"}');
  });

  /*
   * The gate has to *stop* the call, not merely report that it would like to.
   *
   * This is the security property the whole trust switch rests on: if an
   * untrusted server's tool ran and then asked, every unchecked call would
   * already have happened. ADK answers a gated call with a message the model
   * reads as "not yet", and the connection is never touched.
   */
  it('does not touch the server at all when the server is untrusted', async () => {
    let called = false;
    const [built] = buildMcpTools({
      server: server({trusted: false}),
      connection: connection(async () => {
        called = true;
        return 'should not happen';
      }),
      tools: [tool('echo')],
    });

    const result = await built?.runAsync({
      args: {text: 'hi'},
      toolContext: context(),
    });

    expect(called).toBe(false);
    expect(JSON.stringify(result)).toMatch(/confirmation/iu);
  });

  /*
   * A dead server is the ordinary failure, not the exceptional one. Throwing
   * would end the turn; the model can do something useful with a sentence.
   */
  it('reports a dead server as text rather than ending the turn', async () => {
    const [built] = buildMcpTools({
      server: server({name: 'notes', trusted: true}),
      connection: connection(async () => {
        throw new McpError('The server is not connected.', 'off');
      }),
      tools: [tool('echo')],
    });

    const result = await built?.runAsync({
      args: {},
      toolContext: context(),
    });

    expect(typeof result).toBe('string');
    expect(String(result)).toContain('notes');
    expect(String(result)).toContain('not connected');
  });

  it('reports an unexpected throw the same way', async () => {
    const [built] = buildMcpTools({
      server: server({name: 'notes', trusted: true}),
      connection: connection(async () => {
        throw new Error('socket closed');
      }),
      tools: [tool('echo')],
    });

    const result = await built?.runAsync({
      args: {},
      toolContext: context(),
    });
    expect(String(result)).toContain('socket closed');
  });
});

/*
 * The same tools as engine definitions, for the v2 turn path. The properties are
 * the same three, and they are tested here because the v1 builder and the v2
 * builder share the naming plan but not the wrapper: a gate or a failure answer
 * that one path got right and the other did not would be visible only in one
 * kind of conversation.
 */
describe('buildMcpToolDefinitions', () => {
  it('gates an untrusted server and not a trusted one', () => {
    const trusted = buildMcpToolDefinitions({
      server: server({trusted: true}),
      connection: connection(async () => 'ok'),
      tools: [tool('search')],
    });
    expect(trusted[0]?.gate).toBe('never');

    const untrusted = buildMcpToolDefinitions({
      server: server({trusted: false}),
      connection: connection(async () => 'ok'),
      tools: [tool('search')],
    });
    expect(untrusted[0]?.gate).toBe('always');
  });

  it('calls the server by its own name and returns its words', async () => {
    const calls: Array<[string, unknown]> = [];
    const definitions = buildMcpToolDefinitions({
      server: server(),
      connection: connection(async (name, args) => {
        calls.push([name, args]);
        return 'found it';
      }),
      tools: [tool('search')],
    });
    const result = await definitions[0]?.execute({q: 'notes'}, {} as never);
    expect(result).toEqual({ok: true, result: 'found it'});
    expect(calls).toEqual([['search', {q: 'notes'}]]);
  });

  it('answers a dropped server as a failed result rather than throwing', async () => {
    const definitions = buildMcpToolDefinitions({
      server: server(),
      connection: connection(async () => {
        throw new McpError('the pipe closed', 'error');
      }),
      tools: [tool('search')],
    });
    const result = await definitions[0]?.execute({}, {} as never);
    expect(result?.ok).toBe(false);
    expect(String(result?.result)).toContain('could not run');
    expect(String(result?.result)).toContain('the pipe closed');
  });

  it('refuses a tool whose name a built-in already owns', () => {
    expect(() =>
      buildMcpToolDefinitions({
        server: server(),
        connection: connection(async () => 'ok'),
        tools: [tool('search')],
        reserved: new Set(['mcp_notes_search']),
      }),
    ).toThrow(McpToolNameError);
  });
});

/*
 * The grant is the filter, and the two ways it goes wrong are opposite: `all`
 * that quietly means none, and an empty list that quietly means everything.
 */
describe('grantedMcpSources', () => {
  const sources = [
    {server: {id: 'mcp:notes', name: 'notes'}},
    {server: {id: 'mcp:db', name: 'db'}},
  ];

  it('takes every connected server for "all"', () => {
    expect(grantedMcpSources('all', sources)).toEqual(sources);
  });

  it('takes only the connectors the bot was granted', () => {
    expect(grantedMcpSources(['mcp:db'], sources)).toEqual([sources[1]]);
  });

  it('takes none for an empty grant', () => {
    expect(grantedMcpSources([], sources)).toEqual([]);
  });

  it('is empty when nothing is connected', () => {
    expect(grantedMcpSources('all', [])).toEqual([]);
  });
});
