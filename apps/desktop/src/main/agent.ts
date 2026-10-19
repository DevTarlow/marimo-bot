/**
 * The agent, running in this process.
 *
 * Everything the window can ask an agent to do goes through here: list the
 * agents, list and open conversations, send a message, answer a card, stop a
 * turn. The agent itself lives in `@marimo/runtime`, which is Electron-free and
 * is the same class the headless job runner hosts — this file is the part that
 * is specific to being inside Electron, which is three things:
 *
 * - **Where secrets come from.** Provider keys are decrypted with `safeStorage`,
 *   which only exists here. The runner passes the plain-text reader instead.
 * - **Where web search comes from.** `web_search` needs a browser engine, and
 *   Electron ships one; without it the tool is simply not offered, which is why
 *   this is allowed to be absent.
 * - **Where events go.** A turn is a stream, and this process turns it into
 *   broadcasts the window listens for.
 */
import {
  AgentRuntime,
  mcpSecretFile,
  createJobRunner,
  holdProcessLock,
  JobScheduler,
  JobStore,
  McpManager,
  secretReaderFor,
  turnInstruction,
  BOT_BUILDER_INSTRUCTION,
} from '@marimo/runtime';
import type {ProcessLock} from '@marimo/runtime';
import type {
  AppPaths,
  DocumentService,
  EmbeddingPart,
  MediaKind,
  SecretRead,
} from '@marimo/runtime';

import {PROVIDERS, PROVIDER_IDS} from '@marimo/protocol';
import type {
  AgentModel,
  AgentProfile,
  AgentUiEvent,
  BotDraft,
  CompactResult,
  DocumentRead,
  DocumentRevision,
  DocumentWrite,
  HarnessReport,
  Job,
  McpServer,
  McpStatus,
  PendingGate,
  ProfileCatalog,
  ProviderId,
  ProviderKeyStorage,
  RecallModelStatus,
  RecallPiece,
  RecallQueryResult,
  RecallScopeName,
  SessionSummary,
  SessionUsage,
  SkillDraft,
  SkillHistoryEntry,
  StoredSkill,
  TranscriptMessage,
  Workspace,
  WorkspaceState,
} from '@marimo/protocol';
import {fetchProviderModels} from '@marimo/agent';
import type {JobService} from '@marimo/agent';

import {providerSecretStore, secretStore} from './secrets.js';
import {BrowserSearchProvider} from './search/search-window.js';
import {RecallHost} from './recall.js';
import {MediaDecodingWindow} from './media/decode-window.js';
import {mediaParts} from './media/parts.js';
import {MCP_CLIENT} from '../shared/product.js';

/**
 * How often a dropped MCP server is considered for a reconnect.
 *
 * Not a retry interval — the manager keeps its own backoff and will not dial a
 * server that is inside it. This is only how often it is *asked*, so it can be
 * lazy without a server sitting dead for want of a nudge.
 */
const MCP_RECONCILE_MS = 30_000;

/**
 * How long a conversation has to be quiet before it is read back.
 *
 * A minute. Long enough that a pause for thought is not the end of a
 * conversation, short enough that the user sees the suggestion while they still
 * remember what it is about.
 */
const IDLE_REVIEW_MS = 60_000;

/**
 * How long to wait when the conversation has not gone quiet but has piled up.
 *
 * Ten seconds rather than zero, and the reason is the model rather than the user:
 * a review is a second request, and firing one the instant a turn ends puts it in
 * front of the chat model on a local install — for a turn whose answer the user
 * is still watching arrive. Ten seconds lets a natural pause happen first, and is
 * short enough that a fact stated early in a long conversation is remembered
 * while the conversation is still about it.
 */
const BUSY_REVIEW_MS = 10_000;

/**
 * How often to look again when a background run owns the jobs.
 *
 * A run is seconds to a minute, so this is quick enough that the app takes over
 * promptly and slow enough not to spin.
 */
const LOCK_RETRY_MS = 5_000;

export interface AgentServiceOptions {
  paths: AppPaths;
  /** Where a turn's events are sent. */
  sendEvent: (event: AgentUiEvent) => void;
}

export class AgentService {
  private readonly runtime: AgentRuntime;
  private readonly mcp: McpManager;
  /**
   * Keyless web search, through a hidden window.
   *
   * A plain `fetch` cannot search any more — DuckDuckGo answers a scripted
   * challenge and Mojeek refuses outright — so the search runs in a browser
   * engine, and Electron already ships one. Owned here rather than made per
   * call: it is a window, and a window per search would be a window per search.
   */
  private readonly search = new BrowserSearchProvider();
  /**
   * Scheduled jobs, and the clock that runs them.
   *
   * Owned here so a job is an ordinary turn: it is answered by the agent that
   * owns it, in that agent's conversation, with that agent's tools — and it
   * asks for approval the same way, which is why an unattended run can park on a
   * gate rather than going ahead without one.
   */
  private readonly jobsStore: JobStore;
  private readonly scheduler: JobScheduler;
  /**
   * The engine that finds things by meaning, and the indexes behind it.
   *
   * Owned here rather than by the runtime, because starting a process is not
   * something the shared package does. It is constructed unconditionally and does
   * nothing until the setting is on — an object that waits, rather than a second
   * code path for the installs that have it.
   */
  private readonly recall: RecallHost;
  /**
   * The hidden window that decodes media, when the projector is installed.
   *
   * Built unconditionally for the reason the recall engine is: nothing happens
   * until a media file is actually decoded, and a second code path for installs
   * that have the projector would be the one nobody tests. Starting a process is
   * not something `@marimo/runtime` does, which is why this lives here.
   */
  private readonly media: MediaDecodingWindow;
  /** Held for as long as this process is: "the app is running the jobs". */
  private appLock: ProcessLock | undefined;
  private reconcile: NodeJS.Timeout | undefined;
  /** Waiting for a background run to finish so this process can own the jobs. */
  private lockTimer: NodeJS.Timeout | undefined;
  /** The pending idle look, reset by each new turn. */
  private idleReview: NodeJS.Timeout | undefined;
  /** The v2 review timers, one per conversation waiting to be read back. */
  private readonly harnessReviews = new Map<string, NodeJS.Timeout>();
  /** Which agent the turn in flight belongs to, for the review that follows. */
  private busyProfileId: string | undefined;
  private stopped = false;

