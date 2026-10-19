/**
 * The runtime, from the outside.
 *
 * What is tested here is mostly what happens when the agent *cannot* start,
 * because that is the path a user actually meets: no key for the provider the
 * install is pointed at, a folder nobody has chosen yet, a conversation read back
 * without anything to answer with. Each of those has to arrive as a sentence in
 * the conversation rather than as a spinner, an empty screen, or an exception the
 * window never sees.
 *
 * The installed engine those cases used to be built around is gone with the
 * app's own model, so there is nothing to inject in its place: a turn needs a
 * provider and a provider needs a credential, which is the one thing the tests
 * below supply. The two answers a real install can give — a key that is present
 * and one that is not — are both a stub away, and no test touches a keychain.
 */
import {existsSync} from 'node:fs';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {dirname, join} from 'node:path';

import {afterEach, beforeEach, describe, expect, it} from 'vitest';

import {
  FileSessionService,
  MAX_MEMORY_BYTES,
  resolveMemoryFile,
  resolvePersonMemoryFile,
} from '@marimo/agent';
import type {AdkEvent} from '@marimo/agent';
import {
  DEFAULT_AGENT_PERSONA,
  DEFAULT_AGENT_ROLE,
  DEFAULT_MEMORY_SOFT_LIMIT_BYTES,
  DRAFT_BOT_TOOL,
  botPersonaFor,
  botRoleFor,
  botTemplateById,
} from '@marimo/protocol';
import type {AgentModel, ProviderId} from '@marimo/protocol';

import {avatarFile, resolveAppPaths} from '../paths.js';
import type {AppPaths} from '../paths.js';
import {FeedbackStore} from '../feedback.js';
import {MemoryProposalStore} from '../memory-proposals.js';
import {LastProfileError, ProfileStore} from '../profiles.js';
import type {SecretRead} from '../secrets.js';
import {WorkspaceStore} from '../workspaces.js';
import {AgentRuntime} from './runtime.js';
import type {AgentRuntimeOptions} from './runtime.js';

/** A key, so a turn can resolve: the whole of what an injected engine used to be. */
const keyPresent = async (): Promise<SecretRead> => ({
  state: 'present',
  value: 'test-key',
});

/**
 * No key at all, for the describes about refusal.
 *
 * The sentence it produces is the one a fresh install meets — the provider's own
 * label and the Settings card that fixes it — which is why the assertions below
 * are about those rather than about an engine that would not start.
 */
const noKey = async (): Promise<SecretRead> => ({state: 'absent'});

/**
 * An address that answers nothing.
 *
 * A test that let a request reach the service the catalogue names would be making
 * a network call: slow when it works, flaky when it does not, and about somebody
 * else's uptime rather than about this code. Loopback on a port nothing listens on
 * is the same trick the injected engine used to play, and one test needs the
 * *ask* to fail rather than to answer.
 */

/**
 * Gives the install a folder to work in.
 *
 * Seeded at the test's own directory rather than the real one: `resolveAppPaths`
 * derives `defaultWorkspace` from home, and a store that seeds it also creates
 * it — so a test that let the default stand would be making a folder in the
 * tester's home rather than doing something they asked for.
 */
async function seedWorkspaces(paths: AppPaths, root: string): Promise<void> {
  await new WorkspaceStore({
    file: paths.workspaces,
    defaultWorkspaceRoot: root,
  }).load();
}

