/**
 * The agent runtime behind the chat window.
 *
 * `AgentHost` is the only stateful object in this package and the only thing
 * the Electron main process touches. It owns the ADK `Runner`, translates ADK
 * events into the flat UI event stream the renderer understands, and keeps the
 * human-in-the-loop approval round trip.
 *
 * It deliberately imports nothing from Electron: moving the agent into a
 * `utilityProcess` later is then a transport change, not a rewrite.
 */
import {randomUUID} from 'node:crypto';

import {
  createEvent,
  LlmAgent,
  REQUEST_CONFIRMATION_FUNCTION_CALL_NAME,
  Runner,
  StreamingMode,
} from '@google/adk';
import type {Content, Part} from '@google/genai';
import type {
  AgentModel,
  AgentProfile,
  AgentUiEvent,
  CompactResult,
  PendingGate,
  SessionPurpose,
  SessionSource,
  SessionSummary,
  TokenUsage,
  TranscriptMessage,
} from '@marimo/protocol';
import {
  DEFAULT_DREAM_EXPLORATION_WEIGHT,
  DEFAULT_DREAM_PRUNING_THRESHOLD,
  DEFAULT_DREAM_RESULT_BYTES,
  MAIN_AGENT_NAME,
} from '@marimo/protocol';

import type {AgentConfig, DreamConfig} from '../config.js';
import type {DreamSink} from '../dream/recorder.js';
import {TreeRecorder} from '../dream/recorder.js';
import {DreamToolPlugin} from '../dream/tool-plugin.js';
import {MemoryStore} from '../memory/index.js';
import type {MemoryProvenanceEntry} from '@marimo/protocol';
import type {SupersedeReport} from '../memory/index.js';
import {DEFAULT_MAX_CHARS, selectMemory} from '../memory/select.js';
import type {RecalledBullet} from '../memory/select.js';
import type {RecallLookup} from '../tools/recall-tools.js';
import {MEMORY_SOFT_LIMIT_BYTES} from '../memory/size.js';
import {OpenAiCompatLlm} from '../models/openai-compat-llm.js';
import {FileSessionService} from '../sessions/file-session-service.js';
import type {
  AdkEvent,
  SessionIndexEntry,
} from '../sessions/file-session-service.js';
import {composeInstruction} from '../skills/index.js';
import {createAskAgentTool, createTools} from '../tools/index.js';
import {gatesAskedBy, pendingGatesIn, readGate} from './gates.js';
import {
  describeToolResult,
  hasError,
  isConfirmationRefusal,
} from './tool-result.js';
/*
 * The gate readers live beside this file so the transcript can ask the same
 * question without importing the host that projects it. Re-exported here because
 * this module is where callers have always found them, and a second import path
 * is a second answer to where that is.
 */
export {gatesAskedBy, pendingGatesIn} from './gates.js';
import type {
  AgentDelegation,
  AgentLimits,
  AskAgentTool,
  McpToolsetSource,
} from '../tools/index.js';
import type {DeskService} from '../tools/desk-tools.js';
import type {SkillLibrary, SkillService} from '../tools/skill-tools.js';
import type {DiscordService} from '../tools/discord-tools.js';
import type {JobService} from '../tools/job-tools.js';
import type {WebSearchProvider} from '../tools/web-search-tool.js';
import {
  buildCompactedEvent,
  compactionPrompt,
  planAutoCompaction,
  planCompaction,
  renderForSummary,
} from './compaction.js';
import type {CompactionPlan} from './compaction.js';
import {projectTranscript} from './transcript.js';
import {RepeatedToolCallPlugin} from './tool-loop-plugin.js';

export interface AgentHostOptions {
  sessionsDir: string;
  /**
   * The session service this host shares with the runtime's index.
   *
   * One instance means one write queue over `sessions/index.json`; two instances
   * would each believe their own lock covered a file the other is rewriting.
   */
  sessionService?: FileSessionService;
  /**
   * Where the person-level half of memory lives — one folder per profile.
   *
   * Absent means both halves share the workspace file, which is what this app did
   * before they were split. The desktop app and the headless runner both pass the
   * same resolved directory, so a scheduled job and the window remember the same
   * person.
   */
  personMemoryDir?: string;
  config: AgentConfig;
  appName?: string;
  userId?: string;
  /** Supplied by the desktop app; without it the agent has no `web_search`. */
  webSearch?: WebSearchProvider;
  /**
   * Supplied by the desktop app; without it the agent cannot see or create
   * scheduled jobs. The host only passes it through — what a job *is* belongs to
   * whatever owns the store.
   */
  jobService?: JobService;
  /**
   * Supplied by the desktop app when a Discord bot is connected; without it the
   * agent has no way to post or read there. Like `jobService`, this is passed
   * through untouched: the connection, the token and the watched channel are the
   * app's, not the agent's.
   */
  discordService?: DiscordService;
  /**
   * Supplied by the desktop app; without it the agent cannot read or change the
   * to-do list or the notes. Like the rest, passed through untouched: those two
   * documents belong to the app, and the tools name an intention rather than a
   * file.
   */
  deskService?: DeskService;
  /**
   * Supplied by the desktop app; without it the agent cannot save a skill, and
   * `/learn` has nothing to write with.
   */
  skillService?: SkillService;
  /**
   * The skills this profile carries, read through its grant.
   *
   * Supplied only when at least one is switched on, so `load_skill` is absent
   * rather than offered over an empty library. It is separate from
   * `skillService` because saving and loading are different permissions: a bot
   * may read the procedures it was given without being allowed to write new ones.
   */
  skillLibrary?: SkillLibrary;
  /**
   * The MCP servers that are currently connected.
   *
   * Passed as connections rather than as configuration, because that is what
   * they are: the app owns enabling a server, dialling it and giving up on it,
   * and this host only decides what the model is offered. Change them with
   * {@link AgentHost.setMcpServers} when a server connects or drops.
   */
  mcpServers?: readonly McpToolsetSource[];
  /**
   * Supplied by the desktop app when recall is switched on and something is
   * indexed. Absent means memory is injected whole, exactly as it always was.
   *
   * Change it with {@link AgentHost.setRecallService} when the setting moves,
   * rather than rebuilding the host: the service is a fact about the turn being
   * assembled, not about the agent.
   */
  recallService?: RecallLookup;
  /**
   * Where a turn's discovery tree goes, when Dream-RSI is on for that turn.
   *
   * A sink rather than a directory, for the reason `sessionsDir` is a directory
   * and this is not: the host is what records, and whoever owns the file — the
   * runtime, in both the window and the headless runner — is what knows the path.
   * Resolving a path in here would put the user-data layout into a package that
   * cannot see Electron's answer to where it is, which is the class of bug this
   * repository lists as an invariant.
   *
   * Absent means no tree is ever recorded, whatever the config says. Both have to
   * agree before anything is written, and that is deliberate: it is the second
   * lock on a feature whose failure mode is recording somebody's work without
   * their having asked.
   */
  dreamSink?: DreamSink;
  /**
   * Bytes of a tool result one node keeps.
   *
   * Absent means the built-in default. Here rather than in the config because it
   * is a fact about the record rather than about the agent: nothing the model
   * does changes because a result was capped at a different length.
   */
  dreamResultBytes?: number;
  /**
   * Told which conversations are gone, right after they are deleted.
   *
   * A callback rather than a call to `recallService` directly, because the host
   * that deletes is built before it knows which folder the conversation worked
   * in — deletion is metadata, and the placeholder host can do it — while the
   * index that has to forget the chat lives with the folder. The caller that
   * owns both resolves one from the other here.
   */
  onSessionsDeleted?: (sessionIds: readonly string[]) => void | Promise<void>;
  /**
   * How to build the agent an `ask_agent` call named.
   *
   * A seam rather than something this class can do, because resolving a name
   * against the profiles, choosing the space it works in and reading its
   * credential all belong to whoever owns those documents — the runtime. This
   * host knows how to *run* an agent; it does not know who exists.
   *
   * Absent means there is nobody to ask, and the tool is absent with it: an
   * install with one agent must not be offered a way to delegate.
   */
  delegate?: DelegationSeam;
  /**
   * Ceilings on a helper: steps, minutes, the size of what it hands back, and how
   * many one turn may ask for.
   */
  delegateLimits?: Partial<AgentLimits>;
  /**
   * Where a helper's work goes while the turn that asked for it is suspended.
   *
   * Out of band rather than through the turn's generator, because a tool call
   * cannot yield into the stream that is awaiting it. The same channel the MCP
   * status events use, for the same reason: a helper that says nothing until it
   * finishes is a turn that looks hung.
   */
  onDelegateEvent?: (event: AgentUiEvent) => void;
}

export interface ApproveParams {
  sessionId: string;
  callId: string;
  confirmed: boolean;
  payload?: unknown;
}

/**
 * How a helper is resolved, or what stopped it being resolved.
 *
 * A problem is a *sentence* rather than a thrown error, deliberately. The tool
 * that asks reports it as the tool's own answer, so the parent's turn carries on
 * and can tell the user which agents exist; an exception would end the turn and
 * turn "no such agent" into "your request failed".
 */
export interface DelegationResult {
  /** The profile the helper is: the name its reply is attributed to. */
  profile: AgentProfile;
  /** Its configuration, already resolved: model, identity, tools, space. */
  config: AgentConfig;
}

export interface DelegationSeam {
  resolve: (request: {
    agent: string;
    /** The Space the model named, when it named one. */
    space?: string;
    /**
     * The Space the *asking conversation* is filed under.
     *
     * Resolved by the host rather than by the seam, because the conversation
     * index is the host's to read and the seam would otherwise need a second way
     * to ask which conversation this is. It is the fallback *after* the helper's
     * own default and before the rail's current Space: a turn's file tools run in
     * the conversation's folder, and a helper that ran in whichever Space
     * somebody happened to be browsing would be the only part of the app where
     * clicking the rail changes where work lands.
     */
    sessionSpaceId?: string;
  }) => Promise<DelegationResult | {problem: string}>;
}

/** One gate's answer, as the user gave it. */
interface GateDecision {
  confirmed: boolean;
  payload?: unknown;
}

/*
 * `PendingGate` is the contract's, not this file's. It is what a card is drawn
 * from, so the window has to be able to name it — and a second declaration here
 * would be a second shape that could drift from the one on the wire.
 */

/**
 * The gates of one paused round, and the decisions taken so far.
 *
 * Held together because ADK reads confirmations from the newest message alone:
 * the answers cannot be sent one at a time, so they have to accumulate somewhere
 * until the round is complete.
 */
interface GateRound {
  sessionId: string;
  gates: Set<string>;
  decisions: Map<string, GateDecision>;
}

/**
 * An agent id as ADK will accept it, and back again.
 *
 * `LlmAgent` requires a name that starts with a letter or an underscore and holds
 * only letters, digits, underscores and hyphens — while a profile id is a UUID,
 * which starts with a digit often enough to be a coin toss. Underscores are
 * therefore escaped first and dashes become underscores, which is reversible and
 * injective: two ids can only collide if they were the same id.
 *
 * The pair is here rather than in one file because the two halves have to agree
 * exactly: the name is what ADK writes into every event the helper produces, and
 * the transcript is what turns it back into the id the window labels a bubble
 * with. A second implementation of either would be a helper attributed to an
 * agent that does not exist.
 */