  constructor(private readonly options: AgentServiceOptions) {
    const {paths} = options;

    this.media = new MediaDecodingWindow();

    this.recall = new RecallHost({
      ...this.options.paths,
      readSettings: async () => await this.runtime.settings(),
      /*
       * The conversations corpus, read through the runtime rather than a second
       * session store: the listing is the sidebar's own list and the events are
       * the host's, so a chat the window cannot show is a chat the index cannot
       * see either. Called lazily by the indexer, which is why closing over
       * `this.runtime` before it exists is safe.
       */
      listConversations: async (profileId) => {
        const harness = this.runtime.harness();
        const sessions = await this.runtime.listSessions(profileId);
        return await Promise.all(
          sessions.map(async (session) => {
            if (!(await harness.hasLog(session.id))) {
              return {
                sessionId: session.id,
                title: session.title,
                eventCount: session.messageCount,
              };
            }
            try {
              const conversation = await harness.conversationFor(
                profileId,
                session.id,
              );
              return {
                sessionId: session.id,
                title: conversation.title || session.title,
                eventCount: conversation.events.length,
              };
            } catch {
              return {
                sessionId: session.id,
                title: session.title,
                eventCount: session.messageCount,
              };
            }
          }),
        );
      },
      readConversation: async (profileId, sessionId) =>
        await this.runtime.conversationFor(profileId, sessionId),
      decodeMedia: async (path, kind) => await this.decodeMedia(path, kind),
      onProgress: (progress) => {
        options.sendEvent({
          type: 'recall.progress',
          piece: progress.piece,
          label: progress.label,
          receivedBytes: progress.receivedBytes,
          totalBytes: progress.totalBytes,
          ...(progress.percent === undefined
            ? {}
            : {percent: progress.percent}),
        });
      },
      onInstalled: (piece) => {
        options.sendEvent({type: 'recall.installed', piece});
      },
      onFailed: (message) => {
        options.sendEvent({type: 'recall.failed', message});
      },
      onIndexed: (counts) => {
        options.sendEvent({type: 'recall.indexed', ...counts});
      },
    });

    this.mcp = new McpManager({
      readSecrets: secretReaderFor(paths, (file, label) =>
        secretStore(file, label),
      ),
      clientName: MCP_CLIENT.name,
      clientVersion: MCP_CLIENT.version,
      // The window redraws a badge from this. It is one field, so it travels
      // whole rather than as a diff the renderer would have to reconcile.
      onStatus: (serverId, status) => {
        options.sendEvent({
          type: 'mcp.status',
          serverId,
          status,
        } as AgentUiEvent);
      },
    });

    this.runtime = new AgentRuntime({
      paths,
      webSearch: this.search,
      /*
       * Which provider answers, and the key it answers with. The cipher is the
       * only part of this the shared package cannot have: it exists in Electron
       * and nowhere else, which is why the reader is a function it is given.
       */
      readSecret: async (provider) => await this.readSecret(provider),
      recall: {
        stop: async () => {
          await this.recall.stop();
        },
      },
      mcpServers: () => this.mcp.toolsets(),
      /*
       * Both services, resolved per profile and folder. Recall answers
       * `undefined` when the setting is off, which is how the capability becomes
       * absent rather than discouraged.
       */
      services: async (profileId, workspaceRoot) => ({
        jobService: this.jobService(),
        ...(await this.recallServiceFor(profileId, workspaceRoot)),
      }),
      /*
       * A helper agent's words, while the turn that asked for it is still
       * awaiting the tool call. The same channel the MCP status events use, for
       * the same reason: a tool call cannot yield into the stream awaiting it,
       * and a helper that says nothing until it finishes is a turn that looks
       * hung.
       */
      onEvent: (event) => {
        options.sendEvent(event);
      },
    });

    this.jobsStore = new JobStore({file: paths.jobs});
    this.scheduler = new JobScheduler({
      store: this.jobsStore,
      runner: createJobRunner({
        runtime: this.runtime,
        harness: this.runtime.harness(),
        jobs: this.jobsStore,
        onEvent: (event) => {
          options.sendEvent(event);
        },
      }),
      onChange: (jobId) => {
        options.sendEvent({type: 'job.changed', jobId});
      },
    });
  }

  /**
   * The job tools, over the same store the scheduler runs from.
   *
   * One store, so a job the agent creates is a job that runs: a second copy of
   * the document would leave the model describing a schedule that the clock had
   * never heard of.
   *
   * Every mutation calls `sync`, which is what tells the scheduler to look now
   * rather than at its next idle tick. A job asked for in a conversation should
   * appear on the clock immediately, not up to thirty seconds later.
   */
  private jobService(): JobService {
    const owns = async (jobId: string, profileId: string): Promise<boolean> => {
      const document = await this.jobsStore.load();
      return document.jobs.some(
        (job) => job.id === jobId && job.profileId === profileId,
      );
    };

    return {
      list: async (profileId) => {
        const document = await this.jobsStore.load();
        return document.jobs.filter((job) => job.profileId === profileId);
      },

      create: async (input) => {
        const {job} = await this.jobsStore.create(input);
        this.scheduler.sync();
        return job;
      },

      /*
       * Ownership is checked rather than assumed. The agent names a job id from
       * its own conversation, and a stale one — or one belonging to another
       * agent — must not be editable through it: the id is the only thing tying
       * the request to a document.
       */
      update: async (jobId, patch, profileId) => {
        if (!(await owns(jobId, profileId))) {
          return null;
        }
        const job = await this.jobsStore.update(jobId, patch);
        if (job !== null) {
          this.scheduler.sync();
        }
        return job;
      },

      remove: async (jobId, profileId) => {
        if (!(await owns(jobId, profileId))) {
          return false;
        }
        const removed = await this.jobsStore.remove(jobId);
        if (removed) {
          this.scheduler.sync();
        }
        return removed;
      },
    };
  }

  /** The settings as they are on disk, for the callers that need to read them. */
  async settings() {
    return await this.runtime.settings();
  }

  /**
   * The last discovery-log write that failed, or nothing.
   *
   * Read by the settings payload the Dream-RSI card is drawn from. A card that
   * says "recording" while every write is failing is worse than no card at all,
   * and this is the only place that knows.
   */
  dreamProblem(): string | undefined {
    return this.runtime.dreamProblem();
  }