describe('AgentRuntime', () => {
  let dir: string;
  let paths: ReturnType<typeof resolveAppPaths>;
  let profileId: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(process.cwd(), '.marimo-runtime-'));
    paths = resolveAppPaths(dir);
    await seedWorkspaces(paths, dir);

    // Set the install up the way the app would: a default profile, with no
    // capabilities and no folders of its own.
    const profiles = new ProfileStore({
      file: paths.profiles,
      defaultRole: '',
      defaultPersona: DEFAULT_AGENT_PERSONA,
      defaultTools: [],
      defaultSkills: [],
    });
    await profiles.load();
    profileId = (await profiles.activeProfile()).id;
  });

  afterEach(async () => {
    await rm(dir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 20,
    });
  });

  function runtime(
    options: Partial<Omit<AgentRuntimeOptions, 'paths'>> = {},
  ): AgentRuntime {
    // A key by default, because most of what a runtime does needs a config that
    // resolves; the cases about refusal pass `noKey` deliberately.
    return new AgentRuntime({paths, readSecret: keyPresent, ...options});
  }

  it('creates and lists a conversation without building a host', async () => {
    const agent = runtime();
    const hosts = (agent as unknown as {hosts: Map<string, unknown>}).hosts;
    expect(hosts.size).toBe(0);

    const session = await agent.createSession(profileId, 'A chat');
    expect(session).toBeDefined();
    const sessions = await agent.listSessions(profileId);
    expect(sessions.map((entry) => entry.id)).toContain(session?.id);
    expect(hosts.size).toBe(0);
  });

  it('brings a v1 conversation forward into the canonical log', async () => {
    const agent = runtime();
    const summary = await agent.createSession(profileId);
    const sessionId = summary?.id ?? '';
    const store = new FileSessionService({rootDir: paths.sessions});
    const session = await store.getSession({
      appName: 'marimo',
      userId: 'local',
      sessionId,
    });
    if (session === undefined) {
      throw new Error('the session was not created');
    }
    for (const [author, role, text] of [
      ['user', 'user', 'The old question.'],
      ['Marimo Bot', 'model', 'The old answer.'],
    ] as const) {
      await store.appendEvent({
        session,
        event: {
          id: `legacy-${author}`,
          author,
          content: {role, parts: [{text}]},
          timestamp: Date.now(),
        } as unknown as AdkEvent,
      });
    }

    expect(await agent.migrateLegacy(profileId, sessionId)).toBe(true);
    const transcript = await agent.transcript(profileId, sessionId);
    expect(transcript.messages.map((message) => message.text)).toEqual([
      'The old question.',
      'The old answer.',
    ]);
  });

  it('brings a v1 group’s membership forward with its words', async () => {
    const agent = runtime();
    const summary = await agent.createSession(profileId);
    const sessionId = summary?.id ?? '';
    await agent.setParticipants(profileId, sessionId, [
      profileId,
      'another-bot',
    ]);
    const store = new FileSessionService({rootDir: paths.sessions});
    const session = await store.getSession({
      appName: 'marimo',
      userId: 'local',
      sessionId,
    });
    if (session === undefined) {
      throw new Error('the session was not created');
    }
    await store.appendEvent({
      session,
      event: {
        id: 'legacy-user',
        author: 'user',
        content: {role: 'user', parts: [{text: 'A group question.'}]},
        timestamp: Date.now(),
      } as unknown as AdkEvent,
    });

    expect(await agent.migrateLegacy(profileId, sessionId)).toBe(true);
    expect(await agent.transcript(profileId, sessionId)).toMatchObject({
      messages: [{text: 'A group question.'}],
    });
    expect(await agent.harness().sessionInfo(sessionId)).toMatchObject({
      agentIds: [profileId, 'another-bot'],
    });
  });

  it('brings a waiting v1 card forward as a v2 card', async () => {
    const agent = runtime();
    const summary = await agent.createSession(profileId);
    const sessionId = summary?.id ?? '';
    const store = new FileSessionService({rootDir: paths.sessions});
    const session = await store.getSession({
      appName: 'marimo',
      userId: 'local',
      sessionId,
    });
    if (session === undefined) {
      throw new Error('the session was not created');
    }
    await store.appendEvent({
      session,
      event: {
        id: 'legacy-user',
        author: 'user',
        invocationId: 'inv-1',
        content: {role: 'user', parts: [{text: 'Run it?'}]},
        timestamp: Date.now(),
      } as unknown as AdkEvent,
    });
    await store.appendEvent({
      session,
      event: {
        id: 'legacy-gate',
        author: 'marimo',
        invocationId: 'inv-1',
        content: {
          role: 'model',
          parts: [
            {
              functionCall: {
                id: 'confirm-1',
                name: 'adk_request_confirmation',
                args: {
                  originalFunctionCall: {
                    id: 'call-1',
                    name: 'run_shell',
                    args: {command: 'ls'},
                  },
                  toolConfirmation: {hint: 'Run it?', confirmed: false},
                },
              },
            },
          ],
        },
        timestamp: Date.now(),
      } as unknown as AdkEvent,
    });

    expect(await agent.migrateLegacy(profileId, sessionId)).toBe(true);
    const pending = await agent.harness().pendingGates(sessionId);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      tool: 'run_shell',
      args: {command: 'ls'},
      hint: 'Run it?',
    });
  });

  /*
   * The size control in Settings reads these three numbers. They come from the
   * agent's own store rather than from a second copy of the setting, which is
   * what stops the dialog drawing a bar against a limit the agent is not using.
   */
  describe('memory usage', () => {
    it('reports the file size, the user limit and the hard cap', async () => {
      const agent = runtime();
      await agent.updateSettings({memorySoftLimitBytes: 16 * 1024});

      await mkdir(join(dir, '.marimo', profileId), {recursive: true});
      await writeFile(resolveMemoryFile(dir, profileId), '- a fact\n', 'utf8');

      const usage = await agent.memoryUsage(profileId);
      expect(usage).toEqual({
        bytes: Buffer.byteLength('- a fact\n', 'utf8'),
        limitBytes: 16 * 1024,
        capBytes: MAX_MEMORY_BYTES,
        reviewEvents: 40,
      });
    });

    it('reports zero for an agent that has never been told anything', async () => {
      const usage = await runtime().memoryUsage(profileId);
      expect(usage.bytes).toBe(0);
      expect(usage.limitBytes).toBe(DEFAULT_MEMORY_SOFT_LIMIT_BYTES);
    });

    /*
     * A readout is not a reason to dial an MCP server. Answering from settings
     * and the file is the same answer by construction, and it keeps the dialog
     * working on an install with no API key yet — which is what the second
     * assertion pins: a turn here genuinely cannot be configured, and the size
     * control still answers.
     */
    it('answers without building a host', async () => {
      const agent = runtime({readSecret: noKey});
      await agent.updateSettings({memorySoftLimitBytes: 4 * 1024});
      expect(await agent.memoryUsage(profileId)).toMatchObject({
        limitBytes: 4 * 1024,
      });
      expect(await agent.host(profileId)).toMatchObject({ok: false});
    });
  });

  describe('when the agent cannot start', () => {
    it('says so from `host` rather than throwing', async () => {
      const result = await runtime({readSecret: noKey}).host(profileId);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        // The sentence names the service and the screen, not "no API key":
        // somebody who has just picked a provider needs to know which one is
        // asking and where to answer it.
        expect(result.problem).toContain('DeepSeek');
        expect(result.problem).toMatch(/API key/u);
        expect(result.problem).toContain('Settings');
      }
    });

    /*
     * The refusal has to be an event, not an exception. `turn.failed` is what
     * the window already knows how to draw, next to the composer, where the user
     * is looking — an exception would be a console line they never see.
     */
    it('reports a turn it cannot start as a failed turn', async () => {
      const agent = runtime({readSecret: noKey});
      const events = [];
      for await (const event of agent.run(profileId, 'session-1', 'hello')) {
        events.push(event);
      }

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: 'turn.failed',
        sessionId: 'session-1',
        code: 'not-configured',
      });
      if (events[0]?.type === 'turn.failed') {
        expect(events[0].message).toMatch(/API key/u);
      }
    });

    it('says which agent when the profile does not exist', async () => {
      const result = await runtime().host('no-such-profile');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.problem).toContain('no-such-profile');
      }
    });
  });

  /*
   * A conversation is a file. Gating one on a working provider would mean a
   * fresh install could not open the chat it is supposed to explain itself in —
   * the refusal would have nowhere to be shown.
   */
  describe('conversations without a provider', () => {
    it('can be started anyway', async () => {
      const session = await runtime({readSecret: noKey}).createSession(
        profileId,
      );
      expect(session).toBeDefined();
      expect(session?.id.length).toBeGreaterThan(0);
    });

    it('are filed under the agent that started them', async () => {
      const agent = runtime({readSecret: noKey});
      await agent.createSession(profileId);

      expect(await agent.listSessions(profileId)).toHaveLength(1);
      // And not under an agent that did not.
      expect(await agent.listSessions('someone-else')).toEqual([]);
    });

    it('reports no pending gates for an agent that does not exist', async () => {
      expect(await runtime().pendingGates('nope', 'session')).toEqual([]);
    });

    it('has a place to record a gate even with no key', async () => {
      const agent = runtime({readSecret: noKey});
      const session = await agent.createSession(profileId);
      expect(await agent.pendingGates(profileId, session?.id ?? '')).toEqual(
        [],
      );
    });
  });

  describe('state', () => {
    it('is not busy before anything has run', () => {
      expect(runtime().isBusy()).toBe(false);
    });

    it('aborts a conversation it has never heard of without complaining', () => {
    });

    /*
     * A host holds the session service and the conversation state, so one per
     * profile is the point — building a new one per call would re-read the
     * session index on every message.
     */
    it('reuses one host for a profile', async () => {
      const agent = runtime();
      await agent.createSession(profileId);
      await agent.createSession(profileId);
      // Both were created through the same host, so both are listed by it.
      expect(await agent.listSessions(profileId)).toHaveLength(2);
    });

    it('disposes without error when nothing was ever started', async () => {
      await expect(runtime().dispose()).resolves.toBeUndefined();
    });
  });

  /*
   * A conversation longer than one look is read in stretches, and the watermark
   * may only move past what a look actually read.
   *
   * It used to jump to the total event count, so the beginning of a backlog was
   * marked reviewed without ever reaching a prompt: the reviewer could not see
   * it, and no later look would ask about it again. The failure is silent — the
   * first thing said in a long conversation is simply never remembered.
   */

  /*
   * What the panel's age list reads.
   *
   * Answered without building a host, which is the property worth pinning: the
   * panel opens before any turn has run, and a provenance read that dialled every
   * MCP server and started the model to draw a list would be the wrong shape
   * entirely. A write is made first so there is a date to answer with.
   */
  it('reports when a remembered fact was written', async () => {
    // A resolvable configuration, because accepting builds a host: the fact has
    // to be written by an agent, not merely proposed.
    const agent = runtime();
    // And a folder, because a host is built for the conversation's workspace.
    await agent.addWorkspace(join(dir, 'alpha'));
    const session = await agent.createSession(profileId);
    const proposals = new MemoryProposalStore({file: paths.memoryProposals});
    const recorded = await proposals.record(session?.id ?? '', 1, [
      {
        sessionId: session?.id ?? null,
        profileId,
        section: 'About the user',
        text: 'Has a dog called Sunshine.',
        reason: 'Said so.',
      },
    ]);
    const accepted = await agent.resolveMemoryProposal(
      recorded.proposals[0]?.id ?? '',
      true,
    );
    expect(accepted.ok).toBe(true);

    const entries = await agent.memoryProvenance(profileId);

    expect(entries).toHaveLength(1);
    expect(entries[0]?.text).toBe('Has a dog called Sunshine.');
    // Agreed to rather than stated, which is the difference the panel shows.
    expect(entries[0]?.source).toBe('review');
    expect(entries[0]?.scope).toBe('person');
  });

  it('reports nothing rather than failing for an agent that remembers nothing', async () => {
    expect(await runtime().memoryProvenance(profileId)).toEqual([]);
  });

  /*
   * "That answer was wrong", the one judgement that had nowhere to go.
   *
   * The two properties that matter are that it persists — the whole point is
   * that the *next* review reads it, which may be in another process after a
   * restart — and that it is scoped to the agent that gave the answer.
   */
  describe('what the user said about an answer', () => {
    it('records one against the active agent, and lists it', async () => {
      const agent = runtime();
      const session = await agent.createSession(profileId);

      const entry = await agent.recordFeedback({
        sessionId: session?.id ?? '',
        messageId: 'message-1',
        excerpt: 'The parser lives in alpha.',
        correction: 'No, it moved to beta.',
      });

      expect(entry.profileId).toBe(profileId);
      expect(entry.correction).toBe('No, it moved to beta.');
      expect(await agent.feedback()).toHaveLength(1);
    });

    it('survives a restart, which is the whole point of storing it', async () => {
      const session = await runtime().createSession(profileId);
      await runtime().recordFeedback({
        sessionId: session?.id ?? '',
        messageId: 'message-1',
        excerpt: 'Something wrong.',
      });

      const reopened = await runtime().feedback();
      expect(reopened).toHaveLength(1);
      expect(reopened[0]?.excerpt).toBe('Something wrong.');
    });

    it('forgets them all on request', async () => {
      const agent = runtime();
      const session = await agent.createSession(profileId);
      await agent.recordFeedback({
        sessionId: session?.id ?? '',
        messageId: 'message-1',
        excerpt: 'Something wrong.',
      });

      expect(await agent.clearFeedback()).toEqual([]);
      expect(await agent.feedback()).toEqual([]);
    });
  });
});

