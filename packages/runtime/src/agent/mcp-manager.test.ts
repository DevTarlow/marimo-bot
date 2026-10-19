/**
 * The manager, against real servers.
 *
 * Everything here spawns an actual child process and speaks the actual protocol,
 * because the things that go wrong with a supervisor are things a mock cannot
 * reproduce: a process that exits, a command that was never there, a retry that
 * leaks a child, a status that stops being reported.
 *
 * The fixture servers live in `@marimo/agent`'s `test-fixtures`, which is where
 * the MCP client's own tests get them from. Sharing them is deliberate: the two
 * suites are testing the same protocol from two sides.
 */
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import type {McpServer} from '@marimo/protocol';

import type {McpResolvedSecrets} from '@marimo/agent';

import {McpManager, mcpSecretFile, secretReaderFor} from './mcp-manager.js';
import type {McpManagerOptions, McpStatus} from './mcp-manager.js';
import {resolveAppPaths} from '../paths.js';
import type {AppPaths} from '../paths.js';
import {FileSecretStore} from '../secrets.js';

const ECHO = fileURLToPath(
  new URL('../../../agent/test-fixtures/echo-mcp-server.mjs', import.meta.url),
);
const COLLIDE = fileURLToPath(
  new URL(
    '../../../agent/test-fixtures/collide-mcp-server.mjs',
    import.meta.url,
  ),
);

function server(overrides: Partial<McpServer> = {}): McpServer {
  return {
    id: 'mcp:notes',
    name: 'notes',
    transport: 'stdio',
    command: process.execPath,
    args: [ECHO],
    enabled: true,
    secretStorage: 'keychain',
    trusted: false,
    ...overrides,
  };
}