export function agentNameFor(agentId: string): string {
  return `a_${agentId.replaceAll('_', '_u').replaceAll('-', '_d')}`;
}

/** The id behind a name this build wrote, or `undefined` for anything else. */
export function agentIdFor(author: string | undefined): string | undefined {
  if (author === undefined || !author.startsWith('a_')) {
    return undefined;
  }
  return author.slice(2).replaceAll('_d', '-').replaceAll('_u', '_');
}

/**
 * The confirmation response ADK resumes a gated call with.
 *
 * ADK matches it to the gate by `id` and to the original call through the gate's
 * own arguments, so the name has to be the gate's rather than the tool's.
 */
/**
 * How short a question can be before it is not worth retrieving against.
 *
 * "ok", "yes" and "go on" are turns, not questions: a vector for them is closer
 * to the noise in memory than to anything the user meant, and retrieving on one
 * would replace the whole file with whatever happened to rank. Below this, memory
 * is injected whole — the behaviour that existed before any of this.
 */
const MIN_RETRIEVAL_QUERY_CHARS = 3;

/**
 * How long retrieval may take before the whole file is used instead.
 *
 * Generous for what it is — a query embed and a pass over the memory index, which
 * is tens of milliseconds warm — and short enough that a cold engine does not
 * hold a request open. The first turn after switching recall on is spent loading
 * the model; that turn is not the one to make the user wait for.
 */
const RETRIEVAL_DEADLINE_MS = 1_500;

/** The most bullets retrieval may add, matching what the service will rank. */
const RETRIEVED_BULLETS = 12;

/**
 * A promise, or a rejection if it takes longer than the deadline.
 *
 * Rejection rather than a resolved sentinel so the caller's `catch` handles one
 * thing: every way this can go wrong means the same answer, which is the whole
 * file.
 */
async function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`retrieval did not answer within ${String(ms)}ms`));
        }, ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

export class AgentHost {
  static readonly APP_NAME = MAIN_AGENT_NAME;
  static readonly USER_ID = 'local';

  private readonly sessionService: FileSessionService;
  private readonly appName: string;
  private readonly userId: string;
  /**
   * Long-term memory, shared by the instruction provider and the memory tools so
   * the prompt and the tools can never disagree about which file is memory.
   */
  private readonly memory: MemoryStore;
  /**
   * Everything the host was built with, kept whole.
   *
   * The services below are still copied onto their own fields, so every existing
   * reader is unchanged. This one exists for the two Dream-RSI options, which are
   * read at the moment a runner is built rather than at construction: a sink and
   * a byte cap describe a *turn*, and the runner cache outlives many of them.
   */
  private readonly options: AgentHostOptions;
  private readonly webSearch?: WebSearchProvider;
  private readonly jobService?: JobService;
  private readonly discordService?: DiscordService;
  private readonly deskService?: DeskService;
  private readonly skillService?: SkillService;
  private readonly skillLibrary?: SkillLibrary;
  /**
   * The MCP servers in play, replaced wholesale when one connects or drops.
   *
   * Mutable, unlike the services beside it, because a connection is not a
   * setting: a server can die and come back while the app is running, and the
   * next turn has to be offered what is actually reachable now.
   */
  private mcpServers: readonly McpToolsetSource[];
  /**
   * What recall can answer, when the app has one switched on.
   *
   * Mutable like `mcpServers` and for the same reason: the user can turn it on
   * while the window is open, and the next turn must be built from what is true
   * then rather than from what was true when the host was made.
   */
  private recallService: RecallLookup | undefined;
  /** Told which conversations were deleted, so their vectors can be dropped. */
  private readonly onSessionsDeleted:
    | ((sessionIds: readonly string[]) => void | Promise<void>)
    | undefined;
  /** How a named helper is resolved, when this install has more than one agent. */
  private readonly delegate: DelegationSeam | undefined;
  /**
   * The `ask_agent` tools this host has built, one per runner.
   *
   * Kept so a new turn can clear their per-turn counts. A tool is built with the
   * runner that carries it and the runner is cached, so without this the fourth
   * helper of a conversation would be refused rather than the fourth of a turn.
   */
  private readonly askAgentTools = new Set<AskAgentTool>();
  /**
   * The question the current turn is answering.
   *
   * What memory is retrieved *for*. Held here rather than read from the model
   * context because a resumed turn — the user answering an approval card — has a
   * function response where its content should be, and the question worth
   * retrieving against there is the one that started the turn, not "confirmed".
   */
  private memoryQuery: string | undefined;
  /**
   * The last block this host composed, and what it was composed from.
   *
   * The instruction provider runs once per *request*, and a turn with six tool
   * calls is seven requests. Memory is still re-read every time — that is what
   * makes a mid-turn write visible to the next request, and it is one small file
   * — but the retrieval behind it is only worth doing again when the question or
   * the file has changed.
   */
  private memoryBlockCache:
    | {query: string; memory: string; text: string}
    | undefined;
  private config: AgentConfig;
  /**
   * The cached runner, keyed by provider, model and the name it is built under.
   *
   * The name is part of the key because it is part of the agent: a helper is
   * built under the profile it was resolved from, and its events have to carry
   * that name for the transcript to attribute them. Two conversations of one
   * agent differ only by session, so they share an entry.
   */
  private readonly runners = new Map<string, Runner>();
  /**
   * The discovery tree being recorded for each invocation, when Dream-RSI is on.
   *
   * Keyed by invocation because that is what ADK's tool callbacks can name — a
   * plugin is handed a `Context` and nothing else — and because a turn is one
   * invocation, so the key and the unit are the same thing. One entry in practice:
   * one turn runs at a time. The map exists because the entry has to be reachable
   * from a callback that only knows an id.
   */
  private readonly dreamRecorders = new Map<string, TreeRecorder>();
  /**
   * The turn in flight, if there is one.
   *
   * `profileId` rides here rather than being read from the config, because the
   * plugin that files a tree is cached per model while a profile can change
   * between turns: a recorder built from `config.profileId` would have to be
   * right about which agent a conversation belongs to at the moment a callback
   * happens, and the turn's own answer is the only one that cannot be stale.
   *
   * `config` and `author` are the same idea one step further: a group chat can
   * answer as an agent that is not the one the host was last configured with, and
   * the agent a turn is running as has to be a fact about *that turn* rather than
   * about the host — otherwise a second participant's words arrive under the
   * lead's name, which is exactly the confusion this feature exists to remove.
   */
  private active:
    | {
        sessionId: string;
        profileId?: string;
        controller: AbortController;
        config?: AgentConfig;
        author?: string;
      }
    | undefined;

  /**
   * The approval gates a paused turn is waiting on, and the decisions taken so
   * far.
   *
   * A round has to be answered as one message, because ADK reads the
   * confirmations from the newest user message alone: answering the first gate of
   * a two-gate round resumes the turn with the second still unanswered, and the
   * provider then refuses the request — an assistant message's tool calls must
   * each be answered. Holding the decision here is also the honest state: the
   * turn is waiting for the user, not for the model.
   *
   * A new turn abandons whatever the last one was waiting on, which is what the
   * window does when the user stops a paused turn and asks something else. The
   * mapping layer answers the calls left behind on the wire, so an abandoned
   * round costs a re-ask rather than a broken conversation.
   */
  private gateRound: GateRound | undefined;

  /**
   * The gates a helper is paused on, and whoever is waiting to hear about them.
   *
   * A separate round from `gateRound` because it answers a different question.
   * The round above exists because *one* turn's gates have to be answered
   * together as one message; this one exists because a helper runs inside the
   * turn that asked for it, so its runner is the thing suspended — and the
   * decision has to reach *it*, not the turn that is already blocked on the tool
   * call. Same card, same click, two different places the answer has to land.
   */
  private readonly gateDecisions = new Map<string, GateDecision>();
  /**
   * The helpers running right now, so a stop reaches them.
   *
   * A helper outlives the call that started it in one direction only: it is
   * still spending when the user presses Stop. Nothing else in the app can see
   * it — it has no host of its own, on purpose — so the turn that owns it is the
   * only thing that can put it down.
   */
  private readonly childRuns = new Set<AbortController>();

  constructor(options: AgentHostOptions) {
    this.options = options;
    this.sessionService =
      options.sessionService ??
      new FileSessionService({
        rootDir: options.sessionsDir,
      });
    this.appName = options.appName ?? AgentHost.APP_NAME;
    this.userId = options.userId ?? AgentHost.USER_ID;
    this.config = options.config;
    // Memory follows the folder and the agent profile, and now also splits by
    // layer: pointing the app at another project must not carry this project's
    // conventions over, while a fact about the person has to survive the move.
    this.memory = new MemoryStore({
      workspaceRoot: options.config.workspaceRoot,
      ...(options.personMemoryDir !== undefined
        ? {personMemoryRoot: options.personMemoryDir}
        : {}),
      ...(options.config.profileId !== undefined
        ? {profileId: options.config.profileId}
        : {}),
      ...(options.config.memorySoftLimitBytes !== undefined
        ? {softLimitBytes: options.config.memorySoftLimitBytes}
        : {}),
    });
    this.webSearch = options.webSearch;
    this.jobService = options.jobService;
    this.discordService = options.discordService;
    this.deskService = options.deskService;
    this.skillService = options.skillService;
    this.skillLibrary = options.skillLibrary;
    this.mcpServers = options.mcpServers ?? [];
    this.recallService = options.recallService;
    this.onSessionsDeleted = options.onSessionsDeleted;
    this.delegate = options.delegate;
  }

  /** Prepares the runner cache. There is nothing to build until a turn runs. */
  init(): void {
    this.runners.clear();
  }

