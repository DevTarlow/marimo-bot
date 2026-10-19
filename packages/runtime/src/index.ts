/**
 * The Electron-free half of Marimo Bot.
 *
 * Everything here runs in two places: inside the Electron main process, and
 * inside the headless job runner, which is the same binary started as plain Node
 * with no `app`, no window and no display. That is why this package imports
 * nothing from Electron, and why paths and secrets arrive as arguments rather
 * than being looked up — see `paths.ts` and `secrets.ts` for why each seam is
 * where it is.
 *
 * The stores are re-exported rather than reimplemented: `jobs.json` has exactly
 * one reader and one writer, and the app and the runner are two callers of it
 * rather than two versions of it.
 */

/* Where everything lives. */
export {
  avatarFile,
  avatarFileName,
  defaultUserDataDir,
  resolveAppPaths,
  secretFile,
  secretFileName,
} from './paths.js';
export type {AppPaths} from './paths.js';

/*
 * Back to a fresh install: everything under the user-data directory, and nothing
 * outside it. Electron-free like the paths it speaks in, because the folder is
 * the unit and both processes resolve it from the same definition.
 */
export {resetInstall} from './reset.js';
export type {ResetReport} from './reset.js';

/* Secrets, with the cipher injected. */
export {FileSecretStore} from './secrets.js';
export type {SecretCipher, SecretRead} from './secrets.js';

/* The agent's memory suggestions, waiting for an answer. */
export {
  MAX_PENDING_PROPOSALS,
  MemoryProposalStore,
} from './memory-proposals.js';
export type {
  MemoryProposalStoreOptions,
  NewProposal,
} from './memory-proposals.js';

/* Waking the job runner when the app is closed. */
export {
  planService,
  runnerEnvironment,
  SERVICE_LABEL,
  SERVICE_UNIT,
} from './service/plan.js';
export type {
  PlannedCommand,
  PlannedFile,
  ServicePlan,
  ServicePlatform,
  ServiceProbe,
  ServiceSpec,
} from './service/plan.js';
export {
  installService,
  nodeServiceHost,
  serviceState,
  uninstallService,
} from './service/apply.js';
export type {
  CommandResult,
  ServiceFailure,
  ServiceHost,
  ServiceOutcome,
  ServiceState,
} from './service/apply.js';

/* A lock that works between processes, for the files they share. */
export {
  FileLockTimeoutError,
  holdProcessLock,
  isProcessHeld,
  processIsAlive,
  withFileLock,
} from './lock.js';
export type {FileLockOptions, ProcessLock, ProcessLockOptions} from './lock.js';

/*
 * The recall model: its pins, its download, and the engine that serves it.
 *
 * Here rather than in the desktop app because both halves of the app need it —
 * the window to search while somebody is looking, the headless runner to answer
 * a scheduled job with the window closed — and this is the package both of them
 * already share. It is the only model left: the chat model this app used to
 * download and supervise is gone, and what remains of that machinery is the
 * generic engine supervisor below, which recall is the only user of.
 */
export {
  EMBEDDING_ALIAS,
  EMBEDDING_PIECES,
  EMBEDDING_PINS,
  EMBEDDING_POOLINGS,
  embeddingArgs,
  embeddingPidFile,
  embeddingUrl,
  engineAssetFor,
  engineBinaryName,
  engineDir,
  engineIsPinned,
  engineUrl,
  freePort,
  installEmbeddingPiece,
  installEngine,
  InstallError,
  LocalModelService,
  ManifestError,
  MODEL_DIR_ENV,
  MODEL_DIR_NAME,
  modelDir,
  parseEmbeddingManifest,
  platformKey,
  RECALL_DIR_NAME,
  recallDir,
  recallPiecesInstalled,
  recallSpec,
  resolveRecallFiles,
  unpackEngine,
} from './local-model/index.js';
export type {
  DownloadProgress,
  EmbeddingInstallOptions,
  EmbeddingManifest,
  EmbeddingPiece,
  EmbeddingPieceName,
  EmbeddingPooling,
  EmbeddingSpec,
  EngineAsset,
  EngineFiles,
  EngineInstallOptions,
  EngineManifest,
  EngineRunSpec,
  EngineStatus,
  InstallOptions,
  LocalModelOptions,
  RecallFiles,
  RecallSpec,
} from './local-model/index.js';