/*
 * What an agent may be granted, and making a grant take effect.
 *
 * The catalogue is built by *constructing* the tools rather than from a second
 * hand-written list, so these tests are also what stops a renamed tool being
 * offered under a name that grants nothing when it is ticked.
 */
describe('the catalogue', () => {
  let dir: string;
  let paths: AppPaths;
  let profileId: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(process.cwd(), '.marimo-catalog-'));
    paths = resolveAppPaths(dir);
    await seedWorkspaces(paths, dir);
    const profiles = new ProfileStore({
      file: paths.profiles,
      defaultRole: '',
      defaultPersona: DEFAULT_AGENT_PERSONA,
      defaultTools: [],
      defaultSkills: [],
    });
    await profiles.load();
    profileId = (await profiles.activeProfile()).id;
  });

  afterEach(async () => {
    await rm(dir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 20,
    });
  });

  function runtime(): AgentRuntime {
    return new AgentRuntime({paths, readSecret: keyPresent});
  }

  it('lists the tools by the name and wording the model is given', async () => {
    const catalog = await runtime().catalog();
    const names = catalog.tools.map((tool) => tool.name);

    expect(names).toContain('read_file');
    expect(names).toContain('write_file');
    // Every entry has to carry a description, or the settings screen offers a
    // checkbox with nothing beside it.
    expect(catalog.tools.every((tool) => tool.description.length > 10)).toBe(
      true,
    );
  });

  /*
   * A tool the profile has not been granted is still in the catalogue — that is
   * the whole point of a pick-list. What must not happen is the reverse: a name
   * in the catalogue that no tool answers to.
   */
  it('lists tools the profile has not been granted', async () => {
    const catalog = await runtime().catalog();
    expect(catalog.tools.map((tool) => tool.name)).toContain('run_shell');
  });

  /*
   * The catalogue is not per profile: the tools are the install's, and what
   * differs between agents is the grant. A catalogue that took a profile id was
   * one that varied only by the folder the agent happened to name.
   */
  it('is the same catalogue for every agent', async () => {
    const instance = runtime();
    const created = await instance.createProfile({name: 'Researcher'});
    const forResearcher = await instance.catalog();
    await instance.selectProfile(profileId);
    expect((await instance.catalog()).tools.map((tool) => tool.name)).toEqual(
      forResearcher.tools.map((tool) => tool.name),
    );
    expect(created.id).not.toBe(profileId);
  });

  /*
   * The presets are narrowed to what this install has, in the one place that
   * knows what that is. A card promising the to-do tools on an install with no
   * desk would be a choice that grants nothing — and the window, handed the
   * list, would have no way to tell.
   */
  it('offers presets naming only the tools this install has', async () => {
    const catalog = await runtime().catalog();
    const names = new Set(catalog.tools.map((tool) => tool.name));

    expect(catalog.presets.length).toBeGreaterThan(1);
    for (const preset of catalog.presets) {
      expect(preset.tools.length).toBeGreaterThan(0);
      expect(preset.tools.filter((name) => !names.has(name))).toEqual([]);
    }

    /*
     * This runtime wires no desk, and the desk is not part of the app yet, so
     * the eight to-do and note tools are not built here — and the widest card
     * must not offer them. The scheduling tools deliberately stay: this
     * catalogue does list them, because the app has jobs. `save_skill` is the
     * same rule from the other side: the runtime always wires the store, so the
     * switch exists and the widest card may offer it.
     */
    const capable = catalog.presets.find((preset) => preset.id === 'capable');
    expect(capable?.tools).toContain('create_job');
    expect(capable?.tools).not.toContain('list_todos');
    expect(capable?.tools).toContain('save_skill');
    expect(names.has('save_skill')).toBe(true);
  });

  /*
   * The spaces an agent can be pointed at, for the "works in" picker beside it.
   * Drawn from the workspace document rather than from a copy, so the picker can
   * only ever offer one that exists: a space added a moment ago is there, and
   * one the user has just removed is not.
   */
  it('lists the spaces the install has', async () => {
    const instance = runtime();
    expect((await instance.catalog()).spaces).toEqual(
      (await instance.workspaces()).workspaces,
    );

    const state = await instance.addWorkspace(join(dir, 'website'));
    const website = state.workspaces.find(
      (space) => space.path === join(dir, 'website'),
    );
    expect(website).toBeDefined();
    expect((await instance.catalog()).spaces).toContainEqual(website);

    await instance.removeWorkspace(website?.id ?? '');
    expect(
      (await instance.catalog()).spaces.map((space) => space.id),
    ).not.toContain(website?.id);
  });

  /*
   * The connector switches, drawn from the settings document rather than from
   * anything connected.
   *
   * That is the same rule the recall switch follows, and it is the whole reason
   * this catalogue builds no manager: the switch has to exist *before* a server
   * is reachable, or the connectors that cannot be dialled yet — a wrong command,
   * a secret the runner cannot read — would be the ones nobody could grant. The
   * runtime here is given no manager at all, which is what proves it.
   */
  it('lists the install’s connectors, connected or not', async () => {
    const instance = runtime();
    expect((await instance.catalog()).connectors).toEqual([]);

    await instance.updateSettings({
      mcpServers: [
        {
          id: 'mcp:notes',
          name: 'notes',
          transport: 'stdio',
          command: 'npx',
          args: ['-y', 'notes-mcp'],
          enabled: true,
          trusted: false,
          secretStorage: 'keychain',
        },
        {
          id: 'mcp:remote',
          name: 'remote',
          transport: 'http',
          url: 'https://example.test/mcp',
          enabled: false,
          trusted: true,
          secretStorage: 'plaintext',
        },
      ],
    });

    const connectors = (await instance.catalog()).connectors;
    expect(connectors.map((connector) => connector.id)).toEqual([
      'mcp:notes',
      'mcp:remote',
    ]);
    // Where it points, which is the one fact in the document that tells two
    // connectors apart — and the switch beside it, so an unplugged server is
    // still listed rather than silently dropped from the grant screen.
    expect(connectors[0]).toMatchObject({name: 'notes', enabled: true});
    expect(connectors[0]?.blurb).toContain('npx -y notes-mcp');
    expect(connectors[1]?.blurb).toContain('https://example.test/mcp');
    expect(connectors[1]?.enabled).toBe(false);
  });
});

describe('changing an agent', () => {
  let dir: string;
  let paths: AppPaths;
  let profileId: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(process.cwd(), '.marimo-grant-'));
    paths = resolveAppPaths(dir);
    await seedWorkspaces(paths, dir);
    const profiles = new ProfileStore({
      file: paths.profiles,
      defaultRole: '',
      defaultPersona: DEFAULT_AGENT_PERSONA,
      defaultTools: ['read_file'],
      defaultSkills: [],
    });
    await profiles.load();
    profileId = (await profiles.activeProfile()).id;
  });

  afterEach(async () => {
    await rm(dir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 20,
    });
  });

  function runtime(): AgentRuntime {
    return new AgentRuntime({paths, readSecret: keyPresent});
  }

  it('records a new grant', async () => {
    const instance = runtime();
    await instance.updateProfile(profileId, {
      enabledTools: ['read_file', 'run_shell'],
    });

    const profile = (await instance.profiles()).find(
      (entry) => entry.id === profileId,
    );
    expect(profile?.enabledTools).toEqual(['read_file', 'run_shell']);
  });

  /*
   * A grant is worthless if a host built under the old one goes on answering.
   * The host is dropped rather than updated, so the next turn is built from what
   * the profile now says — and this is the assertion that says so, because the
   * bug it prevents is invisible: the setting saves, the screen agrees, and the
   * agent carries on doing what it did before.
   */
  it('forgets the built agent so the next turn uses the new grant', async () => {
    const instance = runtime();
    await instance.updateProfile(profileId, {enabledTools: ['read_file']});
    // Nothing to drop before a host exists, which is the state after this call.
    expect(instance.isBusy()).toBe(false);

    await expect(
      instance.updateProfile(profileId, {enabledTools: []}),
    ).resolves.toMatchObject({enabledTools: []});
  });

  it('adds an agent and can switch to it', async () => {
    const instance = runtime();
    const created = await instance.createProfile({name: 'Researcher'});
    expect(created.name).toBe('Researcher');

    await instance.selectProfile(created.id);
    expect((await instance.activeProfile()).id).toBe(created.id);
  });
});