  updateConfig(config: AgentConfig): void {
    const affectsRuns =
      config.model !== this.config.model ||
      config.provider !== this.config.provider ||
      config.baseUrl !== this.config.baseUrl ||
      /*
       * The key is compared too, and that is not paranoia: a user who pastes a
       * new key because the old one was refused must have the turn they are
       * retrying use it, and a cached runner would otherwise keep sending the
       * credential that just failed.
       */
      config.apiKey !== this.config.apiKey ||
      config.maxOutputTokens !== this.config.maxOutputTokens ||
      config.systemPrompt !== this.config.systemPrompt ||
      config.profileId !== this.config.profileId ||
      config.workspaceRoot !== this.config.workspaceRoot ||
      !sameList(config.enabledTools, this.config.enabledTools) ||
      /*
       * The connector grant is a tool list from the model's side of the fence:
       * changing it changes what the cached runner offers, so it belongs here
       * rather than beside the dream settings below. Leaving it out would make a
       * switch in Settings appear to do nothing until something else changed the
       * configuration — which is the complaint every one of these lines exists to
       * prevent.
       */
      !sameList(config.mcpServerIds, this.config.mcpServerIds) ||
      config.allowPrivateNetworkFetch !== this.config.allowPrivateNetworkFetch;

    /*
     * `enabledSkills` is deliberately not in the list above, and neither is
     * `instruction`.
     *
     * Tool names, the model and the folder all change what a running turn can do,
     * so a change to one of them aborts it rather than letting it finish against
     * a configuration the user has just replaced. A skill and a turn's own
     * instruction are prompt text: the instruction provider reads `this.config`
     * on every request, so text changed midway through a turn is simply in the
     * next one — and aborting the turn that saved a skill, which is what `/learn`
     * does, would be the one case where the feature could never work.
     */
    this.config = config;
    /*
     * Dream-RSI moves the runner cache rather than aborting a turn.
     *
     * The plugin is chosen when a runner is built, so switching the feature on or
     * off has to invalidate the cached one — otherwise the setting would appear
     * to do nothing until the model changed or the app restarted, which is the
     * shape of bug this whole file is written to avoid. It is *not* in
     * `affectsRuns` above, and that is the deliberate part: `affectsRuns` aborts
     * a turn in flight, and aborting somebody's answer because they moved a
     * slider is a worse outcome than the setting taking effect on the next turn.
     * So the cache is dropped and the turn that is already running finishes under
     * the policy it started with — which is also the honest thing for the log to
     * record, since the tree stores the weights it ran under.
     */
    if (!sameDream(this.config.dream, config.dream)) {
      this.runners.clear();
    }
    // Memory follows both the folder and the agent: a profile switch must not
    // inherit the previous agent's remembered facts.
    this.memory.setWorkspaceRoot(config.workspaceRoot);
    this.memory.setProfileId(config.profileId);
    // Read at call time by the tools, so moving the limit in Settings reaches the
    // next read and write rather than the next launch.
    this.memory.setSoftLimitBytes(
      config.memorySoftLimitBytes ?? MEMORY_SOFT_LIMIT_BYTES,
    );
    // Agents hold the model, address and tool closures, so a settings change
    // invalidates every cached runner.
    this.runners.clear();
    if (affectsRuns) {
      // A run in flight is using the previous configuration; stop it rather
      // than letting it finish against settings the user just replaced.
      this.abortActive();
    }
  }

  /**
   * Replaces the connected MCP servers.
   *
   * The cached runners are dropped because a runner holds the tool closures it
   * was built with: a server that connected after that build would be invisible
   * until something rebuilt, which is exactly the "I added it and nothing
   * happened" complaint this avoids.
   *
   * A turn in flight is deliberately *not* aborted. Tools are chosen when a turn
   * begins, and the request already in flight is carrying the old list — killing
   * it to deliver a new server's tools mid-sentence would lose the answer the
   * user is reading. The next turn has them.
   */
  setMcpServers(sources: readonly McpToolsetSource[]): void {
    this.mcpServers = sources;
    this.runners.clear();
  }

  /**
   * Replaces what recall can answer, or removes it.
   *
   * Dropped rather than updated when it changes, for the same reason a tool list
   * is: the cached runner holds the tool closures it was built with, so a service
   * that appeared after that build would be invisible until something rebuilt —
   * "I switched it on and nothing happened".
   *
   * A turn in flight is not aborted. Tools are chosen when a turn begins, and
   * memory narrowed under a request already being composed is not worth losing
   * the answer the user is reading; the next turn has it.
   */
  setRecallService(service: RecallLookup | undefined): void {
    if (this.recallService === service) {
      return;
    }
    this.recallService = service;
    // The block itself is derived from memory and the question, so a cached one
    // belongs to the service that produced it.
    this.memoryBlockCache = undefined;
    this.runners.clear();
  }

  /**
   * The conversations a profile can see.
   *
   * Sessions are per profile, so passing one is how the sidebar stays scoped.
   * `undefined` lists everything, which is what a host with no profile concept
   * wants.
   */
  async listSessions(profileId?: string): Promise<SessionSummary[]> {
    const entries = await this.sessionService.getIndex();
    const scoped =
      profileId === undefined
        ? entries
        : entries.filter((entry) => entry.profileId === profileId);
    return scoped
      .map(toSummary)
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  }

  /**
   * The folder a conversation is filed under, or `undefined` when it is unfiled
   * — either because it predates folders, or because the folder it named has
   * since been forgotten.
   *
   * A read of the index and nothing more: it is what decides which folder a turn
   * runs in, and the caller resolves the id to a path, because the folders are
   * the whole install's business rather than one host's.
   */
  async sessionWorkspaceId(sessionId: string): Promise<string | undefined> {
    return (await this.sessionService.getIndexEntry(sessionId))?.workspaceId;
  }

  /**
   * Claims conversations that predate profiles, so an upgrade does not strand a
   * user's history outside every profile.
   */
  async adoptUnownedSessions(profileId: string): Promise<number> {
    return await this.sessionService.adoptUnownedSessions(profileId);
  }

  /**
   * Deletes a profile's conversations, answering which ones went.
   *
   * The ids rather than a count, because a caller removing a bot has more to
   * drop that was keyed to a conversation — its discovery tree, in the runtime
   * that owns that store — and a second scan of the index to find out what was
   * just deleted is a race against the next write. Its memory files are left
   * alone: the folder's half is inside a Space the user owns, and the person's
   * half is the runtime's to decide about.
   */
  async deleteSessionsForProfile(profileId: string): Promise<string[]> {
    if (
      this.active &&
      (await this.sessionProfile(this.active.sessionId)) === profileId
    ) {
      this.abortActive();
    }
    const deleted =
      await this.sessionService.deleteSessionsForProfile(profileId);
    /*
     * Told before the ids are answered, so a caller that deletes a profile and
     * immediately searches cannot find the conversations it just removed. The
     * ids are the session service's own answer rather than a second scan of the
     * index.
     */
    if (deleted.length > 0) {
      await this.onSessionsDeleted?.(deleted);
    }
    return deleted;
  }

  async createSession(
    title?: string,
    profileId?: string,
    workspaceId?: string,
    source?: SessionSource,
    purpose?: SessionPurpose,
  ): Promise<SessionSummary> {
    const state: Record<string, unknown> = {};
    if (title) {
      state['title'] = title;
    }
    if (profileId) {
      state['profileId'] = profileId;
    }
    if (workspaceId) {
      state['workspaceId'] = workspaceId;
    }
    if (source) {
      state['source'] = source;
    }
    if (purpose) {
      state['purpose'] = purpose;
    }

    const session = await this.sessionService.createSession({
      appName: this.appName,
      userId: this.userId,
      sessionId: randomUUID(),
      state: Object.keys(state).length > 0 ? state : undefined,
    });
    const entry = await this.sessionService.getIndexEntry(session.id);
    return entry
      ? toSummary(entry)
      : {
          id: session.id,
          title: title ?? 'New chat',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          messageCount: 0,
          ...(workspaceId ? {workspaceId} : {}),
          ...(source ? {source} : {}),
          ...(purpose ? {purpose} : {}),
        };
  }

  /**
   * What a conversation is for, for the turn that is about to run.
   *
   * Read from the index rather than from the in-memory active turn: a reloaded
   * window and a restarted service both need the builder's instruction, and the
   * conversation on disk is the state machine. An unreadable entry answers
   * `undefined` — an ordinary chat — because losing a purpose is a duller
   * conversation, while throwing here would be a turn that never starts.
   */
  async sessionPurpose(sessionId: string): Promise<SessionPurpose | undefined> {
    const entry = await this.sessionService.getIndexEntry(sessionId);
    return entry?.purpose;
  }

  /**
   * Re-files a conversation under another folder, or under none.
   *
   * This is the sidebar's filing, not the agent's confinement root: what the
   * agent may touch is the active profile's active workspace, which the window
   * shows above the composer. A conversation keeps running exactly as it did.
   */
  async setSessionWorkspace(
    sessionId: string,
    workspaceId: string | undefined,
    profileId?: string,
  ): Promise<SessionSummary> {
    await this.assertOwned(sessionId, profileId);
    const entry = await this.sessionService.setSessionWorkspace(
      sessionId,
      workspaceId,
    );
    if (!entry) {
      throw new Error(`Unknown session: ${sessionId}`);
    }
    return toSummary(entry);
  }

  /**
   * The model a conversation was pointed at, or nothing when it follows the app.
   *
   * A read of the index entry, exactly like `sessionWorkspaceId` above and for
   * the same reason: the window draws what a conversation will answer with before
   * any turn runs, and reading the conversation's event log for one field would
   * make opening a chat cost a scan of everything on disk.
   */
  async sessionModel(sessionId: string): Promise<AgentModel | undefined> {
    return (await this.sessionService.getIndexEntry(sessionId))?.model;
  }

  /**
   * Points a conversation at a model of its own, or back at its agent's.
   *
   * Ownership is asserted like every other path that touches a conversation, so a
   * window cannot re-point another profile's chat by guessing at an id.
   */
  async setSessionModel(
    sessionId: string,
    model: AgentModel | undefined,
    profileId?: string,
  ): Promise<SessionSummary> {
    await this.assertOwned(sessionId, profileId);
    const entry = await this.sessionService.setSessionModel(sessionId, model);
    if (!entry) {
      throw new Error(`Unknown session: ${sessionId}`);
    }
    return toSummary(entry);
  }

  /**
   * The agents in a conversation, the lead first, or nothing for a chat with one.
   *
   * A read of the index entry, exactly like `sessionModel` above, and for the
   * same reason: the composer draws who is in the chat before any turn runs.
   */
  async sessionParticipants(sessionId: string): Promise<string[] | undefined> {
    return (await this.sessionService.getIndexEntry(sessionId))?.agentIds;
  }

  /**
   * Sets who is in a conversation, the lead first. An empty list is "just the
   * agent that owns it".
   *
   * Ownership is asserted like every other path that touches a conversation, so a
   * window cannot add itself to another profile's chat by guessing at an id.
   */
  async setParticipants(
    sessionId: string,
    agentIds: readonly string[],
    profileId?: string,
  ): Promise<SessionSummary> {
    await this.assertOwned(sessionId, profileId);
    const entry = await this.sessionService.setSessionParticipants(
      sessionId,
      agentIds,
    );
    if (!entry) {
      throw new Error(`Unknown session: ${sessionId}`);
    }
    return toSummary(entry);
  }

  /**
   * Names a conversation, replacing the title derived from its first message.
   *
   * Ownership is asserted like every other path that touches a conversation, so
   * a window cannot rename another profile's chat by guessing at an id.
   */
  async renameSession(
    sessionId: string,
    title: string,
    profileId?: string,
  ): Promise<SessionSummary> {
    await this.assertOwned(sessionId, profileId);
    const entry = await this.sessionService.renameSession(sessionId, title);
    if (!entry) {
      throw new Error(`Unknown session: ${sessionId}`);
    }
    return toSummary(entry);
  }

  /**
   * Replaces the older part of a conversation with a summary the model writes.
   *
   * One event is appended and nothing else is touched — see `compaction.ts` for
   * why that is the whole mechanism, and why a rewrite was worth avoiding. The
   * conversation keeps every message; the request gets smaller; the transcript
   * shows one card where the replaced messages were.
   *
   * The refusals are returned rather than thrown. A command that cannot run is
   * not a failure of the app: a short conversation has nothing to compact, and a
   * turn that is mid-flight has a reason the user can act on. Throwing would turn
   * all of those into the same red banner as a provider that is down.
   */
  async compact(sessionId: string, profileId?: string): Promise<CompactResult> {
    await this.assertOwned(sessionId, profileId);

    const refused = await this.compactionRefusal(sessionId);
    if (refused !== undefined) {
      return refused;
    }

    const session = await this.sessionForCompaction(sessionId);
    const plan = planCompaction(session.events);
    if (plan === undefined) {
      return {
        compacted: false,
        reason: 'Nothing to compact yet — this conversation is short enough to fit.',
      };
    }
    return await this.applyCompaction(session, plan);
  }

