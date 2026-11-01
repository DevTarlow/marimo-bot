/**
 * The parts of "keep jobs running" that can only be decided in the app.
 *
 * Which binary to name, where the runner script is, and which directory the
 * window is actually using. That last one is invariant 13: the app and the
 * runner resolve the same user-data directory, and when they do not nothing
 * errors — the window writes one `jobs.json`, the service reads another, finds
 * nothing due, and exits 0.
 *
 * The third answer here is the one that decides whether switching the service on
 * is honest: whether the provider a scheduled job would use is one a process with
 * no keychain can read. It is a fact about two documents — the catalogue and the
 * user's settings — and getting it wrong is a job that fails at nine in the
 * morning with nobody watching.
 */
import {mkdtemp, rm} from 'node:fs/promises';
import {join} from 'node:path';

import {afterEach, beforeEach, describe, expect, it} from 'vitest';

import type {StoredSettings} from '@marimo/protocol';
import {defaultStoredSettings, resolveAppPaths} from '@marimo/runtime';
import type {AppPaths} from '@marimo/runtime';

import {keysReadableIn, serviceSpec, statusOf} from '../src/main/service.js';
import type {ServiceContext} from '../src/main/service.js';

describe('the service definition', () => {
  let dir: string;
  let paths: AppPaths;
  let context: ServiceContext;

  beforeEach(async () => {
    dir = await mkdtemp(join(process.cwd(), '.marimo-service-'));
    paths = resolveAppPaths(dir);
    context = {
      paths,
      execPath: '/opt/marimo/marimo-agent',
      appPath: '/opt/marimo/resources/app.asar',
      home: '/home/sam',
      configHome: '/home/sam/.config',
      readSettings: async () => defaultStoredSettings(),
    };
  });

  afterEach(async () => {
    await rm(dir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 20,
    });
  });

  it('names the app binary and the runner inside it', () => {
    const spec = serviceSpec(context);
    expect(spec.execPath).toBe('/opt/marimo/marimo-agent');
    /*
     * Inside the app, so the service runs the code that shipped with it rather
     * than a copy that can drift — and valid packaged, because Electron reads
     * inside an asar archive.
     */
    expect(spec.scriptPath).toBe(
      '/opt/marimo/resources/app.asar/dist/runner/run-due.js',
    );
  });

  /*
   * Invariant 13, from the app's side: the directory the window is using is the
   * one written into the definition, not one the runner would work out for
   * itself and possibly get wrong.
   */
  it('bakes in the directory the app is actually using', () => {
    expect(serviceSpec(context).userDataDir).toBe(dir);
  });

  it('wakes once a minute, which is the finest a schedule can ask for', () => {
    expect(serviceSpec(context).everyMinutes).toBe(1);
  });

  it('asks the app for the settings it is actually running under', async () => {
    /*
     * A model needs no key, so a fresh install with no connectors can run its
     * jobs while the window is closed. The flag is still read from the document
     * the app is actually running under rather than from a default here.
     */
    const settings = defaultStoredSettings();
    context.readSettings = async () => settings;

    expect((await statusOf(context)).keysReadable).toBe(true);
  });
});

describe('keysReadableIn', () => {
  function withConnector(
    overrides: Partial<StoredSettings['mcpServers'][number]> = {},
  ): StoredSettings {
    const settings = defaultStoredSettings();
    settings.mcpServers = [
      {
        id: 'mcp:notes',
        name: 'notes',
        transport: 'stdio',
        command: 'notes-mcp',
        enabled: true,
        trusted: false,
        secretStorage: 'keychain',
        secrets: [{target: 'header', name: 'Authorization'}],
        ...overrides,
      },
    ];
    return settings;
  }

  it('is true when there are no connectors at all', () => {
    // The model runs from local files and needs no key. A job on a fresh install
    // has nothing to decrypt.
    expect(keysReadableIn(defaultStoredSettings())).toBe(true);
  });

  it('is false when an enabled connector has a secret only a keychain could read', () => {
    expect(keysReadableIn(withConnector())).toBe(false);
  });

  it('is true when every enabled connector was let be stored readable', () => {
    expect(keysReadableIn(withConnector({secretStorage: 'plaintext'}))).toBe(
      true,
    );
  });

  it('is true for a connector that needs no secret at all', () => {
    expect(keysReadableIn(withConnector({secrets: []}))).toBe(true);
  });

  it('is true for an encrypted connector that is switched off', () => {
    // Nothing dials it, so there is nothing the runner has to read: a card that
    // said otherwise would refuse to switch the service on for a server no job
    // could ever reach.
    expect(keysReadableIn(withConnector({enabled: false}))).toBe(true);
  });
});