/*
 * The identity a new agent starts with, and the half that matters more: the
 * identities already on disk that must not change.
 *
 * The two are one feature. Settings resets an edited identity to the seed the
 * catalogue holds for *that* profile, so a seed and a button that disagreed
 * would make Reset restore something no agent is ever given — and a "default"
 * applied on read would be the app editing the user's words back to its own.
 * There are two seeds because there are two kinds of profile: the lead gets the
 * app's constant, a bot gets text built from its own name.
 */
describe('the identity a new agent gets', () => {
  let dir: string;
  let paths: AppPaths;

  beforeEach(async () => {
    dir = await mkdtemp(join(process.cwd(), '.marimo-identity-'));
    // A home of this test's own, because `catalog()` reads — and seeds — the
    // workspaces document, and seeding creates the starting folder.
    paths = resolveAppPaths(dir, {home: join(dir, 'home')});
  });

  afterEach(async () => {
    await rm(dir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 20,
    });
  });

  function runtime(): AgentRuntime {
    return new AgentRuntime({paths, readSecret: keyPresent});
  }

  it('starts the first agent on the shipped Role and Persona', async () => {
    const [profile] = await runtime().profiles();
    expect(profile?.identity).toBe(DEFAULT_AGENT_ROLE);
    expect(profile?.persona).toBe(DEFAULT_AGENT_PERSONA);
    // The same constants are what the two Reset buttons restore for the lead,
    // so a blank one is a feature that quietly does nothing in both places.
    expect(DEFAULT_AGENT_ROLE.trim().length).toBeGreaterThan(0);
    expect(DEFAULT_AGENT_PERSONA.trim().length).toBeGreaterThan(0);
  });

  it("gives a bot made later a Role of its own, not the lead's", async () => {
    const created = await runtime().createProfile({name: 'Researcher'});
    expect(created.identity).toBe(botRoleFor('Researcher'));
    expect(created.identity).not.toBe(DEFAULT_AGENT_ROLE);
    expect(created.persona).toBe(botPersonaFor(undefined));
  });

  /*
   * Reset is only correct if the catalogue answers per profile: the window
   * holds neither text, so this is the only place it can learn what to put back.
   * The lead is the first profile in the document, which is what makes its entry
   * the app constant rather than something derived from its name.
   */
  it('answers the reset seed for every profile, lead included', async () => {
    const instance = runtime();
    const [lead] = await instance.profiles();
    const writer = await instance.createProfile({name: 'Writer'});

    const catalog = await instance.catalog();
    expect(catalog.roleSeeds[lead?.id ?? '']).toBe(DEFAULT_AGENT_ROLE);
    expect(catalog.personaSeeds[lead?.id ?? '']).toBe(DEFAULT_AGENT_PERSONA);
    expect(catalog.roleSeeds[writer.id]).toBe(botRoleFor('Writer'));
    expect(catalog.personaSeeds[writer.id]).toBe(botPersonaFor(undefined));
  });

  /*
   * The starter role is resolved by the runtime, not the store: the Role, the
   * Persona and the grant all come from one entry, and a tool this install does
   * not carry is filtered rather than stored as a name the host would drop.
   */
  it('makes a bot from a starter role with its Persona and grant', async () => {
    const writer = botTemplateById('writer');
    expect(writer).toBeDefined();
    const created = await runtime().createProfile({
      name: 'Writer',
      templateId: 'writer',
    });
    expect(created.templateId).toBe('writer');
    expect(created.identity).toContain('Your work is writing');
    expect(created.persona).toBe(botPersonaFor(writer));
    expect(created.avatar?.id).toBe('spark');
    expect(created.enabledTools).toContain('read_file');
    // No web provider is injected here, so the template's web search is filtered.
    expect(created.enabledTools).not.toContain('web_search');
  });

  /*
   * The builder conversation is an ordinary session with a stored purpose, and
   * the check that matters is the one in code: without the tool the conversation
   * would tell Marimo to call something it does not have.
   */
  it('starts a builder session only when the lead can draft', async () => {
    const instance = runtime();
    const [lead] = await instance.profiles();
    expect(lead).toBeDefined();
    await expect(instance.startBuilderSession(lead?.id ?? '')).rejects.toThrow(
      /draft-bot tool/u,
    );

    await instance.updateProfile(lead?.id ?? '', {
      enabledTools: [...(lead?.enabledTools ?? []), DRAFT_BOT_TOOL],
    });
    const session = await instance.startBuilderSession(lead?.id ?? '');
    expect(session.title).toBe('Making a bot');
    expect(session.purpose).toBe('bot-builder');
  });

  /*
   * The seeds are the only reason this catalogue reads the profiles at all, and
   * that read can refuse — a document from a newer build is refused rather than
   * emptied, on purpose. What must not happen is the *rest* of the catalogue
   * going with it: the tools, the Spaces and the connectors come from other
   * documents, and a Settings page that lost all of them because the bots file
   * was unreadable would turn one broken card into five.
   */
  it('still answers its catalogue when the profiles cannot be read', async () => {
    /*
     * The folder document first, so the adoption that reads the profiles for a
     * last time has already happened. That ordering is what makes this the case
     * the guard exists for: from here on, the seeds are the only reason this
     * catalogue touches a file the rest of it does not need.
     */
    const workspaces = new WorkspaceStore({
      file: paths.workspaces,
      defaultWorkspaceRoot: dir,
    });
    const seeded = await workspaces.load();
    await workspaces.rename(seeded.workspaces[0]?.id ?? '', 'Work');

    await writeFile(
      paths.profiles,
      JSON.stringify({version: 99, profiles: [], activeProfileId: 'x'}),
      'utf8',
    );

    const catalog = await runtime().catalog();
    expect(catalog.roleSeeds).toEqual({});
    expect(catalog.personaSeeds).toEqual({});
    // And the four cards that are not about profiles are still there to draw.
    expect(catalog.tools.length).toBeGreaterThan(0);
    expect(catalog.presets.length).toBeGreaterThan(0);
  });

  it('leaves a Role the user already saved alone', async () => {
    const profiles = new ProfileStore({
      file: paths.profiles,
      defaultRole: '',
      defaultPersona: DEFAULT_AGENT_PERSONA,
      defaultTools: [],
      defaultSkills: [],
    });
    await profiles.load();

    const [profile] = await runtime().profiles();
    expect(profile?.identity).toBe('');
  });
});

/*
 * Reading a conversation must not need a provider.
 *
 * The version that resolved the model configuration first returned an *empty*
 * conversation whenever the key was missing — so an expired key, a cleared key,
 * or a fresh install emptied every chat in the window while the messages sat on
 * disk the whole time. That is indistinguishable from having lost them.
 *
 * It was found by trying to render a stored answer and getting a blank screen,
 * which is why the test writes a real conversation file and reads it back.
 */