  /**
   * Summarizes the older half automatically, when the context has grown.
   *
   * The difference from {@link compact} is who decided and what happens on a
   * failure. This one runs before a user's next turn and is allowed to do
   * nothing at all: a conversation that fits is the ordinary case, and a model
   * call that fails must not turn the question the person just asked into an
   * error. The full history is still there, so the turn proceeds and the provider
   * decides — which it would have done anyway.
   *
   * The approval and one-turn-at-a-time rules are the same, because a summary is
   * a write to the conversation a paused turn is reading.
   */
  async autoCompact(
    sessionId: string,
    profileId?: string,
    atChars?: number,
  ): Promise<CompactResult> {
    await this.assertOwned(sessionId, profileId);

    try {
      const refused = await this.compactionRefusal(sessionId);
      if (refused !== undefined) {
        return refused;
      }

      const session = await this.sessionForCompaction(sessionId);
      const plan = planAutoCompaction(
        session.events,
        atChars === undefined ? {} : {atChars},
      );
      if (plan === undefined) {
        return {
          compacted: false,
          reason: 'This conversation still fits, so nothing was summarized.',
        };
      }
      return await this.applyCompaction(session, plan);
    } catch {
      /*
       * Deliberately swallowed. A summariser that is down, a provider that
       * refuses the summary prompt, a write that cannot land: each of those is a
       * reason to send the turn uncompacted, not a reason to fail it. A command
       * the user ran still throws, because there the error is the answer.
       */
      return {
        compacted: false,
        reason:
          'The conversation could not be summarized automatically, so this ' +
          'turn used the full history.',
      };
    }
  }

  /** The two refusals shared by a manual and an automatic compaction. */
  private async compactionRefusal(
    sessionId: string,
  ): Promise<CompactResult | undefined> {
    /*
     * One turn at a time, and a compaction is a write to the conversation the
     * turn is reading. The gates are the sharper half of the same rule: a paused
     * turn is answered by the *next* invocation, and replacing the events it is
     * paused in would leave a card the model can no longer confirm.
     */
    if (this.active?.sessionId === sessionId) {
      return {
        compacted: false,
        reason:
          'A turn is running in this conversation. Stop it, or wait for it to ' +
          'finish, and then compact.',
      };
    }
    const waiting = await this.pendingGates(sessionId);
    if (waiting.length > 0) {
      return {
        compacted: false,
        reason:
          'This conversation is waiting for your approval. Answer it — or stop ' +
          'the turn — and then compact.',
      };
    }
    return undefined;
  }

  private async sessionForCompaction(
    sessionId: string,
  ): Promise<NonNullable<Awaited<ReturnType<FileSessionService['getSession']>>>> {
    const session = await this.sessionService.getSession({
      appName: this.appName,
      userId: this.userId,
      sessionId,
    });
    if (session === undefined) {
      throw new Error(`Unknown session: ${sessionId}`);
    }
    return session;
  }

  /**
   * Asks the model for one summary and appends it.
   *
   * The call is deliberately not a turn: `ask` has no tools, so the provider's
   * "a tool-carrying turn must carry its reasoning" rule does not apply to it,
   * and nothing it does is written to the session. A failed call throws with the
   * conversation untouched; what each caller does with that differs, which is why
   * the try/catch lives outside this method.
   */
  private async applyCompaction(
    session: NonNullable<Awaited<ReturnType<FileSessionService['getSession']>>>,
    plan: CompactionPlan,
  ): Promise<CompactResult> {
    const summary = (
      await this.ask(
        compactionPrompt(renderForSummary(plan.summarise), plan.previous),
      )
    ).trim();
    if (summary.length === 0) {
      return {
        compacted: false,
        reason: 'The model returned an empty summary, so nothing was changed.',
      };
    }

    await this.sessionService.appendEvent({
      session,
      event: buildCompactedEvent({
        summary,
        startTime: plan.startTime,
        endTime: plan.endTime,
      }),
    });
    return {compacted: true};
  }

  async deleteSession(sessionId: string, profileId?: string): Promise<void> {
    await this.assertOwned(sessionId, profileId);
    if (this.active?.sessionId === sessionId) {
      this.abortActive();
    }
    await this.sessionService.deleteSession({
      appName: this.appName,
      userId: this.userId,
      sessionId,
    });
    await this.onSessionsDeleted?.([sessionId]);
  }

  async getTranscript(
    sessionId: string,
    profileId?: string,
  ): Promise<{session: SessionSummary; messages: TranscriptMessage[]}> {
    const entry = await this.assertOwned(sessionId, profileId);
    const events = await this.sessionService.listEvents(sessionId);
    return {session: toSummary(entry), messages: projectTranscript(events)};
  }

  private async sessionProfile(sessionId: string): Promise<string | undefined> {
    const entry = await this.sessionService.getIndexEntry(sessionId);
    return entry?.profileId;
  }

  /**
   * The conversation, if this profile owns it.
   *
   * `undefined` covers both an unknown session and one that belongs to another
   * agent, deliberately: a stale window must not be able to tell the two apart,
   * so guessing an id reveals nothing.
   */
  private async ownedEntry(
    sessionId: string,
    profileId?: string,
  ): Promise<SessionIndexEntry | undefined> {
    const entry = await this.sessionService.getIndexEntry(sessionId);
    if (!entry) {
      return undefined;
    }
    if (profileId !== undefined && entry.profileId !== profileId) {
      return undefined;
    }
    return entry;
  }

  /** The same question, as a refusal for the callers that should throw. */
  private async assertOwned(
    sessionId: string,
    profileId?: string,
  ): Promise<SessionIndexEntry> {
    const entry = await this.ownedEntry(sessionId, profileId);
    if (!entry) {
      throw new Error(`Unknown session: ${sessionId}`);
    }
    return entry;
  }

  /** The refusal message, for the turn path that reports rather than throws. */
  private async ownershipProblem(
    sessionId: string,
    profileId?: string,
  ): Promise<string | undefined> {
    const entry = await this.ownedEntry(sessionId, profileId);
    return entry ? undefined : `Unknown session: ${sessionId}`;
  }

  /**
   * Runs one turn. Callers must consume the whole generator.
   *
   * The profile check happens before anything is sent: appending to another
   * agent's conversation is the one wrong the rest of this class refuses.
   *
   * `instruction` is prompt text for this turn only — the desktop companion
   * asking for a shorter answer than the window asks for. It is applied here
   * rather than by the caller because it has to be cleared as reliably as it is
   * set: a caller that set it and forgot to unset it would leave the *window*
   * answering in the pet's voice, and that is a bug nobody would trace back to
   * this line.
   *
   * `as` is the agent answering, when the user addressed one that is not the
   * agent this host was last configured with. The caller has already resolved it
   * — the host cannot, because it does not know who exists — and the turn runs
   * with that agent's identity, tools and model under that agent's name, which is
   * what makes the reply arrive attributed to the agent the user asked for
   * rather than to the lead.
   */
  async *run(
    sessionId: string,
    text: string,
    instruction?: string,
    profileId?: string,
    as?: {agentId: string; name: string; config: AgentConfig},
  ): AsyncGenerator<AgentUiEvent> {
    const answering = as?.config ?? this.config;
    this.config =
      instruction === undefined
        ? {...answering, ...{instruction: undefined}}
        : {...answering, instruction};
    /*
     * The question memory is retrieved *for*, kept for the length of the turn.
     * `approve` deliberately does not overwrite it: a resumed turn's content is a
     * function response, and the thing worth retrieving against is still the
     * question the user asked before the card appeared.
     */
    this.memoryQuery = text;
    this.memoryBlockCache = undefined;
    yield* this.drive(
      sessionId,
      {role: 'user', parts: [{text}]},
      profileId,
      as === undefined ? undefined : {agentId: as.agentId, config: as.config},
    );
  }

  /**
   * The gates this conversation is still waiting on, read from disk.
   *
   * The in-memory `gateRound` is the fast path, and it is not the truth. A
   * process that restarted, a window that reloaded, and the headless runner
   * looking at a job the app paused on all have the same problem: the gate was
   * raised by an object that no longer exists, so the only place it survives is
   * the conversation itself.
   *
   * That is the same rule the rest of this app follows — the thread on disk is
   * the state machine — and it is what makes an approval card answerable after a
   * relaunch instead of being a button that silently does nothing.
   */
  /**
   * The stored events of a conversation, for something that reads them back.
   *
   * Raw rather than projected: the review wants what was actually said, and the
   * transcript projection is shaped for drawing — it drops reasoning, merges
   * events into messages and attaches tool calls. Both readers want different
   * things from the same log, so the log is what is handed out.
   */
  async eventsFor(
    sessionId: string,
  ): Promise<Awaited<ReturnType<FileSessionService['listEvents']>>> {
    return await this.sessionService.listEvents(sessionId);
  }

  /**
   * Whether this is the first thing said here, and when the last thing was.
   *
   * Read *before* a turn rather than during it, because ADK appends the user's
   * message as the turn runs — reading afterwards would describe this message
   * rather than the one before it.
   *
   * The session index is the source rather than the per-event timestamp, and that
   * is a deliberate choice: `updatedAt` is a stored ISO string the sidebar
   * already sorts on, so it exists for every conversation, while a per-event
   * timestamp is a field the provider may or may not populate. A context block
   * that silently lost its second line on some installs would be worse than one
   * that never had it.
   *
   * Total: an index entry that cannot be read answers "first exchange", which
   * says less rather than something wrong.
   */
  async sessionActivity(
    sessionId: string,
  ): Promise<{firstExchange: boolean; lastActivity?: Date}> {
    const entry = await this.sessionService.getIndexEntry(sessionId);
    if (entry === undefined || entry.messageCount === 0) {
      return {firstExchange: true};
    }
    const at = new Date(entry.updatedAt);
    return Number.isNaN(at.getTime())
      ? {firstExchange: false}
      : {firstExchange: false, lastActivity: at};
  }

  /** What the agent currently remembers, as it would be injected. */
  async memoryText(): Promise<string> {
    return await this.memory.readForPrompt();
  }

