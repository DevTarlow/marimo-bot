export {AgentHost, pendingGatesIn} from './host/agent-host.js';
export type {
  AgentHostOptions,
  ApproveParams,
  DelegationResult,
  DelegationSeam,
} from './host/agent-host.js';
/*
 * `PendingGate` is re-exported from the contract rather than declared here: it
 * is what the window draws a card from, so the protocol owns the shape and this
 * package reads it like everything else on the wire.
 */
export type {PendingGate} from '@marimo/protocol';

/*
 * MCP servers: one connection each, and the tools they offer.
 */
export {
  buildMcpTools,
  MAX_TOOL_NAME_CHARS,
  McpError,
  McpServerConnection,
  McpToolNameError,
  mcpToolNameFor,
  renderResult,
  sanitiseSchema,
} from './mcp/index.js';
export type {
  McpConnectionOptions,
  McpErrorKind,
  McpResolvedSecrets,
  McpToolBuildOptions,
  McpToolInfo,
} from './mcp/index.js';
/*
 * The one client, for every backend: each provider speaks the OpenAI
 * chat-completions dialect, so what changes between one and the next is an
 * address, a key and a model id rather than a second transport. The
 * `DeepSeekLlm` alias went with the single backend it named.
 */
export {
  OpenAiCompatLlm,
  OpenAiCompatRequestError,
} from './models/openai-compat-llm.js';
export type {OpenAiCompatLlmOptions} from './models/openai-compat-llm.js';
export {
  fetchProviderModels,
  ProviderModelsError,
} from './models/provider-models.js';
export type {ProviderModelsOptions} from './models/provider-models.js';
export {FileSessionService} from './sessions/file-session-service.js';
export {reviewDelay} from './review-cadence.js';
export type {ReviewDelay, ReviewDueOptions} from './review-cadence.js';
export type {
  AdkEvent,
  SessionIndexEntry,
} from './sessions/file-session-service.js';
export {projectTranscript} from './host/transcript.js';
export {
  ASK_AGENT_TOOL,
  CAPABILITY_PRESETS,
  capabilityPresets,
  createTools,
  describeTools,
  SAFE_DEFAULT_TOOLS,
} from './tools/index.js';
export type {McpToolsetSource, ToolDependencies} from './tools/index.js';
export {
  createCreateJobTool,
  createDeleteJobTool,
  createListJobsTool,
  createUpdateJobTool,
  DEFAULT_JOB_SCHEDULE,
} from './tools/job-tools.js';
export type {JobService, JobToolContext} from './tools/job-tools.js';
export {
  createListDiscordChannelsTool,
  createReadDiscordMessagesTool,
  createSendDiscordMessageTool,
  discordTools,
  DISCORD_MESSAGE_LIMIT,
  DISCORD_READ_MAX,
} from './tools/discord-tools.js';
export type {
  DiscordService,
  DiscordToolContext,
} from './tools/discord-tools.js';
export {deskTools} from './tools/desk-tools.js';
export {createRecallTool, RECALL_SCOPES} from './tools/recall-tools.js';
export type {
  RecallAnswer,
  RecallHit,
  RecallLookup,
  RecallRequest,
  RecallScope,
  RecallToolContext,
} from './tools/recall-tools.js';
export type {
  DeskEdit,
  DeskService,
  DeskToolContext,
} from './tools/desk-tools.js';
export {
  createLoadSkillTool,
  createSaveSkillTool,
  SKILL_INSTRUCTIONS_MAX,
} from './tools/skill-tools.js';
export type {
  SkillLibrary,
  SkillService,
  SkillToolContext,
} from './tools/skill-tools.js';
export type {
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResult,
} from './tools/web-search-tool.js';
export {
  AGENT_DATA_DIR,
  DEFAULT_PROFILE_ID,
  DEFAULT_SECTION,
  MAX_MEMORY_BYTES,
  MEMORY_FILE_NAME,
  PROVENANCE_FILE_NAME,
  isNewProposal,
  MAX_PROPOSALS,
  MemoryStore,
  MemoryTooLargeError,
  parseProposals,
  renderConversation,
  reviewPrompt,
  runReview,
  resolveAgentDataDir,
  resolveMemoryFile,
  // Where the person's half of memory lives for one profile. Exported for the
  // runtime, which removes that folder when the bot it belonged to is removed:
  // the file's location is this package's fact, not a second spelling in the
  // app.
  resolvePersonMemoryFile,
  // Split and re-render are exported for whatever indexes memory, so that there
  // is one reader of memory.md rather than a second parser in another package.
  // The index has to agree with the store bullet for bullet, and two parsers of
  // one document is exactly the disagreement this package is arranged to avoid.
  // The selector that decides what of memory reaches a prompt, beside the store
  // that owns the file: the two have to agree about what a bullet is, and the
  // only way to be sure of that is for one package to hold both.
  isAlwaysInjected,
  renderSectionGuide,
  selectMemory,
  splitMemory,
  toBullets,
} from './memory/index.js';
export type {
  MemoryPruneRequest,
  MemoryScope,
  MemorySelection,
  MemorySource,
  MemoryStoreOptions,
  MemoryUpdate,
  RecalledBullet,
  ReviewEvent,
  ReviewRequest,
} from './memory/index.js';
/*
 * The threshold `update_memory` uses to decide that a new bullet and an existing
 * one are probably the same fact. Exported because it is a *measurement* rather
 * than a constant: `same-fact.live.test.ts` in the runtime package is the thing
 * that pins it against the real embedding model, and a test cannot pin a number
 * it cannot import.
 */
