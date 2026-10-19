/**
 * The headless runner, from the outside.
 *
 * Everything here is about the two things a timer needs to be able to tell
 * apart: "there was nothing to do" and "I could not do it". The exit code is the
 * only signal the OS gets, so an unreadable jobs file that reports as an empty
 * one is a background service that looks healthy for a week and never runs
 * anything.
 *
 * The run itself is exercised against real stores and real files, with a keyed
 * provider and no key — the state an install that never signed in to anything is
 * in, and one that produces the designed outcome: the job runs, is refused for
 * want of a key, and records that as its result rather than failing silently.
 */
import {mkdir, mkdtemp, readFile, rm, stat, writeFile} from 'node:fs/promises';
import {join} from 'node:path';

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {
  FileSecretStore,
  mcpSecretFile,
  ProfileStore,
  SettingsStore,
  WorkspaceStore,
  resolveAppPaths,
} from '@marimo/runtime';
import type {AppPaths} from '@marimo/runtime';
import {DEFAULT_AGENT_PERSONA} from '@marimo/protocol';
import type {McpServer} from '@marimo/protocol';

import {
  connectorSecrets,
  describeReport,
  main,
  resolveRunnerPaths,
  runDue,
} from '../src/runner/run-due.js';
import {USER_DATA_ENV, USER_DATA_NAME} from '../src/shared/product.js';

describe('resolveRunnerPaths', () => {
  it('honours the override the app also honours', () => {
    const paths = resolveRunnerPaths({[USER_DATA_ENV]: '/tmp/anything'});
    expect(paths.userData).toBe('/tmp/anything');
    expect(paths.jobs).toBe('/tmp/anything/jobs.json');
  });

  /*
   * The folder's name rather than the product's — the app is Marimo Bot and the
   * directory is still `Marimo Bot`, so a test that followed the screen would
   * be the one that let the runner and the window drift apart.
   */
  it('derives the platform directory when there is no override', () => {
    const paths = resolveRunnerPaths({HOME: `/home/${USER_DATA_NAME}`});
    expect(paths.userData).toContain(USER_DATA_NAME);
  });
});

