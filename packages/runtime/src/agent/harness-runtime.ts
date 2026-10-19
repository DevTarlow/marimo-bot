/**
 * The v2 runtime facade.
 *
 * It is deliberately thin: resolve the profile's harness, build the driver for
 * the model it names, and hand the turn to the engine. The old `AgentRuntime`
 * still owns profiles, Spaces, documents, jobs and recall; this owns the turn
 * path and nothing else, which is what lets Phase 1 land without pretending the
 * rest of the app has already moved.
 */
import {randomUUID} from 'node:crypto';

import type {
  AgentProfile,
  AgentUiEvent,
  MemorySupersede,
  PendingGate,
  ProviderId,
  StoredSkill,
  TranscriptMessage,
} from '@marimo/protocol';
import {
  AdkDriver,
  GateNotFoundError,
  MemoryStore,
  OpenAiCompatLlm,
  SKILLS,
  TurnBusyError,
  TurnEngine,
  composeHarnessInstruction,
  participantsIn,
  pendingGatesFromLog,
  resolveHarness,
  runReview,
  type AgentConfig,
  type EventStore,
  type HarnessSpec,
  type SkillToolService,
  type TurnDriver,
} from '@marimo/agent';

import type {MemoryProposal} from '@marimo/protocol';

import {FeedbackStore} from '../feedback.js';
import {MemoryProposalStore} from '../memory-proposals.js';
import type {AppPaths} from '../paths.js';
import {FileEventStore} from '../events/file-event-store.js';
import type {SecretRead} from '../secrets.js';
import type {ProfileStore} from '../profiles.js';
import type {SettingsStore} from '../settings.js';
import {RuntimeSkillService} from '../skill-service.js';
import {SkillStore} from '../skills.js';
import {workspaceRootFor} from '../workspaces.js';
import type {WorkspaceStore} from '../workspaces.js';
import {resolveAgentConfig} from './resolve.js';
import {
  projectPendingGates,
  projectTurn,
  transcriptFromEvents,
} from './harness-projection.js';

export class HarnessRuntimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HarnessRuntimeError';
  }
}

export interface HarnessRuntimeOptions {
  paths: AppPaths;
  settings: SettingsStore;
  profiles: ProfileStore;
  workspaces: WorkspaceStore;
  readSecret: (provider: ProviderId) => Promise<SecretRead>;
  /** Injected by tests; the app builds a real ADK driver. */
  driverFactory?: (config: AgentConfig) => TurnDriver;
  /** Injected by tests; the app writes to the v2 log directory. */
  store?: EventStore;
  /** Injected by tests; the app asks the profile's own model. */
  reviewer?: (prompt: string) => Promise<string>;
  /** Injected by tests; the app asks a bot's own model. */
  answerer?: (prompt: string) => Promise<string>;
  version?: number;
  now?: () => Date;
  createId?: () => string;
}

interface Prepared {
  profile: AgentProfile;
  config: AgentConfig;
  harness: HarnessSpec;
  workspaceRoot: string;
  memory: MemoryStore;
}

interface SessionState {
  engine: TurnEngine;
  driver: DelegatingDriver;
  model: {config: AgentConfig};
}

/**
 * A stable driver seam whose current driver is replaced before each turn.
 *
 * The engine holds one driver for the life of a conversation so its busy guard
 * and state remain one object. The actual ADK driver is built per turn because
 * its prompt and tool services are facts about that turn.
 */
class DelegatingDriver implements TurnDriver {
  current: TurnDriver | undefined;

  run(input: Parameters<TurnDriver['run']>[0]): ReturnType<TurnDriver['run']> {
    if (this.current === undefined) {
      throw new Error('No driver is configured for this turn.');
    }
    return this.current.run(input);
  }

  resume(
    input: Parameters<TurnDriver['resume']>[0],
  ): ReturnType<TurnDriver['resume']> {
    if (this.current === undefined) {
      throw new Error('No driver is configured for this turn.');
    }
    return this.current.resume(input);
  }
}

export class HarnessRuntime {
  private readonly options: HarnessRuntimeOptions;
  private readonly store: EventStore;
  private readonly skillStore: SkillStore;
  private readonly skillService: RuntimeSkillService;
  private readonly proposals: MemoryProposalStore;
  private readonly feedback: FeedbackStore;
  private readonly states = new Map<string, SessionState>();