  async start(): Promise<void> {
    await this.applyMcpServers();
    await this.claimJobs();
    this.reconcile = setInterval(() => {
      void this.mcp.reconcile();
    }, MCP_RECONCILE_MS);
    // A timer must not be the reason the process stays alive: the app decides
    // when it quits, and an interval holding the loop open would turn a quit
    // into a hang.
    this.reconcile.unref?.();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconcile !== undefined) {
      clearInterval(this.reconcile);
      this.reconcile = undefined;
    }
    this.lockTimer = this.clearTimer(this.lockTimer);
    this.idleReview = this.clearIdle(this.idleReview);
    for (const handle of this.harnessReviews.values()) {
      clearTimeout(handle);
    }
    this.harnessReviews.clear();
    this.scheduler.stop();
    await this.appLock?.release();
    this.appLock = undefined;
    await this.mcp.stop();
    // Stops the recall engine too, through the runner the runtime was given: a
    // child still loading weights when its parent exits is memory and a spinning
    // fan with no window left to explain it.
    await this.runtime.dispose();
    this.search.dispose();
    this.media.dispose();
  }

  /**
   * The service this profile and folder should be given, or nothing.
   *
   * A method rather than a call at the construction site: the runtime asks per
   * turn, and what it must get back is the *same object* for the same profile and
   * folder — a new one would invalidate the agent's cached runner on every
   * message, which is the rule the runtime's own interface documents.
   */
  private async recallServiceFor(
    profileId: string,
    workspaceRoot?: string,
  ): Promise<{recallService?: Awaited<ReturnType<RecallHost['serviceFor']>>}> {
    const service = await this.recall.serviceFor(profileId, workspaceRoot);
    return service === undefined ? {} : {recallService: service};
  }

  /**
   * One media file, as the content parts the embedding client takes.
   *
   * The decode and the translation are separate steps because only the first
   * needs a browser engine: a picture is bytes read here, and the parts builder
   * is a plain function with a test that proves the task prefix never appears in
   * front of one.
   */
  private async decodeMedia(
    path: string,
    kind: MediaKind,
  ): Promise<EmbeddingPart[]> {
    return mediaParts(path, await this.media.decode(path, kind));
  }

  /**
   * What recall is doing, for the card and for a search box.
   *
   * Resolved against the *active* profile and folder rather than a conversation's:
   * the card is about the install, and a search box that indexed one folder while
   * the rail showed another would answer about the wrong one.
   */
  async recallStatus(): Promise<RecallModelStatus> {
    const scope = await this.recallScope();
    return await this.recall.status(scope.profileId, scope.workspaceRoot);
  }

  async recallInstall(piece: RecallPiece): Promise<{started: boolean}> {
    return this.recall.install(piece);
  }

  recallCancel(): {cancelled: boolean} {
    return this.recall.cancel();
  }

  async recallReindex(): Promise<{started: boolean}> {
    const scope = await this.recallScope();
    await this.recall.reindex(scope.profileId, scope.workspaceRoot);
    return {started: true};
  }

  async recallForget(): Promise<{forgotten: boolean}> {
    const scope = await this.recallScope();
    return await this.recall.forget(scope.profileId, scope.workspaceRoot);
  }

  /**
   * The window's own search.
   *
   * The same `RecallService` the agent's tool is given, so what a person sees and
   * what the model finds cannot disagree — and deliberately not routed through a
   * turn: searching your own files should not need a conversation, a model, or an
   * answer to be streaming.
   */
  async recallQuery(
    query: string,
    scopes?: readonly RecallScopeName[],
    limit?: number,
    minScore?: number,
  ): Promise<RecallQueryResult> {
    const empty = {
      records: 0,
      chunks: 0,
      memory: 0,
      conversations: 0,
      media: 0,
      changed: 0,
    };
    const settings = await this.runtime.settings();
    if (!settings.recall.enabled) {
      return {hits: [], searched: [], notes: ['Recall is off.'], index: empty};
    }
    const scope = await this.recallScope();
    const service = await this.recall.serviceFor(
      scope.profileId,
      scope.workspaceRoot,
    );
    if (service === undefined) {
      return {
        hits: [],
        searched: [],
        notes: ['Nothing is indexed yet.'],
        index: empty,
      };
    }
    const answer = await service.search({
      query,
      ...(scopes === undefined ? {} : {scopes}),
      ...(limit === undefined ? {} : {limit}),
      ...(minScore === undefined ? {} : {minScore}),
    });
    return {
      hits: answer.hits.map((hit) => ({
        kind: hit.kind,
        path: hit.path,
        ...(hit.startLine === undefined ? {} : {startLine: hit.startLine}),
        ...(hit.endLine === undefined ? {} : {endLine: hit.endLine}),
        ...(hit.section === undefined ? {} : {section: hit.section}),
        ...(hit.sessionId === undefined ? {} : {sessionId: hit.sessionId}),
        ...(hit.title === undefined ? {} : {title: hit.title}),
        preview: hit.preview,
        score: hit.score,
        text: hit.text,
        stale: hit.stale,
      })),
      searched: [...answer.searched],
      notes: answer.notes,
      index: answer.index,
    };
  }

  private async recallScope(): Promise<{
    profileId: string;
    workspaceRoot?: string;
  }> {
    const profile = await this.runtime.activeProfile();
    const state = await this.runtime.workspaces();
    const active = state.workspaces.find(
      (entry) => entry.id === state.activeWorkspaceId,
    );
    return {
      profileId: profile.id,
      ...(active === undefined ? {} : {workspaceRoot: active.path}),
    };
  }

  /**
   * Queues a look at what was just said, once things go quiet.
   *
   * Idle rather than immediate, and it is not a nicety: a review costs a model
   * call, and running one at the end of every turn would spend a second request
   * per message and propose things from a conversation that is still going. A
   * minute of silence means the exchange has finished.
   *
   * The timer is reset by each new turn, so a conversation in progress is never
   * reviewed halfway through — and a turn the user is still having is not a
   * conversation they have finished.
   *
   * **Unless it never goes quiet.** A user typing for twenty minutes never leaves
   * the minute of silence this is waiting for, so the look is also armed on the
   * short delay once enough of the conversation has gone unread. Which of the two
   * applies is `reviewDelay`, decided from the watermark rather than from how
   * long the conversation is — see `review-cadence.ts`.
   */
  private noteForReview(event: AgentUiEvent): void {
    if (
      event.type !== 'turn.completed' &&
      event.type !== 'turn.failed' &&
      event.type !== 'turn.aborted'
    ) {
      /*
       * A new turn cancels the pending look, because the conversation is not
       * over. Only the turn events carry a session id, and only a turn is a
       * reason to remember which agent is busy.
       */
      if (event.type === 'turn.started') {
        this.idleReview = this.clearIdle(this.idleReview);
      }
      return;
    }

    const sessionId = event.sessionId;
    const profileId = this.busyProfileId;
    this.busyProfileId = undefined;
    if (sessionId.length === 0 || profileId === undefined) {
      return;
    }

    this.idleReview = this.clearIdle(this.idleReview);
    /*
     * Decided asynchronously, because the answer is a count of stored events and
     * a setting — and the turn this is reacting to has already finished, so
     * nothing is waiting on the read. A failure falls back to the idle delay:
     * reading a conversation back late is a smaller mistake than reading it back
     * mid-turn, and the timer is a nicety on top of a feature that still works
     * without it.
     */
    void this.runtime
      .reviewDelayFor(profileId, sessionId, {
        idleMs: IDLE_REVIEW_MS,
        shortlyMs: BUSY_REVIEW_MS,
      })
      .catch(() => IDLE_REVIEW_MS)
      .then((delay) => {
        this.idleReview = this.clearIdle(this.idleReview);
        this.idleReview = setTimeout(() => {
          this.idleReview = undefined;
          void this.reviewNow(profileId, sessionId);
        }, delay);
        // Not a reason to keep the process alive on its own.
        this.idleReview.unref?.();
      });
  }

  private clearIdle(handle: NodeJS.Timeout | undefined): undefined {
    if (handle !== undefined) {
      clearTimeout(handle);
    }
    return undefined;
  }

  /**
   * Gives a v2 conversation a quiet minute, then reads it back.
   *
   * A turn followed immediately by another is a conversation still happening;
   * reviewing it then would spend a model call on a half-finished thought. The
   * timer is per conversation and replaced by each new message, which is the
   * same shape as the v1 idle look.
   */
  private scheduleHarnessReview(sessionId: string): void {
    const existing = this.harnessReviews.get(sessionId);
    if (existing !== undefined) {
      clearTimeout(existing);
    }
    const handle = setTimeout(() => {
      this.harnessReviews.delete(sessionId);
      void this.reviewHarnessNow(sessionId);
    }, 60_000);
    handle.unref?.();
    this.harnessReviews.set(sessionId, handle);
  }

  private async reviewHarnessNow(sessionId: string): Promise<void> {
    if (this.stopped) {
      return;
    }
    try {
      const result = await this.runtime.harness().reviewMemory(sessionId);
      this.options.sendEvent({
        type: 'memory.reviewed',
        events: result.events,
        found: result.proposals.length,
      });
      if (result.proposals.length > 0) {
        this.options.sendEvent({
          type: 'memory.proposed',
          count: result.proposals.length,
        });
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.error(`[marimo] the v2 memory review did not finish: ${detail}`);
    }
  }

  /**
   * Runs the review, and tells the window when something was found.
   *
   * Silent when nothing was — which is most of the time, and the reason this is
   * not a notification.
   */
  private async reviewNow(profileId: string, sessionId: string): Promise<void> {
    if (this.stopped) {
      return;
    }
    try {
      /*
       * What was read, before the review, so the event can carry the same numbers
       * the decision was made on. Read here rather than returned by the review
       * because the review answers with what it *found*, and the interesting case
       * is finding nothing — a review that reports only when it has something to
       * say is indistinguishable from one that never ran.
       */
      const progress = await this.runtime.reviewProgress(profileId, sessionId);
      const found = await this.runtime.reviewMemory(profileId, sessionId);
      this.options.sendEvent({
        type: 'memory.reviewed',
        events: progress.reviewed,
        found: found.length,
      });
      if (found.length > 0) {
        this.options.sendEvent({type: 'memory.proposed', count: found.length});
      }
    } catch (error) {
      /*
       * Reported and swallowed. This runs on a timer with nobody waiting, so a
       * throw would be an unhandled rejection in the main process — and a review
       * that failed is not something the user can act on.
       */
      const detail = error instanceof Error ? error.message : String(error);
      console.error(`[marimo] the memory review did not finish: ${detail}`);
    }
  }

  /**
   * Claims the right to run scheduled jobs, retrying while a runner has it.
   *
   * The lock is held for as long as this process runs, and the *runner* holds it
   * for the length of its tick. So failing to take it means a background run is
   * in progress — and the answer is to wait rather than to run beside it, which
   * would be two processes running turns at once.
   *
   * The scheduler is started only once the claim succeeds, because a scheduler
   * running without the lock is exactly the concurrency the lock exists to
   * prevent.
   */
  private async claimJobs(): Promise<void> {
    this.appLock = await holdProcessLock(this.options.paths.appLock);
    if (this.appLock !== undefined) {
      /*
       * Started after the servers, so a job whose prompt needs an MCP tool is
       * not dispatched before that tool exists.
       */
      await this.scheduler.start();
      return;
    }

    this.lockTimer = setInterval(() => {
      void holdProcessLock(this.options.paths.appLock).then(
        async (lock) => {
          if (lock === undefined || this.stopped) {
            return;
          }
          this.appLock = lock;
          this.lockTimer = this.clearTimer(this.lockTimer);
          await this.scheduler.start();
        },
        () => undefined,
      );
    }, LOCK_RETRY_MS);
    this.lockTimer.unref?.();
  }

  private clearTimer(handle: NodeJS.Timeout | undefined): undefined {
    if (handle !== undefined) {
      clearInterval(handle);
    }
    return undefined;
  }

  /** Re-reads the server list and dials whatever changed. */
  async applyMcpServers(): Promise<void> {
    const settings = await this.runtime.settings();
    await this.mcp.apply(settings.mcpServers);
  }

  /**
   * Adds or replaces a connector, and dials it.
   *
   * The write and the connection are one action, because they are one action to
   * the user: a window that saved the file and left the server unconnected would
   * report success for something that had not happened.
   */
  async setMcpServer(server: McpServer): Promise<McpServer[]> {
    const settings = await this.runtime.settings();
    const next = [
      ...settings.mcpServers.filter((entry) => entry.id !== server.id),
      server,
    ];
    await this.runtime.updateSettings({mcpServers: next});
    await this.applyMcpServers();
    return next;
  }

  async removeMcpServer(serverId: string): Promise<McpServer[]> {
    const settings = await this.runtime.settings();
    const next = settings.mcpServers.filter((entry) => entry.id !== serverId);
    await this.runtime.updateSettings({mcpServers: next});
    await this.applyMcpServers();
    return next;
  }

  /**
   * Stores one of a connector's secrets.
   *
   * Through the same store every secret uses, which means the same rules: it is
   * encrypted, a machine with no keychain is refused rather than written to in
   * the clear, and one connector's consent does not decide another's. A connector
   * token is exactly as sensitive as any other, because most of them *are* one.
   *
   * Written the way this connector's own settings say to write it, which is the
   * per-connector version of the choice `setApiKey` makes for a provider: a
   * process with no keychain can read only a secret stored readable, so a
   * connector a scheduled job is meant to use has to be written that way — and
   * one the user left on `keychain` stays encrypted, because encrypting a good
   * default is better than a job that works by having quietly gone readable.
   *
   * A draft the window has not saved yet has no entry to ask. Its secret is still
   * worth storing — the id is the server's identity, so the file is the one the
   * saved connector will read — and an unasked connector gets the safe answer.
   */
  async setMcpSecret(
    serverId: string,
    target: 'env' | 'header',
    name: string,
    value: string,
    secretStorage?: ProviderKeyStorage,
  ): Promise<void> {
    const settings = await this.runtime.settings();
    const server = settings.mcpServers.find((entry) => entry.id === serverId);
    const store = secretStore(
      mcpSecretFile(this.options.paths, serverId, target, name),
      `${name} for this connector`,
    );
    await store.set(value, {
      /*
       * The form's answer first, then the saved connector's, then the safe one.
       *
       * The order matters and it is not defensive programming: the consent and
       * the value are fields of one unsaved form, so the write has to obey what
       * the user is looking at. A draft that has never been saved has no entry to
       * ask at all, which is the case the last fallback is for.
       */
      allowPlaintext: (secretStorage ?? server?.secretStorage) === 'plaintext',
    });
  }

  /**
   * Which of a connector's secrets have a value.
   *
   * Names only. The value never crosses to the window, so the panel can say
   * "set" without being able to say what.
   */
  async mcpSecretState(server: McpServer): Promise<string[]> {
    const set: string[] = [];
    for (const reference of server.secrets ?? []) {
      const store = secretStore(
        mcpSecretFile(
          this.options.paths,
          server.id,
          reference.target,
          reference.name,
        ),
        `${reference.name} for this connector`,
      );
      if (await store.has()) {
        set.push(`${reference.target}:${reference.name}`);
      }
    }
    return set;
  }

  /** Dials a server without saving it, so a wrong command can be found out first. */
  async testMcpServer(
    server: McpServer,
  ): Promise<{ok: boolean; detail: string}> {
    return await this.mcp.test(server);
  }

  /** Every job, for the tray's summary line. */
  async jobs(): Promise<Job[]> {
    const document = await this.jobsStore.load();
    return document.jobs;
  }

  /** The agent's memory suggestions, waiting for an answer. */
  async memoryProposals() {
    return await this.runtime.memoryProposals();
  }

  /** How full an agent's memory is, for the size control in Settings. */
  async memoryUsage(profileId?: string) {
    return await this.runtime.memoryUsage(profileId);
  }

  /** When each remembered bullet was first written, for the age list. */
  async memoryProvenance(profileId?: string) {
    return await this.runtime.memoryProvenance(profileId);
  }

  /** Accepts one into memory, or drops it. */
  async resolveMemoryProposal(proposalId: string, accept: boolean) {
    const proposals = await this.runtime.memoryProposals();
    const proposal = proposals.find((entry) => entry.id === proposalId);
    if (
      proposal?.sessionId !== null &&
      proposal?.sessionId !== undefined &&
      (await this.harnessHasLog(proposal.sessionId))
    ) {
      return await this.runtime
        .harness()
        .resolveMemoryProposal(proposalId, accept);
    }
    return await this.runtime.resolveMemoryProposal(proposalId, accept);
  }

  /** Every suggestion this user has refused, newest last. */
  async dismissedMemory() {
    return await this.runtime.dismissedMemory();
  }

  /** Records that an answer was wrong, and what was right instead. */
  async recordFeedback(params: {
    sessionId: string;
    messageId: string;
    excerpt: string;
    correction?: string;
  }) {
    return await this.runtime.recordFeedback(params);
  }

  /** Every correction on record, newest last. */
  async feedback() {
    return await this.runtime.feedback();
  }

  /** Forgets them all, so the reviewer stops being told about them. */
  async clearFeedback() {
    return await this.runtime.clearFeedback();
  }

  /** Forgets every refusal, so the reviewer may propose them again. */
  async forgetDismissedMemory() {
    return await this.runtime.forgetDismissedMemory();
  }

  /** Reads a conversation back and proposes what is worth remembering. */
  async reviewMemory(profileId: string, sessionId: string) {
    return await this.runtime.reviewMemory(profileId, sessionId);
  }

  /**
   * One provider's key, for the runtime to answer a turn with.
   *
   * The `unreadable` case is passed through rather than flattened to an empty
   * string: "no key yet" and "a key this machine cannot decrypt" are fixed in
   * different places, and this is the read that decides which of them a turn is
   * refused for.
   */
  async readSecret(providerId: ProviderId): Promise<SecretRead> {
    return await providerSecretStore(this.options.paths, providerId).read();
  }

  /**
   * Stores one provider's API key, or clears it with an empty string.
   *
   * Written the way the provider's own settings say to write it, which is the
   * per-provider plaintext consent invariant 16 is about: the headless runner has
   * no keychain, so a key it is meant to use has to be readable by a process that
   * has none. A provider left on `keychain` refuses to write at all on a machine
   * with no keychain, rather than quietly putting a secret in the clear.
   */
  async setApiKey(apiKey: string, providerId?: ProviderId): Promise<void> {
    const settings = await this.runtime.settings();
    const id = providerId ?? settings.providers.active;
    await providerSecretStore(this.options.paths, id).set(apiKey, {
      allowPlaintext: settings.providers.configs[id].keyStorage === 'plaintext',
    });
  }

  /**
   * Which providers have a key stored, by id.
   *
   * Booleans and never values, which is what keeps invariant 8 true through a new
   * door: the window needs to know whether the field it draws is already filled,
   * and `has` is the only question asked of the store here.
   */
  async providerKeys(): Promise<Partial<Record<ProviderId, boolean>>> {
    const state: Partial<Record<ProviderId, boolean>> = {};
    for (const id of PROVIDER_IDS) {
      state[id] = await providerSecretStore(this.options.paths, id).has();
    }
    return state;
  }

  /**
   * Asks a provider what it serves, and records the answer.
   *
   * The refusals come before the request on purpose. A key the user has not
   * entered yet is not a network problem, and a `401` reported as "could not
   * reach the endpoint" sends them to look at an address that was never wrong;
   * the stored secret's own sentence is quoted for the same reason it exists.
   *
   * The list is written through the runtime rather than the settings store, so
   * every host drops what it had applied — a default model the endpoint has
   * retired is replaced before the next turn resolves, rather than after it
   * fails.
   */
  async fetchModels(providerId?: ProviderId): Promise<void> {
    const settings = await this.runtime.settings();
    const id = providerId ?? settings.providers.active;
    const config = settings.providers.configs[id];
    const provider = PROVIDERS[id];

    const secret = await providerSecretStore(this.options.paths, id).read();
    if (secret.state === 'unreadable') {
      throw new Error(`${secret.reason} Re-save it, then fetch its models.`);
    }
    if (provider.requiresApiKey && secret.state !== 'present') {
      throw new Error(
        `${provider.label} needs an API key before it can list its models.`,
      );
    }

    const models = await fetchProviderModels({
      provider: id,
      apiKey: secret.state === 'present' ? secret.value : '',
      /*
       * The address as the user set it, so a server on their own network is
       * asked rather than the catalogue's default for that provider — and the
       * catalogue's when the field was cleared, because an empty string is a
       * field somebody emptied rather than an instruction to request `/models`
       * from nowhere.
       */
      baseUrl:
        config.baseUrl.length > 0 ? config.baseUrl : provider.defaultBaseUrl,
    });
    await this.runtime.setAvailableModels(id, models);
  }

  mcpStatuses(): Record<string, McpStatus> {
    return this.mcp.statuses();
  }

  async profiles(): Promise<{
    profiles: AgentProfile[];
    activeProfileId: string;
  }> {
    const profiles = await this.runtime.profiles();
    const active = await this.runtime.activeProfile();
    return {profiles, activeProfileId: active.id};
  }

  /** The tools and skills a pick-list can offer, as this install builds them. */
  async catalog(): Promise<ProfileCatalog> {
    return await this.runtime.catalog();
  }

  /**
   * The user's skills, for the Settings card.
   *
   * The editor and `save_skill` share the runtime's service, so a name saved one
   * way is a name the other can see and switch on.
   */
  async skills(): Promise<StoredSkill[]> {
    return await this.runtime.skills();
  }

  async saveSkill(
    draft: SkillDraft,
    id?: string,
  ): Promise<{skills: StoredSkill[]; saved: StoredSkill}> {
    return await this.runtime.saveSkill(draft, id);
  }

  async removeSkill(id: string): Promise<StoredSkill[]> {
    return await this.runtime.removeSkill(id);
  }

  /** Counts for the Settings card and a bug report. */
  async harnessReport(profileId: string): Promise<HarnessReport> {
    const report = await this.runtime.harness().report(profileId);
    const sessions = await this.runtime.listSessions(profileId);
    const jobs = (await this.jobsStore.load()).jobs.filter(
      (job) => job.profileId === profileId,
    ).length;
    return {
      engine: 'v2-for-new',
      conversations: {
        ...report.conversations,
        v1: Math.max(0, sessions.length - report.conversations.v2),
      },
      turns: report.turns,
      usage: report.usage,
      unreadableLogs: report.unreadableLogs,
      harnessVersions: report.harnessVersions,
      versions: report.versions,
      pendingProposals: report.pendingProposals,
      skills: report.skills,
      jobs,
      paths: report.paths,
    };
  }

  async sessionUsage(
    profileId: string,
    sessionId: string,
  ): Promise<SessionUsage> {
    if (await this.harnessHasLog(sessionId)) {
      const usage = await this.runtime.harness().sessionUsage(profileId, sessionId);
      return {engine: 'v2', ...usage};
    }
    return {
      engine: 'v1',
      turns: 0,
      usage: {promptTokens: 0, completionTokens: 0, totalTokens: 0},
    };
  }

  async restoreHarness(
    profileId: string,
    hash: string,
  ): Promise<void> {
    await this.runtime.harness().restoreHarness(profileId, hash);
  }

  async skillHistory(id: string): Promise<SkillHistoryEntry[]> {
    return await this.runtime.skillHistory(id);
  }

  async restoreSkill(
    id: string,
    entryId: string,
  ): Promise<{skills: StoredSkill[]; saved: StoredSkill}> {
    return await this.runtime.restoreSkill(id, entryId);
  }

  async selectProfile(profileId: string): Promise<void> {
    await this.runtime.selectProfile(profileId);
  }

  /**
   * The folders this install works in.
   *
   * Every mutation answers with the whole list, so the window never merges a
   * single entry into a copy of its own.
   */
  async workspaces(): Promise<WorkspaceState> {
    return await this.runtime.workspaces();
  }

  async addWorkspace(path: string): Promise<WorkspaceState> {
    return await this.runtime.addWorkspace(path);
  }

  async selectWorkspace(workspaceId: string): Promise<WorkspaceState> {
    return await this.runtime.selectWorkspace(workspaceId);
  }

  async renameWorkspace(
    workspaceId: string,
    name: string,
  ): Promise<WorkspaceState> {
    return await this.runtime.renameWorkspace(workspaceId, name);
  }

  async removeWorkspace(workspaceId: string): Promise<WorkspaceState> {
    return await this.runtime.removeWorkspace(workspaceId);
  }

  /** One folder, for the caller that opens it in the file manager. */
  async workspace(workspaceId: string): Promise<Workspace> {
    const workspace = await this.runtime.workspaceById(workspaceId);
    if (workspace === undefined) {
      throw new Error(`Unknown workspace: ${workspaceId}`);
    }
    return workspace;
  }

  /**
   * A space's documents.
   *
   * The window names a space and never a path: the runtime resolves the id and
   * the service refuses anything that leaves the folder, so the five `docs.*`
   * calls cannot reach a file the user did not load.
   */
  async documentsFor(spaceId: string): Promise<DocumentService> {
    return await this.runtime.documentsFor(spaceId);
  }

  /** One document's text, and the revision a write has to be based on. */
  async readDocument(spaceId: string, path: string): Promise<DocumentRead> {
    return await this.runtime.readDocument(spaceId, path);
  }

  /** Writes a document, or answers that it moved on since it was read. */
  async writeDocument(
    spaceId: string,
    path: string,
    text: string,
    revision: DocumentRevision,
  ): Promise<DocumentWrite> {
    return await this.runtime.writeDocument(spaceId, path, text, revision);
  }

  /** A new, empty document in one of a space's folders. */
  async createDocument(
    spaceId: string,
    dir: string | undefined,
    name: string,
  ): Promise<DocumentRead> {
    return await this.runtime.createDocument(spaceId, dir, name);
  }

  /** A conversation written into a space as a document. */
  async saveChatAsDocument(
    profileId: string,
    sessionId: string,
    spaceId: string,
    path: string,
  ): Promise<DocumentRead> {
    return await this.runtime.saveChatAsDocument(
      profileId,
      sessionId,
      spaceId,
      path,
    );
  }

  /** Re-files a conversation, or unfiles it with `null`. */
  async moveSession(
    profileId: string,
    sessionId: string,
    workspaceId: string | null,
  ): Promise<SessionSummary> {
    const session = await this.runtime.setSessionWorkspace(
      profileId,
      sessionId,
      workspaceId,
    );
    if (await this.harnessHasLog(sessionId)) {
      await this.runtime
        .harness()
        .moveSession(profileId, sessionId, workspaceId);
    }
    return session;
  }

  async renameSession(
    profileId: string,
    sessionId: string,
    title: string,
  ): Promise<SessionSummary> {
    const session = await this.runtime.renameSession(
      profileId,
      sessionId,
      title,
    );
    if (await this.harnessHasLog(sessionId)) {
      await this.runtime.harness().renameSession(profileId, sessionId, title);
    }
    return session;
  }

  /**
   * Points one conversation at a model of its own, or back at its agent's.
   *
   * The choice belongs to the conversation rather than to the window that made
   * it: a reloaded window, the companion, and a scheduled job all resolve the
   * same entry, so "use the big model for this one question" survives all three.
   */
  async setSessionModel(
    profileId: string,
    sessionId: string,
    model: AgentModel | null,
  ): Promise<SessionSummary> {
    const session = await this.runtime.setSessionModel(
      profileId,
      sessionId,
      model,
    );
    if (await this.harnessHasLog(sessionId)) {
      await this.runtime.harness().setSessionModel(profileId, sessionId, model);
    }
    return session;
  }

  /**
   * Sets who is in a conversation, the lead first. An empty list clears it.
   *
   * A write and nothing else, like the model above it: the next turn resolves who
   * is in the chat from the index entry, so there is no host to rebuild and no
   * turn to interrupt.
   */
  async setParticipants(
    profileId: string,
    sessionId: string,
    agentIds: string[],
  ): Promise<SessionSummary> {
    if (await this.harnessHasLog(sessionId)) {
      await this.runtime
        .harness()
        .setParticipants(profileId, sessionId, agentIds);
      const summary = (await this.runtime.listSessions(profileId)).find(
        (session) => session.id === sessionId,
      );
      if (summary === undefined) {
        throw new Error(`Unknown session: ${sessionId}`);
      }
      const {agentIds: _previous, ...rest} = summary;
      return agentIds.length > 1 ? {...rest, agentIds} : rest;
    }
    return await this.runtime.setParticipants(profileId, sessionId, agentIds);
  }

  /** The folder a conversation works in, for judging an attached file. */
  async conversationFolder(
    profileId: string,
    sessionId: string,
  ): Promise<string | undefined> {
    return await this.runtime.conversationFolder(profileId, sessionId);
  }

  /** Replaces the older part of a conversation with a summary. */
  async compact(profileId: string, sessionId: string): Promise<CompactResult> {
    if (await this.harnessHasLog(sessionId)) {
      const result = await this.runtime
        .harness()
        .compactSession(profileId, sessionId);
      this.options.sendEvent({type: 'session.changed', sessionId});
      return result;
    }
    const result = await this.runtime.compact(profileId, sessionId);
    /*
     * Told even when nothing happened: the window that ran the command re-reads
     * the conversation, and the rail's own copy of the entry is now stale — the
     * summary is a new event, so the count and the time have both moved.
     */
    this.options.sendEvent({type: 'session.changed', sessionId});
    return result;
  }

  async deleteSession(profileId: string, sessionId: string): Promise<void> {
    if (await this.harnessHasLog(sessionId)) {
      await this.runtime.harness().deleteSession(profileId, sessionId);
    }
    await this.runtime.deleteSession(profileId, sessionId);
  }

  async updateProfile(
    profileId: string,
    patch: Parameters<AgentRuntime['updateProfile']>[1],
  ): Promise<void> {
    await this.runtime.updateProfile(profileId, patch);
  }

  async createProfile(draft?: BotDraft, sourceCallId?: string) {
    const created = await this.runtime.createProfile(draft, sourceCallId);
    await this.runtime.selectProfile(created.id);
    return created;
  }

  /**
   * Removes a bot, its conversations, its schedule and what it remembered.
   *
   * The runtime first and the jobs second, because that call is the one that
   * refuses the last bot — and it refuses *before* it destroys anything. Taking
   * a bot's schedule away and then declining to take the bot would be a change
   * somebody did not ask for.
   */
  async removeProfile(profileId: string): Promise<void> {
    await this.runtime.removeProfile(profileId);
    await this.jobsStore.removeForProfile(profileId);
  }

  async updateSettings(
    patch: Parameters<AgentRuntime['updateSettings']>[0],
  ): Promise<void> {
    await this.runtime.updateSettings(patch);
  }

  async listSessions(profileId?: string): Promise<SessionSummary[]> {
    const sessions = await this.runtime.listSessions(profileId);
    if (profileId === undefined) {
      return sessions;
    }
    const harness = this.runtime.harness();
    return await Promise.all(
      sessions.map(async (session) => {
        if (!(await harness.hasLog(session.id))) {
          return session;
        }
        const info = await harness.sessionInfo(session.id);
        const {agentIds: _previous, ...rest} = session;
        return {
          ...rest,
          ...(info.title === undefined ? {} : {title: info.title}),
          messageCount: info.messageCount,
          ...(info.agentIds.length > 1 ? {agentIds: info.agentIds} : {}),
        };
      }),
    );
  }

  async createSession(
    profileId: string,
    spaceId?: string,
  ): Promise<SessionSummary> {
    // No title: the store names a chat from the first thing said in it.
    const session = await this.runtime.createSession(
      profileId,
      undefined,
      spaceId,
    );
    if (session === undefined) {
      throw new Error(`There is no bot called "${profileId}".`);
    }
    return session;
  }

  /**
   * Starts the conversation that makes a bot.
   *
   * The runtime owns the purpose and the tool check; this only names it. There
   * is no turn here — the window opens the session and draws the opening card.
   */
  async startBotBuilder(profileId: string): Promise<SessionSummary> {
    return await this.runtime.startBuilderSession(profileId);
  }

  /**
   * Reads a conversation.
   *
   * Goes to the runtime's own reader rather than resolving the configuration
   * first. The version that resolved it returned an empty conversation whenever
   * the engine was not up — so a model that would not start emptied every chat in
   * the window, and the history was on disk the whole time.
   */
  async transcript(
    profileId: string,
    sessionId: string,
  ): Promise<{messages: TranscriptMessage[]; pending: PendingGate[]}> {
    if (await this.harnessHasLog(sessionId)) {
      const harness = this.runtime.harness();
      return {
        messages: await harness.transcript(sessionId, profileId),
        pending: await harness.pendingGates(sessionId),
      };
    }
    return await this.runtime.transcript(profileId, sessionId);
  }

  /**
   * Whether this turn should run on the v2 engine.
   *
   * A conversation that already has a v2 log stays on it, so turning the preview
   * off does not abandon a turn that is waiting on a card. A conversation with a
   * v1 history stays on v1, because two formats in one transcript would lose
   * whichever half the window is not reading. Only an empty conversation starts
   * on v2, and only when the preview is on.
   */
  private async useHarness(
    profileId: string,
    sessionId: string,
    origin: 'window' | 'pet' | undefined,
    agentId: string | undefined,
  ): Promise<boolean> {
    if (await this.harnessHasLog(sessionId)) {
      return true;
    }
    if (agentId !== undefined || origin === 'pet') {
      return false;
    }
    if (process.env['MARIMO_HARNESS_V2'] !== '1') {
      return false;
    }
    try {
      return (
        (await this.runtime.transcript(profileId, sessionId)).messages
          .length === 0
      );
    } catch {
      return false;
    }
  }

  private async harnessHasLog(sessionId: string): Promise<boolean> {
    try {
      return await this.runtime.harness().hasLog(sessionId);
    } catch {
      return false;
    }
  }

  /**
   * Starts a turn.
   *
   * Answers as soon as the turn has been *started*, because a turn is a stream
   * and an `invoke` is not: the answer arrives on the event channel. A refusal —
   * a turn already running, no key, an unknown conversation — comes back as
   * `turn.failed` on that same channel, which is the shape the window already
   * draws, so nothing here has to invent a second way to say no.
   *
   * `origin` is which surface asked — the window, or the moss ball floating over
   * it. The two share a conversation, so it is not a second thread: it is the one
   * thing the turn needs that the message itself does not carry.
   *
   * `agentId` is the participant the user addressed with `@`. It rides the turn
   * rather than the conversation, because `@` is a decision about one message:
   * the next one goes back to the lead unless it is addressed too.
   */
  async send(
    profileId: string,
    sessionId: string,
    text: string,
    origin?: 'window' | 'pet',
    agentId?: string,
  ): Promise<{accepted: boolean}> {
    /*
     * Checked here as well as inside the agent, purely so the answer is
     * synchronous. A send that is going to be refused should be refused in the
     * reply the window is waiting for, not one event later.
     */
    /*
     * Which agent is about to be busy, for the review that follows the turn.
     * Recorded here because this is the last point at which the profile is
     * known: the events a turn emits carry a conversation, not an agent.
     */
    this.busyProfileId = profileId;

    if (await this.useHarness(profileId, sessionId, origin, agentId)) {
      const harness = this.runtime.harness();
      if (harness.isRunning(sessionId)) {
        this.options.sendEvent({
          type: 'turn.failed',
          sessionId,
          messageId: '',
          code: 'busy',
          message:
            'A turn is already running. Wait for it to finish, or stop it.',
        });
        return {accepted: false};
      }
      const purpose = await this.runtime.sessionPurpose(profileId, sessionId);
      const instruction =
        origin === 'pet'
          ? turnInstruction(
              'pet',
              (await this.runtime.settings()).companion.answerLength,
            )
          : purpose === 'bot-builder'
            ? BOT_BUILDER_INSTRUCTION
            : undefined;
      this.pump(harness.run(profileId, sessionId, text, agentId, instruction));
      this.scheduleHarnessReview(sessionId);
      return {accepted: true};
    }

    if (this.runtime.isBusy()) {
      this.options.sendEvent({
        type: 'turn.failed',
        sessionId,
        messageId: '',
        code: 'busy',
        message:
          'A turn is already running. Wait for it to finish, or stop it.',
      });
      return {accepted: false};
    }

    this.pump(this.runtime.run(profileId, sessionId, text, origin, agentId));
    return {accepted: true};
  }

  async approve(
    profileId: string,
    sessionId: string,
    callId: string,
    confirmed: boolean,
  ): Promise<{accepted: boolean}> {
    /*
     * Which agent is about to be busy, for the review that follows the turn.
     * Recorded here because this is the last point at which the profile is
     * known: the events a turn emits carry a conversation, not an agent.
     */
    this.busyProfileId = profileId;

    if (await this.harnessHasLog(sessionId)) {
      const harness = this.runtime.harness();
      if (harness.isRunning(sessionId)) {
        this.options.sendEvent({
          type: 'turn.failed',
          sessionId,
          messageId: '',
          code: 'busy',
          message:
            'A turn is already running. Wait for it to finish, or stop it.',
        });
        return {accepted: false};
      }
      this.pump(harness.approve(profileId, {sessionId, callId, confirmed}));
      return {accepted: true};
    }

    if (this.runtime.isBusy()) {
      this.options.sendEvent({
        type: 'turn.failed',
        sessionId,
        messageId: '',
        code: 'busy',
        message:
          'A turn is already running. Wait for it to finish, or stop it.',
      });
      return {accepted: false};
    }

    this.pump(this.runtime.approve(profileId, {sessionId, callId, confirmed}));
    return {accepted: true};
  }

  abort(profileId: string, sessionId: string): {aborted: boolean} {
    /*
     * Abort answers synchronously, so it cannot ask the log which engine owns
     * this conversation. Trying the v2 turn first is safe: it answers false when
     * it has nothing running, and the v1 path is then the fallback.
     */
    if (this.runtime.harness().abort(sessionId)) {
      return {aborted: true};
    }
    return {aborted: this.runtime.abort(profileId, sessionId)};
  }

  /** Whether any agent is mid-turn. */
  isBusy(): boolean {
    return this.runtime.isBusy();
  }

  /**
   * Drains a turn's events to the window.
   *
   * The generator is consumed to completion in the background: a turn outlives
   * the call that started it, and the window may well have been closed and
   * reopened by the time it finishes.
   *
   * A throw is turned into a `turn.failed` event rather than being left to
   * reject an unawaited promise, which would be an unhandled rejection in the
   * main process — a crash with nothing on screen to explain it.
   */
  private pump(stream: AsyncGenerator<AgentUiEvent>): void {
    void (async () => {
      try {
        for await (const event of stream) {
          if (this.stopped) {
            return;
          }
          this.options.sendEvent(event);
          this.noteForReview(event);
        }
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        this.options.sendEvent({
          type: 'turn.failed',
          sessionId: '',
          messageId: '',
          code: 'internal',
          message: `The turn failed: ${detail}`,
        });
      }
    })();
  }
}