  /**
   * Memory as this request should see it: rules whole, facts recalled.
   *
   * The fallback is the whole file, and it is the important half. Every reason
   * retrieval might not happen — no service, no question, a question too short to
   * retrieve against, no memory corpus, a search that failed, one that took too
   * long — produces exactly the block this app has always produced. Retrieval may
   * only narrow the prompt when it is working; a smaller prompt produced by a
   * broken step is a silent loss of facts the user wrote down, which is the one
   * failure nobody would notice.
   */
  private async memoryForPrompt(): Promise<string> {
    const whole = await this.memory.readForPrompt();
    const recall = this.recallService;
    const query = this.memoryQuery?.trim() ?? '';
    if (
      recall === undefined ||
      query.length < MIN_RETRIEVAL_QUERY_CHARS ||
      !recall.scopes().includes('memory') ||
      /*
       * A file no larger than the recalled block cannot be narrowed, only
       * shortened: retrieval could drop bullets and could not add one. Skipping
       * it is not an optimisation of the result — the result is identical to the
       * best case — and it takes a query embed, an index pass and up to
       * `RETRIEVAL_DEADLINE_MS` off the first token of every turn on a young
       * install, which is most of them.
       */
      whole.length <= DEFAULT_MAX_CHARS
    ) {
      return whole;
    }

    let text: string;
    try {
      text = await this.memory.read();
    } catch {
      // `readForPrompt` already turned this into a sentence; nothing to add.
      return whole;
    }
    const cached = this.memoryBlockCache;
    if (cached !== undefined && cached.query === query && cached.memory === text) {
      return cached.text;
    }

    try {
      const answer = await withDeadline(
        recall.search({query, scopes: ['memory'], limit: RETRIEVED_BULLETS}),
        RETRIEVAL_DEADLINE_MS,
      );
      const recalled: RecalledBullet[] = answer.hits
        .map((hit) => ({section: hit.section ?? '', text: hit.text}))
        .filter((bullet) => bullet.text.length > 0);
      /*
       * A hit with no text is one the index could not verify — a stale bullet, or
       * a cold engine that answered with previews only. Nothing recalled is not a
       * reason to narrow: it is the case the whole-file fallback is for.
       */
      if (recalled.length === 0) {
        return whole;
      }
      const block = selectMemory({memory: text, recalled, usedRetrieval: true}).text;
      this.memoryBlockCache = {query, memory: text, text: block};
      return block;
    } catch {
      return whole;
    }
  }

  /** How many bytes this agent's memory file holds right now. */
  async memoryBytes(): Promise<number> {
    return await this.memory.bytes();
  }

  /** When each remembered bullet was first written, for the panel. */
  async memoryProvenance(): Promise<MemoryProvenanceEntry[]> {
    return await this.memory.provenance();
  }

  /**
   * Adds a fact to memory, as if the agent had called `update_memory`.
   *
   * `append` is still the mode, and deliberately: a mode that could rewrite a
   * section would let one accepted suggestion quietly replace everything the
   * agent had learned before it. `replaces` is not that — it names one bullet to
   * remove, is checked against the section it is in, and reports back whether it
   * matched anything, so an accepted correction either takes the old fact out or
   * says that it could not.
   *
   * The report is returned rather than swallowed for the same reason: the user
   * pressed a button believing a fact would be corrected, and "the bullet you
   * meant was not found" is the only evidence they will get.
   */
  async remember(
    section: string,
    text: string,
    replaces?: string,
  ): Promise<SupersedeReport> {
    const report = await this.memory.update(
      {
        section,
        content: text,
        mode: 'append',
        ...(replaces === undefined || replaces.trim().length === 0
          ? {}
          : {replaces}),
      },
      // Provenance, not behaviour: a person reading their own memory later
      // should be able to tell the facts they stated from the ones a background
      // look proposed and they agreed to.
      'review',
    );
    return report.supersede;
  }

  /**
   * Asks the model one question, outside any conversation.
   *
   * A plain request rather than an agent turn: no tools, no session, no events
   * written anywhere. A review that ran through the conversation machinery would
   * appear in the transcript as something the user said, and would be re-reviewed
   * by the next look — a loop that grows.
   *
   * The reply is what the model *said*, not what it thought: thought parts are
   * dropped. Our transport aggregates a turn into one response with the reasoning
   * first (`openai-compat-llm.ts`), so the alternative is an answer with the
   * model's working glued to the front of it — which for the summariser below
   * means a summary that opens by narrating how it was written.
   *
   * A refusal or a network failure throws, and the caller decides what that
   * means; for a review, it means nothing was found.
   */
  async ask(prompt: string, abortSignal?: AbortSignal): Promise<string> {
    return await this.oneShot(prompt, this.config, abortSignal);
  }

  /**
   * One question to one model, with the configuration named by the caller.
   *
   * A configuration rather than a model id, because since the app stopped running
   * a model of its own an id means nothing without the endpoint that serves it —
   * and the two callers here are asking *this* install's provider, whose address,
   * key and model all come from the same document.
   */
  private async oneShot(
    prompt: string,
    config: AgentConfig,
    abortSignal?: AbortSignal,
  ): Promise<string> {
    const llm = this.llmFor(config);
    const request = {
      model: config.model,
      contents: [{role: 'user', parts: [{text: prompt}]}],
    } as unknown as Parameters<typeof llm.generateContentAsync>[0];

    let text = '';
    for await (const response of llm.generateContentAsync(
      request,
      false,
      abortSignal,
    )) {
      for (const part of response.content?.parts ?? []) {
        if (part.thought === true || typeof part.text !== 'string') {
          continue;
        }
        text += part.text;
      }
    }
    return text;
  }

  /**
   * The model client for a configuration.
   *
   * Takes the configuration rather than reading `this.config`, because the two
   * are not always the same one: a helper is built from a profile that is not the
   * host's, and a client built from the wrong config would send the helper to the
   * lead's address with the lead's credential.
   */
  private llmFor(config: AgentConfig = this.config): OpenAiCompatLlm {
    return new OpenAiCompatLlm({
      model: config.model,
      baseUrl: config.baseUrl,
      provider: config.provider,
      apiKey: config.apiKey,
      /*
       * Read at send time rather than captured, for the reason the option
       * documents: this client is cached per model and outlives the turn that
       * built it, so the conversation it names has to be the one being answered
       * now.
       */
      readSessionId: () => this.activeSessionId(),
      ...(config.maxOutputTokens !== undefined
        ? {maxOutputTokens: config.maxOutputTokens}
        : {}),
    });
  }

  async pendingGates(sessionId: string): Promise<PendingGate[]> {
    const events = await this.sessionService.listEvents(sessionId);
    return pendingGatesIn(events);
  }

  /**
   * The round to record a decision against.
   *
   * Prefers the round this process opened, and falls back to reading the gates
   * back out of the conversation when it did not open one — which is what a
   * restart, a reload or a second window looks like from here.
   *
   * The derived round is cached exactly like a live one, so a round with several
   * gates still collects all of its decisions before anything is sent: ADK reads
   * the confirmations from the newest message alone, and resuming on the first
   * decision is what leaves a turn with one tool result for two calls.
   */
  private async roundFor(sessionId: string): Promise<GateRound | undefined> {
    if (this.gateRound?.sessionId === sessionId) {
      return this.gateRound;
    }

    const gates = await this.pendingGates(sessionId);
    if (gates.length === 0) {
      return undefined;
    }

    this.gateRound = {
      sessionId,
      gates: new Set(gates.map((gate) => gate.callId)),
      decisions: new Map(),
    };
    return this.gateRound;
  }

  /**
   * Answers a pending `adk_request_confirmation` gate. ADK resumes the paused
   * call when the newest user turn carries a function response whose name is
   * the gate name and whose id is the gate's call id.
   *
   * A gate is only part of the answer when its turn asked about several calls:
   * ADK reads the confirmations from the newest user message alone, so the
   * decisions are held until every gate of the round has one and then sent
   * together. Resuming on the first decision is what left a real turn with one
   * tool result for two tool calls, which the provider refuses.
   *
   * A gate that is not waiting anywhere — answered already, or belonging to a
   * round abandoned by a later turn — is dropped rather than sent: ADK would
   * refuse it as a confirmation for a call it is not asking about, and the
   * window has taken its card down by then.
   */
  async *approve(params: ApproveParams): AsyncGenerator<AgentUiEvent> {
    const decision: GateDecision = {
      confirmed: params.confirmed,
      ...(params.payload !== undefined ? {payload: params.payload} : {}),
    };

    /*
     * A helper's gate comes first, and it is answered by *waking the helper*
     * rather than by resuming the turn. The turn is not paused on a card: it is
     * suspended inside the tool call that started the helper, so there is nothing
     * for a new turn to resume — the helper's own runner is what has to continue,
     * and it will, in the call below.
     */
    this.gateDecisions.set(params.callId, decision);

    const round = await this.roundFor(params.sessionId);
    if (!round) {
      return;
    }
    if (!round.gates.has(params.callId)) {
      return;
    }

    round.decisions.set(params.callId, decision);
    if (round.decisions.size < round.gates.size) {
      return;
    }

    // Built before the drive, which starts its own round: an undecided gate
    // cannot survive into the message, so the round is read out in full here.
    const parts: Part[] = [...round.gates].map((callId) =>
      confirmationResponse(
        callId,
        round.decisions.get(callId) ?? {confirmed: false},
      ),
    );
    yield* this.drive(params.sessionId, {role: 'user', parts});
  }

  /**
   * Registers a helper's run so the turn that owns it can stop it.
   *
   * Returns the function that unregisters it, which the caller must call in a
   * `finally`: a controller left in the set is a set that grows for the life of
   * the window and an abort aimed at a helper that finished long ago.
   */
  registerChildRun(controller: AbortController): () => void {
    this.childRuns.add(controller);
    return () => {
      this.childRuns.delete(controller);
    };
  }

  abort(sessionId: string): boolean {
    if (this.active?.sessionId !== sessionId) {
      return false;
    }
    this.abortActive();
    return true;
  }

  /**
   * Whether a turn is in flight.
   *
   * The scheduler asks before it dispatches: this host answers one turn at a
   * time, and a scheduled job that collided with the user's own message would be
   * refused by `drive` and lost. Asking first turns that into "run it in a
   * moment" instead.
   */
  isBusy(): boolean {
    return this.active !== undefined;
  }

  /** The session a turn is running in, when one is. Exposed for the scheduler. */
  activeSessionId(): string | undefined {
    return this.active?.sessionId;
  }

  /** Stops any in-flight turn. Called when the app is quitting. */
  dispose(): void {
    this.abortActive();
  }

  private abortActive(): void {
    this.active?.controller.abort();
    this.active = undefined;
    /*
     * A helper is part of the turn that started it, so stopping the turn stops it
     * too. It costs the provider real money per step and the user has no other
     * way to reach it — it has no host of its own — so leaving one running would
     * be a Stop button that stopped the answer and not the spending.
     */
    this.stopChildRuns();
  }

  private stopChildRuns(): void {
    for (const child of this.childRuns) {
      child.abort();
    }
    this.childRuns.clear();
  }

  /**
   * Clears every `ask_agent` tool's per-turn count.
   *
   * The tools are reachable only through the runners that were built with them,
   * so the host keeps this set rather than reaching into a runner: a helper's tool
   * is built fresh per call and is in the set only until the call ends, while the
   * lead's lives as long as its cached runner does.
   */
  private resetDelegations(): void {
    for (const tool of this.askAgentTools) {
      tool.reset();
    }
  }

  /**
   * The connected servers an agent was granted.
   *
   * The grant is the profile's, and an absent one means every server: that is the
   * state every profile written before the field existed is in, so an upgrade
   * behaves exactly as it did. Ids rather than names, because a grant has to
   * survive a rename and must not be inherited by a new server given an old name.
   *
   * Read at the moment a runner is built rather than when the servers are handed
   * over, because both halves move: a server can connect after the profile was
   * written, and the profile can be edited while the app runs.
   */
  private grantedMcpServers(
    config: AgentConfig = this.config,
  ): readonly McpToolsetSource[] {
    const ids = config.mcpServerIds;
    if (ids === undefined) {
      return this.mcpServers;
    }
    const granted = new Set(ids);
    return this.mcpServers.filter((source) => granted.has(source.server.id));
  }