/*
 * Recall: the embedding model, and the pieces that turn it into an answer.
 *
 * Beside the model above because it *is* a model — a second engine, its own
 * pins, its own directory under the same model directory — and apart from it
 * because none of what is above applies: no tiers, no probe, no GPU.
 */
export {
  CHUNK_CHARS,
  CHUNK_OVERLAP_CHARS,
  chunkText,
  CONVERSATION_SOURCE,
  ConversationWatermarkStore,
  conversationSlice,
  DEFAULT_LIMIT,
  DEFAULT_PER_SOURCE,
  digestOf,
  documentText,
  EmbeddingClient,
  EmbeddingError,
  emptyIndex,
  frameTimes,
  INDEX_FILE,
  INDEX_VERSION,
  indexMatchesModel,
  MAX_CONVERSATION_CHARS,
  MAX_LIMIT,
  MAX_MEDIA_BYTES,
  MEDIA_EXTENSIONS,
  MEDIA_KINDS,
  mediaKindOf,
  MEMORY_SOURCE,
  memoryBullets,
  normalize,
  previewOf,
  QUERY_PREFIX,
  queryText,
  readIndex,
  RECALL_IDLE_MS,
  RECALL_INDEX_FILE,
  RecallEngine,
  recallIndexDir,
  RecallService,
  REFRESH_CHUNKS,
  REFRESH_CONVERSATIONS,
  REFRESH_FILES,
  REFRESH_MEDIA,
  refreshIndex,
  removeIndex,
  renderConversationText,
  searchVectors,
  VECTORS_FILE,
  writeIndex,
} from './recall/index.js';
export type {
  ChunkOptions,
  ConversationEvent,
  ConversationSlice,
  ConversationSource,
  ConversationSummary,
  ConversationWatermarkStoreOptions,
  EmbeddingClientOptions,
  EmbeddingPart,
  EmbeddingResult,
  FileStamp,
  IndexCoverage,
  IndexData,
  IndexFile,
  IndexModel,
  IndexRecord,
  MediaKind,
  MediaSource,
  MemoryBullet,
  MemoryIndexState,
  RecallAnswer,
  RecallEngineOptions,
  RecallHit,
  RecallIndexStatus,
  RecallQuery,
  RecallScope,
  RecallServiceOptions,
  RefreshOptions,
  RefreshResult,
  SearchHit,
  SearchOptions,
  TextChunk,
} from './recall/index.js';

/*
 * Format versions, and refusing to overwrite a document we cannot read.
 *
 * Re-exported from `@marimo/agent`, where it lives — the conversation index
 * needs the same rule and cannot import from here, and one implementation is
 * better than two. Kept in this package's public API so a caller still finds it
 * beside the stores that use it.
 */
export {
  assertWritable,
  DOCUMENT_VERSION,
  DocumentTooNewError,
  quarantineDocument,
  readVersionedDocument,
} from '@marimo/agent';
export type {
  DocumentMigration,
  DocumentRead,
  ReadVersionedOptions,
} from '@marimo/agent';

/*
 * The review cadence, re-exported for the same reason as the version machinery:
 * the decision lives with the memory it is about, and the app that arms the timer
 * should not have to import the agent package to ask which delay to use.
 */
export {reviewDelay} from '@marimo/agent';
export type {ReviewDelay, ReviewDueOptions} from '@marimo/agent';

/* The agent, assembled from what the user configured. */
export {AgentRuntime} from './agent/runtime.js';
export type {
  AgentRuntimeOptions,
  HostResult,
  RuntimeServices,
} from './agent/runtime.js';
export {parseProfile, resolveAgentConfig} from './agent/resolve.js';
export {createJobRunner} from './agent/job-runner.js';
export type {JobRunnerOptions} from './agent/job-runner.js';
/*
 * What the floating companion asks for, in words. Exported because the settings
 * screen describes the three lengths and the agent is the thing that acts on
 * them; a second copy of these sentences in the renderer is a second thing to
 * keep true.
 */