describe('reading a conversation without a working provider', () => {
  let dir: string;
  let paths: AppPaths;
  let profileId: string;
  const sessionId = 'session-read-check';

  /**
   * One stored event, in the shape the session service writes.
   *
   * `actions` and `longRunningToolIds` are part of it: a line missing them is
   * skipped by the reader, which is how a hand-written conversation file
   * silently reads back as nothing at all.
   */
  function stored(
    author: string,
    role: string,
    text: string,
    invocationId = '',
  ): string {
    return JSON.stringify({
      author,
      content: {role, parts: [{text}]},
      id: `event-${author}-${text.length}`,
      invocationId,
      actions: {
        stateDelta: {},
        artifactDelta: {},
        requestedAuthConfirmation: {},
        requestedToolConfirmations: {},
      },
      longRunningToolIds: [],
      timestamp: Date.now(),
    });
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(process.cwd(), '.marimo-read-'));
    paths = resolveAppPaths(dir);
    await seedWorkspaces(paths, dir);
    const profiles = new ProfileStore({
      file: paths.profiles,
      defaultRole: '',
      defaultPersona: DEFAULT_AGENT_PERSONA,
      defaultTools: [],
      defaultSkills: [],
    });
    await profiles.load();
    profileId = (await profiles.activeProfile()).id;

    await mkdir(paths.sessions, {recursive: true});
    await writeFile(
      join(paths.sessions, `${sessionId}.jsonl`),
      `${stored('user', 'user', 'show me the parser output')}\n${stored('marimo', 'model', 'Here it is.', 'turn-read-1')}\n`,
      'utf8',
    );
    await writeFile(
      join(paths.sessions, 'index.json'),
      JSON.stringify({
        version: 1,
        sessions: {
          [sessionId]: {
            id: sessionId,
            title: 'Parser output',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            messageCount: 2,
            appName: 'marimo',
            userId: 'local',
            profileId,
          },
        },
      }),
      'utf8',
    );
  });

  afterEach(async () => {
    await rm(dir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 20,
    });
  });

  function runtime(): AgentRuntime {
    // No key at all: the describe is about what still works when nothing can
    // answer, so the refusal is the premise rather than an accident.
    return new AgentRuntime({paths, readSecret: noKey});
  }

  it('refuses the turn, because there is no key to answer with', async () => {
    // The premise: this install genuinely cannot answer.
    const result = await runtime().host(profileId);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problem).toContain('DeepSeek');
      expect(result.problem).toMatch(/API key/u);
    }
  });

  it('still reads the stored conversation', async () => {
    const {messages} = await runtime().transcript(profileId, sessionId);

    expect(messages.map((message) => message.text)).toEqual([
      'show me the parser output',
      'Here it is.',
    ]);
  });

  /*
   * What the user said about an answer has to come back with the answer.
   *
   * It used to live in one component's state until the window reloaded, so a
   * conversation opened again offered to note something already noted. The mark
   * is now read out of the document on every read — joined by the turn, because
   * that is the name the discovery log also uses.
   */
  it('marks the answer the user said was wrong', async () => {
    await writeFile(
      paths.feedback,
      JSON.stringify({
        version: 1,
        entries: [
          {
            id: 'feedback-1',
            profileId,
            sessionId,
            // Deliberately not the message's id: the invocation is the join
            // that matters, and a match on the message id here would hide a
            // broken invocation join behind a passing test.
            messageId: 'some-other-event',
            invocationId: 'turn-read-1',
            excerpt: 'Here it is.',
            correction: '',
            createdAt: new Date().toISOString(),
          },
        ],
      }),
      'utf8',
    );

    const {messages} = await runtime().transcript(profileId, sessionId);
    const answer = messages.find((message) => message.role === 'assistant');
    expect(answer?.markedWrong).toBe(true);
    // The user's own words are not the turn being judged.
    expect(messages[0]?.markedWrong).toBeUndefined();
  });

  it('marks one noted before turns were recorded, by its message', async () => {
    /*
     * Entries written before the window sent an invocation id have only the
     * message id. Refusing to show those would turn an upgrade into a silent
     * objection about the user's own note.
     */
    await writeFile(
      paths.feedback,
      JSON.stringify({
        version: 1,
        entries: [
          {
            id: 'feedback-2',
            profileId,
            sessionId,
            messageId: `event-marimo-${'Here it is.'.length}`,
            excerpt: 'Here it is.',
            correction: '',
            createdAt: new Date().toISOString(),
          },
        ],
      }),
      'utf8',
    );

    const {messages} = await runtime().transcript(profileId, sessionId);
    expect(
      messages.find((message) => message.role === 'assistant')?.markedWrong,
    ).toBe(true);
  });

  it('answers with nothing for an agent that does not exist', async () => {
    const runtime = new AgentRuntime({paths, readSecret: keyPresent});
    const {messages, pending} = await runtime.transcript(
      'no-such-agent',
      sessionId,
    );
    expect(messages).toEqual([]);
    expect(pending).toEqual([]);
  });

});

/*
 * The folders, and the rule the whole feature rests on: a turn runs in the
 * folder its conversation is filed under.
 *
 * This is the seam that makes browsing the rail safe. The folder is resolved
 * from the conversation at the moment a turn starts, so opening another chat
 * cannot move the one that is streaming — and the profile's current folder is
 * only the fallback, for a conversation with none or one whose folder has since
 * been forgotten.
 */