  /**
   * An ADK agent for one configuration, under the name that attributes it.
   *
   * Two callers: the turn runner below, whose agent is the conversation's own and
   * is always built under `MAIN_AGENT_NAME`; and `ask_agent`, whose helper is
   * built under the id of the profile it resolved to. That name is not a label —
   * it is what ADK writes into every event the agent produces, and therefore what
   * the transcript splits bubbles on, so one name per agent is what keeps two
   * agents' words from merging into one answer.
   */
  buildAgent(
    config: AgentConfig,
    author: string,
    description: string,
  ): LlmAgent {
    /*
     * The instruction is an async provider rather than a string, because most of
     * it is read per *request*: memory may have been written midway through a turn
     * and a profile edited while one is in flight, and both should reach the very
     * next request rather than the next turn. The config is captured rather than
     * read off `this`, so an agent built for a helper keeps the helper's identity
     * for as long as it exists.
     */
    const mcpServers = this.grantedMcpServers(config);
    /*
     * Whether this agent answers *as* the turn: the conversation's own, or the
     * participant the user addressed. A helper does not — see `configFor`.
     */
    const live = author === MAIN_AGENT_NAME || this.active?.author === author;
    /** This agent's configuration as of *this request*, not of this build. */
    const configNow = (): AgentConfig => this.configFor(config, live);
    return new LlmAgent({
      name: author,
      description,
      model: this.llmFor(config),
      /*
       * A helper gets no prior history, and that is the honesty of the tool's own
       * promise: it is told it cannot see this conversation, so it must not be
       * handed one. Without this ADK folds every earlier message of the parent's
       * chat into the helper's request as "for context" text — a large prompt for
       * a small task, and a helper that answers about the user's earlier questions
       * rather than about the task it was given.
       */
      ...(author === MAIN_AGENT_NAME ? {} : {includeContents: 'none' as const}),
      instruction: async () =>
        composeInstruction({
          base: configNow().systemPrompt,
          // Read per request for the same reason as the tools below it: someone
          // editing their Persona while a turn is running should reach that
          // turn's next request rather than the next turn.
          ...(configNow().persona !== undefined
            ? {persona: configNow().persona}
            : {}),
          /*
           * Read per request rather than per turn: the model may have just
           * written to memory, and the next request should already see it. What
           * of it is *shown* depends on the question, when recall is available.
           *
           * The block is composed for the *parent conversation*, which is the one
           * this file can retrieve against, and it is shared with a helper on
           * purpose: the helper works for the same person, and a second retrieval
           * against a task the user never wrote would rank their facts against
           * the wrong question.
           */
          memory: await this.memoryForPrompt(),
          // Whatever the surface that asked for this turn wanted, if there was
          // anything. `run` cleared it on its way in, so a turn that asked for
          // nothing — every turn from the window — carries no trace of the pet's.
          // A helper is given none of it: the pet's brevity is not its business.
          ...(configNow().instruction !== undefined &&
          author === MAIN_AGENT_NAME
            ? {instruction: configNow().instruction}
            : {}),
          // Which capabilities the prompt may describe. Read per request for the
          // same reason as memory above: a profile edited in Settings while a
          // turn is in flight should reach that turn's next request rather than
          // the next turn.
          ...(configNow().enabledTools !== undefined
            ? {tools: configNow().enabledTools}
            : {}),
          ...(configNow().enabledSkills !== undefined
            ? {userSkillNames: configNow().enabledSkills}
            : {}),
          // Read from the config on every request, like memory above it: a skill
          // saved midway through a turn is in the very next request that turn
          // makes, which is what makes `/learn` take effect immediately.
          ...(configNow().userSkills !== undefined
            ? {userSkills: configNow().userSkills}
            : {}),
        }),
      tools: createTools(config, {
        memory: this.memory,
        ...(this.recallService === undefined
          ? {}
          : {recallService: this.recallService}),
        model: config.model,
        provider: config.provider,
        ...(this.webSearch ? {webSearch: this.webSearch} : {}),
        ...(this.jobService ? {jobService: this.jobService} : {}),
        ...(this.discordService ? {discordService: this.discordService} : {}),
        ...(this.deskService ? {deskService: this.deskService} : {}),
        ...(this.skillService ? {skillService: this.skillService} : {}),
        ...(this.skillLibrary ? {skillLibrary: this.skillLibrary} : {}),
        ...(mcpServers.length > 0 ? {mcpServers} : {}),
        /*
         * The helper tool, built here so a helper cannot have one: `buildAgent`
         * is what constructs both the lead and the helper, and this dependency is
         * only ever passed for an agent that is allowed to delegate. Depth one is
         * therefore a fact about how the agent is put together rather than a
         * number anything has to compare.
         */
        ...(this.delegate !== undefined && author === MAIN_AGENT_NAME
          ? {delegate: this.askAgentDelegation(this.delegate)}
          : {}),
      }),
    });
  }

  /**
   * The tool's view of delegating: who exists, and how they are followed.
   *
   * The two callbacks that are not the seam itself are the host's own, because
   * they read and write things only the host has — the conversation's pending
   * gates, and the decisions the window sent back for them.
   */
  private askAgentDelegation(seam: DelegationSeam): AskAgentTool {
    /*
     * Kept as a local, because the generator below is a method of the object
     * being built: `this` inside it is the tool, not the host.
     */
    const host = this;
    const delegation: AgentDelegation = {
      start: async (request) => {
        const filed = await this.sessionWorkspaceId(request.sessionId);
        const resolved = await seam.resolve({
          ...request,
          ...(filed === undefined ? {} : {sessionSpaceId: filed}),
        });
        if ('problem' in resolved) {
          return resolved;
        }
        /*
         * The helper is the agent it resolved to: its own configuration, its own
         * name — which is the id its replies are attributed by — and its own
         * profile's tools, because that grant is what the user decided about it.
         */
        const author = agentNameFor(resolved.profile.id);
        const runner = this.buildRunner({
          config: resolved.config,
          author,
          description: resolved.profile.name,
        });
        return {
          agentId: resolved.profile.id,
          author,
          name: resolved.profile.name,
          run: async function* (streamed) {
            /*
             * Every helper runs under a controller this host holds, so stopping
             * the turn stops the helper: it costs money per step and the user has
             * no other way to reach it, since it deliberately has no host of its
             * own. The tool's own abort is relayed in rather than passed through,
             * because one of the two is cancelled by `stopChildRuns` and a passed
             * signal cannot be cancelled from outside.
             */
            const controller = new AbortController();
            const stop = (): void => {
              controller.abort();
            };
            streamed.signal.addEventListener('abort', stop, {once: true});
            if (streamed.signal.aborted) {
              controller.abort();
            }
            const unregister = host.registerChildRun(controller);
            try {
              const events = runner.runAsync({
                userId: AgentHost.USER_ID,
                sessionId: streamed.sessionId,
                newMessage: streamed.newMessage,
                abortSignal: controller.signal,
                runConfig: {streamingMode: StreamingMode.SSE},
              });
              for (;;) {
                const next = await events.next();
                if (next.done === true || controller.signal.aborted) {
                  return;
                }
                yield next.value;
              }
            } finally {
              streamed.signal.removeEventListener('abort', stop);
              unregister();
            }
          },
        };
      },
      pendingGates: async (sessionId) =>
        (await this.pendingGates(sessionId)).map((gate) => ({
          callId: gate.callId,
          tool: gate.tool,
          args: gate.args,
        })),
      helperGates: async (sessionId, author, afterCallId) => {
        const events = await this.sessionService.listEvents(sessionId);
        return gatesAskedBy(events, author, afterCallId).map((gate) => ({
          callId: gate.callId,
          tool: gate.tool,
          args: gate.args,
        }));
      },
      ...(this.options.onDelegateEvent === undefined
        ? {}
        : {onEvent: this.options.onDelegateEvent}),
      ...(this.options.delegateLimits === undefined
        ? {}
        : {limits: this.options.delegateLimits}),
    };
    const tool = createAskAgentTool(delegation, delegation);
    this.askAgentTools.add(tool);
    return tool;
  }

  /**
   * The runner for the conversation's own agent, built on first use and reused.
   *
   * Keyed by provider *and* model *and* author. The provider is in the key and
   * not just the model because two conversations can be pointed at two services
   * that happen to serve a model of the same name — `glm-5.3-flash` at OpenCode
   * Go and the same name on somebody's own server — and a cache keyed on the name
   * alone would hand one of them the other one's address and credential. The
   * author is in the key because the name is bound into the agent, and therefore
   * into every event it writes: two participants of one conversation can share a
   * model and must not share an agent.
   */
  private runnerFor(model: string, author: string): Runner {
    const key = `${this.config.provider}\u0000${model}\u0000${author}`;
    const cached = this.runners.get(key);
    if (cached) {
      return cached;
    }

    const runner = this.buildRunner({
      config: this.config,
      author,
      description: 'Marimo Bot, a local desktop assistant.',
    });
    this.runners.set(key, runner);
    return runner;
  }

  /**
   * The configuration an agent built under this name should read right now.
   *
   * Two answers, and the difference between them is a whole class of bug.
   *
   * An agent built for a *turn* — the conversation's own, or the participant a
   * message addressed — reads the live configuration, because `run` is what
   * replaces it: the addressed agent's identity, and the companion's one-turn
   * instruction come through there, and an agent that captured the object that
   * was there when it was built would go on answering from a stale one. That is
   * not hypothetical: the runner cache means one agent outlives many turns, and a
   * pet's "answer briefly" that never left is that bug.
   *
   * A helper reads its own. It is built *during* the parent's turn, when the live
   * configuration is by definition the parent's, and taking that would give it the
   * lead's identity under its own name — the one thing that would make the
   * transcript's attribution a lie.
   */
  private configFor(own: AgentConfig, live: boolean): AgentConfig {
    return live ? (this.active?.config ?? this.config) : own;
  }

