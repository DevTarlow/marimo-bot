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
  LearningLesson,
  LearningProposal,
  MemorySupersede,
  CompactResult,
  PendingGate,
  ProviderId,
  StoredSkill,
  TranscriptMessage,
} from '@marimo/protocol';
import {
  AdkDriver,
  CORE_TOOLS,
  GateNotFoundError,
  MemoryStore,
  OpenAiCompatLlm,
  SKILLS,
  TurnBusyError,
  TurnEngine,
  composeHarnessInstruction,
  participantsIn,
  pendingGatesFromLog,
  harnessHash,
  resolveHarness,
  isAlwaysInjected,
  runReview,
  type AgentConfig,
  type EventStore,
  type HarnessSpec,
  type JobService,
  type LearningToolService,
  type RecallLookup,
  type SkillToolService,
  type WebSearchProvider,
  type TurnDriver,
  type ToolContext,
} from '@marimo/agent';

import type {MemoryProposal} from '@marimo/protocol';

import {FeedbackStore} from '../feedback.js';
import {LearningProposalStore} from '../learning-proposals.js';
import {MemoryProposalStore} from '../memory-proposals.js';
import {SkillUsageStore} from '../skill-usage.js';
import type {AppPaths} from '../paths.js';
import {FileEventStore} from '../events/file-event-store.js';
import type {HarnessVersionStore} from '../harness-versions.js';
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

/**
 * How long a granted skill may go unloaded before the inbox proposes retiring
 * it.
 *
 * Long enough that a monthly procedure survives fifty-nine days of not being
 * needed, short enough that a skill saved for one task does not sit in every
 * prompt for a year. The proposal is not a deletion, so being wrong costs one
 * click.
 */
const MAINTENANCE_AFTER_DAYS = 60;

function formatSize(bytes: number): string {
  return `${String(Math.max(1, Math.round(bytes / 1024)))} KB`;
}

function clip(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > 80 ? `${trimmed.slice(0, 77)}...` : trimmed;
}

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
  /** Recall, when the install has it switched on for this profile. */
  recallFor?: (
    profileId: string,
    workspaceRoot: string,
  ) => Promise<RecallLookup | undefined>;
  /** Scheduling, when the app has a job service for this profile. */
  jobsFor?: (
    profileId: string,
    workspaceRoot: string,
  ) => Promise<JobService | undefined>;
  /** Search, when this install has a provider. */
  webSearch?: WebSearchProvider;
  /** The frozen-spec ledger, when this install keeps one. */
  versions?: HarnessVersionStore;
  /** The index's Space for a session that has no v2 log yet. */
  sessionSpace?: (sessionId: string) => Promise<string | undefined>;
  /** Opens a conversation for a task, when this install can list one. */
  createSession?: (
    profileId: string,
    title: string,
  ) => Promise<{id: string; title?: string} | undefined>;
  version?: number;
  now?: () => Date;
  createId?: () => string;
}