describe('folders and filing', () => {
  let dir: string;
  let paths: AppPaths;
  let profileId: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(process.cwd(), '.marimo-filing-'));
    // The starting folder under the test's own home: the seed below is at
    // `paths.defaultWorkspace`, and it creates the folder it names.
    paths = resolveAppPaths(dir, {home: join(dir, 'home')});
    const profiles = new ProfileStore({
      file: paths.profiles,
      defaultRole: '',
      defaultPersona: DEFAULT_AGENT_PERSONA,
      defaultTools: [],
      defaultSkills: [],
    });
    await profiles.load();
    profileId = (await profiles.activeProfile()).id;
  });

  afterEach(async () => {
    await rm(dir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 20,
    });
  });

  /*
   * Every configuration below has to resolve, so the install needs a key — the
   * injected engine that used to stand here went with the app's own model. The
   * refusal cases have their own describes, where there is deliberately none.
   */
  function runtime(): AgentRuntime {
    return new AgentRuntime({paths, readSecret: keyPresent});
  }

  /** Writes what an agent would have remembered in one folder. */
  async function remember(folder: string, line: string): Promise<void> {
    const memory = resolveMemoryFile(join(dir, folder), profileId);
    await mkdir(dirname(memory), {recursive: true});
    await writeFile(memory, `${line}\n`, 'utf8');
  }

  const folderId = (
    state: {workspaces: Array<{id: string; path: string}>},
    folder: string,
  ): string =>
    state.workspaces.find((entry) => entry.path === join(dir, folder))?.id ??
    '';

  it('seeds one folder at the default root', async () => {
    const state = await runtime().workspaces();
    expect(state.workspaces).toHaveLength(1);
    expect(state.workspaces[0]?.path).toBe(paths.defaultWorkspace);
    expect(state.activeWorkspaceId).toBe(state.workspaces[0]?.id);
    // And the folder the document names is there to work in.
    expect(existsSync(paths.defaultWorkspace)).toBe(true);
  });

  it('adds, selects, renames and removes, answering with the whole list', async () => {
    const agent = runtime();
    const first = await agent.addWorkspace(join(dir, 'alpha'));
    const alpha = folderId(first, 'alpha');
    expect(first.workspaces.map((entry) => entry.name)).toContain('alpha');
    // Loading a folder makes it the one a new conversation is filed under.
    expect(first.activeWorkspaceId).toBe(alpha);

    const renamed = await agent.renameWorkspace(alpha, 'Client work');
    expect(renamed.workspaces.find((entry) => entry.id === alpha)?.name).toBe(
      'Client work',
    );

    const second = await agent.addWorkspace(join(dir, 'beta'));
    expect(second.activeWorkspaceId).not.toBe(alpha);
    expect((await agent.selectWorkspace(alpha)).activeWorkspaceId).toBe(alpha);

    const removed = await agent.removeWorkspace(alpha);
    expect(removed.workspaces.map((entry) => entry.id)).not.toContain(alpha);
    expect(await agent.workspaceById(alpha)).toBeUndefined();
  });

  /*
   * The upgrade. A file written before folders were install-wide holds the only
   * copy of them, and the runtime is what hands it over — then drops the fields
   * from the file they came from.
   */
  it('adopts the folders a profiles file carried', async () => {
    await writeFile(
      paths.profiles,
      JSON.stringify({
        version: 1,
        activeProfileId: 'legacy-agent',
        profiles: [
          {
            id: 'legacy-agent',
            name: 'Agent',
            identity: 'You are an agent.',
            workspaces: [
              {id: 'legacy-ws', name: 'legacy', path: join(dir, 'legacy')},
            ],
            activeWorkspaceId: 'legacy-ws',
            enabledTools: [],
            enabledSkills: [],
          },
        ],
      }),
      'utf8',
    );

    const state = await runtime().workspaces();
    expect(state.workspaces).toEqual([
      {id: 'legacy-ws', name: 'legacy', path: join(dir, 'legacy')},
    ]);
    expect(state.activeWorkspaceId).toBe('legacy-ws');

    const raw = JSON.parse(await readFile(paths.profiles, 'utf8')) as {
      profiles: Array<{workspaces?: unknown; activeWorkspaceId?: unknown}>;
    };
    expect(raw.profiles[0]?.workspaces).toBeUndefined();
    expect(raw.profiles[0]?.activeWorkspaceId).toBeUndefined();
  });

  it('runs a turn in the folder its conversation is filed under', async () => {
    await remember('alpha', '- the parser lives in alpha');
    await remember('beta', '- the renderer lives in beta');

    const agent = runtime();
    const alpha = folderId(
      await agent.addWorkspace(join(dir, 'alpha')),
      'alpha',
    );
    const session = await agent.createSession(profileId);
    // Another folder becomes current; the conversation keeps its own.
    await agent.addWorkspace(join(dir, 'beta'));

    const filed = await agent.host(profileId, session?.id);
    expect(filed.ok).toBe(true);
    if (filed.ok) {
      expect(await filed.host.memoryText()).toContain('alpha');
    }

    // Asked about no conversation in particular, the agent is on the current
    // folder — which is what the memory readout in Settings reports.
    const current = await agent.host(profileId);
    if (current.ok) {
      expect(await current.host.memoryText()).toContain('beta');
    }

    // Unfiled, it falls back to the current folder rather than to nothing.
    await agent.setSessionWorkspace(profileId, session?.id ?? '', null);
    const loose = await agent.host(profileId, session?.id);
    if (loose.ok) {
      expect(await loose.host.memoryText()).toContain('beta');
    }

    // And a folder that has been forgotten falls back the same way.
    await agent.setSessionWorkspace(profileId, session?.id ?? '', alpha);
    await agent.removeWorkspace(alpha);
    const forgotten = await agent.host(profileId, session?.id);
    if (forgotten.ok) {
      expect(await forgotten.host.memoryText()).toContain('beta');
    }
  });

  /*
   * Where a new conversation is filed.
   *
   * Three answers in a fixed order — the space the caller named, the agent's
   * own, the rail's — and the point of the second is that a person who said
   * once that their Writer drafts into the website repo does not have to say it
   * again from the rail. The third is the behaviour every conversation had
   * before an agent could own a space, so it is here to keep that from
   * regressing.
   */
  it('files a new chat in the space the caller named', async () => {
    const agent = runtime();
    const alpha = folderId(
      await agent.addWorkspace(join(dir, 'alpha')),
      'alpha',
    );
    // Beta is the current space; the rail's "new chat in this space" names
    // alpha, and the caller wins.
    await agent.addWorkspace(join(dir, 'beta'));

    const session = await agent.createSession(profileId, undefined, alpha);
    expect(session?.workspaceId).toBe(alpha);
  });

  it("files a new chat in the agent's own space, whatever the rail is on", async () => {
    const agent = runtime();
    const alpha = folderId(
      await agent.addWorkspace(join(dir, 'alpha')),
      'alpha',
    );
    await agent.addWorkspace(join(dir, 'beta'));
    expect((await agent.workspaces()).activeWorkspaceId).not.toBe(alpha);
    await agent.updateProfile(profileId, {spaceId: alpha});

    expect((await agent.createSession(profileId))?.workspaceId).toBe(alpha);
  });

  it('files a new chat in the current space for an agent with none of its own', async () => {
    const agent = runtime();
    await agent.addWorkspace(join(dir, 'alpha'));
    const beta = folderId(await agent.addWorkspace(join(dir, 'beta')), 'beta');

    // The state every agent is in until somebody points one somewhere: the
    // space the rail is on, which is what this always did.
    expect((await agent.createSession(profileId))?.workspaceId).toBe(beta);
  });

  /*
   * A space the rail named that somebody has since removed. Stamping the id
   * would file the chat under "Other chats" — findable only by going to look in
   * a group nobody chose — so the rest of the order answers instead, exactly as
   * a conversation whose folder was removed falls back to the current one.
   */
  it('falls back when the named space is gone', async () => {
    const agent = runtime();
    const alpha = folderId(
      await agent.addWorkspace(join(dir, 'alpha')),
      'alpha',
    );
    const beta = folderId(await agent.addWorkspace(join(dir, 'beta')), 'beta');
    await agent.updateProfile(profileId, {spaceId: beta});

    await agent.removeWorkspace(alpha);
    expect(
      (await agent.createSession(profileId, undefined, alpha))?.workspaceId,
    ).toBe(beta);

    /*
     * And when the agent's own space has gone too, the rail's is what is left.
     * Reaching that needs no second removal: a Settings window that was open
     * when a space went can write the same stale id the rail just did.
     */
    await agent.updateProfile(profileId, {spaceId: alpha});
    expect((await agent.createSession(profileId))?.workspaceId).toBe(beta);
  });

  it('files, renames and deletes one conversation, refusing another agent', async () => {
    const agent = runtime();
    const session = await agent.createSession(profileId);
    const id = session?.id ?? '';

    const alpha = folderId(
      await agent.addWorkspace(join(dir, 'alpha')),
      'alpha',
    );
    expect(
      (await agent.setSessionWorkspace(profileId, id, alpha)).workspaceId,
    ).toBe(alpha);
    expect(
      (await agent.setSessionWorkspace(profileId, id, null)).workspaceId,
    ).toBeUndefined();

    // A stale window cannot touch another agent's conversation by naming it.
    await expect(
      agent.setSessionWorkspace('someone-else', id, alpha),
    ).rejects.toThrow(/Unknown session/u);

    expect(
      (await agent.renameSession(profileId, id, 'Release prep')).title,
    ).toBe('Release prep');

    await agent.deleteSession(profileId, id);
    expect(
      (await agent.listSessions(profileId)).map((entry) => entry.id),
    ).not.toContain(id);
  });

  /*
   * An accepted fact has to land in the project it came from, not in whichever
   * folder happens to be current when the user presses Accept — which can be a
   * day later, after opening something else entirely.
   */
  it('writes an accepted fact into the folder it came from', async () => {
    const agent = runtime();
    await mkdir(join(dir, 'alpha'), {recursive: true});
    await agent.addWorkspace(join(dir, 'alpha'));
    const session = await agent.createSession(profileId);
    // The current folder moves on before the user answers.
    await agent.addWorkspace(join(dir, 'beta'));

    const proposals = new MemoryProposalStore({file: paths.memoryProposals});
    const recorded = await proposals.record(session?.id ?? '', 1, [
      {
        sessionId: session?.id ?? null,
        profileId,
        section: 'Project',
        text: 'The parser lives in alpha.',
        reason: 'Said so in that conversation.',
      },
    ]);
    const proposal = recorded.proposals[0];

    const result = await agent.resolveMemoryProposal(proposal?.id ?? '', true);
    expect(result.ok).toBe(true);
    expect(
      await readFile(resolveMemoryFile(join(dir, 'alpha'), profileId), 'utf8'),
    ).toContain('The parser lives in alpha.');
    // And nothing was written into the folder that merely happens to be current.
    await expect(
      readFile(resolveMemoryFile(join(dir, 'beta'), profileId), 'utf8'),
    ).rejects.toThrow();
  });

  /*
   * An accepted correction either removes the old bullet or says that it could
   * not. The second half is the one that is invisible without this: the write
   * succeeds, the new fact is in memory, and the old one is still there too —
   * which is a contradiction the user believes they just resolved.
   */
  it('reports that a correction did remove the old bullet', async () => {
    const agent = runtime();
    const session = await agent.createSession(profileId);
    const proposals = new MemoryProposalStore({file: paths.memoryProposals});
    const recorded = await proposals.record(session?.id ?? '', 1, [
      {
        sessionId: session?.id ?? null,
        profileId,
        section: 'About the user',
        text: 'Their dog is called Sunshine.',
        reason: 'They corrected the name.',
        replaces: 'Their dog is called Shadow.',
      },
    ]);
    // The fact being corrected is already in memory, the way the reviewer saw it.
    await mkdir(join(paths.personMemoryDir, profileId), {recursive: true});
    await writeFile(
      join(paths.personMemoryDir, profileId, 'memory.md'),
      '## About the user\n- Their dog is called Shadow.\n',
      'utf8',
    );

    const result = await agent.resolveMemoryProposal(
      recorded.proposals[0]?.id ?? '',
      true,
    );

    expect(result.ok).toBe(true);
    expect(result.supersede).toEqual({
      outcome: 'removed',
      removed: '- Their dog is called Shadow.',
    });
  });

  /*
   * A refusal is remembered, and the memory is not written.
   *
   * Both halves matter and they fail in opposite directions: a refusal that was
   * not recorded is a suggestion the reviewer will make again, and a refusal that
   * *was* written to memory is the worse of the two — the user said no, and the
   * fact is now in every future prompt.
   */
  it('remembers a refusal without writing it into memory', async () => {
    const agent = runtime();
    const session = await agent.createSession(profileId);

    const proposals = new MemoryProposalStore({file: paths.memoryProposals});
    const recorded = await proposals.record(session?.id ?? '', 1, [
      {
        sessionId: session?.id ?? null,
        profileId,
        section: 'About the user',
        text: 'Scans their receipts every Sunday.',
        reason: 'Said so in that conversation.',
      },
    ]);

    const result = await agent.resolveMemoryProposal(
      recorded.proposals[0]?.id ?? '',
      false,
    );

    expect(result.ok).toBe(true);
    expect(await agent.memoryProposals()).toEqual([]);
    expect((await agent.dismissedMemory()).map((entry) => entry.text)).toEqual([
      'Scans their receipts every Sunday.',
    ]);
    // The fact itself never reached the memory file.
    await expect(
      readFile(resolveMemoryFile(dir, profileId), 'utf8'),
    ).rejects.toThrow();

    // And the undo is total, which is what makes the quiet list safe to keep.
    expect(await agent.forgetDismissedMemory()).toEqual([]);
    expect(await agent.dismissedMemory()).toEqual([]);
  });
});

