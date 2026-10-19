/**
 * The consent a connector's secret is stored under.
 *
 * A connector's secret is exactly as sensitive as a provider's key, so it is
 * encrypted unless the user says otherwise — and "otherwise" is a per-connector
 * answer, because the headless job runner has no `app` object and therefore no
 * keychain. Without the opt-in a scheduled job could never use a connector that
 * needs a credential; with it, the secret is on disk in a form anything can read,
 * which is a trade the user makes one connector at a time.
 *
 * This is the only place that can test the whole round trip, because the write
 * path is the main process's: Electron is mocked so `safeStorage` exists, and
 * what is asserted is the file on disk and what the *runner's* store — a
 * `FileSecretStore` with no cipher, exactly what `run-due` builds — makes of it.
 * A test that only checked the write would pass with a file nothing can read.
 */
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

/*
 * `safeStorage` as Electron provides it, stood in for by something reversible
 * rather than by a cipher: what is under test is which of the two forms a secret
 * is written in, and the encryption itself belongs to the platform. Hoisted above
 * the imports by Vitest, which is what lets `main/secrets.ts` — written when the
 * app starts, not when this test does — see it.
 */
vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value, 'utf8'),
    decryptString: (payload: Buffer) => payload.toString('utf8'),
  },
}));

import type {McpServer} from '@marimo/protocol';

import {FileSecretStore, mcpSecretFile, resolveAppPaths} from '@marimo/runtime';
import type {AppPaths} from '@marimo/runtime';

import {AgentService} from '../src/main/agent.js';

describe('a connector secret', () => {
  let dir: string;
  let paths: AppPaths;
  let service: AgentService;

  beforeEach(async () => {
    dir = await mkdtemp(join(process.cwd(), '.marimo-consent-'));
    paths = resolveAppPaths(dir);
    service = new AgentService({paths, sendEvent: () => undefined});
  });

  afterEach(async () => {
    await service.stop();
    await rm(dir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 20,
    });
  });

  function connector(overrides: Partial<McpServer> = {}): McpServer {
    return {
      id: 'mcp:notes',
      name: 'notes',
      transport: 'stdio',
      // Never started: the secret is written before any dial, and a connector
      // that cannot be reached is the ordinary state of one being configured.
      command: '/nonexistent/definitely-not-real',
      enabled: true,
      trusted: false,
      secretStorage: 'keychain',
      secrets: [{target: 'header', name: 'Authorization'}],
      ...overrides,
    };
  }

  function secretFile(): string {
    return mcpSecretFile(paths, 'mcp:notes', 'header', 'Authorization');
  }

  /** What the headless runner makes of the file, having no cipher at all. */
  async function asTheRunnerReadsIt() {
    return await new FileSecretStore(
      secretFile(),
      'Authorization for this connector',
    ).read();
  }

  it('is written readable when the connector lets the runner read it', async () => {
    await service.setMcpServer(connector({secretStorage: 'plaintext'}));
    await service.setMcpSecret(
      'mcp:notes',
      'header',
      'Authorization',
      'a-token',
    );

    expect(await readFile(secretFile(), 'utf8')).toMatch(/^plaintext:/u);
    // The point of the consent: a process with no keychain gets the value.
    await expect(asTheRunnerReadsIt()).resolves.toEqual({
      state: 'present',
      value: 'a-token',
    });
  });

  it('is encrypted when the connector was left on the keychain', async () => {
    await service.setMcpServer(connector({secretStorage: 'keychain'}));
    await service.setMcpSecret(
      'mcp:notes',
      'header',
      'Authorization',
      'a-token',
    );

    expect(await readFile(secretFile(), 'utf8')).toMatch(/^encrypted:/u);
    const read = await asTheRunnerReadsIt();
    // Unreadable rather than absent, and with the sentence that says what to do
    // about it — which is the difference between a job that names its setting and
    // one that fails with a `401`.
    expect(read.state).toBe('unreadable');
    if (read.state === 'unreadable') {
      expect(read.reason).toMatch(/cannot decrypt/u);
    }
  });

  /*
   * The install that already has connectors, which is the case a required field
   * would have broken: a settings file written before the choice existed has no
   * `secretStorage`, and the safe reading of that silence is the keychain. Written
   * by hand because nothing in this build can produce such a file.
   */
  it('is encrypted for a connector written before the choice existed', async () => {
    await writeFile(
      paths.settings,
      `${JSON.stringify({
        version: 1,
        mcpServers: [
          {
            id: 'mcp:notes',
            name: 'notes',
            transport: 'stdio',
            command: '/nonexistent/definitely-not-real',
            enabled: true,
            trusted: false,
            secrets: [{target: 'header', name: 'Authorization'}],
          },
        ],
      })}\n`,
      'utf8',
    );

    const stored = await service.settings();
    expect(stored.mcpServers[0]?.secretStorage).toBe('keychain');

    await service.setMcpSecret(
      'mcp:notes',
      'header',
      'Authorization',
      'a-token',
    );
    expect(await readFile(secretFile(), 'utf8')).toMatch(/^encrypted:/u);
  });

  /*
   * The window stores a secret from the connector form, and the form can be
   * filled in before the connector is saved — so there may be no entry to ask.
   * The answer for that is the safe one, and the file is the one the saved
   * connector will read, because the id is the server's identity.
   */
  it('is encrypted for a connector that has not been saved yet', async () => {
    await service.setMcpSecret(
      'mcp:draft',
      'header',
      'Authorization',
      'a-token',
    );

    const file = mcpSecretFile(paths, 'mcp:draft', 'header', 'Authorization');
    expect(await readFile(file, 'utf8')).toMatch(/^encrypted:/u);
  });

  /*
   * And the form's own answer wins over the saved connector's, because they are
   * two fields of one thing the user is looking at.
   *
   * Without this the ordering is a leak rather than a nuisance: untick "let the
   * runner read this", type the new value, save the secret without saving the
   * connector, and the file is still written readable while the screen says it
   * is encrypted. The reverse — ticking it and getting an encrypted file — is
   * merely a job that fails with a sentence.
   */
  it('obeys the form rather than the saved connector', async () => {
    await service.setMcpServer(connector({secretStorage: 'keychain'}));
    await service.setMcpSecret(
      'mcp:notes',
      'header',
      'Authorization',
      'a-token',
      'plaintext',
    );
    expect(await readFile(secretFile(), 'utf8')).toMatch(/^plaintext:/u);

    await service.setMcpServer(connector({secretStorage: 'plaintext'}));
    await service.setMcpSecret(
      'mcp:notes',
      'header',
      'Authorization',
      'another-token',
      'keychain',
    );
    expect(await readFile(secretFile(), 'utf8')).toMatch(/^encrypted:/u);
  });
});