  /**
   * A runner over this host's session service, for one agent.
   *
   * Never cached: the cache above belongs to the conversation's own agent, and a
   * helper is built afresh per call. A helper's runner is used by exactly one
   * invocation — the one that resolves it — so there is nothing to share, and a
   * cache keyed on a caller-supplied name would be a cache two agents could
   * collide in.
   */
  private buildRunner(request: {
    config: AgentConfig;
    author: string;
    description: string;
  }): Runner {
    return new Runner({
      appName: this.appName,
      agent: this.buildAgent(
        request.config,
        request.author,
        request.description,
      ),
      sessionService: this.sessionService,
      /*
       * One plugin or the other, never both.
       *
       * Two plugins both deciding whether a call may proceed would be two answers
       * to one question, and the first to return a value short-circuits the rest
       * — so which won would depend on registration order rather than on anything
       * anybody chose. With Dream-RSI off the runner gets exactly the plugin it
       * has always had, which is what makes "off" mean the code that ran before
       * this feature existed.
       */
      plugins: [
        this.dreamEnabled()
          ? new DreamToolPlugin({
              /*
               * Built on demand, at the first callback of the turn, rather than
               * waited for: a model request happens before the host's event loop
               * has seen anything, so a recorder created there is a recorder
               * created too late to see the turn's first step. `openRecorder`
               * dedupes by invocation id, so the event loop's own call below is
               * a fallback rather than a second tree.
               */
              openRecorder: ({invocationId, sessionId}) => {
                const profile = this.treeProfile();
                return this.openRecorder({
                  sessionId,
                  invocationId,
                  ...(profile === undefined ? {} : {profileId: profile}),
                });
              },
              // Read per turn rather than captured: a user who moves the slider
              // while the agent is thinking gets the new weight on the next turn.
              settings: () => ({
                explorationWeight:
                  this.config.dream?.explorationWeight ??
                  DEFAULT_DREAM_EXPLORATION_WEIGHT,
                pruningThreshold:
                  this.config.dream?.pruningThreshold ??
                  DEFAULT_DREAM_PRUNING_THRESHOLD,
              }),
            })
          : new RepeatedToolCallPlugin(),
      ],
    });
  }

  /**
   * Whether this turn is being recorded and its search controlled.
   *
   * Both halves have to be present: the config says the user asked for the
   * feature, and the sink says somebody is willing to store the result. A host
   * built without a sink — every test, and the placeholder host the runtime makes
   * before it has read a folder — therefore records nothing even if it is handed
   * a config that asks for it, which is the direction a mistake should fall in.
   */
  private dreamEnabled(): boolean {
    return this.config.dream !== undefined && this.options.dreamSink !== undefined;
  }

  /**
   * Starts a tree for one invocation, or answers nothing when the feature is off.
   *
   * Registered in a map keyed by invocation id because that is the only name a
   * plugin callback is given: ADK hands a plugin a `Context`, and a `Context`
   * knows its invocation and not this host. The entry is removed when the turn
   * ends — see {@link closeRecorder} — so a long-lived window does not accumulate
   * one tree per turn it has ever run.
   */
  /**
   * Which agent the turn in flight belongs to, for filing its tree.
   *
   * The order is the order of certainty. The agent the turn is running *as* comes
   * first, because a group chat is recorded under the agent that did the work
   * rather than under the one that owns the chat; then the turn's own profile,
   * which is what a conversation is filed under; and the config last, for a caller
   * that ran a turn without naming one — the approve path, where the host was
   * built for exactly one profile anyway.
   */
  private treeProfile(): string | undefined {
    return (
      this.active?.author ??
      this.active?.profileId ??
      this.config.profileId
    );
  }

  private openRecorder(context: {
    sessionId: string;
    invocationId: string;
    profileId?: string;
  }): TreeRecorder | undefined {
    const sink = this.options.dreamSink;
    const policy = this.config.dream;
    if (sink === undefined || policy === undefined) {
      return undefined;
    }

    /*
     * One tree per invocation, whichever path asks first.
     *
     * Two things call this for the same turn: the plugin, at the turn's first
     * model request, and the host's own event loop, at the first event. They
     * race by construction — the request happens first — and returning a second
     * recorder would mean two trees for one turn, each seeing half of it, with
     * the store keyed by invocation id replacing one with the other. The first
     * caller wins, and it is the only caller that can exist.
     */
    const existing = this.dreamRecorders.get(context.invocationId);
    if (existing !== undefined) {
      return existing;
    }

    const recorder = new TreeRecorder(
      {
        sessionId: context.sessionId,
        invocationId: context.invocationId,
        ...(context.profileId === undefined
          ? {}
          : {profileId: context.profileId}),
        policy,
      },
      sink,
      {
        resultBytes:
          this.options.dreamResultBytes ?? DEFAULT_DREAM_RESULT_BYTES,
      },
    );
    this.dreamRecorders.set(context.invocationId, recorder);
    return recorder;
  }

  /** Forgets a finished turn's tree, so the map holds only what is running. */
  private closeRecorder(recorder: TreeRecorder): void {
    for (const [invocationId, known] of this.dreamRecorders) {
      if (known === recorder) {
        this.dreamRecorders.delete(invocationId);
      }
    }
  }

  private async *drive(
    sessionId: string,
    newMessage: Content,
    profileId?: string,
    as?: {agentId: string; config: AgentConfig},
  ): AsyncGenerator<AgentUiEvent> {
    const messageId = randomUUID();

    // A gap here is refused as a failed turn rather than thrown, because a
    // generator that throws mid-stream is harder for the window to report.
    const ownership = await this.ownershipProblem(sessionId, profileId);
    if (ownership) {
      yield {type: 'turn.failed', sessionId, messageId, message: ownership};
      return;
    }
    if (this.active) {
      yield {
        type: 'turn.failed',
        sessionId,
        messageId,
        message: 'A turn is already running. Wait for it to finish or stop it.',
      };
      return;
    }
    const model = this.config.model;
    /*
     * The agent answering: the addressed one when the user named a participant,
     * and the host's own configuration otherwise. `as.agentId` is the ADK name as
     * well as the contract's id — a helper is built under the profile it was
     * resolved from — which is what makes the reply's events attributable without
     * a second mapping anybody could get wrong.
     */
    const runner = this.runnerFor(
      model,
      as === undefined ? MAIN_AGENT_NAME : agentNameFor(as.agentId),
    );

    const controller = new AbortController();
    this.active = {
      sessionId,
      ...(profileId === undefined ? {} : {profileId}),
      controller,
      ...(as === undefined
        ? {}
        : {config: as.config, author: agentNameFor(as.agentId)}),
    };
    /*
     * A turn is where a round begins, and starting one abandons whatever the
     * last turn was waiting on: the user asked something else, or stopped the
     * paused turn. The gates of this turn are collected as they are yielded.
     */
    this.gateRound = {
      sessionId,
      gates: new Set<string>(),
      decisions: new Map(),
    };
    /*
     * And the delegation budget, which is a budget of *this* turn. The tools are
     * cached with the runners that carry them, so a count kept inside one would
     * otherwise still be sitting at its limit on the user's next message — a
     * refusal they would have no way to understand.
     */
    this.resetDelegations();
    yield {type: 'turn.started', sessionId, messageId};

    let streamedText = '';
    let streamedReasoning = '';
    let usage: TokenUsage | undefined;
    let failure: {code?: string; message: string} | undefined;
    /** Whether this turn completed with nothing at all the user could see. */
    let silent = false;
    /** The reply a silent turn was rescued with, when the model supplied one. */
    let recovered: string | undefined;
    /*
     * Every event of a turn carries the invocation that produced it, and the
     * recovery below stamps the message it writes with the same one: an event
     * with a different invocation id reads to `pendingGatesIn` as a new turn,
     * and a new turn abandons the gates of this one.
     */
    let invocationId = '';

    /*
     * The turn's discovery tree, when the user has Dream-RSI on.
     *
     * Built here rather than in the plugin because the plugin is constructed once
     * per model while a recorder belongs to one turn, and because *this* is where
     * the session and the profile are known — a tree is filed under the
     * conversation it belongs to. The plugin finds it by invocation id, which is
     * the only name ADK hands a callback.
     *
     * `undefined` when the feature is off, and every use below is guarded by the
     * plugin rather than by this: the recorder is registered so a callback can
     * reach it, and a turn with no recorder is a turn whose plugin is the
     * repeat-only one, which never asks.
     */
    let dream: TreeRecorder | undefined;
    /*
     * Which agent the tree is filed under.
     *
     * The turn's own answer when it has one, because a conversation belongs to
     * the profile that ran the turn rather than to whatever the host was last
     * configured with; the config is the fallback for a caller that ran a turn
     * without naming a profile. Read here rather than where the recorder is made
     * because the plugin makes it first, and the plugin reads the same two
     * places — see the factory in `runnerFor`.
     */
    const treeProfile =
      profileId ?? this.active?.author ?? this.config.profileId;

    try {
      const events = runner.runAsync({
        userId: this.userId,
        sessionId,
        newMessage,
        abortSignal: controller.signal,
        // SSE is what makes the model reply token by token, and it is also what
        // makes ADK hand the provider `stream: true`.
        runConfig: {streamingMode: StreamingMode.SSE},
      });

      for await (const event of events) {
        if (event.invocationId && invocationId.length === 0) {
          /*
           * The first event of a turn is what names it, and the assignment is
           * deliberately once-only.
           *
           * A turn is one invocation, so every event carries the same id — which
           * is why this *could* be written as a plain assignment. It is not,
           * because the two things keyed by this id are the transcript's
           * invocation stamp and the recorder map, and a turn whose events ever
           * disagreed would then leave a recorder registered under an id nothing
           * would ever close. Binding the identity at the first event means the
           * tree is opened once and closed once whatever arrives after it.
           *
           * The recorder is usually already here by now: the turn's first model
           * request made it — see the plugin's `openRecorder` — and this call
           * then returns that one rather than building a second. It remains the
           * backstop, because a turn that somehow reaches an event without a
           * request would otherwise record nothing at all.
           */
          invocationId = event.invocationId;
          dream = this.openRecorder({
            sessionId,
            invocationId,
            ...(treeProfile === undefined ? {} : {profileId: treeProfile}),
          });
        }
        for (const part of event.content?.parts ?? []) {
          // A thought part is the model's reasoning, not its answer. It is
          // streamed into the collapsible reasoning block and persisted with the
          // turn so the next request can echo it back.
          if (part.thought === true) {
            if (typeof part.text === 'string' && part.text.length > 0) {
              if (event.partial === true) {
                streamedReasoning += part.text;
                yield {
                  type: 'reasoning.delta',
                  sessionId,
                  messageId,
                  text: part.text,
                };
              } else if (streamedReasoning.length === 0) {
                streamedReasoning = part.text;
                yield {
                  type: 'reasoning.delta',
                  sessionId,
                  messageId,
                  text: part.text,
                };
              }
            }
            continue;
          }

          if (typeof part.text === 'string' && part.text.length > 0) {
            if (event.partial === true) {
              streamedText += part.text;
              yield {
                type: 'text.delta',
                sessionId,
                messageId,
                text: part.text,
              };
            } else if (streamedText.length === 0) {
              // Non-streaming path: the aggregated event is the only copy of
              // the text, so surface it as one delta.
              streamedText = part.text;
              yield {
                type: 'text.delta',
                sessionId,
                messageId,
                text: part.text,
              };
            }
          }

          const call = part.functionCall;
          if (call) {
            if (call.name === REQUEST_CONFIRMATION_FUNCTION_CALL_NAME) {
              const gate = readGate(call.args);
              // Every gate ADK asks about in this turn belongs to one round, so
              // the answer is sent as one message once they have all been
              // decided. A gate with no id cannot be answered at all, and is
              // left out rather than blocking the round on a decision the
              // window has no card to collect.
              if (call.id) {
                this.gateRound?.gates.add(call.id);
              }
              yield {
                type: 'approval.request',
                sessionId,
                messageId,
                callId: call.id ?? '',
                tool: gate.tool,
                args: gate.args,
                hint: gate.hint,
              };
            } else {
              yield {
                type: 'tool.started',
                sessionId,
                messageId,
                callId: call.id ?? '',
                tool: call.name ?? 'unknown',
                args: call.args ?? {},
              };
            }
          }

          const response = part.functionResponse;
          if (
            response &&
            response.name !== REQUEST_CONFIRMATION_FUNCTION_CALL_NAME &&
            !isConfirmationRefusal(response.response)
          ) {
            yield {
              type: 'tool.finished',
              sessionId,
              messageId,
              callId: response.id ?? '',
              tool: response.name ?? 'unknown',
              ok: !hasError(response.response),
              result: describeToolResult(response.response),
            };
          }
        }

        usage = readUsage(event) ?? usage;

        if (event.errorCode || event.errorMessage) {
          failure = {
            code: event.errorCode,
            message: event.errorMessage ?? 'The model reported an error.',
          };
        }
      }

      /*
       * A completed turn that said nothing. This is the failure the user
       * reported: a small model puts its whole reply in the reasoning channel
       * and emits no content and no tool call, ADK ends the turn there, and
       * every layer above treats "no answer" as a successful turn — so the
       * window draws an empty bubble and the user is left waiting for something
       * that will never arrive. Whitespace counts as nothing: a bubble holding a
       * space is the same silence to the person looking at it.
       *
       * A turn that raised an approval card is excluded: it is not silent, it is
       * waiting, and the card is what the user is meant to look at.
       *
       * Done here, inside the turn, rather than after the `finally` below —
       * `this.active` is the one-turn-at-a-time lock, and a recovery that
       * released it first would let a scheduled job start a conversation turn
       * while this one was still writing to the same session.
       */
      if (
        !controller.signal.aborted &&
        failure === undefined &&
        streamedText.trim().length === 0 &&
        this.raisedNoGate()
      ) {
        silent = true;
        recovered = await this.recoverSilentTurn({
          sessionId,
          invocationId,
          userText: userTextOf(newMessage),
          reasoning: streamedReasoning,
          abortSignal: controller.signal,
        });
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        failure = {message: describeError(error)};
      }
    } finally {
      this.active = undefined;
      /*
       * The tree is closed here rather than with the events below, and the
       * ordering is the point: `finally` runs on every path out of the try,
       * including the one where the recovery above threw. A recorder left open
       * would keep an entry in the map and a tree whose outcome says `'open'`
       * forever — and an unfinished turn is exactly the turn somebody would want
       * to replay.
       *
       * The outcome is derived from the same three facts the events below are
       * derived from, so the log and the window cannot disagree about how a turn
       * ended.
       */
      dream?.finish(
        controller.signal.aborted
          ? 'aborted'
          : failure !== undefined
            ? 'failed'
            : 'answered',
      );
      if (dream !== undefined) {
        this.closeRecorder(dream);
      }
    }

    if (controller.signal.aborted) {
      yield {type: 'turn.aborted', sessionId, messageId};
    } else if (failure) {
      yield {
        type: 'turn.failed',
        sessionId,
        messageId,
        code: failure.code,
        message: failure.message,
      };
    } else if (recovered !== undefined) {
      yield {type: 'text.delta', sessionId, messageId, text: recovered};
      yield {type: 'turn.completed', sessionId, messageId, usage};
    } else if (silent) {
      /*
       * Reported as a failed turn rather than as words the model never said.
       * The alternative — writing a sentence into the transcript and letting it
       * read as the agent's reply — is the one thing this app's own rules
       * forbid: never claim something happened that did not.
       */
      yield {
        type: 'turn.failed',
        sessionId,
        messageId,
        message: SILENT_TURN_MESSAGE,
      };
    } else {
      yield {type: 'turn.completed', sessionId, messageId, usage};
    }
    yield {type: 'session.changed', sessionId};
  }