  constructor(options: HarnessRuntimeOptions) {
    this.options = options;
    this.store =
      options.store ??
      new FileEventStore({rootDir: options.paths.harnessSessions});
    this.skillStore = new SkillStore({
      root: options.paths.skills,
      legacyFile: options.paths.legacySkills,
      reserved: SKILLS.map((skill) => skill.name),
    });
    this.skillService = new RuntimeSkillService({
      skills: this.skillStore,
      profiles: options.profiles,
    });
    this.proposals = new MemoryProposalStore({
      file: options.paths.memoryProposals,
    });
    this.feedback = new FeedbackStore({file: options.paths.feedback});
  }

  /** Runs one turn in one conversation. */
  async *run(
    profileId: string,
    sessionId: string,
    text: string,
    addressedProfileId?: string,
  ): AsyncGenerator<AgentUiEvent> {
    let prepared: Prepared;
    try {
      await this.assertOwner(sessionId, profileId);
      const events = await this.store.read(sessionId);
      const answering =
        addressedProfileId !== undefined && addressedProfileId !== profileId
          ? addressedProfileId
          : profileId;
      if (
        answering !== profileId &&
        !participantsIn(events).includes(answering)
      ) {
        throw new HarnessRuntimeError(
          `"${answering}" is not in this conversation.`,
        );
      }
      prepared = await this.prepare(answering);
    } catch (error) {
      yield failed(sessionId, error);
      return;
    }

    const state = this.stateFor(sessionId, prepared.config);
    state.driver.current = this.driverFor(prepared);
    try {
      yield* projectTurn(
        state.engine.run({
          sessionId,
          profileId,
          text,
          harness: prepared.harness,
          session: {title: titleFor(text)},
        }),
        sessionId,
      );
    } catch (error) {
      yield failed(sessionId, busyOr(error));
    }
  }

  /** Answers one card and resumes the turn when its round is complete. */
  async *approve(
    profileId: string,
    params: {sessionId: string; callId: string; confirmed: boolean},
  ): AsyncGenerator<AgentUiEvent> {
    let prepared: Prepared;
    let gate: ReturnType<typeof pendingGatesFromLog>[number] | undefined;
    try {
      await this.assertOwner(params.sessionId, profileId);
      gate = pendingGatesFromLog(await this.store.read(params.sessionId)).find(
        (candidate) => candidate.callId === params.callId,
      );
      if (gate === undefined) {
        throw new GateNotFoundError(params.callId);
      }
      prepared = await this.prepare(gate.agentId ?? profileId);
    } catch (error) {
      yield failed(params.sessionId, error);
      return;
    }

    const state = this.stateFor(params.sessionId, prepared.config);
    state.driver.current = this.driverFor(prepared);
    try {
      yield* projectTurn(
        state.engine.approve({
          sessionId: params.sessionId,
          callId: params.callId,
          confirmed: params.confirmed,
          harness: prepared.harness,
        }),
        params.sessionId,
        gate.turnId,
      );
    } catch (error) {
      yield failed(params.sessionId, busyOr(error));
    }
  }

  async pendingGates(sessionId: string): Promise<PendingGate[]> {
    return projectPendingGates(await this.store.read(sessionId));
  }

  async participants(profileId: string, sessionId: string): Promise<string[]> {
    await this.assertOwner(sessionId, profileId);
    return participantsIn(await this.store.read(sessionId));
  }

  /**
   * Sets who is in a v2 conversation. The owner is implicit; the list is the
   * other agents, or the whole membership the window passed.
   */
  async setParticipants(
    profileId: string,
    sessionId: string,
    agentIds: readonly string[],
  ): Promise<string[]> {
    await this.assertOwner(sessionId, profileId);
    const unique = [...new Set(agentIds)];
    const event: import('@marimo/agent').SessionEvent = {
      id: randomUUID(),
      sessionId,
      at: new Date().toISOString(),
      type: 'participants.changed',
      agentIds: unique,
      by: profileId,
    };
    await this.store.append(sessionId, [event]);
    return participantsIn([...(await this.store.read(sessionId))]);
  }

  abort(sessionId: string): boolean {
    return this.states.get(sessionId)?.engine.abort(sessionId) ?? false;
  }

  isRunning(sessionId: string): boolean {
    return this.states.get(sessionId)?.engine.isRunning(sessionId) ?? false;
  }