interface Prepared {
  profile: AgentProfile;
  config: AgentConfig;
  harness: HarnessSpec;
  workspaceRoot: string;
  spaceId?: string;
  memory: MemoryStore;
  recall?: RecallLookup;
  jobs?: JobService;
  /** The version this turn's harness was edited from, when it is new. */
  parentVersion?: number;
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
  private readonly learning: LearningProposalStore;
  private readonly skillUsage: SkillUsageStore;
  private readonly feedback: FeedbackStore;
  private readonly states = new Map<string, SessionState>();
  /** ADK sessions left parked on a helper gate, keyed by parent session. */
  private readonly helperSessions = new Map<string, unknown>();
  /** Task conversations opened by start_task; they may not start another. */
  private readonly taskSessions = new Set<string>();

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
    this.skillUsage = new SkillUsageStore({
      file: options.paths.skillUsage,
    });
    this.skillService = new RuntimeSkillService({
      skills: this.skillStore,
      profiles: options.profiles,
      usage: this.skillUsage,
    });
    this.proposals = new MemoryProposalStore({
      file: options.paths.memoryProposals,
    });
    this.learning = new LearningProposalStore({
      file: options.paths.learningProposals,
    });
    this.feedback = new FeedbackStore({file: options.paths.feedback});
  }

  /** Runs one turn in one conversation. */
  async *run(
    profileId: string,
    sessionId: string,
    text: string,
    addressedProfileId?: string,
    instruction?: string,
    purpose?: 'bot-builder',
  ): AsyncGenerator<AgentUiEvent> {
    this.helperSessions.delete(sessionId);
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
      prepared = await this.prepare(answering, sessionId);
    } catch (error) {
      yield failed(sessionId, error);
      return;
    }

    /*
     * Audit, not the conversation. A ledger that cannot be written is worth a
     * missing record, not a turn that never starts.
     */
    await this.options.versions
      ?.record(
        prepared.harness,
        prepared.parentVersion === undefined
          ? undefined
          : {
              parent: prepared.parentVersion,
              reason: 'the bot or the app changed',
            },
      )
      .catch(() => undefined);

    const state = this.stateFor(sessionId, prepared.config);
    state.driver.current = this.driverFor(prepared, sessionId);
    try {
      yield* projectTurn(
        state.engine.run({
          sessionId,
          profileId,
          text,
          harness: prepared.harness,
          ...(instruction === undefined ? {} : {instruction}),
          session: {
            title: titleFor(text),
            ...(prepared.spaceId === undefined
              ? {}
              : {spaceId: prepared.spaceId}),
            ...(purpose === undefined ? {} : {purpose}),
          },
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
      prepared = await this.prepare(gate.agentId ?? profileId, params.sessionId);
    } catch (error) {
      yield failed(params.sessionId, error);
      return;
    }

    const state = this.stateFor(params.sessionId, prepared.config);
    state.driver.current = this.driverFor(prepared, params.sessionId);
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
    } finally {
      this.helperSessions.delete(params.sessionId);
    }
  }

  async pendingGates(sessionId: string): Promise<PendingGate[]> {
    return projectPendingGates(await this.store.read(sessionId));
  }

  /**
   * Counts for the Settings card: what this profile's v2 logs hold.
   *
   * A report is a read across every conversation, so it is on demand rather than
   * on the turn path. A log this build cannot read is counted, not hidden; one
   * bad file must not stop the rest of the report.
   */
  async report(profileId: string): Promise<{
    conversations: {v2: number};
    turns: number;
    usage: {promptTokens: number; completionTokens: number; totalTokens: number};
    unreadableLogs: number;
    harnessVersions: number;
    versions: Array<{hash: string; harnessVersion: number; recordedAt: string}>;
    pendingProposals: number;
    dismissedProposals: number;
    reviewedConversations: number;
    skills: number;
    skillVersions: number;
    /**
     * What the finished turns cost, and how many the user corrected.
     *
     * The denominator a proposal is judged against. A metric without it says
     * "three tool errors" and cannot say whether that is a bad week or a bad
     * bot; `completed` beside it is what makes the number mean something.
     */
    outcomes: {
      completed: number;
      failed: number;
      aborted: number;
      toolCalls: number;
      toolErrors: number;
      steps: number;
      approvals: number;
      corrections: number;
    };
    paths: {harnessSessions: string; harnessVersions: string};
  }> {
    let v2 = 0;
    let turns = 0;
    let promptTokens = 0;
    let completionTokens = 0;
    let totalTokens = 0;
    let unreadableLogs = 0;
    const outcomes = {
      completed: 0,
      failed: 0,
      aborted: 0,
      toolCalls: 0,
      toolErrors: 0,
      steps: 0,
      approvals: 0,
      corrections: 0,
    };
    const ids = this.store.list === undefined ? [] : await this.store.list();
    for (const id of ids) {
      let events;
      try {
        events = await this.store.read(id);
      } catch {
        unreadableLogs += 1;
        continue;
      }
      const owner =
        events.find((event) => event.type === 'session.created')?.profileId ??
        events.find((event) => event.type === 'turn.started')?.profileId;
      if (owner !== profileId) {
        continue;
      }
      v2 += 1;
      for (const event of events) {
        if (event.type === 'turn.started') {
          turns += 1;
        } else if (event.type === 'turn.completed') {
          outcomes.completed += 1;
          if (event.usage !== undefined) {
            promptTokens += event.usage.promptTokens;
            completionTokens += event.usage.completionTokens;
            totalTokens += event.usage.totalTokens;
          }
        } else if (event.type === 'turn.failed') {
          outcomes.failed += 1;
        } else if (event.type === 'turn.aborted') {
          outcomes.aborted += 1;
        }
        /*
         * An outcome is optional because a log written before this field existed
         * has none. Counting only what is there is the honest read: a missing
         * outcome contributes nothing rather than a zero that looks measured.
         */
        if (
          event.type === 'turn.completed' ||
          event.type === 'turn.failed' ||
          event.type === 'turn.aborted'
        ) {
          if (event.outcome !== undefined) {
            outcomes.toolCalls += event.outcome.toolCalls;
            outcomes.toolErrors += event.outcome.toolErrors;
            outcomes.steps += event.outcome.steps;
            outcomes.approvals += event.outcome.approvals;
          }
        }
      }
    }
    const versions =
      this.options.versions === undefined
        ? []
        : await this.options.versions.list().catch(() => []);
    const ownVersions = versions.filter((record) => record.spec.id === profileId);
    const proposalFile = await this.proposals.load();
    const learningFile = await this.learning.load();
    const currentLessons = await this.learning.currentLessons();
    const proposals =
      proposalFile.proposals.filter(
        (proposal) => proposal.profileId === profileId,
      ).length +
      learningFile.proposals.filter(
        (proposal) => proposal.profileId === profileId,
      ).length;
    /*
     * The current refusals, not the document's whole history. An expired
     * lesson is kept for the audit but no longer suppresses anything, and a
     * count that included it would tell the person the bot is quieter than it
     * is.
     */
    const dismissedProposals =
      proposalFile.dismissed.length +
      currentLessons.filter((lesson) => lesson.profileId === profileId)
        .length;
    const reviewedConversations = Object.keys(proposalFile.reviewed).length;
    outcomes.corrections = (await this.feedback.forProfile(profileId)).length;
    const skillList = await this.skillStore.load();
    let skillVersions = 0;
    for (const skill of skillList) {
      skillVersions += (await this.skillStore.history(skill.id)).length;
    }
    return {
      conversations: {v2},
      turns,
      usage: {promptTokens, completionTokens, totalTokens},
      unreadableLogs,
      harnessVersions: ownVersions.length,
      versions: ownVersions.map((record) => ({
        hash: record.hash,
        harnessVersion: record.harnessVersion,
        recordedAt: record.recordedAt,
      })),
      pendingProposals: proposals,
      dismissedProposals,
      reviewedConversations,
      skills: skillList.length,
      skillVersions,
      outcomes,
      paths: {
        harnessSessions: this.options.paths.harnessSessions,
        harnessVersions: this.options.paths.harnessVersions,
      },
    };
  }

  /**
   * Brings a v1 conversation's visible words into the canonical log.
   *
   * Best effort and one-way: the old ADK store stays where it is, and this only
   * runs when the conversation has no pending card. Tool calls are not replayed
   * — a migrated turn is the words, not the machinery — because inventing a tool
   * result for a call whose arguments are only partly known would be worse than
   * losing the fold. The next turn reads the words and continues on v2.
   */
  async importLegacy(
    profileId: string,
    sessionId: string,
    info: {
      title: string;
      spaceId?: string;
      purpose?: 'bot-builder';
      agentIds?: readonly string[];
      gates?: readonly import('@marimo/protocol').PendingGate[];
      author: string;
    },
    messages: readonly TranscriptMessage[],
  ): Promise<{imported: boolean; reason?: string}> {
    if (await this.hasLog(sessionId)) {
      return {imported: false, reason: 'This conversation is already on v2.'};
    }
    const visible = messages.filter(
      (message) => message.text.trim().length > 0,
    );
    const gates = info.gates ?? [];
    if (visible.length === 0 && gates.length === 0) {
      return {imported: false, reason: 'There was nothing to bring forward.'};
    }
    const first = visible[0];
    const events: import('@marimo/agent').SessionEvent[] = [
      {
        id: randomUUID(),
        sessionId,
        at:
          first?.createdAt ??
          gates[0]?.askedAt ??
          new Date().toISOString(),
        type: 'session.created',
        profileId,
        title: info.title,
        ...(info.spaceId === undefined ? {} : {spaceId: info.spaceId}),
        ...(info.purpose === undefined ? {} : {purpose: info.purpose}),
      },
    ];
    if (info.agentIds !== undefined && info.agentIds.length > 1) {
      events.push({
        id: randomUUID(),
        sessionId,
        at:
          first?.createdAt ??
          gates[0]?.askedAt ??
          new Date().toISOString(),
        type: 'participants.changed',
        agentIds: [...info.agentIds],
        by: profileId,
      });
    }
    let lastTurnId = 'legacy-0';
    visible.forEach((message, index) => {
      const turnId = `legacy-${String(Math.floor(index / 2))}`;
      lastTurnId = turnId;
      if (message.role === 'user') {
        events.push({
          id: randomUUID(),
          sessionId,
          at: message.createdAt,
          turnId,
          type: 'user.message',
          text: message.text,
        });
      } else {
        events.push({
          id: randomUUID(),
          sessionId,
          at: message.createdAt,
          turnId,
          type: 'assistant.message',
          author: info.author,
          text: message.text,
          ...(message.reasoning === undefined
            ? {}
            : {reasoning: message.reasoning}),
        });
      }
    });
    for (const gate of gates) {
      const callId = `legacy-${gate.callId}`;
      const args =
        gate.args !== null &&
        typeof gate.args === 'object' &&
        !Array.isArray(gate.args)
          ? (gate.args as Record<string, unknown>)
          : {};
      events.push(
        {
          id: randomUUID(),
          sessionId,
          at: gate.askedAt,
          turnId: lastTurnId,
          type: 'tool.call',
          callId,
          tool: gate.tool,
          args,
          author: info.author,
        },
        {
          id: randomUUID(),
          sessionId,
          at: gate.askedAt,
          turnId: lastTurnId,
          type: 'approval.requested',
          callId,
          confirmationId: gate.callId,
          tool: gate.tool,
          args,
          hint: gate.hint,
          author: info.author,
        },
      );
    }
    await this.store.append(sessionId, events);
    return {imported: true};
  }

  /** One v2 conversation's turns and the usage its completed turns reported. */
  async sessionUsage(
    profileId: string,
    sessionId: string,
  ): Promise<{
    turns: number;
    usage: {promptTokens: number; completionTokens: number; totalTokens: number};
  }> {
    await this.assertOwner(sessionId, profileId);
    const events = await this.store.read(sessionId);
    let turns = 0;
    let promptTokens = 0;
    let completionTokens = 0;
    let totalTokens = 0;
    for (const event of events) {
      if (event.type === 'turn.started') {
        turns += 1;
      } else if (event.type === 'turn.completed' && event.usage !== undefined) {
        promptTokens += event.usage.promptTokens;
        completionTokens += event.usage.completionTokens;
        totalTokens += event.usage.totalTokens;
      }
    }
    return {turns, usage: {promptTokens, completionTokens, totalTokens}};
  }

  /**
   * Puts a bot back to one recorded harness.
   *
   * The snapshot contains the identity, the tool grants, the skills grant, the
   * connector grant and the model pair. It does not contain the Space, the icon
   * or the memory files: those are not the harness, and silently moving a bot
   * back to an old folder or an old memory would be a much larger undo than the
   * person asked for. The next turn records the new harness as a new version.
   */
  async restoreHarness(
    profileId: string,
    hash: string,
  ): Promise<import('@marimo/protocol').AgentProfile> {
    if (this.options.versions === undefined) {
      throw new HarnessRuntimeError('There is no harness ledger to restore from.');
    }
    const record = await this.options.versions.load(hash);
    if (record === undefined || record.spec.id !== profileId) {
      throw new HarnessRuntimeError('That harness version does not belong to this bot.');
    }
    const spec = record.spec;
    const profile = await this.options.profiles.update(profileId, {
      name: spec.identity.name,
      identity: spec.identity.role,
      persona: spec.identity.persona ?? '',
      enabledTools: [...spec.tools.grants],
      enabledSkills: [...spec.context.skills.enabled],
      mcpServerIds:
        spec.tools.mcpServerIds === 'all'
          ? null
          : [...spec.tools.mcpServerIds],
      model: spec.model,
      /*
       * The safe policy comes back too. A version is a whole harness, and
       * restoring one that changed how much room a turn had while leaving the
       * room at the new value would be a partial undo presented as a whole one.
       */
      policy: {
        memoryPolicy: spec.context.memory.policy,
        maxContextTokens: spec.context.compaction.maxContextTokens,
        maxToolCalls: spec.tools.budgets.maxToolCalls,
      },
    });
    return profile;
  }

  /**
   * Replaces the replayed history with a model-written summary.
   *
   * The canonical log keeps every event; the summary is the only thing the ADK
   * driver replays for the events it covers. A gate waiting means the user is in
   * the middle of a decision, so compaction refuses rather than making the card
   * harder to explain.
   */
  async compactSession(
    profileId: string,
    sessionId: string,
  ): Promise<CompactResult> {
    await this.assertOwner(sessionId, profileId);
    const events = await this.store.read(sessionId);
    if (pendingGatesFromLog(events).length > 0) {
      return {
        compacted: false,
        reason: 'Answer the waiting card first; the turn is still in progress.',
      };
    }
    const messages = await this.transcript(sessionId, profileId);
    const visible = messages.filter((message) => message.text.trim().length > 0);
    if (visible.length < 4) {
      return {
        compacted: false,
        reason: 'This conversation is short enough to fit; nothing was replaced.',
      };
    }
    const conversation = visible
      .map(
        (message) =>
          `${message.role === 'user' ? 'Person' : 'Bot'}: ${message.text.trim()}`,
      )
      .join('\n\n')
      .slice(-40_000);
    const prompt = [
      'Summarise the conversation below for the bot’s own future context.',
      'Keep decisions, facts, names, open tasks and anything the person asked to remember.',
      'Omit small talk and tool mechanics. Write compactly in the third person.',
      '',
      conversation,
    ].join('\n');
    const prepared = await this.prepare(profileId, sessionId);
    const summary = (
      await (this.options.answerer?.(prompt) ?? this.askOnce(prepared, prompt))
    ).trim();
    if (summary.length === 0) {
      return {compacted: false, reason: 'The summariser returned nothing.'};
    }
    const last = events.at(-1);
    if (last === undefined) {
      return {compacted: false, reason: 'There is nothing to compact.'};
    }
    const event: import('@marimo/agent').SessionEvent = {
      id: randomUUID(),
      sessionId,
      at: new Date().toISOString(),
      type: 'summary',
      text: summary,
      coversThrough: last.id,
    };
    await this.store.append(sessionId, [event]);
    return {compacted: true};
  }

  /**
   * One conversation in the shape the recall indexer reads.
   *
   * The indexer wants the title and a flat list of visible user/assistant
   * events. It gets the transcript, so a task's posted result and an addressed
   * participant's reply are indexed as the words they are, and it gets the same
   * event count the indexer will slice against — not the sidebar's user-message
   * count, which would make the watermark skip assistant-only stretches.
   */
  async conversationFor(
    profileId: string,
    sessionId: string,
  ): Promise<{
    title: string;
    events: Array<{
      author?: string;
      content: {parts: Array<{text: string}>};
    }>;
  }> {
    const info = await this.sessionInfo(sessionId);
    const messages = await this.transcript(sessionId, profileId);
    const profiles = await this.options.profiles.profiles();
    const events = messages
      .filter((message) => message.text.trim().length > 0)
      .map((message) => {
        const author =
          message.role === 'user'
            ? 'user'
            : (profiles.find((profile) => profile.id === message.agentId)
                ?.name ?? 'assistant');
        return {
          author,
          content: {parts: [{text: message.text}]},
        };
      });
    return {title: info.title ?? '', events};
  }

  async participants(profileId: string, sessionId: string): Promise<string[]> {
    await this.assertOwner(sessionId, profileId);
    return participantsIn(await this.store.read(sessionId));
  }

  /**
   * Sets who is in a v2 conversation. The owner is implicit; the list is the
   * other agents, or the whole membership the window passed.
   */
  /** Renames a v2 conversation; the window's own title is what the log keeps. */
  async renameSession(
    profileId: string,
    sessionId: string,
    title: string,
  ): Promise<void> {
    await this.assertOwner(sessionId, profileId);
    const trimmed = title.trim();
    if (trimmed.length === 0) {
      throw new HarnessRuntimeError('A conversation needs a title.');
    }
    const event: import('@marimo/agent').SessionEvent = {
      id: randomUUID(),
      sessionId,
      at: new Date().toISOString(),
      type: 'session.renamed',
      title: trimmed,
      by: profileId,
    };
    await this.store.append(sessionId, [event]);
  }

  /** Deletes a v2 conversation's log and its waiting proposals. */
  async deleteSession(profileId: string, sessionId: string): Promise<void> {
    await this.assertOwner(sessionId, profileId);
    this.states.get(sessionId)?.engine.abort(sessionId);
    this.states.delete(sessionId);
    await this.proposals.forget(sessionId);
    if (this.store.delete !== undefined) {
      await this.store.delete(sessionId);
    }
  }

  /** Points a v2 conversation at a model of its own, or back at its agent's. */
  async setSessionModel(
    profileId: string,
    sessionId: string,
    model: import('@marimo/protocol').AgentModel | null,
  ): Promise<void> {
    await this.assertOwner(sessionId, profileId);
    const event: import('@marimo/agent').SessionEvent = {
      id: randomUUID(),
      sessionId,
      at: new Date().toISOString(),
      type: 'session.model',
      ...(model === null ? {} : {model}),
    };
    await this.store.append(sessionId, [event]);
  }

  /** Files a v2 conversation under a Space, or removes it from one. */
  async moveSession(
    profileId: string,
    sessionId: string,
    workspaceId: string | null,
  ): Promise<void> {
    await this.assertOwner(sessionId, profileId);
    const event: import('@marimo/agent').SessionEvent = {
      id: randomUUID(),
      sessionId,
      at: new Date().toISOString(),
      type: 'session.moved',
      ...(workspaceId === null ? {} : {spaceId: workspaceId}),
      by: profileId,
    };
    await this.store.append(sessionId, [event]);
  }

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

  /** Whether any v2 conversation is mid-turn. */
  isRunningAny(): boolean {
    for (const [sessionId, state] of this.states) {
      if (state.engine.isRunning(sessionId)) {
        return true;
      }
    }
    return false;
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
    purpose?: 'bot-builder';
  }> {
    const events = await this.store.read(sessionId);
    const title = events
      .filter(
        (event) =>
          event.type === 'session.created' || event.type === 'session.renamed',
      )
      .at(-1)?.title;
    const messageCount = events.filter(
      (event) => event.type === 'user.message',
    ).length;
    const created = events.find((event) => event.type === 'session.created');
    return {
      ...(title === undefined ? {} : {title}),
      messageCount,
      agentIds: participantsIn(events),
      ...(created?.type === 'session.created' && created.purpose !== undefined
        ? {purpose: created.purpose}
        : {}),
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
    const prepared = await this.prepare(owner, sessionId);
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
        ...(proposal.evidence === undefined
          ? {}
          : {evidence: proposal.evidence}),
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
        const prepared = await this.prepare(
          proposal.profileId,
          proposal.sessionId ?? undefined,
        );
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

  /**
   * The one inbox: facts waiting, changes waiting, and the refusals.
   *
   * Two documents, one answer. Memory has a watermark and an exact-text refusal
   * list; a grant has neither. Merging them here rather than in the window keeps
   * the two stores' different shapes from leaking into a component that only
   * wants a list of decisions.
   */
  async learningProposals(profileId?: string): Promise<{
    proposals: LearningProposal[];
    memory: MemoryProposal[];
    lessons: LearningLesson[];
  }> {
    /*
     * Opening the inbox is also the moment to look for housekeeping the bot
     * could do. It is on demand rather than a background timer because the
     * evidence is the library itself — size, age, use — and a card nobody has
     * opened should not spend writes discovering that.
     */
    if (profileId !== undefined) {
      await this.proposeMaintenance(profileId).catch(() => undefined);
    }
    const [learning, memory, lessons] = await Promise.all([
      this.learning.load(),
      this.proposals.load(),
      this.learning.currentLessons(),
    ]);
    /*
     * Scoped to the bot whose card is being drawn. A proposal carries the
     * profile it would change, and showing one bot's request under another's
     * name is how a person approves something for the wrong agent. The
     * app-wide view is the one with no profile id, and it is only used where
     * there is no bot in context.
     */
    return {
      proposals:
        profileId === undefined
          ? learning.proposals
          : learning.proposals.filter(
              (proposal) => proposal.profileId === profileId,
            ),
      memory:
        profileId === undefined
          ? memory.proposals
          : memory.proposals.filter(
              (proposal) => proposal.profileId === profileId,
            ),
      lessons,
    };
  }

  /**
   * Answers a proposal of any kind.
   *
   * A memory proposal is resolved by the memory path, because it is the one that
   * knows how to write a bullet and report a failed supersede. Everything else is
   * a grant here, and the grant is the person's click: the profile is updated
   * only inside this method, after `accept`, never by the tool that asked.
   */
  async resolveLearningProposal(
    proposalId: string,
    accept: boolean,
  ): Promise<{
    ok: boolean;
    problem?: string;
    applied?: string;
    supersede?: import('@marimo/protocol').MemorySupersede;
  }> {
    const memory = (await this.proposals.load()).proposals.find(
      (proposal) => proposal.id === proposalId,
    );
    if (memory !== undefined) {
      const answer = await this.resolveMemoryProposal(proposalId, accept);
      return {
        ok: answer.ok,
        ...(answer.problem === undefined ? {} : {problem: answer.problem}),
        ...(answer.supersede === undefined
          ? {}
          : {supersede: answer.supersede}),
      };
    }

    const file = await this.learning.load();
    const proposal = file.proposals.find((entry) => entry.id === proposalId);
    if (proposal === undefined) {
      return {ok: false, problem: 'That suggestion is no longer waiting.'};
    }
    if (!accept) {
      /*
       * The lesson is the point of declining here. Removing the card alone
       * would let the next turn ask the same question, which is the loop this
       * store exists to stop.
       */
      await this.learning.remove(proposalId, true);
      return {ok: true, applied: 'Declined; it will not ask again.'};
    }
    if (proposal.kind === 'grant') {
      return await this.applyGrant(proposal);
    }
    if (proposal.kind === 'maintenance') {
      return await this.applyMaintenance(proposal);
    }
    if (proposal.kind === 'policy') {
      return await this.applyPolicy(proposal);
    }
    return {
      ok: false,
      problem: 'That kind of change cannot be applied yet.',
    };
  }

  /** Forgets every refusal, so the bot may ask again. */
  async forgetLearningLessons(): Promise<LearningLesson[]> {
    return (await this.learning.clearLessons()).lessons;
  }

  async forgetLearningSession(sessionId: string): Promise<void> {
    await this.learning.forget(sessionId);
  }

  async forgetLearningProfile(profileId: string): Promise<void> {
    await this.learning.forgetProfile(profileId);
  }

  /** Forgets a removed skill's load count, so a reused id does not inherit it. */
  async forgetSkillUsage(skillId: string): Promise<void> {
    await this.skillUsage.forget(skillId);
  }

  /**
   * Looks for housekeeping the bot could do, and writes it down as proposals.
   *
   * Two candidates, both from the library rather than from a model: memory that
   * is over the limit it was given, and a granted skill that has not been loaded
   * in a long time. They are proposals because both are removals — a fact or a
   * procedure the person may still want — and because deleting is exactly the
   * kind of change this app asks about.
   *
   * Best effort. A library that cannot be read is not a reason to fail the
   * inbox; it is a reason to show what is already waiting.
   */
  private async proposeMaintenance(profileId: string): Promise<void> {
    const profile = (await this.options.profiles.profiles()).find(
      (candidate) => candidate.id === profileId,
    );
    if (profile === undefined) {
      return;
    }

    const memory = await this.memoryStoreFor(profile);
    const bytes = await memory.bytes();
    if (bytes > memory.softLimitBytes) {
      const provenance = await memory.provenance();
      /*
       * Only the layers retrieval is allowed to narrow. `Preferences and tone`,
       * `Boundaries` and `Environment and conventions` ride along whole whatever
       * the question was; a fact in one of those is a rule, and proposing to
       * forget a rule because the file is full is the wrong trade.
       */
      const candidates = provenance
        .filter((entry) => !isAlwaysInjected(entry.section))
        .sort((left, right) => left.at.localeCompare(right.at))
        .slice(0, 2);
      for (const entry of candidates) {
        await this.learning.record({
          kind: 'maintenance',
          action: 'prune-memory',
          target: entry.text,
          ...(entry.section.length === 0 ? {} : {section: entry.section}),
          profileId,
          sessionId: null,
          evidence: [],
          reason:
            `Memory is ${formatSize(bytes - memory.softLimitBytes)} over the ` +
            `${formatSize(memory.softLimitBytes)} you asked it to keep. This is ` +
            'one of the oldest facts in a layer that is not always injected.',
          summary: `Forget "${clip(entry.text)}"`,
        });
      }
    }

    const granted = await this.skillService.grantedForProfile(profileId);
    if (granted.length === 0) {
      return;
    }
    const usage = await this.skillUsage.load();
    const now = this.options.now?.().getTime() ?? Date.now();
    for (const skill of granted) {
      const entry = usage.loads[skill.id];
      const last = entry === undefined ? undefined : Date.parse(entry.lastAt);
      const stale =
        entry === undefined ||
        last === undefined ||
        Number.isNaN(last) ||
        now - last > MAINTENANCE_AFTER_DAYS * 86_400_000;
      if (!stale) {
        continue;
      }
      await this.learning.record({
        kind: 'maintenance',
        action: 'disable-skill',
        target: skill.name,
        profileId,
        sessionId: null,
        evidence: [],
        reason:
          entry === undefined || last === undefined || Number.isNaN(last)
            ? 'It has never been loaded since this app started counting.'
            : `It was last loaded ${String(
                Math.max(1, Math.floor((now - last) / 86_400_000)),
              )} days ago.`,
        summary: `Stop offering "${skill.name}"`,
      });
    }
  }

  /** The memory store for one profile, without building a model or a host. */
  private async memoryStoreFor(profile: AgentProfile): Promise<MemoryStore> {
    const settings = await this.options.settings.load();
    const workspaces = await this.options.workspaces.load();
    const spaceId = profile.spaceId ?? workspaces.activeWorkspaceId ?? undefined;
    const workspaceRoot =
      workspaceRootFor(workspaces, spaceId) ??
      this.options.paths.defaultWorkspace;
    return new MemoryStore({
      workspaceRoot,
      personMemoryRoot: this.options.paths.personMemoryDir,
      profileId: profile.id,
      ...(settings.memorySoftLimitBytes === undefined
        ? {}
        : {softLimitBytes: settings.memorySoftLimitBytes}),
    });
  }

  /**
   * Applies housekeeping.
   *
   * A memory prune removes one bullet, not the file: the proposal named the
   * fact, and the person approved that fact. A skill is switched off rather than
   * deleted, because the file is theirs and "stop offering this" is not "destroy
   * this".
   */
  private async applyMaintenance(
    proposal: import('@marimo/protocol').MaintenanceProposal,
  ): Promise<{ok: boolean; problem?: string; applied?: string}> {
    const profile = (await this.options.profiles.profiles()).find(
      (candidate) => candidate.id === proposal.profileId,
    );
    if (profile === undefined) {
      return {ok: false, problem: 'That bot no longer exists.'};
    }

    if (proposal.action === 'disable-skill') {
      if (!profile.enabledSkills.includes(proposal.target)) {
        await this.learning.remove(proposal.id);
        return {ok: true, applied: 'It was already switched off.'};
      }
      await this.options.profiles.update(profile.id, {
        enabledSkills: profile.enabledSkills.filter(
          (name) => name !== proposal.target,
        ),
      });
      await this.learning.remove(proposal.id);
      return {
        ok: true,
        applied: `Stopped offering "${proposal.target}". The skill is still on disk.`,
      };
    }

    const memory = await this.memoryStoreFor(profile);
    const current = await memory.read();
    const lines = current.split('\n');
    const wanted = proposal.target.trim();
    const kept = lines.filter((line) => {
      const match = /^\s*[-*]\s+(.*?)\s*$/u.exec(line);
      return !(match !== null && match[1] === wanted);
    });
    if (kept.length === lines.length) {
      await this.learning.remove(proposal.id);
      return {
        ok: false,
        problem: 'That fact is no longer in memory; nothing was removed.',
      };
    }
    await memory.prune({content: kept.join('\n'), reason: proposal.reason});
    await this.learning.remove(proposal.id);
    return {ok: true, applied: 'Forgot it.'};
  }

  /**
   * Applies a change to how the bot runs.
   *
   * The profile carries the safe subset, and the resolver maps it into the
   * harness on the next turn — which is also what gives the change a new
   * version hash in the ledger. Nothing here touches Role, Persona, the contract
   * or a gate: the schema has no fields for them.
   */
  private async applyPolicy(
    proposal: import('@marimo/protocol').PolicyProposal,
  ): Promise<{ok: boolean; problem?: string; applied?: string}> {
    const profile = (await this.options.profiles.profiles()).find(
      (candidate) => candidate.id === proposal.profileId,
    );
    if (profile === undefined) {
      return {ok: false, problem: 'That bot no longer exists.'};
    }
    const patch = {
      ...(proposal.patch.memoryPolicy === undefined
        ? {}
        : {memoryPolicy: proposal.patch.memoryPolicy}),
      ...(proposal.patch.maxContextTokens === undefined
        ? {}
        : {maxContextTokens: proposal.patch.maxContextTokens}),
      ...(proposal.patch.maxToolCalls === undefined
        ? {}
        : {maxToolCalls: proposal.patch.maxToolCalls}),
    };
    if (Object.keys(patch).length === 0) {
      await this.learning.remove(proposal.id);
      return {ok: false, problem: 'That proposal changed nothing.'};
    }
    await this.options.profiles.update(profile.id, {
      policy: {...(profile.policy ?? {}), ...patch},
    });
    await this.learning.remove(proposal.id);
    return {
      ok: true,
      applied: `${profile.name}: ${proposal.summary}. It applies from the next turn.`,
    };
  }

  /** Writes a capability into the profile, which is the only way one is granted. */
  private async applyGrant(
    proposal: import('@marimo/protocol').GrantProposal,
  ): Promise<{ok: boolean; problem?: string; applied?: string}> {
    const profile = (await this.options.profiles.profiles()).find(
      (candidate) => candidate.id === proposal.profileId,
    );
    if (profile === undefined) {
      return {ok: false, problem: 'That bot no longer exists.'};
    }

    if (proposal.target === 'tool') {
      const known = CORE_TOOLS.find((tool) => tool.name === proposal.name);
      /*
       * Checked again at the write, not only when the card was drawn. The
       * catalogue can change between the proposal and the click — an upgrade, a
       * hand-edited profile — and `run_shell` is refused by name everywhere.
       */
      if (known === undefined || known.name === 'run_shell') {
        await this.learning.remove(proposal.id);
        return {
          ok: false,
          problem: 'That tool is not one this app can grant.',
        };
      }
      if (!profile.enabledTools.includes(known.name)) {
        await this.options.profiles.update(profile.id, {
          enabledTools: [...profile.enabledTools, known.name],
        });
      }
      await this.learning.remove(proposal.id);
      return {
        ok: true,
        applied: `${known.name} granted to ${profile.name}.`,
      };
    }

    const settings = await this.options.settings.load();
    const server = settings.mcpServers.find(
      (entry) =>
        entry.id === proposal.name ||
        entry.name.toLocaleLowerCase() ===
          proposal.name.toLocaleLowerCase(),
    );
    if (server === undefined) {
      await this.learning.remove(proposal.id);
      return {
        ok: false,
        problem: `There is no connector called "${proposal.name}" on this computer.`,
      };
    }
    /*
     * Absent means every connector, which is the state every profile written
     * before the field existed is in. Granting one of those a specific server
     * would narrow the grant, which is the opposite of what the person just
     * approved.
     */
    if (profile.mcpServerIds === undefined) {
      await this.learning.remove(proposal.id);
      return {
        ok: true,
        applied: `${profile.name} already uses every connector.`,
      };
    }
    if (!profile.mcpServerIds.includes(server.id)) {
      await this.options.profiles.update(profile.id, {
        mcpServerIds: [...profile.mcpServerIds, server.id],
      });
    }
    await this.learning.remove(proposal.id);
    return {ok: true, applied: `${server.name} granted to ${profile.name}.`};
  }

  /**
   * What a `request_tool` or `request_connector` call writes.
   *
   * Bound to one profile, one conversation and one turn, so the model cannot
   * name the agent it is asking for. The name is checked against the catalogue
   * and the settings here rather than trusted from the tool: a model can write
   * any string, and a card for a capability that does not exist is a decision
   * nobody can make.
   */
  private learningToolFor(
    profileId: string,
    sessionId: string,
    turnId?: string,
  ): LearningToolService {
    return {
      request: async (input) => {
        const settings = await this.options.settings.load();
        let name = input.name.trim();
        if (input.target === 'tool') {
          if (name === 'run_shell') {
            return {
              ok: false,
              result:
                'run_shell is never requested. Say what you would run and why, ' +
                'and let the person decide in Settings.',
            };
          }
          const known = CORE_TOOLS.find((tool) => tool.name === name);
          if (known === undefined) {
            return {
              ok: false,
              result: `There is no tool called "${name}" in this app.`,
            };
          }
          const profile = (await this.options.profiles.profiles()).find(
            (candidate) => candidate.id === profileId,
          );
          if (profile?.enabledTools.includes(name) === true) {
            return {
              ok: false,
              result: `You already have ${name}. Use it rather than asking for it.`,
            };
          }
        } else {
          const server = settings.mcpServers.find(
            (entry) =>
              entry.id === name ||
              entry.name.toLocaleLowerCase() === name.toLocaleLowerCase(),
          );
          if (server === undefined) {
            return {
              ok: false,
              result: `There is no connector called "${name}" on this computer.`,
            };
          }
          name = server.id;
        }

        await this.learning.record({
          kind: 'grant',
          target: input.target,
          name,
          profileId,
          sessionId,
          reason: input.reason,
          evidence:
            turnId === undefined && input.evidence === undefined
              ? []
              : [
                  {
                    ...(turnId === undefined ? {} : {turnId}),
                    ...(input.evidence === undefined
                      ? {}
                      : {quote: input.evidence}),
                  },
                ],
        });
        const subject = `${input.target}:${name.toLocaleLowerCase()}`;
        /*
         * The current refusals, not the whole list. An expired lesson stays in
         * the document for the audit but no longer suppresses an ask, and a
         * check against the raw list would tell the model a person had said no
         * when the TTL had already let the question back in.
         */
        const refused = (await this.learning.lessonsFor(profileId)).some(
          (lesson) =>
            lesson.kind === 'grant' && lesson.summary === subject,
        );
        if (refused) {
          return {
            ok: false,
            result:
              'The person has already declined that. Do not ask again unless ' +
              'something has changed; say what changed if it has.',
          };
        }
        return {
          ok: true,
          result:
            `Asked the person for ${name}. It is in the learning inbox, waiting ` +
            'for them; you do not have it yet, so do not use it in this turn.',
        };
      },
      proposePolicy: async (input) => {
        const patch = {
          ...(input.patch.memoryPolicy === undefined
            ? {}
            : {memoryPolicy: input.patch.memoryPolicy}),
          ...(input.patch.maxContextTokens === undefined
            ? {}
            : {maxContextTokens: input.patch.maxContextTokens}),
          ...(input.patch.maxToolCalls === undefined
            ? {}
            : {maxToolCalls: input.patch.maxToolCalls}),
        };
        if (Object.keys(patch).length === 0) {
          return {
            ok: false,
            result: 'That proposal named no setting, so there is nothing to decide.',
          };
        }
        const summary = describePolicy(patch);
        await this.learning.record({
          kind: 'policy',
          patch,
          summary,
          profileId,
          sessionId,
          reason: input.reason,
          evidence:
            turnId === undefined && input.evidence === undefined
              ? []
              : [
                  {
                    ...(turnId === undefined ? {} : {turnId}),
                    ...(input.evidence === undefined
                      ? {}
                      : {quote: input.evidence}),
                  },
                ],
        });
        const subject = `policy:${JSON.stringify(patch)}`;
        const refused = (await this.learning.lessonsFor(profileId)).some(
          (lesson) =>
            lesson.kind === 'policy' && lesson.summary === subject,
        );
        if (refused) {
          return {
            ok: false,
            result:
              'The person has already declined that change. Do not ask again ' +
              'unless something has changed.',
          };
        }
        return {
          ok: true,
          result:
            `Proposed: ${summary}. It is in the learning inbox; you still run ` +
            'under the current setting until the person applies it.',
        };
      },
    };
  }

  /** Whether this conversation has a v2 log, so the shell can fall back. */
  async hasLog(sessionId: string): Promise<boolean> {
    if (this.store.has !== undefined) {
      return await this.store.has(sessionId);
    }
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

  private async prepare(
    profileId: string,
    sessionId?: string,
  ): Promise<Prepared> {
    const settings = await this.options.settings.load();
    const profile = (await this.options.profiles.profiles()).find(
      (candidate) => candidate.id === profileId,
    );
    if (profile === undefined) {
      throw new HarnessRuntimeError(`There is no bot called "${profileId}".`);
    }

    const workspaces = await this.options.workspaces.load();
    const events =
      sessionId === undefined ? [] : await this.store.read(sessionId);
    const filed =
      spaceIdOf(events) ??
      (sessionId === undefined
        ? undefined
        : await this.options.sessionSpace?.(sessionId));
    const sessionModel = modelOf(events);
    const spaceId = filed ?? profile.spaceId ?? workspaces.activeWorkspaceId ?? undefined;
    const workspaceRoot = workspaceRootFor(workspaces, spaceId);
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
      ...(sessionModel === undefined ? {} : {sessionModel}),
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

    const previous =
      this.options.versions === undefined
        ? undefined
        : await this.options.versions.latestFor(profile.id);
    const resolveInput = {
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
        ...(profile.policy === undefined
          ? {}
          : {harness: policyOverrides(profile.policy)}),
      },
      app: {
        model: {provider: config.provider, model: config.model},
        allowPrivateNetworkFetch: settings.allowPrivateNetworkFetch,
        memorySoftLimitBytes: settings.memorySoftLimitBytes,
        learning: {mode: 'propose' as const, retainTraces: false},
      },
      version: previous?.harnessVersion ?? (this.options.version ?? 1),
      workspaceRoot,
      ...(sessionModel === undefined
        ? {}
        : {conversation: {model: sessionModel}}),
    };
    let harness = resolveHarness(resolveInput);
    let parentVersion: number | undefined;
    if (previous !== undefined && harnessHash(harness) !== previous.hash) {
      parentVersion = previous.harnessVersion;
      harness = resolveHarness({
        ...resolveInput,
        version: previous.harnessVersion + 1,
      });
    }

    const recall = await this.options.recallFor?.(profile.id, workspaceRoot);
    const jobs = await this.options.jobsFor?.(profile.id, workspaceRoot);
    return {
      profile,
      config,
      harness,
      workspaceRoot,
      memory,
      ...(spaceId === undefined ? {} : {spaceId}),
      ...(recall === undefined ? {} : {recall}),
      ...(jobs === undefined ? {} : {jobs}),
      ...(parentVersion === undefined ? {} : {parentVersion}),
    };
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

  private driverFor(prepared: Prepared, sessionId: string): TurnDriver {
    if (this.options.driverFactory !== undefined) {
      return this.options.driverFactory(prepared.config);
    }
    const profileId = prepared.profile.id;
    const skills = this.skillToolsFor(profileId);
    return new AdkDriver({
      resolveModel: () => this.llmFor(prepared.config),
      resolveHelper: async (agent, signal) =>
        await this.helperFor(agent, sessionId, signal),
      resumeSessions: (id) => this.helperSessions.get(id),
      rememberSessions: (id, sessions) => {
        this.helperSessions.set(id, sessions);
      },
      promptContext: async () => ({
        memory: await prepared.memory.readForPrompt(),
        skills: (await this.skillService.grantedForProfile(profileId)).map(
          (skill: StoredSkill) => ({
            name: skill.name,
            description: skill.description,
          }),
        ),
      }),
      toolContext: (_harness, signal, turnId) => ({
        workspaceRoot: prepared.workspaceRoot,
        signal,
        memory: prepared.memory,
        skills,
        learning: this.learningToolFor(profileId, sessionId, turnId),
        ...(prepared.recall === undefined ? {} : {recall: prepared.recall}),
        ...(prepared.jobs === undefined ? {} : {jobs: prepared.jobs}),
        sessionId,
        profileId: profileId,
        allowPrivateNetworkFetch:
          prepared.harness.tools.policy.network === 'private',
        ...(this.options.webSearch === undefined
          ? {}
          : {webSearch: this.options.webSearch}),
        ...(this.taskSessions.has(sessionId)
          ? {}
          : {
              delegate: async ({agent, task}) =>
                await this.askAgent(profileId, agent, task),
              delegateTask: async ({agent, task}) =>
                await this.startTask(profileId, agent, task, sessionId),
            }),
      }),
    });
  }

  /** The skill service one profile's turn or helper sees. */
  private skillToolsFor(profileId: string): SkillToolService {
    return {
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
  }

  /**
   * A helper another bot asked for, built for the parent's session.
   *
   * Same session id, same ADK session service as the parent's turn: that is what
   * makes the delegation a tool call in one conversation rather than a second
   * live host. The helper gets the target's full tool set (less `ask_agent`,
   * which the driver omits) and its own memory and Space.
   */
  private async helperFor(
    agent: string,
    sessionId: string,
    signal: AbortSignal,
  ): Promise<
    | {
        harness: HarnessSpec;
        model: ReturnType<HarnessRuntime['llmFor']>;
        promptContext: {
          memory: string;
          skills: Array<{name: string; description: string}>;
        };
        toolContext: ToolContext;
        name: string;
      }
    | {problem: string}
  > {
    const wanted = agent.trim().toLocaleLowerCase();
    const target = (await this.options.profiles.profiles()).find(
      (profile) =>
        profile.id === agent.trim() ||
        profile.name.trim().toLocaleLowerCase() === wanted,
    );
    if (target === undefined) {
      return {problem: `There is no bot called "${agent.trim()}" on this computer.`};
    }
    try {
      const prepared = await this.prepare(target.id, sessionId);
      const skills = this.skillToolsFor(target.id);
      return {
        harness: prepared.harness,
        model: this.llmFor(prepared.config),
        name: target.name,
        promptContext: {
          memory: await prepared.memory.readForPrompt(),
          skills: (await this.skillService.grantedForProfile(target.id)).map(
            (skill: StoredSkill) => ({
              name: skill.name,
              description: skill.description,
            }),
          ),
        },
        toolContext: {
          workspaceRoot: prepared.workspaceRoot,
          signal,
          memory: prepared.memory,
          skills,
          ...(prepared.recall === undefined ? {} : {recall: prepared.recall}),
          ...(prepared.jobs === undefined ? {} : {jobs: prepared.jobs}),
          sessionId,
          profileId: target.id,
          allowPrivateNetworkFetch:
            prepared.harness.tools.policy.network === 'private',
          ...(this.options.webSearch === undefined
            ? {}
            : {webSearch: this.options.webSearch}),
        },
      };
    } catch (error) {
      return {
        problem: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * A second bot's answer, with its own instructions and memory and no tools.
   *
   * Deliberately not a turn: it has no session, no log, no approval card and no
   * ability to act. That keeps a bot-to-bot question from becoming a second
   * writer in the conversation, and it is honest about what the answer is — an
   * opinion, not work done.
   */
  /**
   * Starts a task in its own conversation and returns before it finishes.
   *
   * The child is a normal v2 turn in a new session: its tools are the target
   * bot's, its approvals wait in that conversation, and the parent's tool result
   * is only a pointer. The background loop consumes the events so the turn is
   * driven to completion; the task's own log is where the result lives.
   */
  async startTask(
    ownerProfileId: string,
    agent: string,
    task: string,
    parentSessionId?: string,
  ): Promise<{ok: boolean; result: string}> {
    if (this.options.createSession === undefined) {
      return {ok: false, result: 'Tasks are not available in this turn.'};
    }
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
      const created = await this.options.createSession(target.id, task);
      if (created === undefined) {
        return {
          ok: false,
          result: `Could not open a task conversation for "${target.name}".`,
        };
      }
      this.taskSessions.add(created.id);
      void this.drainTask(
        ownerProfileId,
        parentSessionId,
        target,
        created.id,
        task,
      ).catch(() => undefined);
      const title = created.title ?? task;
      return {
        ok: true,
        result:
          `Started "${title}" for ${target.name} in its own conversation. ` +
          'It will post the result here when it finishes; open that conversation to answer an approval.',
      };
    } catch (error) {
      return {
        ok: false,
        result: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async drainTask(
    ownerProfileId: string,
    parentSessionId: string | undefined,
    target: AgentProfile,
    taskSessionId: string,
    task: string,
  ): Promise<void> {
    let failure: string | undefined;
    try {
      for await (const event of this.run(target.id, taskSessionId, task)) {
        if (event.type === 'turn.failed') {
          failure = event.message;
        }
      }
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
    if (parentSessionId === undefined || parentSessionId === taskSessionId) {
      return;
    }

    let ok = failure === undefined;
    let text = failure ?? '';
    if (ok) {
      const gates = await this.pendingGates(taskSessionId);
      if (gates.length > 0) {
        ok = false;
        text =
          'The task stopped for approval in its own conversation. Open it to continue; this result is the stopping point.';
      } else {
        const transcript = await this.transcript(taskSessionId, target.id);
        text =
          [...transcript]
            .reverse()
            .find(
              (message) =>
                message.role === 'assistant' && message.text.length > 0,
            )?.text ?? '';
        if (text.length === 0) {
          ok = false;
          text = 'The task finished without an answer.';
        }
      }
    }
    const clipped =
      text.length > 4_000
        ? `${text.slice(0, 4_000)}

[the posted result was truncated at 4,000 characters; the task conversation has the rest]`
        : text;
    const parent = await this.store.read(parentSessionId).catch(() => []);
    const created = parent.find((event) => event.type === 'session.created');
    if (
      created?.type !== 'session.created' ||
      created.profileId !== ownerProfileId
    ) {
      return;
    }
    const event: import('@marimo/agent').SessionEvent = {
      id: randomUUID(),
      sessionId: parentSessionId,
      at: new Date().toISOString(),
      type: 'task.result',
      taskSessionId,
      agentId: target.id,
      agentName: target.name,
      ok,
      text: clipped,
    };
    await this.store.append(parentSessionId, [event]).catch(() => undefined);
  }

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
  turnId?: string;
  content?: {parts?: Array<{text?: string; thought?: boolean}>};
}> {
  const reviewable: Array<{
    author?: string;
    turnId?: string;
    content?: {parts?: Array<{text?: string; thought?: boolean}>};
  }> = [];
  for (const event of events) {
    if (event.type === 'user.message') {
      reviewable.push({
        author: 'user',
        turnId: event.turnId,
        content: {parts: [{text: event.text}]},
      });
    } else if (event.type === 'assistant.message') {
      reviewable.push({
        author: event.author,
        turnId: event.turnId,
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


function spaceIdOf(
  events: readonly import('@marimo/agent').SessionEvent[],
): string | undefined {
  let filed: string | undefined;
  for (const event of events) {
    if (event.type === 'session.created') {
      filed = event.spaceId;
    } else if (event.type === 'session.moved') {
      filed = event.spaceId;
    }
  }
  return filed;
}


function modelOf(
  events: readonly import('@marimo/agent').SessionEvent[],
): import('@marimo/protocol').AgentModel | undefined {
  let model: import('@marimo/protocol').AgentModel | undefined;
  for (const event of events) {
    if (event.type === 'session.model') {
      model = event.model;
    }
  }
  return model;
}


/** A profile's policy, in the shape the harness resolver merges. */
function policyOverrides(
  policy: import('@marimo/protocol').HarnessPolicy,
): import('@marimo/agent').HarnessOverrides {
  return {
    context: {
      ...(policy.memoryPolicy === undefined
        ? {}
        : {memory: {policy: policy.memoryPolicy}}),
      ...(policy.maxContextTokens === undefined
        ? {}
        : {compaction: {maxContextTokens: policy.maxContextTokens}}),
    },
    tools: {
      ...(policy.maxToolCalls === undefined
        ? {}
        : {budgets: {maxToolCalls: policy.maxToolCalls}}),
    },
  };
}


/** One proposal's change, in the words the card uses. */
function describePolicy(patch: {
  memoryPolicy?: 'all' | 'relevant';
  maxContextTokens?: number;
  maxToolCalls?: number;
}): string {
  const parts: string[] = [];
  if (patch.memoryPolicy !== undefined) {
    parts.push(
      patch.memoryPolicy === 'all'
        ? 'carry all of memory in the prompt'
        : 'recall only the relevant part of memory',
    );
  }
  if (patch.maxContextTokens !== undefined) {
    parts.push(
      `give a turn ${patch.maxContextTokens.toLocaleString()} tokens of room`,
    );
  }
  if (patch.maxToolCalls !== undefined) {
    parts.push(`allow ${String(patch.maxToolCalls)} tool calls per turn`);
  }
  return parts.join('; ');
}