export {SAME_FACT_SCORE} from './tools/memory-tools.js';
export type {NearDuplicate} from './tools/memory-tools.js';
export {
  SKILLS,
  composeInstruction,
  renderAvailableSkills,
  renderSkills,
} from './skills/index.js';
/*
 * Document versioning lives here rather than in `@marimo/runtime` because the
 * conversation index needs it too, and the dependency runs one way: `runtime`
 * imports `agent`, not the reverse. It needs nothing but `node:fs`, so it can.
 */
export {
  assertWritable,
  DOCUMENT_VERSION,
  DocumentTooNewError,
  quarantineDocument,
  readVersionedDocument,
} from './migrations.js';
export type {
  DocumentRead,
  DocumentMigration,
  ReadVersionedOptions,
} from './migrations.js';
export type {Skill} from './skills/index.js';
export {
  resolveInsideWorkspace,
  PathOutsideWorkspaceError,
} from './tools/paths.js';
/*
 * The walk, shared by the literal search and whatever indexes the same folder.
 *
 * One definition of which files are in a folder, because two would be a file the
 * agent can recall but not quote — or the reverse, which is worse: a file it
 * quotes in a result and never finds again by meaning.
 */
export {
  MAX_FILE_BYTES,
  MAX_FILES_SCANNED,
  SKIPPED_DIRECTORIES,
  walkFiles,
} from './tools/walk.js';
export type {WalkOptions, WalkResult} from './tools/walk.js';
export type {AgentConfig, DreamConfig} from './config.js';
/*
 * Dream-RSI: the recorder, the step controller, and the offline replay.
 *
 * One `export *` rather than a list, because the module is one feature with a
 * documented boundary — see `dream/index.ts` — and a re-export list here would be
 * a second place to update whenever a policy primitive is added. The filesystem
 * is deliberately not part of it: the recorder takes a sink, and the runtime owns
 * the path.
 */
export * from './dream/index.js';
export {iterateSseData} from './models/sse.js';
export {
  normalizeSchema,
  systemInstructionToText,
  toOpenAiMessages,
  toOpenAiTools,
} from './models/openai-mapping.js';
export type {
  OpenAiMessage,
  OpenAiTool,
  OpenAiToolCall,
} from './models/openai-mapping.js';
/*
 * The v2 harness contract. It is exported beside the old core while the rewrite
 * lands, so the runtime can resolve turns against it without a second package.
 * The old `AgentConfig` and `AgentHost` exports go when the engine that uses
 * this replaces them.
 */
export * from './harness/index.js';
/*
 * The v2 turn engine and its log. The driver seam is exported because a test and
 * a future transport both implement it; the event store seam is exported because
 * the file-backed implementation lives in `@marimo/runtime`.
 */
export {
  TurnBusyError,
  GateNotFoundError,
  TurnEngine,
} from './engine/turn-engine.js';
export type {
  ApproveParams as EngineApproveParams,
  EngineUpdate,
  RunParams,
  TurnEngineOptions,
} from './engine/turn-engine.js';
export {MemoryEventStore} from './engine/event-store.js';
export type {EventStore} from './engine/event-store.js';
export type {
  DriverEvent,
  DriverResume,
  DriverRun,
  GateDecision,
  TurnDriver,
} from './engine/driver.js';
export {
  decisionsIn,
  newestTurnEvents,
  newestTurnId,
  parseSessionEvent,
  pendingGatesIn as pendingGatesFromLog,
  roundDecided,
  turnIdOf,
} from './engine/events.js';
export type {SessionEvent, TokenUsage} from './engine/events.js';
/*
 * The real driver and the tools it can offer. ADK stays behind this export: the
 * runtime builds a driver, never an ADK object.
 */
export {AdkDriver, adkAgentName} from './engine/adk-driver.js';
export type {AdkDriverOptions} from './engine/adk-driver.js';
export {CORE_TOOLS, gateFor, toolsFor} from './engine/core-tools.js';
export type {AnyToolDefinition} from './engine/core-tools.js';
export {describeToolError, outcome} from './engine/tool-contract.js';
export type {
  ToolContext,
  ToolDefinition,
  ToolOutcome,
} from './engine/tool-contract.js';
export {composeHarnessInstruction} from './context/instruction.js';