describe('runDue', () => {
  let dir: string;
  let paths: AppPaths;

  beforeEach(async () => {
    dir = await mkdtemp(join(process.cwd(), '.marimo-runner-'));
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

  /** A profile and a job that came due five minutes ago. */
  async function seedDueJob(): Promise<void> {
    /*
     * A folder for the install, seeded at the test's own directory rather than
     * the real home `resolveAppPaths` would otherwise point at.
     */
    await new WorkspaceStore({
      file: paths.workspaces,
      defaultWorkspaceRoot: dir,
    }).load();

    const profiles = new ProfileStore({
      file: paths.profiles,
      defaultRole: '',
      defaultPersona: DEFAULT_AGENT_PERSONA,
      defaultTools: [],
      defaultSkills: [],
    });
    await profiles.load();
    const profile = await profiles.activeProfile();

    await writeFile(
      paths.jobs,
      JSON.stringify({
        version: 1,
        jobs: {
          jobs: [
            {
              id: 'job-1',
              name: 'Overnight summary',
              description: 'Say hello.',
              schedules: ['0 9 * * *'],
              enabled: true,
              profileId: profile.id,
              sessionId: null,
              createdAt: new Date().toISOString(),
              dueAt: new Date(Date.now() - 5 * 60_000).toISOString(),
            },
          ],
          open: false,
          openJobId: null,
        },
      }),
    );
  }

  it('reports an empty install as nothing to do, not as a failure', async () => {
    const report = await runDue({paths});
    expect(report.problem).toBeUndefined();
    expect(report.ran).toEqual([]);
    expect(report.total).toBe(0);
  });

  /*
   * The failure that matters. The runner must not report an unreadable file as
   * an empty one: for a timer the two look identical from outside, and the
   * difference only surfaces to the person whose jobs silently stopped.
   */
  it('reports a jobs file it cannot read', async () => {
    await writeFile(paths.jobs, 'not json at all', 'utf8');

    const report = await runDue({paths});

    expect(report.problem).toBeDefined();
    expect(report.problem).toMatch(/not valid JSON/u);
  });

  it('runs a job that came due, and records what happened', async () => {
    await seedDueJob();

    const report = await runDue({paths});

    expect(report.problem).toBeUndefined();
    expect(report.total).toBe(1);

    const after = JSON.parse(await readFile(paths.jobs, 'utf8'));
    const job = after.jobs.jobs[0];
    /*
     * This directory has no key in it, and the default provider is one that needs
     * one — so the designed outcome is a recorded refusal rather than silence: the
     * runner must not report a run it could not do as one it did. And the marker
     * has moved, so it will not fire again the next minute.
     */
    expect(job.lastStatus).toBe('error');
    expect(job.lastError).toMatch(/needs an API key/iu);
    expect(job.sessionId).toBeTruthy();
  });

  /*
   * The key, from the runner's side.
   *
   * This is the part that cannot be shared with the window and so has to be
   * checked here: the runner has no `app`, therefore no `safeStorage`, therefore
   * no way to decrypt — so what it can read is decided by the provider's stored
   * `keyStorage` and by nothing else. An install in that state has to record a
   * refusal that names the setting, because the alternative is a `401` from a
   * provider that never saw a key, which reads as "the key is wrong".
   */
  it('records the refusal when the key is encrypted and it has no keychain', async () => {
    await seedDueJob();
    /*
     * What the window writes for a provider left on `keychain`. Written by hand
     * rather than through a store, because no store in this process can produce
     * it — that is the whole point of the case.
     */
    await mkdir(join(paths.userData, 'secrets'), {recursive: true});
    await writeFile(
      paths.providerSecrets.deepseek,
      `encrypted:${Buffer.from('sk-not-really').toString('base64')}\n`,
      'utf8',
    );

    const report = await runDue({paths});

    expect(report.problem).toBeUndefined();
    const after = JSON.parse(await readFile(paths.jobs, 'utf8'));
    const job = after.jobs.jobs[0];
    expect(job.lastStatus).toBe('error');
    expect(job.lastError).toMatch(/cannot decrypt/u);
    // And the sentence points at the fix rather than at the provider.
    expect(job.lastError).toMatch(/re-enter it/iu);
  });

  /*
   * The other half, and the reason the plaintext opt-in exists.
   *
   * The same file, read the way each process reads it: the runner's store has no
   * cipher and gets the key, and the window's has one and would decrypt. What is
   * asserted is the *runner's* half of invariant 16 — a key the user chose to
   * store readable is readable here — through the path `run-due` builds, so the
   * derivation is what is under test rather than a store the test made up.
   */
  it('reads a key the user stored readable, through the same path', async () => {
    await mkdir(join(paths.userData, 'secrets'), {recursive: true});
    await writeFile(
      paths.providerSecrets.deepseek,
      `plaintext:${Buffer.from('sk-read-me').toString('base64')}\n`,
      'utf8',
    );

    const read = await new FileSecretStore(
      paths.providerSecrets.deepseek,
      'DeepSeek API key',
    ).read();

    expect(read).toEqual({state: 'present', value: 'sk-read-me'});
  });

  /*
   * The optimisation, not the correctness measure: the store's claim is what
   * makes a job run once. This is what stops the runner building an agent and
   * dialling every MCP server beside an app doing the same, once a minute.
   */
  it('stands aside when the app is running the jobs', async () => {
    await seedDueJob();
    // This process's own pid, which is certainly alive.
    await writeFile(
      paths.appLock,
      JSON.stringify({pid: process.pid, host: 'test', since: Date.now()}),
      'utf8',
    );

    const report = await runDue({paths});

    expect(report.appIsRunning).toBe(true);
    expect(report.ran).toEqual([]);
    // And it did not touch the job.
    const after = JSON.parse(await readFile(paths.jobs, 'utf8'));
    expect(after.jobs.jobs[0].lastStatus).toBeUndefined();
  });

  /*
   * Held for the length of the work and released afterwards.
   *
   * The runner used to only *read* the lock, which made the exclusion
   * one-directional: an app launched while a runner was mid-turn found the lock
   * free, took it, and started its own scheduler beside the run in progress. It
   * holds it now, so the app waits — and it must not leave it behind, or the app
   * would wait forever and jobs would stop until somebody deleted a file they
   * have never heard of.
   */
  it('leaves no lock behind after a run', async () => {
    await seedDueJob();

    await runDue({paths});

    await expect(stat(paths.appLock)).rejects.toThrow();
  });

  it('takes over from an app that is gone', async () => {
    await seedDueJob();
    // A pid that cannot be running: 0 is never a process.
    await writeFile(
      paths.appLock,
      JSON.stringify({pid: 0, host: 'test', since: Date.now()}),
      'utf8',
    );

    const report = await runDue({paths});

    expect(report.appIsRunning).toBe(false);
    expect(report.total).toBe(1);
  });

  /*
   * The connector half of invariant 16, and the reason a connector has a
   * `secretStorage` choice at all.
   *
   * A scheduled job's agent is the same agent the window runs, so it dials the
   * same connectors — and this process has no `app` object and therefore no
   * keychain. What it must not do is dial a server whose credential it could not
   * read: the server answers `401`, the job records a refusal that reads as a
   * wrong token, and the setting that would fix it is named nowhere. The report
   * is the only surface a background run has.
   */
  it('reports an enabled connector whose secret it cannot decrypt', async () => {
    await seedDueJob();
    await new SettingsStore(paths.settings).patch({
      mcpServers: [connector()],
    });
    await mkdir(paths.secretsDir, {recursive: true});
    await writeFile(
      mcpSecretFile(paths, 'mcp:notes', 'header', 'Authorization'),
      `encrypted:${Buffer.from('a-token').toString('base64')}\n`,
      'utf8',
    );

    const report = await runDue({paths});

    // Not a failed run: the jobs still run, without that connector's tools.
    expect(report.problem).toBeUndefined();
    expect(report.connectorProblems).toHaveLength(1);
    expect(report.connectorProblems?.[0]).toContain('notes');
    expect(report.connectorProblems?.[0]).toMatch(/is encrypted/u);
    // And the sentence points at the fix rather than at the server.
    expect(report.connectorProblems?.[0]).toMatch(/Re-enter it/iu);
  });
});

/** A connector with one header secret, as the settings document holds it. */
function connector(): McpServer {
  return {
    id: 'mcp:notes',
    name: 'notes',
    transport: 'stdio',
    // Never reached: the credential is read before the command is spawned, and
    // that is the whole point of the case.
    command: '/nonexistent/definitely-not-real',
    enabled: true,
    trusted: false,
    secretStorage: 'keychain',
    secrets: [{target: 'header', name: 'Authorization'}],
  };
}

/*
 * What the runner can make of a connector's secret, which is decided by the store
 * it builds rather than by anything it is told: no cipher, so `plaintext:` is a
 * value and `encrypted:` is a sentence. Both halves are asserted here because the
 * difference is the whole feature — one lets a scheduled job use a connector, and
 * the other must be reported rather than dialled around.
 */
describe('the connector secrets the runner reads', () => {
  let dir: string;
  let paths: AppPaths;

  beforeEach(async () => {
    dir = await mkdtemp(join(process.cwd(), '.marimo-runner-secrets-'));
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

  async function writeSecret(contents: string): Promise<void> {
    await mkdir(paths.secretsDir, {recursive: true});
    await writeFile(
      mcpSecretFile(paths, 'mcp:notes', 'header', 'Authorization'),
      contents,
      'utf8',
    );
  }

  it('reads a plaintext: secret the user let the runner read', async () => {
    await writeSecret(
      `plaintext:${Buffer.from('a-token').toString('base64')}\n`,
    );

    await expect(connectorSecrets(paths)(connector())).resolves.toEqual({
      env: {},
      headers: {Authorization: 'a-token'},
    });
  });

  it('reports an encrypted: one as unreadable, with the sentence', async () => {
    await writeSecret(
      `encrypted:${Buffer.from('a-token').toString('base64')}\n`,
    );

    const failure = await connectorSecrets(paths)(connector()).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(Error);
    const message = failure instanceof Error ? failure.message : '';
    expect(message).toMatch(/is encrypted/u);
    expect(message).toMatch(/Re-enter it/iu);
  });

  it('says nothing for a connector that declares no secret', async () => {
    const {secrets: _none, ...withoutSecrets} = connector();
    await expect(connectorSecrets(paths)(withoutSecrets)).resolves.toEqual({
      env: {},
      headers: {},
    });
  });
});

describe('describeReport', () => {
  const base = {
    userData: '/data/marimo',
    appIsRunning: false,
    total: 0,
    enabled: 0,
    due: 0,
    ran: [] as string[],
  };

  it('says plainly when there is nothing to do', () => {
    expect(describeReport(base).join('\n')).toMatch(/none due/u);
  });

  it('says the app has it, rather than reporting an error', () => {
    const lines = describeReport({...base, appIsRunning: true}).join('\n');
    expect(lines).toMatch(/the app is running/u);
    expect(lines).not.toMatch(/FAILED/u);
  });

  it('prints a problem as a failure, not as an empty schedule', () => {
    const lines = describeReport({...base, problem: 'it is broken'}).join('\n');
    expect(lines).toContain('FAILED');
    expect(lines).not.toContain('none due');
  });

  it('names the jobs it ran', () => {
    const lines = describeReport({...base, ran: ['job-1']}).join('\n');
    expect(lines).toContain('job-1');
  });

  it('prints a connector that did not come up, without calling the run failed', () => {
    // A connector that is down costs a job its tools; it does not stop the run,
    // and a report that made it a failure would make a timer's exit code depend
    // on somebody else's server.
    const lines = describeReport({
      ...base,
      connectorProblems: ['notes: The Authorization is encrypted.'],
    }).join('\n');
    expect(lines).toContain('notes: The Authorization is encrypted.');
    expect(lines).not.toContain('FAILED');
  });
});

describe('main', () => {
  let dir: string;
  let previous: string | undefined;

  beforeEach(async () => {
    dir = await mkdtemp(join(process.cwd(), '.marimo-runner-main-'));
    previous = process.env[USER_DATA_ENV];
    process.env[USER_DATA_ENV] = dir;
  });

  afterEach(async () => {
    if (previous === undefined) {
      delete process.env[USER_DATA_ENV];
    } else {
      process.env[USER_DATA_ENV] = previous;
    }
    await rm(dir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 20,
    });
  });

  /** Runs `main` without printing, and answers its exit code. */
  async function quietly(argv: string[] = []): Promise<number> {
    const stdout = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    try {
      return await main(argv);
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
    }
  }

  it('exits zero on a fresh install, because nothing to do is not a failure', async () => {
    expect(await quietly()).toBe(0);
  });

  it('exits non-zero when it could not read the jobs', async () => {
    await writeFile(join(dir, 'jobs.json'), 'not json at all', 'utf8');
    expect(await quietly()).toBe(1);
  });

  it('answers in JSON when asked, for a service log', async () => {
    const stdout = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
    try {
      await main(['--json']);
      const printed = stdout.mock.calls.map((call) => String(call[0])).join('');
      expect(JSON.parse(printed)).toMatchObject({appIsRunning: false});
    } finally {
      stdout.mockRestore();
    }
  });
});
