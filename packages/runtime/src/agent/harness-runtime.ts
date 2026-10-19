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
  PendingGate,
  ProviderId,
  TranscriptMessage,
} from '@marimo/protocol';
import {
  AdkDriver,
  GateNotFoundError,
  OpenAiCompatLlm,
  TurnBusyError,
  TurnEngine,
  resolveHarness,
  type AgentConfig,
  type EventStore,
  type HarnessSpec,
  type TurnDriver,
} from '@marimo/agent';

import type {AppPaths} from '../paths.js';
import {FileEventStore} from '../events/file-event-store.js';
import type {SecretRead} from '../secrets.js';
import type {ProfileStore} from '../profiles.js';
import type {SettingsStore} from '../settings.js';
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
  version?: number;
  now?: () => Date;
  createId?: () => string;
}

interface Prepared {
  profile: AgentProfile;
  config: AgentConfig;
  harness: HarnessSpec;
}

interface SessionState {
  engine: TurnEngine;
  model: {config: AgentConfig};
}

export class HarnessRuntime {
  private readonly options: HarnessRuntimeOptions;
  private readonly store: EventStore;
  private readonly states = new Map<string, SessionState>();

  constructor(options: HarnessRuntimeOptions) {
    this.options = options;
    this.store =
      options.store ??
      new FileEventStore({rootDir: options.paths.harnessSessions});
  }

  /** Runs one turn in one conversation. */
  async *run(
    profileId: string,
    sessionId: string,
    text: string,
  ): AsyncGenerator<AgentUiEvent> {
    let prepared: Prepared;
    try {
      prepared = await this.prepare(profileId);
    } catch (error) {
      yield failed(sessionId, error);
      return;
    }

    try {
      await this.assertOwner(sessionId, profileId);
    } catch (error) {
      yield failed(sessionId, error);
      return;
    }

    const state = this.stateFor(sessionId, prepared.config);
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
    try {
      prepared = await this.prepare(profileId);
    } catch (error) {
      yield failed(params.sessionId, error);
      return;
    }

    try {
      await this.assertOwner(params.sessionId, profileId);
    } catch (error) {
      yield failed(params.sessionId, error);
      return;
    }

    const state = this.stateFor(params.sessionId, prepared.config);
    const gates = await state.engine.pendingGates(params.sessionId);
    const gate = gates.find((candidate) => candidate.callId === params.callId);
    if (gate === undefined) {
      yield failed(params.sessionId, new GateNotFoundError(params.callId));
      return;
    }

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

  abort(sessionId: string): boolean {
    return this.states.get(sessionId)?.engine.abort(sessionId) ?? false;
  }

  isRunning(sessionId: string): boolean {
    return this.states.get(sessionId)?.engine.isRunning(sessionId) ?? false;
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

    return {profile, config, harness};
  }

  private stateFor(sessionId: string, config: AgentConfig): SessionState {
    const existing = this.states.get(sessionId);
    if (existing !== undefined) {
      existing.model.config = config;
      return existing;
    }
    const model = {config};
    const driver =
      this.options.driverFactory?.(config) ??
      new AdkDriver({
        resolveModel: () => this.llmFor(model.config),
      });
    const engine = new TurnEngine({
      store: this.store,
      driver,
      ...(this.options.now === undefined ? {} : {now: this.options.now}),
      ...(this.options.createId === undefined
        ? {}
        : {createId: this.options.createId}),
    });
    const state: SessionState = {engine, model};
    this.states.set(sessionId, state);
    return state;
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