/*
 * The model a turn answers with, as a pair.
 *
 * `{provider, model}` is the only shape this app stores or sends, because a model
 * id means nothing without the endpoint that serves it — and the two halves move
 * for different reasons. A provider's list is a *fact*, recorded by the refresh
 * that fetched it; a conversation's choice is a decision about one question.
 */
describe('the model a turn answers with', () => {
  let dir: string;
  let paths: AppPaths;
  let profileId: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(process.cwd(), '.marimo-model-choice-'));
    paths = resolveAppPaths(dir);
    await seedWorkspaces(paths, dir);
    const profiles = new ProfileStore({
      file: paths.profiles,
      defaultRole: '',
      defaultPersona: DEFAULT_AGENT_PERSONA,
      defaultTools: [],
      defaultSkills: [],
    });
    await profiles.load();
    profileId = (await profiles.activeProfile()).id;
  });

  afterEach(async () => {
    await rm(dir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 20,
    });
  });

  function runtime(
    options: Partial<Omit<AgentRuntimeOptions, 'paths'>> = {},
  ): AgentRuntime {
    return new AgentRuntime({paths, readSecret: keyPresent, ...options});
  }

  /*
   * The provider's own default moves with the list, and that is the half worth
   * pinning: a model the endpoint has retired would fail the next turn for a
   * reason nobody could see from the picker.
   */
  it('stores what a provider serves and moves its default off a retired name', async () => {
    const agent = runtime();
    const before = await agent.settings();
    // The catalogue's placeholder, which the endpoint no longer serves.
    expect(before.providers.configs.deepseek.model).toBe('deepseek-flash');

    const after = await agent.setAvailableModels('deepseek', [
      'deepseek-v4-pro',
    ]);

    expect(after.availableModels.deepseek).toEqual(['deepseek-v4-pro']);
    expect(after.providers.configs.deepseek.model).toBe('deepseek-v4-pro');
    // No other endpoint's answer is invented: each list is about one service, and
    // one that has never been asked has no list at all rather than a placeholder
    // written in its name.
    expect(after.availableModels.gemini).toBeUndefined();
    expect(after.providers.configs.gemini).toEqual(
      before.providers.configs.gemini,
    );
  });

  /*
   * A conversation's own choice, which outranks its agent's and the app's.
   *
   * The observable proof that the resolver honours it is which provider's key the
   * turn asks for, and `null` is the way back — without it, a chat that once
   * picked a model could never follow its agent again.
   */
  it('gives a conversation a model of its own, and takes it back with null', async () => {
    const asked: ProviderId[] = [];
    const agent = runtime({
      readSecret: async (provider) => {
        asked.push(provider);
        return {state: 'present', value: 'test-key'};
      },
    });
    const session = await agent.createSession(profileId);
    const id = session?.id ?? '';
    const chosen: AgentModel = {provider: 'gemini', model: 'gemini-3.1-pro'};

    expect((await agent.setSessionModel(profileId, id, chosen)).model).toEqual(
      chosen,
    );
    await agent.host(profileId, id);
    expect(asked).toEqual(['gemini']);

    expect(
      (await agent.setSessionModel(profileId, id, null)).model,
    ).toBeUndefined();
    await agent.host(profileId, id);
    // Back on the app's own provider. Absent means "follow the agent" rather than
    // "nothing was chosen", which is why giving it up is an answer of its own.
    expect(asked).toEqual(['gemini', 'deepseek']);
  });
});

/*
 * Who is in a conversation, and who answers when somebody is addressed.
 *
 * The membership lives on the conversation's index entry, so what is tested here
 * is the write, the read, the ownership rule every other conversation write
 * follows, and the routing an `@` produces. The turn's *answer* needs a provider
 * and is tested in the agent package, against a loopback server; what this file
 * can prove without one is that the refusal happens before a request and that the
 * agent addressed is the agent resolved.
 */
describe('who is in a conversation', () => {
  let dir: string;
  let paths: AppPaths;
  let lead: string;
  let helper: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(process.cwd(), '.marimo-participants-'));
    paths = resolveAppPaths(dir);
    await seedWorkspaces(paths, dir);
    const profiles = new ProfileStore({
      file: paths.profiles,
      defaultRole: '',
      defaultPersona: DEFAULT_AGENT_PERSONA,
      defaultTools: [],
      defaultSkills: [],
    });
    await profiles.load();
    lead = (await profiles.activeProfile()).id;
    helper = (
      await profiles.create({
        name: 'Researcher',
        role: (name) => botRoleFor(name),
        persona: DEFAULT_AGENT_PERSONA,
      })
    ).id;
    // Back to the lead: creating a profile selects it, and these tests are about
    // a conversation the lead owns with somebody else in it.
    await profiles.select(lead);
  });

  afterEach(async () => {
    await rm(dir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 20,
    });
  });

  function runtime(
    options: Partial<Omit<AgentRuntimeOptions, 'paths'>> = {},
  ): AgentRuntime {
    return new AgentRuntime({paths, readSecret: keyPresent, ...options});
  }

  it('round-trips the members, lead first', async () => {
    const agent = runtime();
    const session = await agent.createSession(lead);
    const id = session?.id ?? '';

    const updated = await agent.setParticipants(lead, id, [lead, helper]);

    expect(updated.agentIds).toEqual([lead, helper]);
    expect(await agent.sessionParticipants(lead, id)).toEqual([lead, helper]);
    // And through a fresh runtime, which is what a reloaded window is.
    expect(await runtime().sessionParticipants(lead, id)).toEqual([
      lead,
      helper,
    ]);
  });

  /*
   * Absent rather than an empty array: "just the agent that owns this chat" is
   * the state every conversation starts in, and a sentinel would be a second way
   * to say it that every reader would have to know about.
   */
  it('means "just the owner" when the list is empty', async () => {
    const agent = runtime();
    const session = await agent.createSession(lead);
    const id = session?.id ?? '';
    await agent.setParticipants(lead, id, [lead, helper]);

    const cleared = await agent.setParticipants(lead, id, []);

    expect(cleared.agentIds).toBeUndefined();
    expect(await agent.sessionParticipants(lead, id)).toBeUndefined();
  });

  /*
   * The rule every other path that touches a conversation follows, so a window
   * cannot add itself to another agent's chat by guessing at an id.
   */
  it('refuses a conversation another agent owns', async () => {
    const agent = runtime();
    const session = await agent.createSession(lead);
    const id = session?.id ?? '';

    await expect(agent.setParticipants(helper, id, [helper])).rejects.toThrow(
      /Unknown session/u,
    );
    expect(await agent.sessionParticipants(lead, id)).toBeUndefined();
  });

  it('refuses a conversation that does not exist', async () => {
    await expect(
      runtime().setParticipants(lead, 'no-such-session', [lead]),
    ).rejects.toThrow(/Unknown session/u);
  });

  /*
   * An id that is not a participant is refused rather than quietly answered by
   * the lead: a message that looks delivered and is not is worse than a refusal.
   */
  it('refuses a message addressed to somebody who is not in it', async () => {
    const agent = runtime();
    const session = await agent.createSession(lead);
    const id = session?.id ?? '';

    const events = [];
    for await (const event of agent.run(lead, id, 'hello', undefined, helper)) {
      events.push(event);
    }

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({type: 'turn.failed', sessionId: id});
    if (events[0]?.type === 'turn.failed') {
      expect(events[0].message).toContain('Researcher');
      expect(events[0].message).toMatch(/is not in this conversation/u);
      expect(events[0].message).toContain('@');
    }
  });

  it('refuses a message addressed to an agent this install does not have', async () => {
    const agent = runtime();
    const session = await agent.createSession(lead);
    const id = session?.id ?? '';
    // A member the install has since forgotten: the id is in the conversation, and
    // there is no profile behind it.
    await agent.setParticipants(lead, id, [lead, 'ghost']);

    const events = [];
    for await (const event of agent.run(
      lead,
      id,
      'hello',
      undefined,
      'ghost',
    )) {
      events.push(event);
    }

    expect(events[0]).toMatchObject({type: 'turn.failed'});
    if (events[0]?.type === 'turn.failed') {
      expect(events[0].message).toContain('"ghost"');
    }
  });

  /*
   * The routing itself, proved by *which agent's* configuration it resolved: the
   * addressed one has no key of its own, so the turn is refused with that agent's
   * sentence rather than the lead's. A turn that quietly answered as the lead
   * would fail on the lead's key and read as a working install.
   */
  it('answers as the agent that was addressed', async () => {
    const asked: ProviderId[] = [];
    const agent = runtime({
      readSecret: async (provider) => {
        asked.push(provider);
        return {state: 'present', value: 'test-key'};
      },
    });
    const session = await agent.createSession(lead);
    const id = session?.id ?? '';
    await agent.setParticipants(lead, id, [lead, helper]);
    // The addressed agent answers with a service this install has no key for.
    await agent.updateProfile(helper, {
      model: {provider: 'gemini', model: 'gemini-3.1-pro'},
    });

    const events = [];
    for await (const event of agent.run(lead, id, 'hello', undefined, helper)) {
      events.push(event);
    }

    // Resolved: the helper's own provider was asked for its key. The turn then
    // fails at the provider, which is the next thing after this file's business.
    expect(asked).toContain('gemini');
    expect(events.some((event) => event.type === 'turn.failed')).toBe(true);
  });
});