/** A manager with no secrets, no waiting, and a clock a test controls. */
function manager(overrides: Partial<McpManagerOptions> = {}) {
  let clock = 1_000_000;
  const statuses: Array<{id: string; status: McpStatus}> = [];

  const instance = new McpManager({
    readSecrets: async (): Promise<McpResolvedSecrets> => ({
      env: {},
      headers: {},
    }),
    // Short enough that a test which does wait does not wait long.
    retryDelaysMs: [10, 100, 1_000],
    now: () => clock,
    onStatus: (id, status) => statuses.push({id, status}),
    ...overrides,
  });

  return {
    instance,
    statuses,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe('McpManager', () => {
  it('connects an enabled server and reports what it offers', async () => {
    const {instance} = manager();
    try {
      await instance.apply([server()]);

      const status = instance.statusOf('mcp:notes');
      expect(status.state).toBe('online');
      // The fixture serves five tools across two pages, so a client that
      // ignored the cursor would report two.
      expect(status.toolCount).toBe(5);
      expect(status.detail).toContain('5 tools');
    } finally {
      await instance.stop();
    }
  });

  it('leaves a disabled server alone', async () => {
    const {instance} = manager();
    try {
      await instance.apply([server({enabled: false})]);
      expect(instance.statusOf('mcp:notes').state).toBe('off');
      expect(instance.toolsets()).toEqual([]);
    } finally {
      await instance.stop();
    }
  });

  it('offers the connected servers to a turn', async () => {
    const {instance} = manager();
    try {
      await instance.apply([server()]);
      const toolsets = instance.toolsets();

      expect(toolsets).toHaveLength(1);
      expect(toolsets[0]?.server.name).toBe('notes');
      expect(toolsets[0]?.tools.map((tool) => tool.name)).toContain('echo');
    } finally {
      await instance.stop();
    }
  });

  /*
   * The property that matters most about a supervisor: a broken server is a
   * sentence in Settings, not an app that will not start. A user with one bad
   * configuration should still have all their other servers.
   */
  it('reports a server whose tools collide instead of throwing', async () => {
    const {instance} = manager();
    try {
      await instance.apply([
        server({id: 'mcp:collide', name: 'collide', args: [COLLIDE]}),
      ]);

      const status = instance.statusOf('mcp:collide');
      expect(status.state).toBe('error');
      expect(status.detail).toMatch(/silently replace|both/u);
      expect(instance.toolsets()).toEqual([]);
    } finally {
      await instance.stop();
    }
  });

  it('still connects the good servers beside a broken one', async () => {
    const {instance} = manager();
    try {
      await instance.apply([
        server({id: 'mcp:collide', name: 'collide', args: [COLLIDE]}),
        server({id: 'mcp:notes', name: 'notes'}),
      ]);

      expect(instance.statusOf('mcp:collide').state).toBe('error');
      expect(instance.statusOf('mcp:notes').state).toBe('online');
      expect(instance.toolsets()).toHaveLength(1);
    } finally {
      await instance.stop();
    }
  });

  it('reports a command that does not exist as a configuration problem', async () => {
    const {instance} = manager();
    try {
      await instance.apply([
        server({command: '/nonexistent/definitely-not-real', args: []}),
      ]);

      const status = instance.statusOf('mcp:notes');
      expect(status.state).toBe('error');
      expect(status.detail).toMatch(/Could not start/u);
    } finally {
      await instance.stop();
    }
  });

  describe('retrying', () => {
    /*
     * A server that is down is retried on a backoff, not left dead until
     * somebody presses Save. The delay is asserted because a supervisor that
     * retries instantly is a fork bomb, and one that never retries is the bug
     * this exists to fix.
     */
    it('waits out the backoff before trying again', async () => {
      const {instance, advance} = manager();
      try {
        await instance.apply([
          server({command: '/nonexistent/definitely-not-real', args: []}),
        ]);
        expect(instance.statusOf('mcp:notes').detail).toMatch(/Retrying in/u);

        // Still inside the first delay, so nothing should be attempted.
        const dial = vi.spyOn(
          instance as unknown as {dial: () => Promise<void>},
          'dial',
        );
        await instance.reconcile();
        expect(dial).not.toHaveBeenCalled();

        advance(10_000);
        await instance.reconcile();
        expect(dial).toHaveBeenCalled();
      } finally {
        await instance.stop();
      }
    });

    it('comes back when the server does', async () => {
      const {instance, advance} = manager();
      try {
        // Starts broken, then the configuration is fixed.
        await instance.apply([
          server({command: '/nonexistent/nope', args: []}),
        ]);
        expect(instance.statusOf('mcp:notes').state).toBe('error');

        await instance.apply([server()]);
        expect(instance.statusOf('mcp:notes').state).toBe('online');
        void advance;
      } finally {
        await instance.stop();
      }
    });

    it('says how long until the next attempt', async () => {
      // "It will try again" with no when is the status that makes a user press
      // Refresh forever. The real schedule is used here rather than the short
      // one the other tests inject, because the wording is the thing under test
      // and "a moment" is what a 10ms delay correctly renders as.
      const {instance} = manager({retryDelaysMs: [5_000]});
      try {
        await instance.apply([
          server({command: '/nonexistent/nope', args: []}),
        ]);
        expect(instance.statusOf('mcp:notes').detail).toMatch(
          /Retrying in 5 seconds\./u,
        );
      } finally {
        await instance.stop();
      }
    });

    it('describes a long delay in minutes rather than milliseconds', async () => {
      const {instance} = manager({retryDelaysMs: [300_000]});
      try {
        await instance.apply([
          server({command: '/nonexistent/nope', args: []}),
        ]);
        expect(instance.statusOf('mcp:notes').detail).toMatch(
          /Retrying in 5 minutes\./u,
        );
      } finally {
        await instance.stop();
      }
    });
  });

  describe('applying a changed configuration', () => {
    it('closes a server that was switched off', async () => {
      const {instance, statuses} = manager();
      try {
        await instance.apply([server()]);
        expect(instance.statusOf('mcp:notes').state).toBe('online');

        await instance.apply([server({enabled: false})]);

        expect(instance.statusOf('mcp:notes').state).toBe('off');
        expect(instance.toolsets()).toEqual([]);
        // And the window is told, because a server left showing as online after
        // being switched off is worse than no status at all.
        expect(statuses.at(-1)?.status.state).toBe('off');
      } finally {
        await instance.stop();
      }
    });

    it('closes a server that was removed', async () => {
      const {instance} = manager();
      try {
        await instance.apply([server()]);
        await instance.apply([]);
        expect(instance.statusOf('mcp:notes').state).toBe('off');
        expect(instance.toolsets()).toEqual([]);
      } finally {
        await instance.stop();
      }
    });

    it('re-dials when the configuration changes', async () => {
      const {instance} = manager();
      try {
        await instance.apply([server()]);
        const before = instance.toolsets()[0];

        // Same id, different command: a different server.
        await instance.apply([server({args: [COLLIDE]})]);

        expect(instance.statusOf('mcp:notes').state).toBe('error');
        expect(instance.toolsets()).toEqual([]);
        expect(before).toBeDefined();
      } finally {
        await instance.stop();
      }
    });

    it('leaves a healthy server alone when nothing changed', async () => {
      const {instance} = manager();
      try {
        await instance.apply([server()]);
        const first = instance.toolsets()[0]?.connection;

        await instance.apply([server()]);

        // Same connection object: re-dialling on every settings save would drop
        // a server's session for no reason, and a stdio server's session is a
        // process.
        expect(instance.toolsets()[0]?.connection).toBe(first);
      } finally {
        await instance.stop();
      }
    });
  });

  describe('testing a configuration', () => {
    it('reports what a good server offers, by its own name', async () => {
      const {instance} = manager();
      try {
        const result = await instance.test(server());
        expect(result.ok).toBe(true);
        expect(result.detail).toContain('marimo-fixture');
        expect(result.detail).toContain('5');
      } finally {
        await instance.stop();
      }
    });

    it('reports a bad command without throwing', async () => {
      const {instance} = manager();
      try {
        const result = await instance.test(
          server({command: '/nonexistent/nope', args: []}),
        );
        expect(result.ok).toBe(false);
        expect(result.detail).toMatch(/Could not start/u);
      } finally {
        await instance.stop();
      }
    });

    /*
     * The Test button must not disturb the server the user is looking at. It is
     * pressed *while* deciding whether to change something, so answering it by
     * taking the working connection down would make it dangerous.
     */
    it('does not disturb a live connection', async () => {
      const {instance} = manager();
      try {
        await instance.apply([server()]);
        const live = instance.toolsets()[0]?.connection;

        await instance.test(server());
        await instance.test(server({command: '/nonexistent/nope', args: []}));

        expect(instance.statusOf('mcp:notes').state).toBe('online');
        expect(instance.toolsets()[0]?.connection).toBe(live);
      } finally {
        await instance.stop();
      }
    });
  });

  describe('refreshing', () => {
    it('re-lists what a connected server offers', async () => {
      const {instance} = manager();
      try {
        await instance.apply([server()]);
        const result = await instance.refresh('mcp:notes');

        expect(result.ok).toBe(true);
        expect(result.tools).toContain('echo');
      } finally {
        await instance.stop();
      }
    });

    it('says so for a server that is not connected', async () => {
      const {instance} = manager();
      try {
        const result = await instance.refresh('mcp:missing');
        expect(result.ok).toBe(false);
        expect(result.detail).toMatch(/not connected/iu);
      } finally {
        await instance.stop();
      }
    });
  });

  it('reports nothing after being stopped', async () => {
    const {instance} = manager();
    await instance.apply([server()]);
    await instance.stop();

    expect(instance.toolsets()).toEqual([]);
    expect(instance.statusOf('mcp:notes').state).toBe('off');
  });

  it('does not reconnect after being stopped', async () => {
    const {instance, advance} = manager();
    await instance.apply([server({command: '/nonexistent/nope', args: []})]);
    await instance.stop();

    advance(60_000);
    await instance.reconcile();
    expect(instance.toolsets()).toEqual([]);
  });

  it('stops cleanly when nothing was ever started', async () => {
    const {instance} = manager();
    await expect(instance.stop()).resolves.toBeUndefined();
  });
});

describe('mcpSecretFile', () => {
  const paths = resolveAppPaths('/data/marimo-agent');

  it('names a credential by server, target and variable', () => {
    expect(mcpSecretFile(paths, 'mcp:notes', 'header', 'Authorization')).toBe(
      `${paths.secretsDir}/mcp-notes-header-authorization.bin`,
    );
  });

  it('keeps two variables of one server apart', () => {
    const first = mcpSecretFile(paths, 'mcp:notes', 'header', 'Authorization');
    const second = mcpSecretFile(paths, 'mcp:notes', 'env', 'API_KEY');
    expect(first).not.toBe(second);
  });

  it('cannot be walked out of the secrets directory', () => {
    const file = mcpSecretFile(paths, '../../etc', 'header', 'passwd');
    expect(file.startsWith(`${paths.secretsDir}/`)).toBe(true);
    expect(file).not.toContain('..');
  });
});

describe('secretReaderFor', () => {
  const paths = resolveAppPaths('/data/marimo-agent');

  it('reads only the names the server declared', async () => {
    const asked: string[] = [];

    const read = secretReaderFor(paths, (file) => {
      asked.push(file);
      return {
        read: async () => ({state: 'present', value: 'secret-value'}),
      } as never;
    });

    const secrets = await read(
      server({
        secrets: [
          {target: 'header', name: 'Authorization'},
          {target: 'env', name: 'NOTES_TOKEN'},
        ],
      }),
    );

    expect(asked).toHaveLength(2);
    expect(secrets.headers).toEqual({Authorization: 'secret-value'});
    expect(secrets.env).toEqual({NOTES_TOKEN: 'secret-value'});
  });

  it('says nothing about a credential that is not set', async () => {
    // An empty value would be sent as an empty header, which some servers treat
    // as a wrong credential rather than as no credential.
    const read = secretReaderFor(
      paths,
      () => ({read: async () => ({state: 'absent'})}) as never,
    );

    const secrets = await read(
      server({secrets: [{target: 'header', name: 'Authorization'}]}),
    );
    expect(secrets).toEqual({env: {}, headers: {}});
  });

  it('refuses rather than dialling without a credential it cannot read', async () => {
    /*
     * The distinction the three-valued read exists for. Dialling without the
     * secret earns a `401` from a server that never saw one, which sends the user
     * to check a token that is perfectly correct; the store's sentence says what
     * is actually wrong. The throw is deliberate — the manager turns it into the
     * server's status, which is where a person can read it.
     */
    const read = secretReaderFor(
      paths,
      () =>
        ({
          read: async () => ({
            state: 'unreadable',
            reason:
              'The Authorization is encrypted and this process cannot decrypt it.',
          }),
        }) as never,
    );

    await expect(
      read(server({secrets: [{target: 'header', name: 'Authorization'}]})),
    ).rejects.toThrow(/cannot decrypt/u);
  });

  it('names the secret the way the store quotes it back', async () => {
    // The store's own sentences begin with "The ", so a label beginning with
    // "the" reads as "The the Authorization for …" — and that is the sentence a
    // user is shown when a connector's secret has to be entered again.
    const labels: string[] = [];
    const read = secretReaderFor(paths, (_file, label) => {
      labels.push(label);
      return {read: async () => ({state: 'absent'})} as never;
    });

    await read(
      server({
        name: 'notes',
        secrets: [{target: 'header', name: 'Authorization'}],
      }),
    );

    expect(labels).toEqual(['Authorization for "notes"']);
  });

  it('reads nothing for a server that declares nothing', async () => {
    const read = secretReaderFor(paths, () => {
      throw new Error('should not be asked');
    });
    expect(await read(server())).toEqual({env: {}, headers: {}});
  });
});

/*
 * The runner's side of a connector's secret, against real files.
 *
 * This is the configuration the headless job runner builds and the window does
 * not: a `FileSecretStore` with no cipher at all. What it decides is whether a
 * scheduled job can use a connector at all — and the failure worth pinning is the
 * quiet one, where a server is dialled without the credential it asked for and
 * answers `401`, instead of being reported as the setting it actually is.
 */
describe('a connector secret the runner cannot open', () => {
  let dir: string;
  let paths: AppPaths;

  beforeEach(async () => {
    dir = await mkdtemp(join(process.cwd(), '.marimo-mcp-secret-'));
    paths = resolveAppPaths(dir);
  });

  afterEach(async () => {
    await rm(dir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 20,
    });
  });

  /** The runner's manager: the window's class, over a store with no cipher. */
  function runnerManager() {
    return manager({
      readSecrets: secretReaderFor(
        paths,
        (file, label) => new FileSecretStore(file, label),
      ),
    });
  }

  async function writeSecret(contents: string): Promise<void> {
    const file = mcpSecretFile(paths, 'mcp:notes', 'header', 'Authorization');
    await mkdir(dirname(file), {recursive: true});
    await writeFile(file, contents, 'utf8');
  }

  const notes = server({
    secrets: [{target: 'header', name: 'Authorization'}],
  });

  it('comes up when the user stored the secret readable', async () => {
    await writeSecret(
      `plaintext:${Buffer.from('a-token').toString('base64')}\n`,
    );

    const {instance} = runnerManager();
    try {
      await instance.apply([notes]);
      expect(instance.statusOf('mcp:notes').state).toBe('online');
    } finally {
      await instance.stop();
    }
  });

  it('is reported as unreadable instead of being dialled without it', async () => {
    await writeSecret(
      `encrypted:${Buffer.from('a-token').toString('base64')}\n`,
    );

    const {instance} = runnerManager();
    try {
      await instance.apply([notes]);

      const status = instance.statusOf('mcp:notes');
      expect(status.state).toBe('error');
      // The store's own sentence, which names the setting that fixes it rather
      // than the server.
      expect(status.detail).toMatch(/is encrypted/u);
      expect(status.detail).toMatch(/Re-enter it/iu);
      // And no tools at all: a turn is never offered a server that is not up.
      expect(instance.toolsets()).toEqual([]);
    } finally {
      await instance.stop();
    }
  });
});