  /**
   * The facts the sidebar needs that the v1 index does not have for a v2 chat.
   *
   * A v2 conversation's title and message count live in its own log, not the
   * ADK index. The list is merged from here so a group does not look like one
   * bot and a chat does not look empty after a reload.
   */
  async sessionInfo(sessionId: string): Promise<{
    title?: string;
    messageCount: number;
    agentIds: string[];
  }> {
    const events = await this.store.read(sessionId);
    const title = events
      .filter((event) => event.type === 'session.created')
      .at(-1)?.title;
    const messageCount = events.filter(
      (event) => event.type === 'user.message',
    ).length;
    return {
      ...(title === undefined ? {} : {title}),
      messageCount,
      agentIds: participantsIn(events),
    };
  }

  async transcript(
    sessionId: string,
    profileId?: string,
  ): Promise<TranscriptMessage[]> {
    if (profileId !== undefined) {
      await this.assertOwner(sessionId, profileId);
    }
    return transcriptFromEvents(await this.store.read(sessionId));
  }

  /**
   * Reads the conversation back and proposes what is worth remembering.
   *
   * Proposals go to the same `memory-proposals.json` the v1 review uses, so the
   * existing Memory card can show and resolve them. The watermark is moved
   * whether or not anything was found; a look that found nothing is still a look.
   */
  async reviewMemory(sessionId: string): Promise<{
    proposals: MemoryProposal[];
    events: number;
  }> {
    const events = await this.store.read(sessionId);
    const owner = ownerOf(events);
    if (owner === undefined) {
      return {proposals: [], events: 0};
    }
    const prepared = await this.prepare(owner);
    const reviewable = reviewEvents(events);
    const from = await this.proposals.reviewedUpTo(sessionId);
    if (reviewable.length <= from) {
      return {proposals: [], events: 0};
    }
    const refused = (await this.proposals.load()).dismissed
      .filter((entry) => entry.profileId === owner)
      .map((entry) => ({text: entry.text}));
    const corrections = (await this.feedback.forProfile(owner)).map(
      (entry) => ({excerpt: entry.excerpt, text: entry.correction}),
    );
    const found = await runReview({
      events: reviewable.slice(from),
      memory: await prepared.memory.read(),
      refused,
      corrections,
      ask: async (prompt) =>
        await (this.options.reviewer?.(prompt) ??
          this.askOnce(prepared, prompt)),
    });

    const recorded = await this.proposals.record(
      sessionId,
      from + found.used,
      found.proposals.map((proposal) => ({
        sessionId,
        profileId: owner,
        section: proposal.section,
        text: proposal.text,
        reason: proposal.reason,
        ...(proposal.replaces === undefined
          ? {}
          : {replaces: proposal.replaces}),
      })),
    );
    const added = new Set(found.proposals.map((proposal) => proposal.text));
    return {
      proposals: recorded.proposals.filter((proposal) =>
        added.has(proposal.text),
      ),
      events: found.used,
    };
  }

  /**
   * Accepts or refuses a proposal the v2 review recorded.
   *
   * The proposal store is shared with v1, so the window does not need a second
   * queue. What differs is who writes the fact: a v2 proposal belongs to a v2
   * conversation, and its memory is the one this facade knows how to reach.
   */
  async resolveMemoryProposal(
    proposalId: string,
    accept: boolean,
  ): Promise<{ok: boolean; problem?: string; supersede?: MemorySupersede}> {
    const file = await this.proposals.load();
    const proposal = file.proposals.find((entry) => entry.id === proposalId);
    if (proposal === undefined) {
      return {ok: false, problem: 'That suggestion is no longer waiting.'};
    }
    let supersede: MemorySupersede | undefined;
    if (accept) {
      try {
        const prepared = await this.prepare(proposal.profileId);
        const report = await prepared.memory.update(
          {
            content: proposal.text,
            section: proposal.section,
            ...(proposal.replaces === undefined
              ? {}
              : {replaces: proposal.replaces}),
          },
          'review',
        );
        supersede = report.supersede;
      } catch (error) {
        return {
          ok: false,
          problem: error instanceof Error ? error.message : String(error),
        };
      }
    }
    await this.proposals.remove(
      proposalId,
      accept ? undefined : {profileId: proposal.profileId, text: proposal.text},
    );
    return supersede === undefined ? {ok: true} : {ok: true, supersede};
  }

  /** Whether this conversation has a v2 log, so the shell can fall back. */
  async hasLog(sessionId: string): Promise<boolean> {
    return (await this.store.read(sessionId)).length > 0;
  }

  dispose(): void {
    this.states.clear();
  }

  private async assertOwner(
    sessionId: string,
    profileId: string,
  ): Promise<void> {
    const events = await this.store.read(sessionId);
    const owner =
      events.find((event) => event.type === 'session.created')?.profileId ??
      events.find((event) => event.type === 'turn.started')?.profileId;
    if (owner !== undefined && owner !== profileId) {
      throw new HarnessRuntimeError(
        'This conversation belongs to another bot.',
      );
    }
  }