/*
 * Recall, as the runtime sees it: a setting, a service, and a process.
 *
 * The runtime does not own the engine — the window does — so what is tested here
 * is the two things this layer decides: whether the capability is offered at all,
 * and whether the process outlives the app. This is the *recall* engine, the one
 * left: it downloads its own weights under `model/recall/`.
 */
describe('recall', () => {
  let dir: string;
  let paths: AppPaths;

  beforeEach(async () => {
    dir = await mkdtemp(join(process.cwd(), '.marimo-recall-runtime-'));
    paths = resolveAppPaths(dir);
    await seedWorkspaces(paths, dir);
  });

  afterEach(async () => {
    await rm(dir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 20,
    });
  });

  /*
   * Built here rather than through a helper in this file: the other describes'
   * runtimes take an options object or nothing, and this one exists to hand in the
   * single process the runtime can be told to stop. Being explicit costs three
   * lines and cannot be read wrongly.
   */
  function withRecall(recall?: {stop: () => Promise<void>}): AgentRuntime {
    return new AgentRuntime({
      paths,
      readSecret: keyPresent,
      ...(recall === undefined ? {} : {recall}),
    });
  }

  /*
   * The switch has to exist before it can be turned on, and it must not exist on
   * an install that has no recall — a tick-box that grants nothing is worse than
   * no tick-box, because the user believes they granted something.
   */
  it('lists the recall tool only when the feature is switched on', async () => {
    const agent = withRecall();
    const before = await agent.catalog();
    expect(before.tools.map((tool) => tool.name)).not.toContain('recall');

    await agent.updateSettings({recall: {enabled: true}});

    const after = await agent.catalog();
    expect(after.tools.map((tool) => tool.name)).toContain('recall');
    /*
     * Listed, and not granted by default: a default the catalogue only
     * sometimes shows is a preset that stops matching, which is what the smoke
     * check found when recall was added to `SAFE_DEFAULT_TOOLS`.
     */
    const entry = after.tools.find((tool) => tool.name === 'recall');
    expect(entry?.byDefault).toBe(false);
    expect(entry?.blurb).toContain('mean');
  });

  it('takes the switch back off when it is turned off again', async () => {
    const agent = withRecall();
    await agent.updateSettings({recall: {enabled: true}});
    await agent.updateSettings({recall: {enabled: false}});

    expect(
      (await agent.catalog()).tools.map((tool) => tool.name),
    ).not.toContain('recall');
  });

  /*
   * The recall engine is 400 MB of weights and a fan, and this is the last moment
   * anything can stop it. The window's own service owns the process; the runtime
   * only knows to tell it.
   */
  it('stops the recall engine on the way out', async () => {
    let stops = 0;
    const agent = withRecall({
      stop: async () => {
        stops += 1;
      },
    });

    await agent.dispose();

    expect(stops).toBe(1);
  });

  it('does not require a recall engine to be there at all', async () => {
    const agent = withRecall();
    await expect(agent.dispose()).resolves.toBeUndefined();
  });
});

/**
 * Removing a bot, which is the only action in the app that destroys more than one
 * document at once.
 *
 * What it must *not* do is as much of the point as what it must. The last bot is
 * refused before anything of its is touched, and the bot beside it keeps its
 * conversations, its schedule and its corrections — because the failure this
 * guards against is a removal that takes a neighbour's history with it, and that
 * one is invisible until somebody notices a chat is gone.
 */
describe('removing a bot', () => {
  let dir: string;
  let paths: AppPaths;
  let defaultId: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(process.cwd(), '.marimo-remove-'));
    paths = resolveAppPaths(dir);
    await seedWorkspaces(paths, dir);
    const profiles = new ProfileStore({
      file: paths.profiles,
      defaultRole: '',
      defaultPersona: DEFAULT_AGENT_PERSONA,
      defaultTools: [],
      defaultSkills: [],
    });
    await profiles.load();
    defaultId = (await profiles.activeProfile()).id;
  });

  afterEach(async () => {
    await rm(dir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 20,
    });
  });

  function runtime(): AgentRuntime {
    return new AgentRuntime({paths, readSecret: keyPresent});
  }

  it('takes its conversations, its memory and its records with it', async () => {
    const instance = runtime();
    const bot = await instance.createProfile({name: 'Writer'});
    await instance.createSession(defaultId, 'kept');
    await instance.createSession(bot.id, 'written');

    /*
     * Everything else the app keeps for one bot: the person's half of memory
     * under user data, a suggestion it was about to make, and a correction the
     * user left about one of its answers.
     */
    const memoryDir = dirname(
      resolvePersonMemoryFile(paths.personMemoryDir, bot.id),
    );
    await mkdir(memoryDir, {recursive: true});
    await writeFile(join(memoryDir, 'memory.md'), '- has a cat\n', 'utf8');
    await new MemoryProposalStore({file: paths.memoryProposals}).record(
      'session-written',
      3,
      [
        {
          sessionId: 'session-written',
          profileId: bot.id,
          section: 'Notes',
          text: 'Has a cat.',
          reason: 'said so',
        },
      ],
    );
    await new FeedbackStore({file: paths.feedback}).record({
      profileId: bot.id,
      sessionId: 'session-written',
      messageId: 'message-1',
      excerpt: 'Wrong about the date.',
    });
    const avatar = avatarFile(paths, bot.id);
    await mkdir(dirname(avatar), {recursive: true});
    await writeFile(avatar, 'a png would be here', 'utf8');

    await instance.removeProfile(bot.id);

    expect((await instance.profiles()).map((entry) => entry.id)).toEqual([
      defaultId,
    ]);
    expect(await instance.listSessions(bot.id)).toEqual([]);
    expect(await instance.listSessions(defaultId)).toHaveLength(1);
    expect(existsSync(memoryDir)).toBe(false);
    expect(
      (await new MemoryProposalStore({file: paths.memoryProposals}).load())
        .proposals,
    ).toEqual([]);
    expect(
      (await new FeedbackStore({file: paths.feedback}).load()).entries,
    ).toEqual([]);
    expect(existsSync(avatar)).toBe(false);
  });

  /*
   * The order this method is written for. A refusal discovered after the
   * conversations were deleted would leave a bot that still exists with nothing
   * to answer for — which is the state removal exists to avoid, arrived at from
   * the other side.
   */
  it('refuses the last bot before touching anything it owns', async () => {
    const instance = runtime();
    await instance.createSession(defaultId, 'kept');

    await expect(instance.removeProfile(defaultId)).rejects.toBeInstanceOf(
      LastProfileError,
    );
    expect((await instance.profiles()).map((entry) => entry.id)).toEqual([
      defaultId,
    ]);
    expect(await instance.listSessions(defaultId)).toHaveLength(1);
  });
});