export {turnInstruction} from './agent/pet-turn.js';
export type {
  ResolvedAgent,
  ResolveAgentOptions,
  StoredSkillForPrompt,
} from './agent/resolve.js';

/* MCP servers: which exist, which are up, and where their credentials live. */
export {
  McpManager,
  mcpSecretFile,
  secretReaderFor,
} from './agent/mcp-manager.js';
export type {
  McpConnectionState,
  McpManagerOptions,
  McpStatus,
} from './agent/mcp-manager.js';

/* Scheduled jobs. */
export {DEFAULT_SCHEDULE, isPlaceholder, JobStore} from './jobs.js';
export type {JobRunRecord, JobStoreOptions, NewJob} from './jobs.js';

/* The thing that runs them. */
export {JobScheduler} from './scheduler.js';
export type {JobRunner, JobSchedulerOptions} from './scheduler.js';

/* The jobs rail's pure reading of a job, shared with the window. */
export {
  jobBadge,
  jobTone,
  lastRunLabel,
  relativeWhen,
  sortJobs,
  visibleJobs,
  weekdayName,
} from './job-rules.js';
export type {JobTone} from './job-rules.js';

/* Agents. */
export {
  LastProfileError,
  ProfileStore,
  UnknownProfileError,
} from './profiles.js';
export type {
  ProfileFile,
  ProfileSeed,
  ProfileSnapshot,
  ProfileStoreOptions,
} from './profiles.js';

/* The folders every agent works in. */
export {
  WorkspaceStore,
  workspaceLabel,
  workspaceRootFor,
} from './workspaces.js';
export type {LegacyWorkspaces, WorkspaceStoreOptions} from './workspaces.js';

/*
 * A Space's documents: the markdown files in the folder it points at.
 *
 * The protocol's own `DocumentRead`/`DocumentWrite` are deliberately not
 * re-exported here — this package already re-exports the *versioned* document
 * reader's `DocumentRead` from `@marimo/agent`, and two meanings of that name in
 * one module is a type a caller cannot read.
 */
export {
  DocumentService,
  MAX_DOCUMENT_BYTES,
  MAX_DOCUMENTS,
  MAX_DOCUMENT_DEPTH,
  renderChatDocument,
} from './documents.js';
export type {
  ChatDocument,
  ChatMessage,
  DocumentList,
  DocumentServiceOptions,
} from './documents.js';

/* Preferences. */
export {
  defaultStoredSettings,
  readLegacyProfileSeed,
  SettingsStore,
} from './settings.js';

/*
 * Dream-RSI's trees on disk, and the offline replay that reads them.
 *
 * The replay is exported from here rather than from the agent package because it
 * is the *file* half — reading a directory of conversations and reporting — while
 * the policy arithmetic stays in `@marimo/agent`, where it is shared with the
 * live turn. The CLI is the thinnest possible wrapper over these two.
 */
export {DREAM_VERSION, DreamStore} from './dream-store.js';
export type {DreamStoreOptions, LoadedTrees} from './dream-store.js';
export {sweepDreamTrees, renderSweep} from './dream-replay.js';
export type {
  DreamReplayOptions,
  DreamSweep,
  DreamSweepRow,
} from './dream-replay.js';

/* Skills. */
export {
  DuplicateSkillNameError,
  normaliseName,
  parseSkillMarkdown,
  renderSkillMarkdown,
  ReservedSkillNameError,
  SkillDescriptionTooLongError,
  SkillStore,
  SkillTooLongError,
} from './skills.js';
export type {SkillDraft, SkillStoreOptions} from './skills.js';
export {RuntimeSkillService} from './skill-service.js';
export type {RuntimeSkillServiceOptions} from './skill-service.js';
/*
 * The v2 conversation log. The engine owns the events; this owns the file.
 */
export {EventLogError, FileEventStore} from './events/file-event-store.js';
export type {FileEventStoreOptions} from './events/file-event-store.js';