  /** Whether this turn paused on an approval card rather than going quiet. */
  private raisedNoGate(): boolean {
    return (this.gateRound?.gates.size ?? 0) === 0;
  }

  /**
   * Asks the model once more for the answer it thought instead of said.
   *
   * The model's reasoning is handed back to it rather than thrown away, and that
   * is the whole trick: in the observed failure the reasoning ended with the
   * decision to ask the user which recipe they wanted — the answer existed and
   * was simply never emitted. Asking a second time with that reasoning in view
   * recovers it, and a fresh request is cheap next to the turn that was already
   * spent.
   *
   * The recovered words are *stored*, not merely streamed, because the window
   * re-reads the transcript the moment the turn completes — a message that was
   * only streamed would vanish on the reload that follows it. Written as an
   * ordinary model event under this turn's invocation id, it is what the next
   * turn replays as the agent's own last message, which is exactly what it is.
   *
   * Returns `undefined` when there is nothing to show: the caller then reports a
   * failed turn. A model that produces reasoning-only twice in a row is a real
   * signal, and dressing it up as an answer would hide it.
   */
  private async recoverSilentTurn(params: {
    sessionId: string;
    invocationId: string;
    userText: string;
    reasoning: string;
    abortSignal: AbortSignal;
  }): Promise<string | undefined> {
    let answer = '';
    try {
      answer = (
        await this.oneShot(
          silentTurnPrompt(params.userText, params.reasoning),
          /*
           * The agent that produced the silence answers for it. This runs inside
           * the turn, where `this.config` is already the answering agent's — the
           * addressed one, when the user named a participant — so the recovery is
           * the same model as the turn it is rescuing rather than the lead's.
           */
          this.config,
          params.abortSignal,
        )
      ).trim();
    } catch {
      // A failed recovery is not a failed turn of its own: the turn is already
      // over, and all that is left to decide is what the user is told.
      return undefined;
    }
    if (answer.length === 0) {
      return undefined;
    }

    const session = await this.sessionService.getSession({
      appName: this.appName,
      userId: this.userId,
      sessionId: params.sessionId,
    });
    if (session === undefined) {
      return undefined;
    }
    await this.sessionService.appendEvent({
      session,
      event: createEvent({
        author: MAIN_AGENT_NAME,
        invocationId: params.invocationId,
        content: {role: 'model', parts: [{text: answer}]},
        timestamp: Date.now(),
      }),
    });
    return answer;
  }
}

function toSummary(entry: {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  workspaceId?: string;
  source?: SessionSource;
  purpose?: SessionPurpose;
  model?: AgentModel;
  agentIds?: string[];
}): SessionSummary {
  return {
    id: entry.id,
    title: entry.title,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    messageCount: entry.messageCount,
    ...(entry.workspaceId ? {workspaceId: entry.workspaceId} : {}),
    ...(entry.source ? {source: entry.source} : {}),
    ...(entry.purpose ? {purpose: entry.purpose} : {}),
    ...(entry.model ? {model: entry.model} : {}),
    /*
     * Carried only when there is more than one, so a chat with one agent reports
     * exactly what every conversation did before this field existed. Absent is
     * the contract's word for "just the owner", and an array holding only the
     * owner would be a second way to say it.
     */
    ...(entry.agentIds !== undefined && entry.agentIds.length > 1
      ? {agentIds: entry.agentIds}
      : {}),
  };
}

/**
 * Compares two optional name lists by content.
 *
 * A profile's tool and skill selections arrive as a fresh array on every config
 * update, so an identity comparison would see a change on every keystroke in
 * Settings and abort a running turn for nothing.
 */
function sameList(
  left: string[] | undefined,
  right: string[] | undefined,
): boolean {
  if (left === undefined || right === undefined) {
    return left === right;
  }
  if (left.length !== right.length) {
    return false;
  }
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.every((entry, index) => entry === sortedRight[index]);
}

/**
 * Whether two Dream-RSI configurations are the same.
 *
 * Three states rather than two, and the third is the one that matters: absent
 * means off, and `undefined` against a config is a *change* — the user switching
 * the feature on or off — while two configs with the same two weights are not.
 * Comparing only the fields would make switching the feature on look like no
 * change at all, because there is nothing there to compare against.
 */
function sameDream(
  left: DreamConfig | undefined,
  right: DreamConfig | undefined,
): boolean {
  if (left === undefined || right === undefined) {
    return left === right;
  }
  return (
    left.explorationWeight === right.explorationWeight &&
    left.pruningThreshold === right.pruningThreshold
  );
}

function readUsage(event: AdkEvent): TokenUsage | undefined {
  const usage = event.usageMetadata;
  if (!usage) {
    return undefined;
  }
  return {
    promptTokens: usage.promptTokenCount ?? 0,
    completionTokens: usage.candidatesTokenCount ?? 0,
    totalTokens:
      usage.totalTokenCount ??
      (usage.promptTokenCount ?? 0) + (usage.candidatesTokenCount ?? 0),
  };
}

function confirmationResponse(callId: string, decision: GateDecision): Part {
  return {
    functionResponse: {
      id: callId,
      name: REQUEST_CONFIRMATION_FUNCTION_CALL_NAME,
      response: {
        confirmed: decision.confirmed,
        ...(decision.payload !== undefined ? {payload: decision.payload} : {}),
      },
    },
  };
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as {cause?: unknown}).cause;
    if (cause instanceof Error && cause.message) {
      return `${error.message} (${cause.message})`;
    }
    return error.message;
  }
  return String(error);
}

/**
 * What the user is told when a turn had nothing to say and could not be rescued.
 *
 * Deliberately not phrased as the agent's reply. It goes out as `turn.failed`
 * and is drawn where every other failure is, because a sentence in the
 * transcript would read as the model having answered, and it did not.
 */
const SILENT_TURN_MESSAGE =
  'The model returned only reasoning and no reply, and a second attempt came ' +
  'back empty too. Try again, or rephrase the request.';

/** How much of a silent turn's reasoning is handed back to the model. */
const MAX_REASONING_ECHO_CHARS = 4_000;

/** The text the user sent this turn, for a turn that has any. */
function userTextOf(content: Content): string {
  return (content.parts ?? [])
    .map((part) => (typeof part.text === 'string' ? part.text : ''))
    .join('')
    .trim();
}

/**
 * The prompt that turns reasoning-only output into an answer.
 *
 * It states the problem plainly and then hands back the two things the model
 * needs to answer from: what the user asked, and what it had already worked out.
 * The reasoning is taken from its tail, because the decision the model failed to
 * voice is at the end of it — the opening of a small model's reasoning is
 * restating the question, which is worth nothing here.
 *
 * The last line matters more than it looks. Without it a small model tends to
 * answer by narrating the recovery ("I see my previous response had no
 * content…"), which is a worse reply than the silence it replaced.
 */
function silentTurnPrompt(userText: string, reasoning: string): string {
  const sections = [
    'Your previous reply to the user contained only private reasoning and no ' +
      'message, so the user saw nothing at all.',
  ];

  if (userText.length > 0) {
    sections.push(`The user's message was:\n"""\n${userText}\n"""`);
  }

  const tail = reasoning.slice(-MAX_REASONING_ECHO_CHARS);
  if (tail.length > 0) {
    sections.push(`What you had worked out:\n"""\n${tail}\n"""`);
  }

  sections.push(
    'Write the reply the user should have received, in your own voice, as plain ' +
      'text. Do not call any tools. If you had decided to ask the user ' +
      'something, ask it now. Do not refer to this instruction, and do not ' +
      'mention that anything went wrong — just answer.',
  );

  return sections.join('\n\n');
}