  private async prepare(profileId: string): Promise<Prepared> {
    const settings = await this.options.settings.load();
    const profile = (await this.options.profiles.profiles()).find(
      (candidate) => candidate.id === profileId,
    );
    if (profile === undefined) {
      throw new HarnessRuntimeError(`There is no bot called "${profileId}".`);
    }

    const workspaces = await this.options.workspaces.load();
    const workspaceRoot = workspaceRootFor(workspaces, profile.spaceId);
    if (workspaceRoot === undefined) {
      throw new HarnessRuntimeError(
        `"${profile.name}" has no Space to work in. Load one in the rail first.`,
      );
    }

    const resolved = await resolveAgentConfig({
      settings,
      profile,
      readSecret: this.options.readSecret,
      workspaceRoot,
    });
    if (!resolved.ok) {
      throw new HarnessRuntimeError(resolved.problem);
    }
    const config = resolved.config;

    const memory = new MemoryStore({
      workspaceRoot,
      personMemoryRoot: this.options.paths.personMemoryDir,
      profileId: profile.id,
      ...(settings.memorySoftLimitBytes === undefined
        ? {}
        : {softLimitBytes: settings.memorySoftLimitBytes}),
    });

    const harness = resolveHarness({
      profile: {
        id: profile.id,
        name: profile.name,
        role: profile.identity,
        ...(profile.persona === undefined ? {} : {persona: profile.persona}),
        enabledTools: profile.enabledTools,
        enabledSkills: profile.enabledSkills,
        ...(profile.mcpServerIds === undefined
          ? {}
          : {mcpServerIds: profile.mcpServerIds}),
        ...(profile.model === undefined ? {} : {model: profile.model}),
      },
      app: {
        model: {provider: config.provider, model: config.model},
        allowPrivateNetworkFetch: settings.allowPrivateNetworkFetch,
        memorySoftLimitBytes: settings.memorySoftLimitBytes,
        learning: {mode: 'propose', retainTraces: false},
      },
      version: this.options.version ?? 1,
      workspaceRoot,
    });

    return {profile, config, harness, workspaceRoot, memory};
  }

  private stateFor(sessionId: string, config: AgentConfig): SessionState {
    const existing = this.states.get(sessionId);
    if (existing !== undefined) {
      existing.model.config = config;
      return existing;
    }
    const model = {config};
    const driver = new DelegatingDriver();
    const engine = new TurnEngine({
      store: this.store,
      driver,
      ...(this.options.now === undefined ? {} : {now: this.options.now}),
      ...(this.options.createId === undefined
        ? {}
        : {createId: this.options.createId}),
    });
    const state: SessionState = {engine, driver, model};
    this.states.set(sessionId, state);
    return state;
  }

  private driverFor(prepared: Prepared): TurnDriver {
    if (this.options.driverFactory !== undefined) {
      return this.options.driverFactory(prepared.config);
    }
    const profileId = prepared.profile.id;
    const skills: SkillToolService = {
      load: async (name) => {
        const answer = await this.skillService.load(profileId, name);
        return {
          ...(answer.skill === undefined
            ? {}
            : {
                skill: {
                  name: answer.skill.name,
                  description: answer.skill.description,
                  instructions: answer.skill.instructions,
                },
              }),
          names: answer.names,
        };
      },
      save: async (input) =>
        await this.skillService.saveFromAgent(input, profileId),
    };
    return new AdkDriver({
      resolveModel: () => this.llmFor(prepared.config),
      promptContext: async () => ({
        memory: await prepared.memory.readForPrompt(),
        skills: (await this.skillService.grantedForProfile(profileId)).map(
          (skill: StoredSkill) => ({
            name: skill.name,
            description: skill.description,
          }),
        ),
      }),
      toolContext: (_harness, signal) => ({
        workspaceRoot: prepared.workspaceRoot,
        signal,
        memory: prepared.memory,
        skills,
        delegate: async ({agent, task}) =>
          await this.askAgent(profileId, agent, task),
      }),
    });
  }

  /**
   * A second bot's answer, with its own instructions and memory and no tools.
   *
   * Deliberately not a turn: it has no session, no log, no approval card and no
   * ability to act. That keeps a bot-to-bot question from becoming a second
   * writer in the conversation, and it is honest about what the answer is — an
   * opinion, not work done.
   */
  async askAgent(
    ownerProfileId: string,
    agent: string,
    task: string,
  ): Promise<{ok: boolean; result: string}> {
    try {
      const profiles = await this.options.profiles.profiles();
      const wanted = agent.trim().toLowerCase();
      const target = profiles.find(
        (profile) =>
          profile.id !== ownerProfileId &&
          (profile.id === agent ||
            profile.name.trim().toLowerCase() === wanted),
      );
      if (target === undefined) {
        return {
          ok: false,
          result: `There is no bot called "${agent}". The roster has: ${profiles
            .filter((profile) => profile.id !== ownerProfileId)
            .map((profile) => profile.name)
            .join(', ')}.`,
        };
      }
      const owner = profiles.find((profile) => profile.id === ownerProfileId);
      const prepared = await this.prepare(target.id);
      /*
       * No skill index here. The bot being asked has no tools, so advertising a
       * skill it cannot load would be the prompt claiming a capability the turn
       * does not have. Memory and identity are enough for an opinion.
       */
      const instruction = composeHarnessInstruction(prepared.harness, {
        memory: await prepared.memory.readForPrompt(),
      });
      const prompt = [
        instruction,
        '',
        `${owner?.name ?? 'Another bot'} is asking you, in the same workspace:`,
        task,
        '',
        'Answer for the person. You cannot use tools in this exchange, so say what you know and what you would need.',
      ].join('\n');
      const answer = (
        await (this.options.answerer?.(prompt) ??
          this.askOnce(prepared, prompt))
      ).trim();
      return answer.length === 0
        ? {ok: false, result: `"${target.name}" did not answer.`}
        : {ok: true, result: answer};
    } catch (error) {
      return {
        ok: false,
        result: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * One model call for a background look, with no tools and no session.
   *
   * The review is not a turn: it must not appear in the conversation, and it
   * must not be able to call a tool. The same client serves it, because the
   * provider and key are the same facts.
   */
  private async askOnce(prepared: Prepared, prompt: string): Promise<string> {
    const llm = this.llmFor(prepared.config);
    let text = '';
    for await (const response of llm.generateContentAsync(
      {
        contents: [{role: 'user', parts: [{text: prompt}]}],
        liveConnectConfig: {},
        toolsDict: {},
      } as never,
      true,
    )) {
      for (const part of response.content?.parts ?? []) {
        if (typeof part.text === 'string' && part.text.length > 0) {
          text += part.text;
        }
      }
    }
    return text;
  }

  private llmFor(config: AgentConfig): OpenAiCompatLlm {
    return new OpenAiCompatLlm({
      model: config.model,
      baseUrl: config.baseUrl,
      provider: config.provider,
      apiKey: config.apiKey,
      ...(config.maxOutputTokens === undefined
        ? {}
        : {maxOutputTokens: config.maxOutputTokens}),
    });
  }
}

function failed(sessionId: string, error: unknown): AgentUiEvent {
  const message = error instanceof Error ? error.message : String(error);
  return {
    type: 'turn.failed',
    sessionId,
    messageId: randomUUID(),
    message,
  };
}

function busyOr(error: unknown): Error {
  if (error instanceof TurnBusyError) {
    return error;
  }
  return error instanceof Error ? error : new Error(String(error));
}

function titleFor(text: string): string {
  const title = text.replace(/\s+/g, ' ').trim().slice(0, 80);
  return title.length === 0 ? 'New chat' : title;
}

function ownerOf(
  events: readonly import('@marimo/agent').SessionEvent[],
): string | undefined {
  return (
    events.find((event) => event.type === 'session.created')?.profileId ??
    events.find((event) => event.type === 'turn.started')?.profileId
  );
}

function reviewEvents(
  events: readonly import('@marimo/agent').SessionEvent[],
): Array<{
  author?: string;
  content?: {parts?: Array<{text?: string; thought?: boolean}>};
}> {
  const reviewable: Array<{
    author?: string;
    content?: {parts?: Array<{text?: string; thought?: boolean}>};
  }> = [];
  for (const event of events) {
    if (event.type === 'user.message') {
      reviewable.push({
        author: 'user',
        content: {parts: [{text: event.text}]},
      });
    } else if (event.type === 'assistant.message') {
      reviewable.push({
        author: event.author,
        content: {
          parts: [
            ...(event.reasoning === undefined
              ? []
              : [{text: event.reasoning, thought: true}]),
            {text: event.text},
          ],
        },
      });
    }
  }
  return reviewable;
}
