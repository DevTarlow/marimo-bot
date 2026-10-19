/**
 * The single typed contract between the Marimo Desktop main process and its
 * renderer.
 *
 * Both sides import this module: the main process validates every inbound call
 * with `callSchemas`, and the renderer gets compile-time checking for the same
 * calls through `MarimoBridge`. Nothing here depends on Electron, Node, or
 * React, so it can be reused by a future CLI or test harness.
 */
import {z} from 'zod';

import {botDraftSchema} from './bots.js';
import type {BotTemplate} from './bots.js';
import {parseCron} from './cron.js';
import {mcpServerSchema, mcpServersAreDistinct} from './mcp.js';
import {
  providerIdSchema,
  providerKeyStorageSchema,
  providersPatchSchema,
  providersSchema,
} from './providers.js';
import type {ProviderId} from './providers.js';

/*
 * The starter bots and the two texts a bot is seeded with. They live in their
 * own module because they are a catalogue with its own shape and its own tests,
 * and because this file is the IPC contract rather than a place for prose.
 */
export {
  availableBotTemplates,
  BOT_BUILDER_OPENING,
  BOT_DRAFT_PERSONA_MAX,
  BOT_TEMPLATES,
  botDraftSchema,
  botPersonaFor,
  botRoleFor,
  botTemplateById,
  DEFAULT_BOT_PERSONA,
  DRAFT_BOT_TOOL,
} from './bots.js';
export type {BotDraft, BotTemplate} from './bots.js';

export {describeCron, nextCronRun, nextRunAfter, parseCron} from './cron.js';
export type {CronSpec} from './cron.js';

/*
 * The approval summary is here rather than in the renderer because the window's
 * card and the Discord message both have to say the same thing about a gate.
 */
export {meaningfulHint, summarizeApproval} from './approval.js';
export type {ApprovalPreview} from './approval.js';

/*
 * MCP servers, the documents that describe them, and the naming rule that keeps
 * their tools from colliding with this app's own.
 */
export {
  MCP_SERVER_NAME_HELP,
  MCP_SERVER_NAME_PATTERN,
  mcpSecretRefSchema,
  mcpServerSchema,
  mcpToolName,
  mcpToolPrefix,
  mcpTransportSchema,
} from './mcp.js';
export type {McpSecretRef, McpServer, McpTransport} from './mcp.js';
import type {McpServer} from './mcp.js';

/* -------------------------------------------------------------------------- */
/* Providers                                                                   */
/* -------------------------------------------------------------------------- */

/*
 * The model backends this app can talk to, their descriptors, the settings
 * schemas that choose one, and the rules about how a key is kept.
 *
 * It is its own module rather than a block in this file because it is a
 * catalogue with its own shape and its own tests, and because this file is the
 * IPC contract: what every provider *is* belongs beside the shapes that carry it
 * rather than in the middle of them.
 */
export {
  activeProvider,
  DEFAULT_PROVIDER_ID,
  defaultProviders,
  fallbackModelsFor,
  PROVIDER_IDS,
  PROVIDER_KEY_STORAGE,
  providerConfigSchema,
  providerDescriptor,
  providerIdSchema,
  providerKeyStorageSchema,
  PROVIDERS,
  providersPatchSchema,
  providersSchema,
} from './providers.js';
export type {
  ProviderConfig,
  ProviderDescriptor,
  ProviderId,
  ProviderKeyStorage,
  Providers,
  ProvidersPatch,
} from './providers.js';

/**
 * The things the window can do to a conversation, as opposed to things said
 * *in* it.
 *
 * Most commands act on the conversation rather than sending anything: the answer
 * is a result, not a turn. `learn` is the exception, and the exception is the
 * point — it sends one fixed instruction asking the model to write down the
 * repeatable part of the conversation as a skill. What to write down is the
 * model's judgement about a conversation it just had, so a handler that invented
 * the wording would be choosing the skill's text for the person who has to
 * review it.
 *
 * The catalogue is one declaration here for the reason the model id is: the
 * Settings switch, the `+` menu and the call that runs it are all keyed off it,
 * so adding a command is one entry and one handler rather than a string typed out
 * in three places.
 *
 * `compact` is the first because it is the one that makes long conversations
 * usable: it replaces the older messages with a summary the model writes, so the
 * request stops growing while the file keeps everything.
 */
export const COMMAND_IDS = ['compact', 'learn'] as const;
export const commandIdSchema = z.enum(COMMAND_IDS);
export type CommandId = z.infer<typeof commandIdSchema>;

export interface CommandDescriptor {
  /** What the switch and the menu item say. */
  label: string;
  /**
   * What it does, said to the person deciding rather than to the model — the
   * same division as a tool's `blurb` and its `description`.
   */
  blurb: string;
  /**
   * The message a command sends, for the one command that sends one.
   *
   * Written here rather than in the window so the instruction is reviewed with
   * the command it belongs to, and there is no second copy for the two to
   * disagree about.
   */
  instruction?: string;
}

export const COMMANDS: Record<CommandId, CommandDescriptor> = {
  compact: {
    label: 'Compact history',
    blurb:
      'Replaces the older part of a conversation with a summary the model ' +
      'writes, so a long chat still fits. Every message stays in the ' +
      'conversation file; the transcript shows one card where they were.',
  },
  learn: {
    label: 'Learn a skill',
    blurb:
      'Asks the bot to turn the repeatable part of this conversation into a ' +
      'skill it can load next time. It has to write the skill with its ' +
      'save_skill tool, so that tool has to be switched on for this bot.',
    instruction:
      'Look back over this conversation and save the repeatable part of it as ' +
      'a skill with `save_skill`. Write the method rather than this one case: ' +
      'the steps, the tools or files they use, and what to check before ' +
      'finishing. Give it a short kebab-case name and a one-line description ' +
      'that says when to use it. If there is nothing repeatable yet, say so ' +
      'instead of saving one.',
  },
};

/* -------------------------------------------------------------------------- */
/* Appearance                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * How the window decides its colours.
 *
 * `system` is the default and is not the same as "dark": it means the app has no
 * opinion and follows the OS, which can change while the app is running. The
 * resolved answer is reported separately in `AppInfo`, so a window never has to
 * guess which way `system` went.
 */
export const THEME_MODES = ['system', 'light', 'dark'] as const;
export const themeModeSchema = z.enum(THEME_MODES);
export type ThemeMode = z.infer<typeof themeModeSchema>;

/** Which way the OS (or the user) actually went. */
export const themeSchema = z.enum(['light', 'dark']);
export type Theme = z.infer<typeof themeSchema>;

/**
 * How the window looks.
 *
 * A theme and nothing else. The project this was extracted from carried a
 * background image, an accent colour and a UI scale here as well; all three had
 * settings, tests and no reader — no window ever drew them — so they went with
 * the features they belonged to. A field that is stored, validated and never
 * read is worse than a missing one, because it looks like a working feature from
 * the settings screen.
 */
export const appearanceSchema = z.object({
  /**
   * Light, dark, or whatever the machine is set to.
   *
   * A preference rather than a reading: `system` is the default and is resolved
   * against the OS at the moment it is drawn, so a machine that switches to dark
   * at sunset takes the window with it.
   */
  theme: themeModeSchema,
});

export type Appearance = z.infer<typeof appearanceSchema>;
export const appearancePatchSchema = appearanceSchema.partial();

export function defaultAppearance(): Appearance {
  return {
    // Follows the machine until told otherwise, which is what most people want
    // and what a window should do before anybody has an opinion about it.
    theme: 'system',
  };
}

/**
 * The custom scheme the renderer loads app-owned images through.
 *
 * An uploaded bot icon lives in the user-data directory, which the renderer
 * cannot read: it is sandboxed, and in development it is served from
 * `http://localhost`, so a `file://` URL would be blocked by both the origin and
 * the CSP. A scheme of the app's own is registered in the main process and
 * allowed in `img-src`, so the same picture arrives in development and in a
 * packaged build.
 *
 * Both sides build the URL, so the literal lives here rather than in either one.
 */
export const ASSET_SCHEME = 'marimo-asset';

/**
 * `marimo-asset://bot/<profile id>.png?v=<version>`.
 *
 * The version is what makes a replacement show up: the URL a browser cached is
 * now a different URL, so no cache-busting header or reload dance is needed. The
 * profile id is percent-encoded because it is the path, and the query is ignored
 * by the handler — it exists only to make the URL distinct.
 */
export function botAvatarUrl(profileId: string, version: string): string {
  return `${ASSET_SCHEME}://bot/${encodeURIComponent(profileId)}.png?v=${encodeURIComponent(version)}`;
}

/*
 * MCP server documents used to be declared here, as a stub with an `id`, a
 * `name`, an `enabled` flag and a transport. They now live in `./mcp.ts` with
 * the two things the stub could not express and the plan needs: a per-server
 * `trusted` flag, which is what decides whether that server's tools ask before
 * they run, and `headers`, which is the only way to authenticate against a
 * remote server at all.
 */

/**
 * What the settings file holds about Discord.
 *
 * The token is deliberately absent: it is a secret, it lives in the OS keychain,
 * and nothing about it crosses to the window. Everything here is either a choice the
 * user made or a name Discord reported back, kept so the dialog can describe the
 * connection without a network round trip.
 */
export const discordSettingsSchema = z.object({
  /** Connect at launch and watch `channelId` for mentions of the bot. */
  enabled: z.boolean(),
  /** The channel the agent watches, and its default destination when sending. */
  channelId: z.string(),
  /** That channel's name, as Discord reports it, so the dialog can show it. */
  channelName: z.string(),
  /** The guild the channel is in, for the same reason. */
  guildName: z.string(),
  /**
   * Post the agent's answer back to the channel when it is mentioned.
   *
   * Off means a mention is still picked up — the agent runs and the conversation
   * appears in the sidebar — but nothing is posted on the user's behalf.
   */
  autoReply: z.boolean(),
  /** The bot's own account, learned when the token was verified. */
  botUserId: z.string(),
  botName: z.string(),
});

export type DiscordSettings = z.infer<typeof discordSettingsSchema>;

/** Discord is off until the user sets it up: a bot needs a token first. */
export function defaultDiscordSettings(): DiscordSettings {
  return {
    enabled: false,
    channelId: '',
    channelName: '',
    guildName: '',
    // Mentions are the whole point of connecting a bot, so answering them is the
    // default once the user turns the connection on.
    autoReply: true,
    botUserId: '',
    botName: '',
  };
}

/**
 * How verbose the companion's answers are.
 *
 * Three named sizes rather than a number of words. The setting is a sentence
 * added to the instruction, and a slider would only be a way of choosing one of
 * three sentences with a number nobody could predict the meaning of.
 */
export const COMPANION_ANSWER_LENGTHS = [
  'brief',
  'balanced',
  'detailed',
] as const;
export const companionAnswerLengthSchema = z.enum(COMPANION_ANSWER_LENGTHS);
export type CompanionAnswerLength = z.infer<typeof companionAnswerLengthSchema>;

/**
 * What the settings file holds about the floating companion.
 *
 * A block rather than four flat fields because these are the four answers to one
 * question — what the moss ball does — and the settings screen draws them as one
 * section.
 *
 * **Answer length is not layout state.** It is a turn instruction: the companion
 * shares the conversation with the window, so the only thing that can make its
 * answers shorter is saying so to the model on the turns it asked for. The other
 * three are facts about the window itself, applied by the process that owns it.
 */
export const companionSettingsSchema = z.object({
  /**
   * How the agent answers when the question was asked at the moss.
   *
   * `brief` is the default because that is what the companion is for: a
   * question asked over whatever the user is working in wants the answer, not a
   * survey of the subject. The main window is unaffected — the length travels
   * with the turn, not with the conversation.
   */
  answerLength: companionAnswerLengthSchema,
  /** How many of the most recent messages float above the moss. */
  visibleMessages: z.number().int().min(1).max(20),
  /**
   * Whether the moss floats above other windows.
   *
   * On is what a desktop pet is for. Off is for the case where being above
   * everything is worse than being found: a full-screen window, a video, a
   * presentation.
   */
  alwaysOnTop: z.boolean(),
  /**
   * Whether the window stops accepting the mouse where there is nothing to click.
   *
   * On is the default and is what makes it sit *on* the desktop: without it the
   * companion is a 340×460 rectangle swallowing every click on the things behind
   * it. Off is the escape hatch for a machine where the pointer tracking
   * misbehaves — the window then behaves like an ordinary small window over
   * whatever is behind it.
   */
  clickThrough: z.boolean(),
});

export type CompanionSettings = z.infer<typeof companionSettingsSchema>;

export function defaultCompanionSettings(): CompanionSettings {
  return {
    answerLength: 'brief',
    // What the companion showed before this was adjustable.
    visibleMessages: 6,
    alwaysOnTop: true,
    clickThrough: true,
  };
}

/** A patch of the block: any subset, merged over what is stored. */
export const companionSettingsPatchSchema = companionSettingsSchema.partial();

/** The bot's own account, as `GET /users/@me` reports it. */
export interface DiscordBot {
  id: string;
  name: string;
}

/** One channel the bot may post to, flattened to what the picker needs. */
export interface DiscordChannel {
  id: string;
  name: string;
  /** Guild name; empty for a direct message channel. */
  guild: string;
}

/** One message, flattened to what the agent needs to read. */
export interface DiscordMessage {
  id: string;
  /** Display name of whoever wrote it. */
  author: string;
  content: string;
  createdAt: string;
  /** Whether the author is a bot, so the agent can tell its own posts apart. */
  bot: boolean;
}

/**
 * Whether the app is connected to Discord right now.
 *
 * Reported separately from the settings because it changes on its own: the
 * gateway drops, Discord refuses the token, the network goes away. `detail` is
 * what the dialog shows under the badge when the state is not `online`.
 */
export type DiscordConnectionState = 'off' | 'connecting' | 'online' | 'error';

export interface DiscordConnectionStatus {
  state: DiscordConnectionState;
  /** The bot's name once Discord has confirmed the token; empty before that. */
  botName: string;
  /** Why it is not online, when it is not. */
  detail: string;
}

/**
 * The size and position of the app window, as the last close left them.
 *
 * The bounds are not clamped here. A window is moved and resized by the window
 * manager, so the numbers that arrive are the OS's own and can legitimately
 * describe a display that is no longer attached; deciding what to do about that
 * needs to know about displays, which belongs to the process that owns the
 * window rather than to the settings file. This schema only refuses values that
 * cannot describe a window at all.
 */
export const windowStateSchema = z.object({
  width: z.number().int().min(200).max(20_000),
  height: z.number().int().min(200).max(20_000),
  /** Null means "no position to restore, let the OS place it". */
  x: z.number().int().min(-20_000).max(20_000).nullable(),
  y: z.number().int().min(-20_000).max(20_000).nullable(),
});

export type WindowState = z.infer<typeof windowStateSchema>;

/**
 * The bounds and default of the memory soft limit, shared by the schema above
 * and anything that has to fall back to a limit without reading settings.
 *
 * Exported rather than written twice because the agent's warning and the
 * settings file's default must be the same number: a default the prompt quotes
 * and the settings dialog draws differently is the sort of disagreement nobody
 * notices until the warning fires at the wrong size.
 */
export const MEMORY_SOFT_LIMIT_MIN_BYTES = 4 * 1024;
export const MEMORY_SOFT_LIMIT_MAX_BYTES = 32 * 1024;
export const DEFAULT_MEMORY_SOFT_LIMIT_BYTES = 8 * 1024;

/**
 * How much unreviewed conversation a session may accumulate before the idle
 * look stops waiting for the conversation to end.
 *
 * In *events*, which is the same unit as the review watermark — deliberately, so
 * the number the user sets and the number the store keeps are the same number
 * rather than two that have to be converted. One exchange is roughly five to
 * six events (the user's message, an assistant message, and a tool call with its
 * result), so the default of 40 is about seven turns.
 *
 * The default is a judgement, and the reason it is not lower is on both sides of
 * it. A review costs a model call competing with the chat model on a local
 * install, so reviewing every turn would spend a second request per message. And
 * waiting for a full minute of silence — which is what the idle timer does, and
 * what a real conversation usually reaches — loses nothing at all. This number
 * only decides the case in between: a session that is still going after enough
 * turns that a fact mentioned early would otherwise be unremembered for as long
 * as it continues.
 *
 * The floor is where a review would be reading back less than one exchange; the
 * ceiling is high enough that a user who wants the old behaviour of "only when
 * the conversation ends" can have it by setting it past any realistic session.
 */
export const MEMORY_REVIEW_EVENTS_MIN = 10;
export const MEMORY_REVIEW_EVENTS_MAX = 500;
export const DEFAULT_MEMORY_REVIEW_EVENTS = 40;

/**
 * The size a first launch opens at, and the window's own bounds in the CSS
 * pixels Electron reports.
 *
 * `x`/`y` are null rather than a number so the first window is placed by the OS,
 * which is the only thing that knows what else is on the screen.
 */
export function defaultWindowState(): WindowState {
  return {width: 1180, height: 780, x: null, y: null};
}

/**
 * Recall: the embedding model, and what of it this install uses.
 *
 * **Off until the user asks for it**, because turning it on downloads 310 MB and
 * starts a second engine process. Discord is off for the same reason — a fresh
 * install makes no network calls it was not asked to make — and a model download
 * nobody asked for is that failure with a bigger number attached.
 *
 * The two corpora are separate switches because they are separate consents. The
 * folder is the user's work; memory is what the agent has written *about* them,
 * and somebody who wants "find my file about retries" may reasonably not want
 * their remembered preferences indexed alongside it. `memory` defaults on because
 * it is the half that changes what the agent is told on every request, which is
 * the reason to turn the feature on at all.
 */
export const recallSettingsSchema = z.object({
  /*
   * No `.catch` on any of them, unlike the flat fields above. A block that does
   * not validate is replaced *whole* by the settings store, which is the same
   * leniency by a different route — and the defaults it lands on are off, which
   * is the state that downloads nothing and starts nothing.
   */
  enabled: z.boolean(),
  memory: z.boolean(),
  workspace: z.boolean(),
  /**
   * Whether the user's own conversations are part of the index.
   *
   * A third consent beside the folder and memory, and the one somebody is most
   * likely to want to decline: a folder is the work, memory is what the agent
   * wrote about them, and a conversation is everything they said. It defaults on
   * for the same reason memory does — the feature exists to answer questions
   * about *them* — but it is a switch rather than a consequence of `enabled`,
   * because the two are different promises.
   */
  conversations: z.boolean(),
  /**
   * Whether images, audio and video are part of it.
   *
   * Off, and unlike the others that is not a preference: media needs the
   * projector, a 555 MB second download, and without it in the engine process
   * there is no image encoder at all — so a picture is not a slower answer, it is
   * one the engine cannot give. Switching it on is what offers that download.
   */
  media: z.boolean(),
  /**
   * Whether questions about this folder are asked the model's *code* way.
   *
   * The model was trained with two query prompts and identical document prompts:
   * `task: search result` for prose and `task: code retrieval` for code, where the
   * second scores better on code-only corpora. There is no way to tell which one a
   * question wants — "why does the upload keep failing" is equally about a file
   * and about a function — so this is the user's answer about their folder rather
   * than a guess made per query. Off by default: a wrong guess is invisible in a
   * result list, and prose is the safer thing to be wrong about.
   */
  codeQueries: z.boolean(),
  /**
   * Whether the first-run card has been answered, either way.
   *
   * Not consent and not a switch: `enabled` is the feature and this is the
   * question about it. It exists because the card is asked *once* — the moment a
   * download finishes — and "once" cannot be derived from anything else in this
   * document. `enabled: false` is as true of somebody who pressed "Not now" as it
   * is of somebody who has never been asked, and the next model download would
   * ask them again. Written when the card is answered, never read by the model or
   * by the window's chat surface.
   */
  introSeen: z.boolean(),
});

export type RecallSettings = z.infer<typeof recallSettingsSchema>;

/** The two downloads: the backbone, and the projector that makes media possible. */
export const RECALL_PIECES = ['text', 'media'] as const;
export const recallPieceSchema = z.enum(RECALL_PIECES);
export type RecallPiece = z.infer<typeof recallPieceSchema>;

/** The corpora the window may ask about. */
export const RECALL_QUERY_SCOPES = [
  'folder',
  'memory',
  'conversation',
  'media',
] as const;
export const recallScopeSchema = z.enum(RECALL_QUERY_SCOPES);
export type RecallScopeName = z.infer<typeof recallScopeSchema>;

/**
 * The recall model, as the card draws it.
 *
 * Its own status rather than a reuse of `EngineStatus`, because the two engines
 * are different things: this one has two possible downloads, can be *absent*
 * because a switch is off rather than because a file is missing, and carries a
 * count of what it has indexed — which is the number that tells a user whether
 * the thing they turned on has done anything yet.
 */
/**
 * One thing a search found, with its text already verified.
 *
 * `text` is what the source says *now* — the service re-reads each hit and checks
 * it against the digest stored with its vector — and `stale` is the other answer:
 * the file changed since it was indexed, so the text is empty and the result says
 * so rather than quoting a copy that no longer exists.
 */
export interface RecallQueryHit {
  kind: 'text' | 'memory' | 'conversation' | 'media';
  path: string;
  startLine?: number;
  endLine?: number;
  section?: string;
  /** Conversation only: the id of the conversation this passage came from. */
  sessionId?: string;
  /** Conversation only: the conversation's title, for the result list. */
  title?: string;
  preview: string;
  /** Cosine similarity. Not comparable between modalities — see the card. */
  score: number;
  text: string;
  stale: boolean;
}

export interface RecallQueryResult {
  hits: RecallQueryHit[];
  /** The corpora that were actually searched, which may be less than asked. */
  searched: string[];
  /** Sentences to show beside the results: a cap reached, a file unreadable. */
  notes: string[];
  index: RecallModelStatus['index'];
}

export interface RecallModelStatus {
  /** Whether the user has switched recall on. Nothing downloads until they do. */
  enabled: boolean;
  /** Whether images and audio are part of it, which needs the projector. */
  media: boolean;
  state: 'off' | 'starting' | 'ready' | 'failed';
  detail?: string;
  /** Which pieces are on disk, at their pinned size. */
  enginePresent: boolean;
  textPresent: boolean;
  projectorPresent: boolean;
  /** Bytes each piece is, for the button that names the download. */
  sizeBytes: {engine: number; text: number; media: number};
  /** Exactly what the app runs, once something is running. */
  command: string[];
  log: string[];
  /** What is being downloaded, when something is. */
  installing?: {
    piece: RecallPiece;
    label: string;
    receivedBytes: number;
    totalBytes: number;
    percent?: number;
  };
  /** What the index holds for the folder the window is looking at. */
  index: {
    builtAt?: string;
    records: number;
    chunks: number;
    memory: number;
    conversations: number;
    media: number;
    changed: number;
  };
}

export function defaultRecallSettings(): RecallSettings {
  return {
    enabled: false,
    memory: true,
    workspace: true,
    conversations: true,
    media: false,
    codeQueries: false,
    // False for an existing install, which is what makes the card appear once
    // after this field was added — and never again, because the card writes it.
    introSeen: false,
  };
}

/* -------------------------------------------------------------------------- */
/* Dream-RSI                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * How far the search controller may explore, and when it starts pruning.
 *
 * These are the two numbers the whole feature turns on, and they are here rather
 * than inside the agent because they are the thing a person changes. Everything
 * else about Dream-RSI is machinery: the recorder writes what happened, the
 * replay reads it back, and neither has a knob worth turning.
 *
 * The bounds are deliberately wide and the defaults deliberately conservative.
 * An exploration weight of zero is a controller that only ever repeats its best
 * observed action — a real, describable strategy, and the right thing to be able
 * to ask for. A pruning threshold above one prunes every action whose reward is
 * not a certain success, which is a way to make the agent give up rather than a
 * way to make it efficient; it is allowed because a bound the user can reach and
 * measure is better than a clamp that hides what they asked for.
 */
export const DREAM_EXPLORATION_MIN = 0;
export const DREAM_EXPLORATION_MAX = 4;
/**
 * What the controller explores with before it has watched anything.
 *
 * UCB1 divides by the visit count, so an action nobody has tried is undefined
 * rather than infinite — and the first tool call of a turn is exactly that case.
 * At `1` an untried action ties with a proven one, which keeps the opening move
 * the model's choice rather than the controller's; at `0` an untried action
 * never wins and the agent is stuck on whatever it tried first.
 */
export const DEFAULT_DREAM_EXPLORATION_WEIGHT = 1;

/**
 * Below what mean reward an action is no longer offered to the model.
 *
 * `-1` is "prune nothing" — and it is the default, which is the safe direction.
 * The failure mode of pruning too eagerly is invisible from the outside: the
 * agent answers from less than it could have, competently and wrongly. The
 * failure mode of pruning too little is a slow turn. So the feature ships on the
 * side where being wrong costs time rather than truth.
 *
 * `0` is the interesting setting and the one worth measuring with the replay: it
 * prunes anything that has not yet earned a positive reward, which on a tool
 * that fails is exactly right and on a tool that has simply not been tried yet
 * is exactly wrong. The recorder is what makes that answerable rather than
 * arguable.
 */
export const DEFAULT_DREAM_PRUNING_THRESHOLD = -1;
export const DREAM_PRUNING_MIN = -1;
export const DREAM_PRUNING_MAX = 1;

/** How many tree logs to keep before the oldest is dropped. */
export const DEFAULT_DREAM_KEEP_LOGS = 200;
export const DREAM_KEEP_LOGS_MIN = 1;
export const DREAM_KEEP_LOGS_MAX = 5000;

/**
 * How many bytes of a tool result one tree node may hold.
 *
 * A node is a record of a decision, not a copy of the corpus: `read_file` on a
 * large source file returns more than an entire tree should weigh, and a log
 * nobody can open is a log nobody replays. What is kept is the head of the
 * result, which is where a tool's own verdict lives — a JSON error, a count, a
 * path — and the true length is recorded beside it so a truncated node still
 * says how much it is not showing.
 */
export const DEFAULT_DREAM_RESULT_BYTES = 256;
export const DREAM_RESULT_BYTES_MIN = 0;
export const DREAM_RESULT_BYTES_MAX = 8192;

/**
 * Dream-RSI: recording what the agent did, and searching it offline.
 *
 * Off by default, and the default is load-bearing rather than cautious. Turning
 * it on writes one file per turn — every tool call, its arguments and the head
 * of its result — which is a record of the user's work that did not exist
 * before. It is not a secret and it never leaves the machine, but it is theirs
 * to agree to, in the same way recall's three consents are.
 *
 * The block exists as soon as the *settings* are read rather than when the
 * feature is switched on, because a fresh install has to be able to describe the
 * state it is in: "off, and here is what it would do".
 */
export const dreamSettingsSchema = z.object({
  /*
   * No `.catch`, for the reason the recall block has none: a block that does not
   * validate is replaced *whole* by the settings store, and the defaults it
   * lands on are off — the state that writes nothing.
   */
  enabled: z.boolean(),
  /**
   * How much weight the controller gives to actions it has not tried.
   *
   * Zero is a controller that exploits only; the upper bound is well past the
   * point where a turn has enough steps for exploration to pay for itself, and
   * is here so the field has a defined range rather than none.
   */
  explorationWeight: z
    .number()
    .min(DREAM_EXPLORATION_MIN)
    .max(DREAM_EXPLORATION_MAX),
  /** Mean reward below which an action stops being offered. See above. */
  pruningThreshold: z
    .number()
    .min(DREAM_PRUNING_MIN)
    .max(DREAM_PRUNING_MAX),
  /** How many turns' trees to keep on disk, oldest dropped first. */
  keepLogs: z
    .number()
    .int()
    .min(DREAM_KEEP_LOGS_MIN)
    .max(DREAM_KEEP_LOGS_MAX),
  /** Bytes of a tool's result kept per node, for the reason above. */
  resultBytes: z
    .number()
    .int()
    .min(DREAM_RESULT_BYTES_MIN)
    .max(DREAM_RESULT_BYTES_MAX),
});

export type DreamSettings = z.infer<typeof dreamSettingsSchema>;

export function defaultDreamSettings(): DreamSettings {
  return {
    // Off, so a fresh install records nothing about anybody.
    enabled: false,
    explorationWeight: DEFAULT_DREAM_EXPLORATION_WEIGHT,
    // Prune nothing. See the constant: the safe direction is the slow one.
    pruningThreshold: DEFAULT_DREAM_PRUNING_THRESHOLD,
    keepLogs: DEFAULT_DREAM_KEEP_LOGS,
    resultBytes: DEFAULT_DREAM_RESULT_BYTES,
  };
}

/**
 * Settings are what applies to the app as a whole: how it looks, how literal the
 * model's wording is, and the escape hatches. Anything about *an agent's*
 * behaviour — who it is, which folder it works in, which tools it may use — lives
 * in a profile below, because that is the unit the user switches between.
 *
 * There is nothing here about *which* model answers. The app carries one, so
 * there is no address, no key and no model id to choose — and a settings file
 * that named a service is a file from a build that had a catalogue, which the
 * schema simply strips.
 */
export const settingsSchema = z.object({
  /**
   * Whether the setup flow has had its turn.
   *
   * The flow that makes a first bot, loads a Space and points the app at a
   * provider is a *first run*, and a first run is a fact rather than a state
   * that can be recomputed: an install with no key looks the same on its first
   * launch and on its fiftieth, and the difference that matters is whether
   * somebody has already been walked through it. Without this, a user who chose
   * "set this up later" would be handed the wizard again every time they opened
   * the app, and a user whose key stopped being readable would be asked to name
   * their first bot a second time.
   *
   * True means the flow has run or been declined; it is not a claim that the app
   * can answer. `modelReady` is that claim, and it is the main process's.
   *
   * `.catch` for the reason the two list fields have it: this is flat, so a
   * hand-edited value that is not a boolean would otherwise fail the whole
   * settings parse and cost the user every other preference they have. Falling
   * back to false offers the flow once more, which is the cheap direction.
   */
  setupSeen: z.boolean().catch(false),
  /** Background, accent and text size: how the app looks, not what it does. */
  appearance: appearanceSchema,
  /**
   * Which service answers, and what each one was last set to.
   *
   * The app's default, and the fallback for an agent that has no model of its
   * own: an agent may name its own provider and model, and a conversation may
   * override both, but every request resolves through this block when neither
   * says anything.
   *
   * It is here rather than per profile because a provider key is one key for the
   * install: a second agent using the same service must not need a second copy of
   * the credential.
   */
  providers: providersSchema,
  maxOutputTokens: z.number().int().positive().optional(),
  /** Opt-in escape hatch for `http_fetch` hitting loopback/private hosts. */
  allowPrivateNetworkFetch: z.boolean(),
  /**
   * The MCP servers this install knows about.
   *
   * Uniqueness is enforced here rather than on the entry schema because neither
   * rule is a property of one server — it takes the whole list to see a
   * duplicate name or a repeated id — and both are worth catching at the door: a
   * duplicated name would offer two sets of identically-named tools.
   */
  mcpServers: z.array(mcpServerSchema).superRefine((servers, context) => {
    for (const problem of mcpServersAreDistinct(servers)) {
      context.addIssue({
        code: 'custom',
        path: [problem.index, problem.field],
        message: problem.message,
      });
    }
  }),
  /**
   * The Discord bot. Here rather than on a profile because there is one token,
   * one gateway connection and one watched channel for the whole app; whether an
   * agent may *use* Discord is a tool checkbox, like every other tool.
   */
  discord: discordSettingsSchema,
  /**
   * The floating companion: how it answers, and how it behaves as a window.
   *
   * Here rather than on a profile for the same reason Discord is: there is one
   * moss ball for the whole app, and "how brief is it" is a fact about the pet
   * rather than about which agent is talking.
   */
  companion: companionSettingsSchema,
  /**
   * How wide the two rails are, in pixels. Clamped here rather than trusted: a
   * width is dragged, and a drag can end anywhere including off the screen, so
   * the bounds belong to the contract rather than to the drag handler.
   */
  sidebarWidth: z.number().int().min(200).max(560),
  todosWidth: z.number().int().min(200).max(560),
  /** The jobs rail's width. Separate from `todosWidth` so each is remembered. */
  jobsWidth: z.number().int().min(200).max(560),
  /** Notes and Files have their own widths for the same reason. */
  notesWidth: z.number().int().min(200).max(560),
  filesWidth: z.number().int().min(200).max(560),
  /**
   * Whether the Files rail is open.
   *
   * The to-do and jobs rails keep this in their own documents, because each of
   * those *is* a document. The file tree is a view of whatever the active
   * workspace happens to hold, so there is nothing of its own to keep it beside
   * and it lives here with the rest of the layout.
   */
  filesOpen: z.boolean(),
  /**
   * The settings dialog's sections the user has opened, by title.
   *
   * Layout state, like the widths above, and here for the same reason: eight
   * sections expanded is a page whose shape nobody can see, so they all start
   * folded and what this remembers is the ones somebody opened to work in. The
   * *open* half rather than the folded one because the default is folded —
   * storing the closed half would mean this document listing every section just
   * to describe a fresh install.
   *
   * Free-form strings rather than an enum of the sections, because the sections
   * are the renderer's business and this is a list of names it no longer cares
   * about — a renamed section simply loses its open state instead of failing to
   * load, and adding one needs no protocol change. `.catch` for the same
   * forgivingness: this is a flat field, so without it a hand-edited file holding
   * something that is not an array would fail the whole settings schema and cost
   * the user every other setting they had.
   */
  expandedSections: z.array(z.string()).catch([]),
  /**
   * The commands the user has switched off.
   *
   * A list of the ones that are *off* rather than of the ones that are on, so a
   * command added in a later build is available to somebody who never touched
   * this setting. `.catch` for the same reason `expandedSections` has it: a
   * command renamed or removed later must cost its own row, not fail the
   * settings schema and take every other preference with it.
   */
  disabledCommands: z.array(commandIdSchema).catch([]),
  /**
   * Where the window last was, so it opens where the user left it.
   *
   * A block rather than four flat fields because the four only mean anything
   * together: a width without a height is not a window, and a position whose
   * monitor is gone has to be considered with the size to decide whether any of
   * the window would still be on screen.
   *
   * `x` and `y` are nullable and default to null, which is "let the OS place it"
   * — a fresh install has no position to restore, and neither has one whose
   * display was unplugged since.
   */
  window: windowStateSchema,
  /**
   * How large `memory.md` may get before the agent is told to prune it.
   *
   * A *soft* limit: writing past it still works and the tools say so, naming
   * this number as the target. It sits well below `MAX_MEMORY_BYTES`, which is
   * where writes start failing outright, because the point of the warning is to
   * arrive while there is still room to act on it.
   *
   * Here rather than on a profile because it is a preference about the app's
   * behaviour rather than a fact about an agent, and because memory is bounded
   * by the same hard cap for every profile — a per-profile limit would be a
   * second number to keep in range for no gain.
   *
   * Bounded and a whole KiB. The floor is where a memory holding a handful of
   * real facts stops being plausible; the ceiling is half the hard cap, so a
   * memory the user has told the agent to let grow still cannot reach the size
   * at which writes fail without crossing the warning first. The step is a KiB
   * because the control is a slider and a user thinks in kilobytes, not in the
   * 8,391 bytes a free-form field would allow them to type.
   */
  memorySoftLimitBytes: z
    .number()
    .int()
    .min(MEMORY_SOFT_LIMIT_MIN_BYTES)
    .max(MEMORY_SOFT_LIMIT_MAX_BYTES)
    .multipleOf(1024),
  /**
   * How many unreviewed events a session may hold before the look happens
   * without waiting for the conversation to go quiet.
   *
   * A power-user field rather than a slider, unlike the size limit above it: the
   * size limit is a quantity the user has a feel for because it is their own
   * words, and this is a number about the app's own bookkeeping. It still
   * belongs in Settings rather than as a constant, because "the agent proposed
   * something mid-conversation" and "it waited until I stopped" are both
   * reasonable things to want and only the user knows which one they are.
   *
   * Bounded but not stepped: this is a number typed into a field, not dragged.
   */
  memoryReviewEvents: z
    .number()
    .int()
    .min(MEMORY_REVIEW_EVENTS_MIN)
    .max(MEMORY_REVIEW_EVENTS_MAX),
  /**
   * Recall: the model that finds things by meaning, and which corpora it indexes.
   *
   * A block rather than three flat fields, for the reason the window block is one:
   * the two switches mean nothing with the feature off, and the store merges a
   * partial block over what is stored so flipping one does not mean sending the
   * others back from a stale window.
   */
  recall: recallSettingsSchema,
  /**
   * Dream-RSI: whether the agent records its own search tree, and how it
   * searches it.
   *
   * A block rather than five flat fields, for the reason `recall` is one: the
   * four numbers mean nothing with the feature off, and the store merges a
   * partial block over what is stored so moving one slider does not mean sending
   * the others back from a stale window.
   */
  dream: dreamSettingsSchema,
});

/**
 * A patch of the Discord block: any subset of it, merged over what is stored.
 *
 * `settingsSchema.partial()` alone would make the whole block optional but still
 * require every field inside it, so flipping one switch would mean sending the
 * token, the channel name and the bot's name back — and a stale window's copy of
 * those is exactly what must not win. The store merges this over the stored
 * block for the same reason.
 */
export const discordSettingsPatchSchema = discordSettingsSchema.partial();

export const settingsPatchSchema = settingsSchema.partial().extend({
  discord: discordSettingsPatchSchema.optional(),
  companion: companionSettingsPatchSchema.optional(),
  appearance: appearancePatchSchema.optional(),
  /* Any subset of the block, merged over what is stored — the reason above. */
  recall: recallSettingsSchema.partial().optional(),
  dream: dreamSettingsSchema.partial().optional(),
  providers: providersPatchSchema.optional(),
});

/*
 * `McpServer` and `McpTransport` are inferred in `./mcp.ts` and re-exported
 * above, rather than declared here as they used to be. Two ways to name one
 * shape is two ways for them to disagree, and the settings schema below is what
 * makes the shape load-bearing.
 */
export type Settings = z.infer<typeof settingsSchema>;
export type SettingsPatch = z.infer<typeof settingsPatchSchema>;

/**
 * What each endpoint last said it serves, keyed by provider.
 *
 * Out of the patchable half on purpose, and that is the whole reason this type
 * exists beside `Settings`: a list a provider reported is a *fact* rather than a
 * preference, and a window holding a copy from before a refresh would otherwise
 * be able to overwrite the newer list with its guess — silently, because both
 * writes succeed.
 *
 * **Absent means the provider has never been asked**, which is why every entry
 * is optional and why a list nobody fetched is not filled in with the
 * catalogue's `fallbackModels` here. Those names are what this build ships with
 * rather than what an endpoint said, and a window that could not tell the two
 * apart could not offer to go and ask — see `modelChoicesFor` in the renderer,
 * which is where a placeholder becomes a list to show and says so.
 */
export type AvailableModels = Partial<Record<ProviderId, string[]>>;

/**
 * The settings as they are on disk: the preferences, plus what was fetched.
 *
 * The split matters at exactly one boundary — the patch. A caller may write any
 * preference through `settings.set`; the fetched lists are written only by the
 * call that fetched them.
 */
export type StoredSettings = Settings & {availableModels: AvailableModels};

/* -------------------------------------------------------------------------- */
/* Agent profiles and workspaces                                               */
/* -------------------------------------------------------------------------- */

/**
 * A folder an agent may work in. `name` is the user's label for it; `path` is
 * the real directory, and it is the confinement root for every file tool and for
 * shell commands.
 *
 * Belongs to the install rather than to one agent: two agents asked about the
 * same project work in the same folder, and the folder is a place on the machine
 * rather than a fact about who is talking.
 *
 * The user calls one a **Space** — the thing that owns its documents, its chats
 * and its agents — and this document goes on saying `workspace` anyway. It is
 * the decision `PROVIDERS.llamacpp` makes about its id: `workspaces.json`,
 * `Workspace` and `workspaceId` are what the file, every session index entry and
 * every migration already name, so renaming them would mean a migration to reach
 * something the user reads as a Space either way. The new word lives where the
 * user reads it — labels, pickers, sentences — and never in a document.
 */
export const workspaceSchema = z.object({
  id: z.string().min(1),
  // Trimmed: a blank label would be persisted, fail the schema on the next read,
  // and take the whole document down with it.
  name: z.string().trim().min(1),
  path: z.string().min(1),
});

/**
 * The folders this install knows about, and which one is current.
 *
 * One document rather than a field on each profile, and it is deliberately its
 * own file rather than a corner of `settings.json`: it is user data with a write
 * path of its own, and a document the app rewrites when somebody loads a folder
 * should not share a file with the one holding their API-key configuration.
 *
 * `activeWorkspaceId` is the folder a *new* conversation is filed under, and the
 * fallback for a conversation whose folder has been forgotten. It is not what
 * decides where a turn runs: a conversation remembers its own folder, which is
 * what lets the rail be browsed while an answer is streaming.
 *
 * **Version 2 is a marker rather than a new shape.** The list and the current
 * pointer are unchanged; what the bump records is that the folder a fresh
 * install used to be seeded with — the home directory itself — has already been
 * moved to the app's own starting folder. Without that record the move would run
 * again on the next read, so a user who later re-added their home folder as
 * their only Space would be moved away from it a second time. The upgrade is
 * declared in `WorkspaceStore`, because it needs the old and new roots.
 */
export const workspacesFileSchema = z.object({
  version: z.literal(2),
  workspaces: z.array(workspaceSchema),
  activeWorkspaceId: z.string().nullable(),
});

export type WorkspacesFile = z.infer<typeof workspacesFileSchema>;

/**
 * Marimo Bot's Role: the app's brief for the agent the person talks to.
 *
 * The stored field is still called `identity` on the profile — changing that
 * would be a document migration for a word, and the name the person reads is
 * what matters. The window calls this **Role**, and the exact same text is what
 * Reset puts back.
 *
 * It is the *job*, not the character. The character lives in
 * `DEFAULT_AGENT_PERSONA`, which is the person's to rewrite; this half is the
 * app's, and Settings can restore it without touching a word they wrote. The
 * split is what makes the two owners real rather than a comment: a reset that
 * could also erase the person's description of how they want to be spoken to is
 * a reset nobody would dare press.
 *
 * It opens with who the agent is to this person rather than with the work,
 * because that opening is what the model narrates itself with on every turn —
 * a Role that begins "you work on their projects, in a folder" answers "hey, how
 * are you?" as an offer to organise a repository.
 *
 * Method stays out of it. The operating protocol is appended after this and is
 * written against a tool list this text cannot see, and the app's own rules —
 * what must be approved, what a paused turn means — live there too. A person
 * rewriting their Role cannot lose them, and a Role cannot advertise a tool its
 * profile does not have: the capability skills are what say what it can do.
 *
 * It is also read where no user is present: a scheduled job and a Discord
 * mention front the same Role, so it states a stance rather than a conversation.
 */
export const DEFAULT_AGENT_ROLE = [
  'You are Marimo Bot. You live on this machine, you belong to one person — the user —',
  'and you are not a service they are renting. The two of you have a history, and',
  'it keeps growing.',
  '',
  'You are not alone in here. They make bots, and each one has a name, its own',
  'instructions, its own tools and its own permissions. Those bots are yours to',
  'work with. When a job suits one of them better, or the person names one, hand',
  'it over and say so: they are talking to you, and "Writer is drafting it" should',
  'come from you rather than turn up later in a transcript. Everything else, do',
  'yourself — passing work along is not a way of being helpful.',
  '',
  'Some conversations hold more than one of you. When the person addresses a bot',
  'by name, that is who they are asking, and when they do not, they are asking',
  'you.',
  '',
  'They come to you for all of it: to work on something, to think out loud, to ask',
  'something small, or just to tell you a thing that happened. A greeting is not a',
  'request. A story is not a request. Answer the person rather than the category —',
  'react to what they actually said — and never close with "let me know if you need',
  'anything else".',
  '',
  'When there is work, it happens in a Space: one of their folders, with their',
  'documents in it and the bots they have put there. Read before you speak about',
  'their code or their setup, and when you are unsure, say so plainly — a confident',
  'guess about their life or their work is worse than a question. When a plan or a',
  'decision is on the table, take it seriously enough to argue with it: name the',
  'assumption you would otherwise share, the failure mode, and the cheaper way,',
  'then let them choose.',
  '',
  'Remember them, and remember what they tell you about their life: a name, an',
  'animal, a plan, a grudge against a piece of software. It is worth keeping',
  'because they told you, not because it is useful to a project. Their world is the',
  'point; the files are one corner of it.',
  '',
  'The persona below is theirs. It says who you are to them and how they want to be',
  'spoken to, and it beats this wherever the two disagree — but it cannot change',
  'what the app asks of you, and it cannot give you a tool you do not have.',
].join('\n');

/**
 * Marimo Bot's Persona: the character, and the person's to rewrite.
 *
 * It follows the Role and wins wherever the two disagree about manner. It is the
 * seed a fresh install starts with and the text "Use the template text" puts
 * back; it is not reset by the Role's Reset button, because the two have
 * different owners.
 *
 * It deliberately says nothing about tools or about the app's rules. Those are
 * in the Role, the operating protocol and the capability skills, where a person
 * editing their character cannot lose them.
 */
export const DEFAULT_AGENT_PERSONA = [
  'Be warm, curious and direct. Be funny when it is funny and quiet when it is',
  'not. You are not a service: you have opinions, you can disagree, and you would',
  'rather be useful than agreeable. When you are unsure, say so rather than',
  'guessing, and when the answer is short, keep it short.',
].join('\n');

/**
 * What an agent answers with, when it does not want the app's default.
 *
 * Absent means "the provider block in settings decides", which is what every
 * agent written before this field existed gets — and it stays the right answer
 * for the agent most people use: one default, chosen once.
 *
 * A pair rather than a model id alone, because a model id means nothing apart
 * from the endpoint that serves it: `glm-5.3-flash` at OpenCode Go and a file of
 * the same name on somebody's llama.cpp server are two different models, and a
 * bare string would let the app pick the wrong one silently.
 */
export const agentModelSchema = z.object({
  provider: providerIdSchema,
  model: z.string().trim().min(1),
});

export type AgentModel = z.infer<typeof agentModelSchema>;

/**
 * The icons a bot can wear without the user supplying a picture.
 *
 * Five, because a pick-list of one is not a choice and a wall of abstract shapes
 * is worse than a name. The ids are stable and are what a profile stores; the
 * labels are what Settings draws. `marimo` is first because it is the default
 * and the lead's own mark.
 */
export const BOT_AVATAR_PRESETS = [
  {id: 'marimo', label: 'Marimo'},
  {id: 'sprout', label: 'Sprout'},
  {id: 'pebble', label: 'Pebble'},
  {id: 'wave', label: 'Wave'},
  {id: 'spark', label: 'Spark'},
] as const;

export const DEFAULT_BOT_AVATAR_ID = 'marimo';

/**
 * One bot's icon, as the profile stores it.
 *
 * `kind: 'custom'` means an image the user uploaded; `id` is then the version
 * that makes a replacement's URL different from the one the browser cached.
 * `kind: 'preset'` means one of the shipped icons and `id` names it.
 *
 * Deliberately permissive about `id`: a profile written by a newer build may
 * name an icon this build does not ship, and the renderer can fall back to the
 * initial. `ProfileStore.parseFile` skips a profile the schema refuses, so
 * strictness here would cost a real bot rather than its picture.
 */
export const botAvatarSchema = z.object({
  kind: z.enum(['preset', 'custom']),
  id: z.string().min(1),
});

export type BotAvatar = z.infer<typeof botAvatarSchema>;

export const DEFAULT_BOT_AVATAR: BotAvatar = {
  kind: 'preset',
  id: DEFAULT_BOT_AVATAR_ID,
};

/**
 * The icon a profile starts with, by its position in the roster.
 *
 * The lead gets Marimo; every bot after it gets the next preset, so two bots
 * made one after the other are distinguishable in the rail without either one
 * being edited. A wrap is deliberate: the sixth bot starting at Marimo again is
 * better than a bot with no icon.
 */
export function defaultBotAvatarFor(index: number): BotAvatar {
  const preset =
    BOT_AVATAR_PRESETS[
      ((index % BOT_AVATAR_PRESETS.length) + BOT_AVATAR_PRESETS.length) %
        BOT_AVATAR_PRESETS.length
    ] ?? BOT_AVATAR_PRESETS[0];
  return {kind: 'preset', id: preset.id};
}

/**
 * An agent: its Role (the stored system prompt), its Persona, and the tools and
 * skills it is allowed to use. Switching profile is what makes the app feel like
 * a different agent, so each one also owns its conversations.
 *
 * **`identity` is the Role, and the name is historical.** The window calls it
 * Role because that is what it is: the app's brief for the bot. The field keeps
 * its old name for the reason `workspace` does — renaming it would be a document
 * migration to change a word the user never reads, and every existing file,
 * migration and comment already uses this one.
 *
 * The folders it works in are **not** here. They used to be, one list per
 * profile, and that made two agents unable to share a project and made the rail
 * impossible to read while the active agent was changing. They live in
 * `workspacesFileSchema` now, for the whole install.
 */
export const agentProfileSchema = z.object({
  id: z.string().min(1),
  name: z.string().trim().min(1),
  /** The system prompt, presented to the user as the agent's Role. */
  identity: z.string(),
  /**
   * The person's own text: the character, the job in their words, and how they
   * want to be spoken to.
   *
   * Separate from `identity` because the two have different owners. The Role is
   * the app's text: a new profile is seeded with it and Settings can restore it.
   * This is the person's, and neither the app nor the agent ever writes it — so
   * resetting the Role cannot cost them their own words, and their own words do
   * not freeze the app's text at whichever release they first edited it.
   *
   * Optional, and that is load-bearing rather than tidy. `ProfileStore.parseFile`
   * skips a profile that fails this schema, and a file whose every profile was
   * skipped is treated as unreadable: renamed aside and replaced with a fresh
   * agent. A *required* field here would quarantine every existing agent on
   * upgrade, which is why this one can never become required.
   */
  persona: z.string().optional(),
  /**
   * The starter role this bot was made from, when it was made from one.
   *
   * Kept only so Reset can restore the Role and Persona seeds that belong to
   * *this* bot: a Writer reset to Marimo Bot's text is the defect the two seeds
   * exist to prevent. Absent means a custom bot — its generic Role and its
   * Persona are still reseeded from the defaults, and its job lives in the
   * Persona where a Role reset cannot erase it.
   *
   * Optional for the reason `persona` above is optional.
   */
  templateId: z.string().min(1).optional(),
  /**
   * The draft card that created this bot, when one did.
   *
   * The transcript keeps a tool call forever, so a card revisited months later
   * would otherwise offer to create the same bot again. The card checks this
   * marker against the roster and draws its "Created" state instead. Internal:
   * nothing in the window shows it and no patch can change it.
   */
  createdFromCall: z.string().min(1).optional(),
  /**
   * The old "How to talk to me" field, read only.
   *
   * It is kept on the schema so a file written before Persona parses, and
   * `ProfileStore.parseFile` moves its text into `persona` on the way in. This
   * build never writes it, and the next profile write drops it. Removing it from
   * the schema instead would make every existing profile unparseable, which is
   * how a whole roster gets quarantined for a rename.
   */
  preferences: z.string().optional(),
  /**
   * The icon this bot is drawn with, when it has one of its own.
   *
   * Optional, and malformed values fall back to the default icon rather than
   * failing the profile. `ProfileStore.parseFile` skips a profile the schema
   * refuses, so a newer build's icon id, or a hand-edited one, must cost the
   * picture rather than the bot.
   */
  avatar: botAvatarSchema.optional().catch(undefined),
  /** Tool names this profile may use, from `profiles.catalog`. */
  enabledTools: z.array(z.string()),
  /** Skill names this profile carries, from `profiles.catalog`. */
  enabledSkills: z.array(z.string()),
  /**
   * Which connectors this agent may use.
   *
   * Absent means *every* connector the install has, which is what every profile
   * written before this field existed carries — an upgrade must not take a
   * user's connectors away from the agent that was using them. An empty array
   * means none, so absent and empty are two different answers rather than the
   * same one, exactly as they are for `enabledTools` above.
   *
   * The ids are the servers' own rather than their names: a connector can be
   * renamed without losing its grant, and a name freed by a delete cannot be
   * inherited by a new server the agent was never given.
   *
   * Optional for the reason `persona` above is optional: a required field
   * would fail this schema for every agent that already exists, and
   * `ProfileStore.parseFile` skips a profile it cannot parse — a file whose
   * profiles were all skipped is renamed aside and replaced with a fresh agent.
   */
  mcpServerIds: z.array(z.string().min(1)).optional(),
  /**
   * What this agent answers with, when it is not the app's default.
   *
   * Optional for the reason `persona` above is optional, and the reason is
   * not tidiness: a required field here would fail this schema for every agent
   * that already exists, and `ProfileStore.parseFile` skips a profile it cannot
   * parse — a file whose profiles were all skipped is renamed aside and replaced
   * with a fresh agent. The whole roster would be lost to an upgrade.
   */
  model: agentModelSchema.optional(),
  /**
   * The space this agent starts new chats in.
   *
   * Absent means "wherever the rail is", which is what every agent written
   * before this field existed gets — and it stays the right answer for the agent
   * most people use: one space, followed as they move between them. It is what
   * makes "my Writer drafts into the website repo" need no sentence in a prompt:
   * the person says it once in Settings and every new chat is filed there.
   *
   * Optional for the reason `persona` above is optional, and it is not
   * tidiness: a required field here would fail this schema for every agent that
   * already exists, and `ProfileStore.parseFile` skips a profile it cannot parse
   * — a file whose profiles were all skipped is renamed aside and replaced with
   * a fresh agent.
   */
  spaceId: z.string().min(1).optional(),
});

export const profilePatchSchema = z.object({
  name: z.string().trim().min(1).optional(),
  identity: z.string().optional(),
  /** An empty string clears it; absent leaves whatever is stored alone. */
  persona: z.string().optional(),
  /**
   * The icon, or `null` to go back to the default for this bot's place in the
   * roster. Absent leaves whatever is stored alone — the same three answers
   * `mcpServerIds`, `model` and `spaceId` carry below.
   */
  avatar: botAvatarSchema.nullable().optional(),
  enabledTools: z.array(z.string()).optional(),
  enabledSkills: z.array(z.string()).optional(),
  /**
   * This agent's connectors, or `null` for every one of them.
   *
   * Three answers in one field, and all three are needed: absent leaves the
   * grant alone, `null` clears it so the agent is offered every connector —
   * including one added afterwards — and an array names exactly the ones it may
   * use, where an empty array means none.
   *
   * The empty array is why clearing is a `null` rather than `[]`, which is the
   * same reason `model` above needs one: "this agent uses none of them" is a real
   * answer a user can give, and overloading `[]` to mean "back to all" would make
   * it impossible to express *and* impossible to store.
   */
  mcpServerIds: z.array(z.string().min(1)).nullable().optional(),
  /**
   * The agent's own model, or `null` to go back to the app's default.
   *
   * Where every other field here says "absent leaves it alone", this one has to
   * be able to *unset*: an agent moved back to the default is a real answer, and
   * without a null there would be no way to express it — the picker would only
   * ever move an agent off the default, never back onto it.
   */
  model: agentModelSchema.nullable().optional(),
  /**
   * The agent's own space, or `null` to go back to wherever the rail is.
   *
   * The third field here that has to be able to *unset*, and for the same
   * reason: "this agent works in the website repo" is a real answer a person
   * gives, and so is taking it back. Without the null the picker could only ever
   * move an agent onto a space, never off one, and the state every other agent
   * is in would be unreachable for one that had ever been pointed somewhere.
   */
  spaceId: z.string().min(1).nullable().optional(),
});

/** One entry in the pick-lists Settings renders, reported by the agent. */
export interface CatalogEntry {
  name: string;
  description: string;
}

export type Workspace = z.infer<typeof workspaceSchema>;
export type AgentProfile = z.infer<typeof agentProfileSchema>;
export type ProfilePatch = z.infer<typeof profilePatchSchema>;

/**
 * The folder list as every workspace-shaped call answers with it.
 *
 * The whole list rather than the one that changed: the rail draws all of them,
 * and a caller that had to merge a single entry into its own copy is a caller
 * that can get the order or the active folder wrong.
 */
export interface WorkspaceState {
  workspaces: Workspace[];
  activeWorkspaceId: string | null;
}

/**
 * A skill the user created, rather than one the app ships.
 *
 * The shape is the agent package's `Skill` — name, description, instructions —
 * with an id and a timestamp, because unlike the built-in skills these are the
 * user's data: they are listed in Settings, they can be deleted, and one saved
 * under a name that already exists replaces it.
 *
 * `instructions` is the whole point and is stored verbatim: it is prompt text,
 * so anything that trimmed or reformatted it would be changing the agent's
 * behaviour rather than its file.
 */
export const storedSkillSchema = z.object({
  id: z.string().min(1),
  /** Kebab-case, and what a profile's `enabledSkills` names it by. */
  name: z.string().trim().min(1),
  /** One line, for the pick-list in Settings. */
  description: z.string().trim().min(1),
  instructions: z.string().trim().min(1),
  createdAt: z.string().min(1),
});

export type StoredSkill = z.infer<typeof storedSkillSchema>;

/**
 * The longest set of instructions a skill file may hold.
 *
 * Much larger than the 8,000 this used to be, because the instructions no longer
 * ride in every request. A skill is advertised by its name and description and
 * its text is loaded on demand, so its size costs nothing until a task matches.
 * The limit stays because a file large enough to blow a context window when
 * loaded is one the model cannot use either, and a refusal with a number is a
 * better answer than a truncated procedure.
 *
 * Here rather than in the agent package because two sides need it and only one
 * of them may import that package: `save_skill` refuses an over-long skill, and
 * the Settings editor has to say the same number while the user is typing. A
 * limit enforced on one path and not the other would mean the window could write
 * a skill the tool would have refused.
 */
export const SKILL_INSTRUCTIONS_MAX = 200_000;

/**
 * The longest description, which *is* carried in every request.
 *
 * One line beside the skill's name in the prompt's available-skills list, so it
 * is what a user pays for on every turn. A description long enough to explain
 * the whole procedure is the procedure, and it would be advertised whether or
 * not the task ever called for it.
 */
export const SKILL_DESCRIPTION_MAX = 600;

/** What a skill is written from: the editor, and `save_skill`. */
export const skillDraftSchema = storedSkillSchema
  .pick({name: true, description: true, instructions: true})
  .extend({
    description: z.string().trim().min(1).max(SKILL_DESCRIPTION_MAX),
  });

export type SkillDraft = z.infer<typeof skillDraftSchema>;

/**
 * The file an older build stored user skills in.
 *
 * Read once and imported into `skills/<name>/SKILL.md`, then renamed aside; never
 * written again. It stays declared because the import has to recognise a file it
 * did not create, and a schema is how it tells "one of ours" from "something
 * else is at that path".
 */
export const skillsFileSchema = z.object({
  version: z.literal(1),
  skills: z.array(storedSkillSchema),
});

export type SkillsFile = z.infer<typeof skillsFileSchema>;

export function emptySkillsFile(): SkillsFile {
  return {version: 1, skills: []};
}

/**
 * What the renderer is allowed to see.
 *
 * No credential is here and none can be: the window is told whether a key is
 * *set* for a provider, never what it is. What it does need is the two facts only
 * the main process has — whether the app could answer a question right now, and
 * whether this machine can encrypt a key at all.
 */
export type PublicSettings = Settings & {
  /**
   * Whether the app can answer at all, right now.
   *
   * A fact only the process that resolved it can supply: it is true when the
   * active provider's model is known and its key is either unnecessary or stored
   * and readable. A window that guessed from what it can see would open a chat on
   * a machine that cannot reply.
   */
  modelReady: boolean;
  /**
   * Why not, when it is not — the sentence the welcome screen shows.
   *
   * A reason rather than a boolean, because the failures have nothing in common:
   * no key, an unreadable key and a provider this build does not know are fixed in
   * different places, and a screen that said "not ready" for all of them would be
   * a dead end for each.
   */
  modelProblem?: string;
  /**
   * Which providers have a key stored, by id. Never the key.
   *
   * A provider that needs no key reports `false` here and is not thereby
   * unusable; this says what is stored, and `requiresApiKey` on the descriptor
   * says whether that matters.
   */
  providerKeys: Partial<Record<ProviderId, boolean>>;
  /**
   * Whether this machine can encrypt a key at rest.
   *
   * False is not a failure to report as one — a local server needs no key — but
   * it is what the key card has to say before a user types a secret into a field
   * whose storage is about to refuse it.
   */
  encryptionAvailable: boolean;
  /**
   * What every provider last said it serves, by id.
   *
   * Every provider's rather than only the active one's, because a model is a
   * pair: an agent or a conversation pinned to another endpoint is offered that
   * endpoint's models, and a window given only the active provider's list is a
   * control that cannot show anything for the choice it is holding. A provider
   * absent from this record has never been asked, and the catalogue's names are
   * what a picker shows for it in the meantime.
   */
  availableModels: AvailableModels;
  /**
   * The last discovery-log write that failed, or nothing.
   *
   * Here rather than on an event for the reason `modelProblem` is here: it is a
   * fact the process that tried to write the file owns, and a window that opened
   * after the failure would otherwise draw a card claiming the agent is recording
   * when nothing has been written since. A status, not a message — the card is
   * redrawn from a payload the window reads for other reasons too, so a value that
   * cleared on read could be swallowed by a read nobody was showing.
   */
  dreamProblem?: string;
  profiles: AgentProfile[];
  activeProfileId: string;
};

/* -------------------------------------------------------------------------- */
/* Sessions and transcripts                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Where a conversation came from, when it was not started at the keyboard.
 *
 * There is one source today and it is the reason the field exists: a Discord
 * mention runs a turn the user did not type, and the rail files those under a
 * "Social" heading instead of under a folder. Where the files are and where the
 * conversation came from are different questions, and a conversation that
 * arrives on its own should not be buried inside a folder that had nothing to do
 * with it.
 */
export type SessionSource = 'discord';

/**
 * What a conversation is *for*, when it is not an ordinary chat.
 *
 * A purpose is not a second title and not a source: the setup flow starts a
 * conversation to make a bot, and every turn of it has to carry the builder's
 * own instruction or a small model drifts back into being a general assistant.
 * The stored purpose is what makes that a fact about the conversation rather
 * than a flag a reloaded window has to remember. `bot-builder` is the only value
 * today.
 */
export type SessionPurpose = 'bot-builder';

export interface SessionSummary {
  /**
   * The conversation's own id, and the only name for it that never changes.
   *
   * A UUID assigned when the conversation is created, shown and copyable from
   * its `…` menu: it is what a job, a Discord mention and an on-disk file all
   * refer to, and unlike the title it is not something anyone edits.
   */
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  /**
   * Folder this conversation was started in, recorded once when it is created.
   * The sidebar nests a conversation under the workspace it belongs to.
   *
   * It names a workspace in the install-wide `workspaces.json`, and it is what
   * decides where a turn runs. Absent for conversations that predate
   * workspaces, and deliberately left dangling when a folder is removed: such a
   * chat is still listed, under "Other chats", rather than vanishing with the
   * folder — and its next turn falls back to the active workspace.
   */
  workspaceId?: string;
  /**
   * Set when the app, rather than the user, started the conversation — a Discord
   * mention, today. Such a conversation is listed under its source's own section
   * and never under a folder, whatever `workspaceId` happens to say.
   */
  source?: SessionSource;
  /**
   * What this conversation is for, when it is not an ordinary chat.
   *
   * The window reads it to draw the builder's opening card and the runtime reads
   * it to append the builder instruction on every turn. Absent is every
   * conversation a person started to talk to a bot.
   */
  purpose?: SessionPurpose;
  /**
   * The model this conversation was pointed at, when it has one of its own.
   *
   * Absent means "whatever the agent answers with", which is the state every
   * conversation starts in and the state most stay in. A conversation is the
   * right place for this rather than a second agent: "answer this one question
   * with the big model" is a decision about a question, not about a bot.
   */
  model?: AgentModel;
  /**
   * The agents in this conversation, the lead first.
   *
   * Absent is a chat with one agent — the one that owns it — which is every
   * conversation that existed before this field and most of them after it. A
   * group chat names its members here, and the first is the lead: the one that
   * answers a message nobody addressed, and the one whose model and identity the
   * conversation's own bubbles are written with.
   *
   * A list of ids rather than full agents, because an agent is a document that
   * can change between turns and a conversation should describe who is in it,
   * not who they were when it was created.
   */
  agentIds?: string[];
}

/* -------------------------------------------------------------------------- */
/* Documents                                                                   */
/* -------------------------------------------------------------------------- */

/** One markdown file a Space holds, as the library lists it. */
export interface DocumentEntry {
  /** Relative to the space's root, with forward slashes whatever the platform. */
  path: string;
  /** The file's name without its directory, for the row. */
  name: string;
  /** The directory it sits in, relative to the root, or `''` at the top. */
  dir: string;
  bytes: number;
  modifiedAt: string;
}

/**
 * Which version of a file a write is based on.
 *
 * Size and modification time rather than a hash, deliberately: the question a
 * write has to answer is "has this changed since I read it", and both are facts
 * the filesystem already keeps. A hash would mean reading the whole file to
 * *write* it, which is a strange price for a check that only has to be right
 * about a file an editor held open for a few seconds.
 */
export interface DocumentRevision {
  bytes: number;
  /** Milliseconds since the epoch, as `stat` reports them. */
  modifiedAtMs: number;
}

/** A file's text, and the revision that text belongs to. */
export interface DocumentRead {
  path: string;
  text: string;
  revision: DocumentRevision;
}

/**
 * What a write did.
 *
 * A refusal is a *value* rather than an error, because the one case worth naming
 * — the file changed underneath the editor — is not a failure of anything. It is
 * a question: the person has a draft and the folder has a newer file, and the
 * window has to offer a choice rather than an apology.
 */
export type DocumentWrite =
  | {ok: true; revision: DocumentRevision}
  | {ok: false; conflict: true; revision: DocumentRevision};

export interface ToolCallRecord {
  callId: string;
  tool: string;
  args: unknown;
  result?: string;
  ok?: boolean;
}

export type TranscriptRole = 'user' | 'assistant';

/**
 * The name the main agent is built under, and therefore the `author` on its
 * events.
 *
 * One value in one place because the agent is constructed under this name and
 * the transcript's stored events carry it as their author; a second literal
 * would not fail, it would quietly stop matching what the agent was built as.
 */
export const MAIN_AGENT_NAME = 'marimo';

export interface TranscriptMessage {
  id: string;
  role: TranscriptRole;
  /**
   * The agent that wrote this, when it was not the conversation's own.
   *
   * A turn is not always one voice: the agent a chat was started with can hand a
   * piece of work to another one, and that one's words land in the same
   * transcript — they have to, because a delegated call's approval card is
   * answered here. Without this the two sets of words merge into one bubble and
   * read as a single answer from one mind, which is the failure this field exists
   * to prevent.
   *
   * Absent means the conversation's own agent, which is every message in a chat
   * with one participant and most messages in one with several.
   */
  agentId?: string;
  text: string;
  reasoning?: string;
  toolCalls?: ToolCallRecord[];
  createdAt: string;
  error?: string;
  /**
   * How many earlier messages this summary replaced.
   *
   * Present only on the one message a compaction wrote, and what makes the
   * transcript draw a card instead of a bubble in the user's own voice: the text
   * is the model's, and the role is the user's only because that is how the
   * provider is sent it.
   */
  compacted?: number;
}

/**
 * What a command did, or why it did nothing.
 *
 * Refusals are values rather than errors: "nothing to compact yet" is an ordinary
 * answer about a short conversation, and turning it into a thrown error would put
 * it in the same red banner as a provider that is down. A failure the user cannot
 * act on — no key, no network — still throws, and the window knows the
 * difference.
 */
export interface CompactResult {
  compacted: boolean;
  /** A sentence for the composer's hint slot, when nothing happened. */
  reason?: string;
}

/* -------------------------------------------------------------------------- */
/* To-dos                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * One item on the to-do list.
 *
 * `text` is trimmed and non-empty as a contract: the panel has no way to render
 * a blank row, so an empty item is refused at the boundary instead of being
 * stored and shown as a gap the user cannot explain.
 */
export const todoItemSchema = z.object({
  id: z.string().min(1),
  text: z.string().trim().min(1),
  done: z.boolean(),
  createdAt: z.string().min(1),
});

export type TodoItem = z.infer<typeof todoItemSchema>;

/**
 * The list, which is also the whole document on disk.
 *
 * Sent and stored as one value rather than as per-item calls: the list is small,
 * the editing rules live in one place, and replacing it wholesale means there is
 * no way for the window and the file to disagree about what an edit did.
 */
export const todosSchema = z
  .object({
    /** In the order they were added; the pinned item is not reordered here. */
    items: z.array(todoItemSchema),
    /** The item currently picked out at the top of the panel, if any. */
    activeId: z.string().nullable(),
    /** Whether the panel is open. Part of the document so the layout sticks. */
    open: z.boolean(),
  })
  // A pin pointing at nothing would render as a highlight with no item under it,
  // so the tie between the two fields is enforced rather than tolerated.
  .refine(
    (todos) =>
      todos.activeId === null ||
      todos.items.some((item) => item.id === todos.activeId),
    {message: 'activeId must name an item on the list'},
  );

export type Todos = z.infer<typeof todosSchema>;

/**
 * The list as it is stored: a version beside it, so the file format can change
 * without the list's own schema having to carry the version.
 *
 * It lives here rather than in the store because `zod` belongs to this package;
 * the main process reads the file through this schema.
 */
export const todosFileSchema = z.object({
  version: z.literal(1),
  todos: todosSchema,
});

/* -------------------------------------------------------------------------- */
/* Notes                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * One note: a scrap of text the user means to paste somewhere.
 *
 * Deliberately as small as a to-do item minus the checkbox — there is nothing to
 * tick off and nothing to schedule, so a note is its text and when it was
 * written. Blank text is refused here for the same reason it is on a to-do: the
 * rail has no way to draw a row with nothing in it.
 */
export const noteItemSchema = z.object({
  id: z.string().min(1),
  text: z.string().trim().min(1),
  createdAt: z.string().min(1),
});

export type NoteItem = z.infer<typeof noteItemSchema>;

/**
 * The notes, and whether their rail is open — the same shape as the to-do list,
 * down to the view state travelling in the document, so closing and reopening
 * the window comes back to the rail the user left open.
 */
export const notesSchema = z.object({
  /** In the order they were written. */
  items: z.array(noteItemSchema),
  open: z.boolean(),
});

export type Notes = z.infer<typeof notesSchema>;

export const notesFileSchema = z.object({
  version: z.literal(1),
  notes: notesSchema,
});

/* -------------------------------------------------------------------------- */
/* Files                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * What one entry in a folder is.
 *
 * `link` is its own kind rather than being folded into whichever target it
 * points at: the app resolves nothing through a symlink, because a link is the
 * one way a listing inside a workspace could describe a file outside it.
 */
export const fileEntryKindSchema = z.enum(['directory', 'file', 'link']);

export type FileEntryKind = z.infer<typeof fileEntryKindSchema>;

export const fileEntrySchema = z.object({
  name: z.string().min(1),
  kind: fileEntryKindSchema,
  /** Bytes. Zero for a directory, and for a link, whose target is not read. */
  size: z.number().int().nonnegative(),
  /** When it was last written, ISO, or `null` if that could not be read. */
  modifiedAt: z.string().nullable(),
});

export type FileEntry = z.infer<typeof fileEntrySchema>;

/**
 * One folder of the active workspace, as the Files rail shows it.
 *
 * Both the root and the folder being listed travel back, because the window
 * never sends a path it made up: it asks for a folder *relative to the
 * workspace* and is told what that resolved to. `relative` is the same path
 * normalized — `''` at the root — which is what the breadcrumb is built from.
 */
export const fileListingSchema = z.object({
  /** Absolute path of the workspace root. */
  root: z.string().min(1),
  /** Absolute path of the folder being listed. */
  path: z.string().min(1),
  /** `path` relative to `root`, normalized: `''` names the root itself. */
  relative: z.string(),
  entries: z.array(fileEntrySchema),
  /** True when the folder held more entries than one listing carries. */
  truncated: z.boolean(),
});

export type FileListing = z.infer<typeof fileListingSchema>;

/**
 * How many entries one listing carries.
 *
 * A folder can hold hundreds of thousands of names, and the rail is a list a
 * person scrolls: past this the tail is dropped and the panel says so, which is
 * more honest than a window that appears to hang.
 */
export const FILE_LISTING_LIMIT = 500;

/**
 * A file the user attached to a message.
 *
 * The path is what travels, not the contents. The agent's own `read_file` is
 * what turns it into text: it is the path that is already confined to the
 * conversation's folder, already capped at 64 KiB with the truncation stated,
 * and already gated by the same rules as every other file the agent touches.
 * Reading the file here instead would be a second reader to keep in step with
 * that one, and a message whose stored text was not what the model read.
 */
export interface PickedFile {
  /** Absolute, resolved: symlinks followed, which is what confined it. */
  path: string;
  /** The file's own name, for the chip. */
  name: string;
  /**
   * The path relative to the conversation's folder, which is what the message
   * names — a relative path is what the agent's tools describe themselves in
   * terms of, and it does not leak the user's home directory into the transcript.
   */
  relative: string;
}

/** A file the picker refused, and the sentence explaining why. */
export interface SkippedFile {
  name: string;
  reason: string;
}

/**
 * The line attached paths sit under, as the message spells it.
 *
 * Here rather than beside the composer that writes it, because two readers now
 * depend on the same spelling: the renderer that composes the message, and the
 * runtime that reads the block back out of it to say so in the turn's own
 * context. A second literal in the second reader is a block that silently stops
 * being recognised the day somebody rewords the first.
 */
export const ATTACHED_FILES_HEADING = 'Attached files:';

/* -------------------------------------------------------------------------- */
/* Jobs                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * One time a job runs, as a five-field cron expression.
 *
 * Validated here rather than at the scheduler: the two writers are the agent's
 * own tools and the IPC boundary, and a schedule the runner cannot evaluate must
 * not become a document on disk. `parseCron` is the same parser the scheduler
 * uses, so "accepted" and "will run" cannot drift apart.
 */
export const jobScheduleSchema = z
  .string()
  .trim()
  .min(1)
  .refine((value) => parseCron(value) !== null, {
    message: 'Not a 5-field cron expression',
  });

/**
 * How a job last went, for the badge on its card.
 *
 * `busy` is the one that is not an outcome: a job that came due while the agent
 * was already answering something else is not lost, it is deferred, and saying
 * so is more honest than an error.
 */
export const jobStatusSchema = z.enum([
  'ok',
  'error',
  'aborted',
  'busy',
  'awaiting-approval',
  'chatting',
]);

export type JobStatus = z.infer<typeof jobStatusSchema>;

/**
 * A scheduled job: what to do, when, and where the conversation about it lives.
 *
 * `sessionId` is the thing that makes a job editable. It is nullable because the
 * conversation can be deleted from the sidebar while the job survives; the run
 * then starts a fresh one under the job's name rather than failing.
 */
export const jobSchema = z.object({
  id: z.string().min(1),
  name: z.string().trim().min(1),
  /** The instruction the job runs. Empty is allowed; the name is the prompt then. */
  description: z.string(),
  /** One or more cron expressions, in local time. */
  schedules: z.array(jobScheduleSchema).min(1).max(5),
  enabled: z.boolean(),
  /** The agent that owns this job and is the one that runs it. */
  profileId: z.string().min(1),
  sessionId: z.string().min(1).nullable(),
  createdAt: z.string().min(1),
  lastRunAt: z.string().min(1).optional(),
  lastStatus: jobStatusSchema.optional(),
  lastError: z.string().optional(),
  /** The next time it will run, computed by the main process; absent when paused. */
  nextRunAt: z.string().min(1).optional(),
  /**
   * The occurrence the scheduler is watching, moved on once it has been dealt
   * with.
   *
   * `nextRunAt` is always in the future — it is what the card promises — so it
   * cannot also be the moment that says "this one is now due". This is that
   * moment: the most recent occurrence the schedule named. A job is due when it
   * has passed, and dealing with it moves it on to the next one, which is what
   * keeps a daily job from firing once a minute all day.
   *
   * "Dealt with" means run, failed, or dropped for being too late to run at all.
   * It does not mean deferred: a job the agent was too busy to take keeps this
   * marker where it is, so the run happens as soon as the agent is free rather
   * than at the next scheduled time.
   */
  dueAt: z.string().min(1).optional(),
});

export type Job = z.infer<typeof jobSchema>;

/**
 * What may be changed about a job from outside the owner.
 *
 * A patch rather than the whole job, deliberately: `lastRunAt`, `lastStatus` and
 * `nextRunAt` belong to the scheduler, and `profileId`/`sessionId` are what tie
 * a job to an agent and a conversation. A stale window can rename a job, change
 * its times, or pause it — and cannot do anything else.
 */
export const jobPatchSchema = z.object({
  name: z.string().trim().min(1).optional(),
  description: z.string().optional(),
  schedules: z.array(jobScheduleSchema).min(1).max(5).optional(),
  enabled: z.boolean().optional(),
});

export type JobPatch = z.infer<typeof jobPatchSchema>;

/**
 * The whole jobs document, which is also what `jobs.json` holds.
 *
 * One document rather than per-job files: the list is small, the panel shows all
 * of it at once, and every mutation answers with the new document, so the window
 * and the file cannot disagree about what a change did.
 */
export const jobsSchema = z.object({
  jobs: z.array(jobSchema),
  /** Whether the rail is open. Part of the document so the layout sticks. */
  open: z.boolean(),
  /**
   * The job whose conversation is showing, if any.
   *
   * In the document rather than in the window because it is a view the user can
   * leave and come back to: reopening the rail should return to the job they
   * were editing, not to the list. A stale id — the job was deleted — means
   * "list", which the panel reads as no card expanded.
   */
  openJobId: z.string().min(1).nullable(),
});

export type Jobs = z.infer<typeof jobsSchema>;

/** A fresh document. Closed: a rail the user asked for is a rail they open. */
export function emptyJobs(): Jobs {
  return {jobs: [], open: false, openJobId: null};
}

export const jobsFileSchema = z.object({
  version: z.literal(1),
  jobs: jobsSchema,
});

/* -------------------------------------------------------------------------- */
/* Memory proposals                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Something the agent would remember, waiting for the user to agree.
 *
 * Proposed rather than written, because long-term memory is injected into every
 * future system prompt: a wrong entry is not a wrong answer once, it is a wrong
 * belief the agent carries into every later conversation.
 */
export const memoryProposalSchema = z.object({
  id: z.string().min(1),
  /** Which conversation it came from, so the user can go and look. */
  sessionId: z.string().min(1).nullable(),
  /** Where it would go in `memory.md`. */
  section: z.string().trim().min(1).max(48),
  /** The fact, as it would be written. */
  text: z.string().trim().min(3).max(400),
  /** Why the model thought it worth keeping, for the user to judge by. */
  reason: z.string().max(200),
  /**
   * The existing bullet this fact supersedes, when the reviewer noticed one.
   *
   * Optional, and deliberately **not** a version bump. An older build reading
   * this file treats it as current, strips the field it does not know, and keeps
   * the proposal — which degrades to appending the fact rather than replacing
   * the bullet it corrects. Bumping the version instead would make that build
   * treat the whole file as unreadable and quarantine every proposal the user had
   * not answered yet, which is a worse trade for the one case of a downgrade.
   */
  replaces: z.string().trim().max(400).optional(),
  /** The agent it would be remembered by. */
  profileId: z.string().min(1),
  createdAt: z.string().min(1),
});

export type MemoryProposal = z.infer<typeof memoryProposalSchema>;

/**
 * What happened to the bullet an accepted proposal meant to replace.
 *
 * Reported rather than assumed, because the failure it names is invisible
 * otherwise: a proposal carrying `replaces` that matched nothing leaves the old
 * bullet exactly where it was, so accepting a correction can *add* a contradicting
 * fact while the user believes the old one is gone. Only the store knows which of
 * the four outcomes happened, and the window is the only place the person can be
 * told.
 *
 * Not derived from the agent package's own report type even though the two are
 * the same shape today — the dependency runs one way, and a shared type living in
 * the wrong package is worse than two fields that a test pins together.
 */
export const memorySupersedeSchema = z.object({
  outcome: z.enum(['none', 'removed', 'absent', 'ambiguous']),
  /** The bullet that was removed, when one was. */
  removed: z.string().optional(),
  /** How many bullets a target matched, when it was not unique. */
  matches: z.number().int().nonnegative().optional(),
});

export type MemorySupersede = z.infer<typeof memorySupersedeSchema>;

/**
 * One answer the user said was wrong.
 *
 * The one thing in this app that is neither a preference nor a suggested fact:
 * it is a judgement about something the agent *said*, and until this existed
 * there was nowhere for it to go. A memory proposal's refusal is a judgement
 * about a suggestion and deliberately does not silence the agent's own
 * `update_memory`; "How to talk to me" is the user writing rules for themselves.
 * Neither of them records that an answer was wrong.
 *
 * The excerpt is bounded because it ends up in a prompt, and a stored answer can
 * be arbitrarily long.
 */
export const feedbackEntrySchema = z.object({
  id: z.string().min(1),
  profileId: z.string().min(1),
  /** The conversation it was said in, so a reader can go and look. */
  sessionId: z.string().min(1),
  /** The message that was wrong, for a reference the user can recognise. */
  messageId: z.string().min(1),
  /** What the agent said, capped: enough to recognise, not enough to re-read. */
  excerpt: z.string().max(400),
  /** What the user said was right instead, when they said anything. */
  correction: z.string().max(400),
  createdAt: z.string().min(1),
});

export type FeedbackEntry = z.infer<typeof feedbackEntrySchema>;

/** How many corrections are kept, newest last. */
export const MAX_FEEDBACK_ENTRIES = 200;

export const feedbackFileSchema = z.object({
  version: z.literal(1),
  entries: z.array(feedbackEntrySchema),
});

export type FeedbackFile = z.infer<typeof feedbackFileSchema>;

export function emptyFeedbackFile(): FeedbackFile {
  return {version: 1, entries: []};
}

/* -------------------------------------------------------------------------- */
/* The discovery tree                                                          */
/* -------------------------------------------------------------------------- */

/**
 * What kind of decision a node in the tree records.
 *
 * The four kinds are the four things that actually happen in a turn, in the
 * order they happen, and the parent links between them are the tree:
 *
 *   turn      one model request. The root of a turn's own subtree.
 *   propose   an action the model asked for — a tool call, or its final answer.
 *   call      that action actually running, with whatever came back.
 *   answer    the turn's last model request, which proposed no action at all.
 *
 * `propose` and `call` are separate nodes on purpose, and the separation is the
 * whole reason a replay can answer anything. A proposal is what the model
 * wanted; a call is what the policy allowed. When pruning is on they diverge,
 * and the pair is the measurement: *this action was proposed and withheld*. One
 * node carrying both would make a pruned action indistinguishable from one the
 * model never thought of.
 *
 * The turn node exists for the same reason at the level above. A reward belongs
 * to a step, but "did this turn go well" is a question about a whole subtree,
 * and a flat list of tool calls cannot answer it — the last call of a turn that
 * ended in an answer and the last call of a turn that ended in silence look
 * identical until you can see which subtree they are in.
 */
export const DREAM_NODE_KINDS = ['turn', 'propose', 'call', 'answer'] as const;
export const dreamNodeKindSchema = z.enum(DREAM_NODE_KINDS);
export type DreamNodeKind = z.infer<typeof dreamNodeKindSchema>;

/**
 * What the result of one action was worth, as an observation rather than a
 * judgement.
 *
 * This is the number the search controller sorts by, and the temptation is to
 * make it clever — a model asked to grade the answer, a heuristic about relevance
 * — and every version of that is wrong here for the same reason: the controller
 * has to be replayable. A reward that needs a model cannot be recomputed offline,
 * so a replay would be re-running the expensive thing it exists to avoid. So the
 * reward is a small arithmetic function of what the turn already recorded: did
 * the call fail, did it return nothing, was it refused, was it a repeat, was its
 * output consumed by the next step.
 *
 * `value` is on [-1, 1] so that one exploration weight means the same thing
 * whatever the tool, and `reason` is kept beside it because the number alone is
 * unauditable — a reader has to be able to see *why* a call scored -1 before
 * they can believe a pruning threshold that acts on it.
 */
export const dreamRewardSchema = z.object({
  value: z.number().min(-1).max(1),
  reason: z.string().min(1),
});
export type DreamReward = z.infer<typeof dreamRewardSchema>;

/**
 * One node of one turn's discovery tree.
 *
 * `id`/`parentId` rather than a nested `children` array, and the choice is about
 * what happens when the process dies. This document is appended to as the turn
 * runs — one whole snapshot per line — so a run interrupted mid-turn leaves a
 * prefix of the tree rather than a truncated object that will not parse. Nested
 * children cannot be written incrementally at all without rewriting the file,
 * and rewriting the file is how a crash costs the whole turn instead of its tail.
 *
 * `parentId` absent means a root. A turn's root is its `turn` node; a real log
 * has one per turn, and reading several turns' lines gives a forest, which is
 * what the replay wants anyway — a policy is judged across many turns, not
 * within one.
 */
export const dreamNodeSchema = z.object({
  id: z.string().min(1),
  parentId: z.string().min(1).optional(),
  kind: dreamNodeKindSchema,
  /** 0 for a turn's root. Derived from the parent, stored so a reader can sort. */
  depth: z.number().int().min(0),
  /** The invocation that produced it: one turn. */
  invocationId: z.string().min(1),
  /** Which tool, for `propose` and `call`. */
  tool: z.string().min(1).optional(),
  /**
   * The call this node is about, so a proposal and its execution can be paired.
   *
   * A tool call's id, which the provider assigns. Absent on an answer node,
   * which is not a call.
   */
  callId: z.string().min(1).optional(),
  /** The arguments, verbatim as the model wrote them. */
  args: z.record(z.string(), z.unknown()).optional(),
  /**
   * The head of what the tool returned, capped by the setting.
   *
   * A string rather than the value itself, because tool results are `unknown` at
   * every layer that handles them — some are strings, some objects, some numbers
   * — and a schema that tried to keep the shape would turn a record of what
   * happened into a parser that can refuse it.
   */
  result: z.string().optional(),
  /** How long the untruncated result was, so a cap is visible rather than silent. */
  resultBytes: z.number().int().min(0).optional(),
  /** Present on a `call` once it has finished. Absent means still running. */
  reward: dreamRewardSchema.optional(),
  /**
   * False when the policy withheld this action rather than running it.
   *
   * On a `propose` node. It defaults true so that every node written before
   * pruning existed — and every node from a turn with the feature off — reads as
   * the thing it was: an action that happened.
   */
  allowed: z.boolean(),
  /**
   * The tools the model was offered at this step, on a `turn` node.
   *
   * The half of the search a proposal list cannot see, and the reason it is
   * recorded: pruning acts on the *menu*, not on the order. A step where
   * `web_search` was withheld before the model ever saw it leaves no proposal to
   * count — the model cannot ask for what it was not offered — so a log of
   * proposals alone would show pruning as having done nothing at all. With the
   * offered set beside the proposals, a replay can say both things a user wants
   * to know: which actions a setting would have removed, and what the model did
   * with what was left.
   */
  offered: z.array(z.string()).optional(),
  at: z.string().min(1),
});

export type DreamNode = z.infer<typeof dreamNodeSchema>;

/**
 * One turn's tree, as one line of its log.
 *
 * This is what a recorder appends — the whole tree, snapshotted — and it is
 * deliberately the same shape as the document a reader parses. The alternative,
 * storing `DreamNode[]` and wrapping it once at the end, cannot be written
 * incrementally for the reason above.
 */
export const dreamTreeSchema = z.object({
  version: z.literal(1),
  sessionId: z.string().min(1),
  profileId: z.string().optional(),
  invocationId: z.string().min(1),
  startedAt: z.string().min(1),
  /** How the turn ended: an answer, a failure, or nothing yet. */
  outcome: z.enum(['open', 'answered', 'failed', 'aborted']),
  /** The two weights this turn ran under, so a replay knows the control. */
  policy: z.object({
    explorationWeight: z.number(),
    pruningThreshold: z.number(),
  }),
  nodes: z.array(dreamNodeSchema),
});

export type DreamTree = z.infer<typeof dreamTreeSchema>;

/* -------------------------------------------------------------------------- */
/* Turning settings into a policy                                              */
/* -------------------------------------------------------------------------- */

/**
 * The two settings the controller needs, and nothing else.
 *
 * Narrower than `DreamSettings` on purpose. The controller is used by the live
 * plugin, by the offline replay and by the tests, and none of those three should
 * have to hold a document about keeping logs to ask what a step should do. The
 * settings block satisfies this structurally, so a caller can pass one straight
 * through without a copy to keep in step.
 */
export interface SearchPolicySettings {
  explorationWeight: number;
  pruningThreshold: number;
}

/**
 * The weights a controller uses when nothing has chosen any.
 *
 * Read by the replay rather than written out at its call site, because the
 * interesting comparison is always "what I have" against "what I am considering"
 * — and a CLI that restated the defaults would be comparing against whatever
 * they were on the day it was written.
 */
export function defaultSearchPolicySettings(): SearchPolicySettings {
  const defaults = defaultDreamSettings();
  return {
    explorationWeight: defaults.explorationWeight,
    pruningThreshold: defaults.pruningThreshold,
  };
}

/**
 * How full an agent's `memory.md` is, and the two sizes that give that meaning.
 *
 * All three numbers travel together because none of them is useful alone: a byte
 * count without the limit cannot say whether memory is nearly full, and the limit
 * without the count cannot say how close it is. The window draws them as a bar
 * and the agent is warned at the same line, so they are read from one place
 * rather than each side keeping its own copy.
 *
 * `limitBytes` is the user's soft limit — where the agent is told to prune — and
 * `capBytes` is the hard one, past which writes are refused. Different questions:
 * one is "tidy up soon", the other is "this no longer works".
 */
/**
 * When one remembered bullet was first written.
 *
 * Memory's cap is the thing this exists for. A file that stops accepting facts at
 * 64 KB is fine for a year and a trap afterwards, and the question a person
 * actually has when they look at it is "what in here is stale?" — which needs an
 * age, and the bullets themselves are plain lines with nowhere to put one.
 *
 * The key is the bullet's text rather than an identifier, because memory is a
 * hand-editable markdown file and it is the *sentence* that survives an edit;
 * `section` rides along so two identical sentences in different layers are two
 * entries rather than one. `scope` says which of the two files it is in, so a
 * bullet that has moved between them is recognisable.
 */
export const memoryProvenanceEntrySchema = z.object({
  /** Which file: the person half or the workspace half. */
  scope: z.enum(['person', 'workspace']),
  /** The `##` heading it sits under — absent for the preamble. */
  section: z.string(),
  /** The bullet's text, exactly as the file spells it. */
  text: z.string(),
  /** When the store first saw this sentence, ISO. */
  at: z.string().min(1),
  /**
   * How it arrived, which is the difference between "they told me" and "I read it
   * back later and decided" — and it is also the honest answer for a bullet that
   * predates this document, which is `adopted`.
   */
  source: z.enum(['tool', 'review', 'adopted']),
});

export type MemoryProvenanceEntry = z.infer<
  typeof memoryProvenanceEntrySchema
>;

export const memoryProvenanceFileSchema = z.object({
  version: z.literal(1),
  entries: z.array(memoryProvenanceEntrySchema),
});

export type MemoryProvenanceFile = z.infer<typeof memoryProvenanceFileSchema>;

export function emptyMemoryProvenance(): MemoryProvenanceFile {
  return {version: 1, entries: []};
}

export const memoryUsageSchema = z.object({
  bytes: z.number().int().nonnegative(),
  limitBytes: z.number().int().positive(),
  capBytes: z.number().int().positive(),
  /**
   * The review cadence, carried here rather than read from settings separately.
   *
   * The same reasoning as `limitBytes` above: the panel that draws the control
   * and the agent that obeys it must be quoting one number, and the dialog has
   * already made this call.
   */
  reviewEvents: z.number().int().positive(),
});

export type MemoryUsage = z.infer<typeof memoryUsageSchema>;

/**
 * The proposals, and how far the review has read.
 *
 * The watermark is per conversation and lives here rather than in memory: a
 * review that forgot how far it had read would re-propose the same facts every
 * time the app went quiet, and a queue that refills itself is one nobody reads.
 */
/**
 * One thing the user said no to.
 *
 * Kept because the *absence* of a fact from memory is not evidence that it was
 * refused — it is also what a fact the review has never seen looks like. Without
 * this, the only negative signal the reviewer has is the memory file, and a fact
 * the user rejected is indistinguishable from one nobody has proposed yet.
 *
 * There is no reason to store the model's justification. What has to survive is
 * enough text to recognise the same suggestion again, and the user's answer is
 * the only part of the exchange that is theirs.
 */
export const dismissedMemorySchema = z.object({
  /** The profile that refused it: one agent's no is not another's. */
  profileId: z.string().min(1),
  /** The fact as it was proposed, so the reviewer can recognise it again. */
  text: z.string().min(1),
  at: z.string().min(1),
});

export type DismissedMemory = z.infer<typeof dismissedMemorySchema>;

/**
 * The proposals, how far the review has read, and what the user has refused.
 *
 * The watermark is per conversation and lives here rather than in memory: a
 * review that forgot how far it had read would re-propose the same facts every
 * time the app went quiet, and a queue that refills itself is one nobody reads.
 *
 * **Version 2 added `dismissed`, and that is why the version moved.** A build
 * that understood only version 1 would parse this file, drop the field it did not
 * know, and write it back — every refusal silently forgotten, which is the exact
 * shape of the failure invariant 12 exists to prevent. One added field is still a
 * format change when the field is the one thing that cannot be regenerated.
 */
export const memoryProposalsFileSchema = z.object({
  version: z.literal(2),
  proposals: z.array(memoryProposalSchema),
  /** Conversation id to the number of events already reviewed. */
  reviewed: z.record(z.string(), z.number().int().nonnegative()),
  /**
   * Facts the user refused, newest last.
   *
   * Capped, and capped by dropping the oldest: a refusal is a preference about
   * the reviewer's judgement, and the ones from a thousand conversations ago are
   * the ones most likely to be about a phase the user has moved past. The clearer
   * that memory can be cleared from the dialog is the other half of the same
   * judgement — a cap the user cannot undo is a queue that silences things
   * nobody can see.
   */
  dismissed: z.array(dismissedMemorySchema),
});

export type MemoryProposalsFile = z.infer<typeof memoryProposalsFileSchema>;

export function emptyMemoryProposals(): MemoryProposalsFile {
  return {version: 2, proposals: [], reviewed: {}, dismissed: []};
}

/* -------------------------------------------------------------------------- */
/* Calls: renderer -> main                                                     */
/* -------------------------------------------------------------------------- */

/*
 * The call table for this app is `agentCallSchemas`, further down, with its
 * results in `AgentCallResults` and the bridge in `AgentBridge`.
 *
 * There used to be a second, larger table here — the full surface of the
 * project this app was extracted from, some hundred methods nothing
 * implemented. It was carried along by the vendoring and never trimmed, and it
 * was actively misleading: `settings.get` looked like a call that existed, and
 * the profile calls answered a different shape from the ones that do. A
 * contract that describes a program nobody wrote is worse than no contract.
 */

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export type AgentUiEvent =
  | {type: 'turn.started'; sessionId: string; messageId: string}
  | {type: 'text.delta'; sessionId: string; messageId: string; text: string}
  | {
      type: 'reasoning.delta';
      sessionId: string;
      messageId: string;
      text: string;
    }
  | {
      type: 'tool.started';
      sessionId: string;
      messageId: string;
      callId: string;
      tool: string;
      args: unknown;
    }
  | {
      type: 'tool.finished';
      sessionId: string;
      messageId: string;
      callId: string;
      tool: string;
      ok: boolean;
      result: string;
    }
  | {
      type: 'approval.request';
      sessionId: string;
      messageId: string;
      callId: string;
      tool: string;
      args: unknown;
      hint: string;
    }
  | {
      type: 'turn.completed';
      sessionId: string;
      messageId: string;
      usage?: TokenUsage;
    }
  | {type: 'turn.aborted'; sessionId: string; messageId: string}
  | {
      type: 'turn.failed';
      sessionId: string;
      messageId: string;
      code?: string;
      message: string;
    }
  | {type: 'session.changed'; sessionId: string}
  /**
   * The Discord connection changed state on its own: it connected, dropped, or
   * was refused. Carries the whole status rather than a diff, because the dialog
   * draws a badge from it and has nothing to reconcile.
   */
  | {type: 'discord.status'; status: DiscordConnectionStatus}
  /**
   * A job was created, edited, ran, or deleted.
   *
   * Carries the id rather than the job: the panel reloads the whole document,
   * which is one call and cannot leave it showing half of two versions.
   */
  | {type: 'job.changed'; jobId: string}
  /**
   * The agent wrote to the to-do list or the notes through its own tools.
   *
   * The rail is showing the copy that was just replaced, and — worse — the
   * renderer's copy is what the *next* edit is computed from, so a rail that did
   * not reload would write the agent's change away on the user's next click.
   * There is no id to carry: the document is small and is reloaded whole.
   */
  | {type: 'todos.changed'}
  | {type: 'notes.changed'}
  /**
   * The agent saved a skill through `/learn`.
   *
   * The catalogue is read once when Settings opens, so without this a skill the
   * user just made would be missing from the pick-list until the next launch —
   * which is precisely the moment they are most likely to go looking for it.
   */
  | {type: 'skills.changed'}
  /*
   * A helper agent, while it works.
   *
   * Three events rather than a nested `AgentUiEvent`, deliberately. The child's
   * work is a *tool call* from the parent's point of view — the parent's turn is
   * suspended inside it — and the window draws it as one thing: a labelled group
   * that opens, streams what the helper is saying, and closes with how it went.
   * Nesting a whole event union inside another would mean every future variant
   * being legal in two places, and the window having to be right about both.
   */
  | {
      type: 'delegate.started';
      sessionId: string;
      /** The parent's tool call, so the window can group the stream under it. */
      callId: string;
      agentId: string;
      name: string;
      task: string;
    }
  | {
      type: 'delegate.event';
      sessionId: string;
      callId: string;
      agentId: string;
      name: string;
      text: string;
    }
  | {
      type: 'delegate.finished';
      sessionId: string;
      callId: string;
      agentId: string;
      name: string;
      ok: boolean;
      ms: number;
      error?: string;
    }
  /*
   * The recall model's own four, shaped like a download's and separate from
   * everything else on purpose: the card that draws them has different words to
   * say, and a shared progress event carrying an embedding download would make
   * two unrelated things one event with a string in it to tell them apart.
   */
  | {
      type: 'recall.progress';
      piece: RecallPiece;
      label: string;
      receivedBytes: number;
      totalBytes: number;
      percent?: number;
    }
  | {type: 'recall.installed'; piece: RecallPiece}
  | {type: 'recall.failed'; message: string}
  /**
   * Something was indexed, so a card or a search box showing counts is stale.
   *
   * Carries the numbers rather than making the window ask: indexing happens in
   * the background while a turn is running, and a chatty event that forced a
   * round trip would be a poll wearing an event's clothes.
   */
  | {
      type: 'recall.indexed';
      records: number;
      chunks: number;
      memory: number;
      conversations: number;
      media: number;
    }
  /**
   * The active profile or workspace changed, so what the window is looking at is
   * no longer what the agent would answer as. The renderer reloads its session
   * list on `profile` (conversations are per profile) and drops the turn in
   * flight on either.
   */
  | {type: 'scope.changed'; scope: 'profile' | 'workspace'}
  /**
   * An MCP server changed state on its own: it connected, dropped, or was
   * refused. Carries the whole status rather than a diff, because the badge is
   * drawn from it and there is nothing to reconcile.
   */
  | {type: 'mcp.status'; serverId: string; status: McpStatus}
  /*
   * The tray asking the window to open Settings.
   *
   * A message rather than a navigation the main process performs, because the
   * window owns what it is looking at — and a process that reached in and
   * changed the view would be a second place that decides.
   */
  | {type: 'window.openSettings'}
  /*
   * The theme preference changed.
   *
   * An event as well as a field on `AppInfo`, because it changes without the
   * window asking — a second window, or a settings write from anywhere — and a
   * window that had to re-ask would be one that only notices on reload.
   */
  | {type: 'theme.changed'; mode: ThemeMode}
  /*
   * The companion's own settings changed.
   *
   * The pet window draws bubble count from one of them and would otherwise be
   * showing the previous answer until it was reopened — and the settings screen
   * that changes them is in the *other* window, so nothing here has a return
   * value to read. The whole block travels rather than a diff, for the same
   * reason the MCP status does: there is nothing to reconcile.
   */
  | {type: 'companion.changed'; settings: CompanionSettings}
  /*
   * An idle look at the conversation turned something up.
   *
   * A count rather than the proposals themselves: the window fetches the queue
   * when it wants to draw it, and a review finds nothing most of the time — so
   * this is only ever "there is something to see".
   */
  | {type: 'memory.proposed'; count: number}
  /*
   * A look at the conversation finished, and what it read.
   *
   * Emitted whether or not anything was proposed — which is the point, because
   * finding nothing is the usual answer. The count is what makes the review
   * cadence visible at all: the look either waits for the conversation to go
   * quiet or fires once enough of it has piled up, and when the second of those
   * happens a window with no event to draw it looks exactly like a review that
   * never ran.
   */
  | {type: 'memory.reviewed'; events: number; found: number};

export const IPC_CALL_CHANNEL = 'marimo:call';
export const IPC_EVENT_CHANNEL = 'marimo:event';

/** Shape of an error result returned by the main-process dispatcher. */
export interface IpcErrorResult {
  ok: false;
  error: string;
}

/* -------------------------------------------------------------------------- */
/* Marimo Bot's own surface                                                       */
/* -------------------------------------------------------------------------- */
/*
 * The block above is the contract Marimo Desktop grew, kept because the agent
 * package still refers to its vocabulary (`AgentProfile`, `Job`).
 * This block is Marimo Bot's own surface, and it starts deliberately small:
 * a call is added here when the feature behind it lands, so the contract is a
 * description of what the app does rather than a wish list. The entries above
 * that this app will not implement are pruned as their replacements arrive.
 */

/**
 * A gate a conversation is still waiting on.
 *
 * A wire shape rather than an agent-internal one, because it is exactly what a
 * card is drawn from and a card outlives the process that raised it: the window
 * asks for the pending gates of whatever conversation it is showing, and gets
 * them from the event log rather than from memory.
 */
export const pendingGateSchema = z.object({
  callId: z.string(),
  tool: z.string(),
  args: z.unknown(),
  hint: z.string(),
  /**
   * When the question was asked, so a card can say how long it has waited.
   *
   * There is deliberately no expiry: a desktop agent's user may be away for
   * hours, and a gate that lapsed while they were out would silently throw away
   * the work they asked for.
   */
  askedAt: z.string(),
});

export type PendingGate = z.infer<typeof pendingGateSchema>;

/**
 * What the window needs to describe this install.
 *
 * Versions and paths are here rather than assembled in the renderer because the
 * renderer cannot know them: it has no `process`, no `app`, and no business
 * reading either.
 */
/**
 * Whether jobs run while the app is closed.
 *
 * Two facts rather than one boolean, because each has a different remedy and a
 * single "off" would leave the user guessing which one they have.
 *
 * There used to be no trap behind it at all: a background run needed no secret,
 * because the app answered with its own bundled model and the runner dialled no
 * connectors. Both are gone. A job answers through a provider and may use the
 * connectors its agent was granted, so whether the runner can read the secrets
 * behind either is a fact this has to state — which is what `keysReadable`
 * answers.
 */
export interface ServiceStatus {
  /** Whether the OS is set up to wake the runner. */
  installed: boolean;
  /** The definition's location, shown so a user can go and look. */
  definitionPath: string;
  /**
   * Whether a process with no keychain could run this install's jobs.
   *
   * The runner has no `app` object and therefore no `safeStorage`, so a secret is
   * readable to it only when the user said so — and a job may need two kinds: the
   * active provider's key, and the secret of every connector switched on. True
   * here means "a scheduled job would work as this install is configured": the
   * provider needs no key or its key was stored readable, and every enabled
   * connector either needs no secret or has it stored readable. False is not a
   * fault — it is the state a user is in before they answer the question, and it
   * is what the switch's own copy has to say rather than leaving a job to fail on
   * the night it was needed.
   */
  keysReadable: boolean;
}

export interface AppInfo {
  /** The product name, which is also the user-data directory's name. */
  name: string;
  version: string;
  electron: string;
  chrome: string;
  node: string;
  /**
   * `process.platform`: `'linux'`, `'darwin'`, `'win32'` and so on.
   *
   * A plain string rather than `NodeJS.Platform`, because this package is also
   * read by the renderer and carries no Node types on purpose — importing them
   * here to name one field would put Node's whole ambient surface in scope for
   * every file in the contract.
   */
  platform: string;
  /**
   * Where conversations, jobs and secrets live.
   *
   * Shown in Settings, and the thing to ask for in a bug report: the headless
   * runner has to resolve this same directory for itself, so a disagreement
   * between the two is a real and otherwise invisible failure.
   */
  userData: string;
  /**
   * Something wrong that the user has to know about but that has not stopped
   * the app working.
   *
   * A place for the failures whose only symptom is a feature quietly not doing
   * anything — the app and the job runner disagreeing about where the data lives
   * is the one that exists today. A console line is not enough for those: in a
   * packaged app nobody has a console, and the evidence otherwise is a scheduled
   * job that never fires and no reason given.
   */
  warning?: string;
  /** The mode the user chose. */
  themeMode: ThemeMode;
  /** Which way that resolved, right now. */
  theme: Theme;
}

/**
 * The calls this app's window can make.
 *
 * Kept as a map of zod schemas so the main process validates every inbound call
 * at one door, and the renderer gets the same shapes as types. A method absent
 * from here is not callable at all.
 */
export const agentCallSchemas = {
  'app.info': z.object({}),
  /*
   * Takes this install back to the state it was in before anything was
   * configured, and quits: the app is opened again afterwards like any other
   * launch, which is what makes the next screen a first run.
   *
   * No payload, and deliberately: what makes this safe is the window's warning
   * and the phrase somebody has to type, and a field here that the handler read
   * and the window set would be a second, quieter guard — which is a guard two
   * places have to agree about rather than one the person saw.
   *
   * The call answers only that it was accepted. Everything it starts — stopping
   * the agent, taking the OS timer down, emptying the user-data folder, ending
   * the process — is the main process's own business, and the window is usually
   * gone before a result would matter.
   */
  'app.reset': z.object({}),

  /* The agents this install has. */
  'profiles.list': z.object({}),

  /*
   * The folders this install works in.
   *
   * Separate from `profiles.*` because the folders are not an agent's: every
   * agent sees the same list, and switching agent must not move the rail.
   */
  'workspaces.list': z.object({}),
  /*
   * Loads a folder.
   *
   * With no `path` the main process opens the OS folder picker — a window cannot
   * ask for one itself, and a path typed by hand is a typo away from confining
   * the agent to somewhere nobody meant. A caller that already knows the folder
   * (the smoke check, which cannot drive a native dialog) may name one, and it is
   * accepted only if it is a directory that exists.
   */
  'workspaces.add': z.object({path: z.string().min(1).optional()}),
  'workspaces.select': z.object({workspaceId: z.string().min(1)}),
  'workspaces.rename': z.object({
    workspaceId: z.string().min(1),
    name: z.string().trim().min(1),
  }),
  /*
   * Forgets a folder. Nothing on disk is touched, and the conversations filed
   * under it are left pointing at an id that is no longer in the list — which is
   * exactly how the rail renders "Other chats".
   */
  'workspaces.remove': z.object({workspaceId: z.string().min(1)}),
  /*
   * Opens the folder in whatever file manager the OS has.
   *
   * Named by id rather than by path, so the window can only ever ask for a
   * directory that is already in the document.
   */
  'workspaces.open': z.object({workspaceId: z.string().min(1)}),

  /*
   * Asks the user for files to attach to the next message.
   *
   * Named by conversation rather than by folder, because the files are judged
   * against the folder *that conversation* works in — the same folder its turn's
   * file tools will be confined to. The window never sends the path it wants
   * checked: it says which conversation is asking, and the answer says which
   * folder the offer was measured against.
   */
  'files.pick': z.object({
    profileId: z.string().min(1),
    sessionId: z.string().min(1),
  }),

  /* Conversations. */
  'sessions.list': z.object({profileId: z.string().min(1).optional()}),
  /*
   * Starts a conversation, in a named space when the caller named one.
   *
   * The rail's "new chat in this space" is what names it. Absent is the common
   * case: the agent's own space if it has one, and otherwise the space the rail
   * is on — a resolution the runtime makes, because it is the layer that reads
   * the agent and the folder document together.
   */
  'sessions.create': z.object({
    profileId: z.string().min(1),
    spaceId: z.string().min(1).optional(),
  }),
  /*
   * Starts the conversation that builds a bot.
   *
   * A call of its own rather than `sessions.create` with a flag, because the
   * purpose has to be written where the runtime reads it and the lead has to be
   * checked for the tool before a session exists. The window opens what comes
   * back and draws the opening card; nothing is created here.
   */
  'sessions.startBuilder': z.object({profileId: z.string().min(1)}),
  'sessions.get': z.object({
    profileId: z.string().min(1),
    sessionId: z.string().min(1),
  }),
  /*
   * Re-files a conversation, or unfiles it with `null`.
   *
   * The sidebar's filing rather than the agent's confinement: a conversation
   * keeps the folder it was filed under, and moving it does not move the turn
   * already running.
   */
  'sessions.move': z.object({
    profileId: z.string().min(1),
    sessionId: z.string().min(1),
    workspaceId: z.string().min(1).nullable(),
  }),
  /* Gives a conversation a name of its own, replacing the derived one. */
  'sessions.rename': z.object({
    profileId: z.string().min(1),
    sessionId: z.string().min(1),
    title: z.string().trim().min(1),
  }),
  /*
   * Deletes a conversation and the file behind it.
   *
   * There is no call to choose a conversation's model any more: there is one
   * model, so a per-conversation choice would be a control that cannot change
   * anything.
   */
  'sessions.delete': z.object({
    profileId: z.string().min(1),
    sessionId: z.string().min(1),
  }),
  /*
   * Runs a command against one conversation.
   *
   * An `invoke` rather than a turn, because a command is not something the user
   * said: it never becomes the model's input as their words, and the answer is a
   * result the window draws rather than a stream of events. The conversation it
   * acted on is re-read afterwards, which is what shows the summary card.
   */
  'sessions.compact': z.object({
    profileId: z.string().min(1),
    sessionId: z.string().min(1),
  }),

  /*
   * A turn. The call returns as soon as the turn is *accepted*; the answer
   * arrives as `AgentUiEvent`s on the event channel, because a turn is a stream
   * and an `invoke` is not.
   */
  'chat.send': z.object({
    profileId: z.string().min(1),
    sessionId: z.string().min(1),
    text: z.string().min(1),
    /**
     * Which surface asked.
     *
     * The conversation is shared, so this is not a second thread — it is the one
     * fact the turn needs that the message itself does not carry: the pet asks
     * for a shorter answer than the window, and the agent can only know which
     * one it is talking to if the caller says. Absent means the window.
     */
    origin: z.enum(['window', 'pet']).optional(),
    /**
     * The agent the user addressed, when they named one.
     *
     * A group chat has a lead that answers by default, and `@` is how somebody
     * asks a particular member instead. It has to be a *participant*: addressing
     * an agent this conversation does not hold is refused rather than silently
     * answered by the lead, because a message that looks delivered and is not is
     * worse than a refusal.
     */
    agentId: z.string().min(1).optional(),
  }),
  'chat.approve': z.object({
    profileId: z.string().min(1),
    sessionId: z.string().min(1),
    callId: z.string().min(1),
    confirmed: z.boolean(),
  }),
  'chat.abort': z.object({
    profileId: z.string().min(1),
    sessionId: z.string().min(1),
  }),

  /* What the agent can reach right now. */
  'mcp.statuses': z.object({}),
  /*
   * Connectors.
   *
   * Separate calls from `settings.set` rather than a settings patch, because
   * adding a server has to *dial* it: the write and the connection are one
   * action from the user's point of view, and a window that saved the file and
   * left the server unconnected would report success for something that did not
   * happen.
   */
  'mcp.set': z.object({server: mcpServerSchema}),
  'mcp.remove': z.object({serverId: z.string().min(1)}),
  /*
   * A connector's own secret — an API key it needs in an environment variable or
   * a header. The only secret this app still stores, and never read back: the
   * answer says which secrets are *set*, never what they are.
   */
  'mcp.setSecret': z.object({
    serverId: z.string().min(1),
    target: z.enum(['env', 'header']),
    name: z.string().trim().min(1),
    value: z.string(),
    /*
     * Where to keep it, as the form in front of the user says.
     *
     * Carried with the write rather than read back off the saved connector, and
     * that is the whole point: the consent lives in the same draft as the value,
     * so a user who ticks "let the background runner read this" and then saves
     * the secret — without saving the connector first — must get the readable
     * file they just asked for. Reading the stored entry instead would write the
     * old setting while the screen showed the new one, which is the direction
     * that leaks rather than the direction that fails.
     *
     * Optional so a caller that has nothing to say falls back to the connector's
     * own entry, and then to the safe answer.
     */
    secretStorage: providerKeyStorageSchema.optional(),
  }),
  /*
   * Dials a server without saving it, so somebody can find out that a command is
   * wrong before they commit to it.
   */
  'mcp.test': z.object({server: mcpServerSchema}),

  /*
   * The floating companion.
   *
   * `pointer` is how the window knows where it is *not*: it is a fixed rectangle
   * over whatever the user is working in, and without this it would swallow every
   * click on the things behind it.
   */
  'companion.status': z.object({}),
  'companion.setVisible': z.object({visible: z.boolean()}),
  /*
   * `enabled` is the user's click-through preference, reported by the window on
   * every move along with where the pointer is. The alternative — the main
   * process remembering the preference and the window asking for it — would be
   * one more read of the settings file on a path that runs on every mouse move.
   */
  'companion.pointer': z.object({
    over: z.boolean(),
    enabled: z.boolean(),
  }),

  /*
   * What the agent would remember, waiting for an answer, and what the user has
   * already refused.
   *
   * Both in one call because the dialog shows them together and one of them is
   * the explanation for the other: a queue that looks short is partly a queue of
   * things already rejected, and the count is what makes that visible. Two calls
   * would be two chances for the window to draw one of them from a stale read.
   *
   * `accept` writes a proposal into memory, `dismiss` does not — and both remove
   * it from the queue and, when dismissed, record the refusal, because both are
   * answers.
   */
  'memory.proposals': z.object({}),
  /*
   * Forgets every refusal, so the reviewer may propose them again.
   *
   * A deliberate act with no undo, which is why it is its own call rather than a
   * flag on the one above: the whole point of remembering a no is that it is
   * quiet, and the thing that makes it safe to be quiet is that the user can
   * always see the list and clear it.
   */
  'memory.forgetDismissals': z.object({}),
  /*
   * How full this agent's memory is, for the size control in Settings. A read
   * rather than event: nothing changes it but a write, and the dialog asks again
   * every time it opens.
   */
  'memory.usage': z.object({profileId: z.string().min(1).optional()}),
  /**
   * When each remembered bullet was first written.
   *
   * Its own call rather than part of `memory.usage`: the size is read on every
   * panel open and this is a longer document, and the two answer different
   * questions — "is memory full" and "what in here is stale".
   */
  'memory.provenance': z.object({profileId: z.string().min(1).optional()}),
  'memory.resolve': z.object({
    proposalId: z.string().min(1),
    accept: z.boolean(),
  }),
  /*
   * "That answer was wrong."
   *
   * Its own call rather than a field on a chat message, because it is not part of
   * the conversation: nothing is written to the transcript, nothing is said back,
   * and the agent is not interrupted. It is a note the user leaves about an
   * answer, and the next review reads it.
   */
  'memory.feedback': z.object({
    sessionId: z.string().min(1),
    messageId: z.string().min(1),
    /** What the agent said, as the window has it on screen. */
    excerpt: z.string().max(400),
    /** What was right instead, when they typed anything. */
    correction: z.string().max(400).optional(),
  }),
  /** Every correction on record, newest last. */
  'memory.feedback.list': z.object({}),
  /** Forgets them all, so the reviewer stops being told about them. */
  'memory.feedback.clear': z.object({}),

  /* Whether jobs run while the app is closed. */
  'service.status': z.object({}),
  'service.enable': z.object({}),
  'service.disable': z.object({}),

  /*
   * The provider a request goes to.
   *
   * `settings.set` carries every *preference* about it — which provider is
   * active, each one's address, its model, and how its key is stored — because
   * those are values in a document. The two calls here are not: one writes a
   * secret, and one reaches the network. A settings patch that quietly did either
   * would report success for work it had not done.
   */
  'settings.setApiKey': z.object({
    apiKey: z.string(),
    /* Absent means the active provider, which is what the key card is about. */
    provider: providerIdSchema.optional(),
  }),
  /*
   * Asks one provider what it serves: `GET /models`, with its key.
   *
   * A call rather than a patch because the answer is a fact about an endpoint
   * rather than a preference, and because it can fail in ways the user has to be
   * told about — an unreachable host, a refused key, an empty list. The stored
   * list it returns is written by the store, with a provider's own list replaced
   * rather than merged.
   */
  'providers.fetch': z.object({provider: providerIdSchema.optional()}),
  /*
   * One conversation's own model, or `null` to follow the agent again.
   *
   * A call rather than a profile patch for the obvious reason: it is a fact about
   * a conversation, and the conversation may not be the one the agent's card is
   * about.
   */
  /*
   * Who is in a conversation.
   *
   * A call rather than a field of `sessions.create` alone, because a group is
   * something a chat grows into: a conversation that started with one agent is
   * how somebody adds a second.
   */
  /*
   * A Space's documents.
   *
   * Every one of these names a *space* rather than a path, and that is the whole
   * safety story: the main process resolves the space to its folder and refuses
   * anything that leaves it, so a window cannot ask to read or write outside the
   * folders the user loaded — the same rule the agent's own file tools live
   * under.
   */
  'docs.list': z.object({spaceId: z.string().min(1)}),
  'docs.read': z.object({
    spaceId: z.string().min(1),
    path: z.string().min(1),
  }),
  /*
   * Writes a file, or refuses because the file moved on.
   *
   * `revision` is what the caller read, and a mismatch is the refusal above
   * rather than a silent overwrite: an agent may have written the same file
   * while a person had it open, and a document is the one thing in this app that
   * no versioned store is standing behind.
   */
  'docs.write': z.object({
    spaceId: z.string().min(1),
    path: z.string().min(1),
    text: z.string(),
    revision: z.object({bytes: z.number().int(), modifiedAtMs: z.number()}),
  }),
  'docs.create': z.object({
    spaceId: z.string().min(1),
    /** Where to put it, relative to the root; absent means the root. */
    dir: z.string().optional(),
    name: z.string().trim().min(1),
  }),
  /*
   * A conversation, written into a space as a document.
   *
   * The half of "documents are the folder's files" that makes the folder useful
   * for something other than reviewing what the agent wrote: a chat that arrived
   * somewhere is worth keeping where the work lives, and the file it produces is
   * an ordinary markdown file that the agent can then edit like any other.
   */
  'docs.saveChat': z.object({
    profileId: z.string().min(1),
    sessionId: z.string().min(1),
    spaceId: z.string().min(1),
    path: z.string().min(1),
  }),
  'sessions.setParticipants': z.object({
    profileId: z.string().min(1),
    sessionId: z.string().min(1),
    /* The lead first. An empty list means "just the agent that owns it". */
    agentIds: z.array(z.string().min(1)),
  }),
  'sessions.setModel': z.object({
    profileId: z.string().min(1),
    sessionId: z.string().min(1),
    model: agentModelSchema.nullable(),
  }),

  /*
   * Recall: the model that finds things by meaning.
   *
   * `status` is a read and the rest are buttons, for the same reason the model's
   * are: a settings write that quietly reached the network for 310 MB would
   * report success for something that had not happened yet.
   */
  'recall.status': z.object({}),
  /* Fetches one piece. Answers as soon as the download has *started*. */
  'recall.install': z.object({piece: recallPieceSchema}),
  'recall.cancel': z.object({}),
  'recall.reindex': z.object({}),
  'recall.forget': z.object({}),
  /*
   * The window's own search. The same service the agent's tool uses, so a person
   * and the model see the same scores, the same caps and the same staleness — two
   * implementations would be two answers to one question.
   */
  'recall.query': z.object({
    query: z.string().min(1),
    scopes: z.array(recallScopeSchema).optional(),
    limit: z.number().int().min(1).max(50).optional(),
    /*
     * How near a hit has to be to be a result. Left out, the index's own floor
     * applies and a query nothing in the folder comes close to answers with
     * nothing; `0` asks for the nearest vectors whatever they score, which is
     * what the search box does when somebody asks to see what was withheld.
     */
    minScore: z.number().min(0).max(1).optional(),
  }),

  /* What this agent is allowed to do, and what it is. */
  'profiles.catalog': z.object({}),
  'profiles.update': z.object({
    profileId: z.string().min(1),
    patch: profilePatchSchema,
  }),

  /*
   * The user's skills, as `skills/<name>/SKILL.md` files.
   *
   * `list` is the folder as written, for the editor; `id` on `save` is the
   * folder being edited, which is how a rename knows which file to move. The
   * editor does not grant, so no profile is named here — a rename carries the
   * grants of every bot that had the old name, and a new skill is switched on by
   * the person ticking its box.
   *
   * These are the two ways a person writes a skill without asking the model.
   * `save_skill` writes the same files from inside a turn, so there is one store
   * and one set of rules rather than a UI path and a tool path that can drift.
   */
  'skills.list': z.object({}),
  'skills.save': z.object({
    id: z.string().min(1).optional(),
    draft: skillDraftSchema,
  }),
  'skills.remove': z.object({id: z.string().min(1)}),
  /*
   * Makes a bot, from a draft the person has seen.
   *
   * The draft is the same shape the review card and the `draft_bot` tool use, so
   * there is one description of "a bot to be" rather than a form-shaped copy
   * here and a prompt-shaped one there. Every field is optional: a blank bot is
   * an empty draft, and the runtime fills the rest from the starter role or the
   * defaults.
   *
   * `sourceCallId` is the transcript's tool call id when the draft card asked.
   * It is written onto the profile so a card revisited later can tell it already
   * made this bot instead of offering to make it again.
   */
  'profiles.create': z.object({
    draft: botDraftSchema.optional(),
    sourceCallId: z.string().min(1).optional(),
  }),
  'profiles.select': z.object({profileId: z.string().min(1)}),
  /*
   * An upload is its own call because the file picker, the image decoder and the
   * one file the app writes all live in the main process. It answers with the
   * whole profile state, like every other profile write, and `changed: false`
   * for a picker the user closed — an answer rather than an error.
   */
  'profiles.uploadAvatar': z.object({profileId: z.string().min(1)}),
  /*
   * Removal takes the bot's conversations, jobs and memory with it, which is why
   * it is one call rather than a delete of the profile plus a second call per
   * thing it owned: a client that did the first and not the rest would leave
   * conversations nothing can answer for.
   */
  'profiles.remove': z.object({profileId: z.string().min(1)}),

  /* Preferences, including the two that decide whether hidden jobs can run. */
  'settings.get': z.object({}),
  'settings.set': z.object({patch: settingsPatchSchema}),
} as const;

export type AgentCallMethod = keyof typeof agentCallSchemas;
export type AgentCallParams<M extends AgentCallMethod> = z.infer<
  (typeof agentCallSchemas)[M]
>;

/** What each call answers with. */
export interface AgentCallResults {
  'app.info': AppInfo;
  /**
   * Accepted, not finished. The process that answered is on its way out, and
   * the window that asked is usually gone before this reply is read.
   */
  'app.reset': {resetting: boolean};
  'profiles.list': {profiles: AgentProfile[]; activeProfileId: string};
  'sessions.list': {sessions: SessionSummary[]};
  'sessions.create': {session: SessionSummary};
  'sessions.startBuilder': {session: SessionSummary};
  'sessions.get': {
    messages: TranscriptMessage[];
    pending: PendingGate[];
  };
  'sessions.move': {session: SessionSummary};
  'sessions.rename': {session: SessionSummary};
  'sessions.compact': CompactResult;
  'sessions.delete': {deleted: boolean};
  /**
   * What was attached and what was refused, with the folder both were judged
   * against — so the window can name the folder rather than describing it.
   */
  'files.pick': {files: PickedFile[]; skipped: SkippedFile[]; folder: string};
  'workspaces.list': WorkspaceState;
  'workspaces.add': WorkspaceState & {added: boolean};
  'workspaces.select': WorkspaceState;
  'workspaces.rename': WorkspaceState;
  'workspaces.remove': WorkspaceState & {removed: boolean};
  'workspaces.open': {opened: boolean};
  /** Accepted, not finished: the turn itself arrives on the event channel. */
  'chat.send': {accepted: boolean};
  'chat.approve': {accepted: boolean};
  'chat.abort': {aborted: boolean};
  'mcp.statuses': Record<string, McpStatus>;
  'mcp.set': {servers: McpServer[]; statuses: Record<string, McpStatus>};
  'mcp.remove': {servers: McpServer[]; statuses: Record<string, McpStatus>};
  'mcp.setSecret': {set: string[]};
  'mcp.test': {ok: boolean; detail: string};
  'memory.proposals': {
    proposals: MemoryProposal[];
    /** Every refusal on record, across profiles, newest last. */
    dismissed: DismissedMemory[];
  };
  'memory.forgetDismissals': {dismissed: DismissedMemory[]};
  'memory.usage': MemoryUsage;
  'memory.provenance': {entries: MemoryProvenanceEntry[]};
  'memory.resolve': {
    ok: boolean;
    problem?: string;
    /**
     * What became of the bullet the proposal meant to replace.
     *
     * Present only when the proposal carried a `replaces` and the write actually
     * happened — an `absent` or `ambiguous` answer here is the one thing the
     * person needs, because it means the correction did not take.
     */
    supersede?: MemorySupersede;
  };
  'memory.feedback': {ok: boolean; problem?: string};
  'memory.feedback.list': {entries: FeedbackEntry[]};
  'memory.feedback.clear': {entries: FeedbackEntry[]};
  'companion.status': {visible: boolean};
  'companion.setVisible': {visible: boolean};
  'companion.pointer': {ok: boolean};
  'service.status': ServiceStatus;
  'service.enable': ServiceChange;
  'service.disable': ServiceChange;
  'settings.setApiKey': {settings: PublicSettings};
  'providers.fetch': {settings: PublicSettings};
  'sessions.setModel': {session: SessionSummary};
  'sessions.setParticipants': {session: SessionSummary};
  /*
   * `notes` for the same reason `recall.query` has one: a library that hit its
   * cap and said nothing reads as a folder that holds exactly that much. The
   * window prints them beside the list rather than deciding for itself whether
   * something was dropped.
   */
  'docs.list': {files: DocumentEntry[]; notes: string[]};
  'docs.read': DocumentRead;
  'docs.write': DocumentWrite;
  'docs.create': DocumentRead;
  'docs.saveChat': DocumentRead;
  'recall.status': RecallModelStatus;
  'recall.install': {started: boolean};
  'recall.cancel': {cancelled: boolean};
  'recall.reindex': {started: boolean};
  'recall.forget': {forgotten: boolean};
  'recall.query': RecallQueryResult;
  'profiles.catalog': ProfileCatalog;
  'profiles.update': {profiles: AgentProfile[]; activeProfileId: string};
  'profiles.create': {
    profiles: AgentProfile[];
    activeProfileId: string;
    /**
     * The bot that was just made, so the caller does not have to guess it from
     * whichever profile is active — the handler selects the lead back before it
     * answers in every flow that made a bot.
     */
    created: AgentProfile;
  };
  'profiles.select': {profiles: AgentProfile[]; activeProfileId: string};
  'profiles.uploadAvatar': {
    profiles: AgentProfile[];
    activeProfileId: string;
    changed: boolean;
  };
  'profiles.remove': {profiles: AgentProfile[]; activeProfileId: string};
  /*
   * The whole list after a write, so the window never merges one entry into a
   * copy of its own. A rename also moves the profile grants; the Settings reload
   * that follows every write is what picks those up.
   */
  'skills.list': {skills: StoredSkill[]};
  'skills.save': {skills: StoredSkill[]; saved: StoredSkill};
  'skills.remove': {skills: StoredSkill[]};
  'settings.get': {settings: PublicSettings};
  'settings.set': {settings: PublicSettings};
}

/**
 * What this install can offer, so a pick-list can be built from what exists
 * rather than from a list somebody typed out twice.
 */
export interface ProfileCatalog {
  tools: CatalogTool[];
  skills: CatalogEntry[];
  /**
   * The spaces this install has, for the per-agent "works in" picker.
   *
   * The workspace document's own entries, so the picker can only ever offer a
   * space that exists — and a space added from the rail is offerable without
   * anything having to be told about it. The *active* one is deliberately not
   * here: which space the rail is on is the rail's business, and the window
   * already reads it from `workspaces.list`.
   */
  spaces: Workspace[];
  /**
   * The connectors this install has, for the switches that grant them.
   *
   * Drawn from the settings document rather than from live connections, because
   * the switch has to exist before the server connects: a card that filled in
   * after the first successful dial would be one nobody could grant a connector
   * that is not up yet — which is the same rule the recall switch follows.
   */
  connectors: CatalogConnector[];
  /**
   * The same tools, grouped into the three choices the setup flow offers.
   *
   * Here rather than in the renderer because the names are the agent package's:
   * a list written in the window would be a second copy of the tool names, and
   * the one thing that must not drift is which names a choice actually grants.
   */
  presets: CapabilityPreset[];
  /**
   * The starter roles this install can offer, with their tools narrowed to what
   * it actually has.
   *
   * Here rather than in the window for the reason `presets` is: the tool names
   * are the agent package's, and a card that offered a name nothing answers to
   * would be a choice that grants nothing.
   */
  botTemplates: BotTemplate[];
  /**
   * The Role text Reset would put back, keyed by profile id.
   *
   * One text per profile rather than one for the install, because the kinds of
   * profile are seeded differently: the lead — the first profile in the
   * document, the one created at install — was given `DEFAULT_AGENT_ROLE`, a
   * starter bot was given its template's text, and a custom bot was given the
   * generic bot contract. The window holds none of them, because it is text the
   * app shipped and a copy in the renderer is a copy that can drift; a Writer
   * reset to Marimo Bot's Role is the defect this exists to stop.
   */
  roleSeeds: Record<string, string>;
  /**
   * The Persona text "Use the template text" would put back, keyed by profile
   * id.
   *
   * Separate from `roleSeeds` because the two have different owners and
   * different buttons: the Role has a Reset that is safe to press, and the
   * Persona has a "use the template text" that asks first because it replaces
   * words the person wrote.
   */
  personaSeeds: Record<string, string>;
  /**
   * The tool that hands work from one agent to another, when this install has it.
   *
   * Carried as data for the reason `presets` above is: the name belongs to the
   * agent package, and a window with its own copy of the string would grant a
   * name nothing answers to. That failure is silent rather than loud — a
   * profile's grant naming no tool is filtered away at the host, not refused —
   * so the screen that offers it would tick a box and change nothing.
   *
   * Absent on an install whose tool set has no such tool, which is what stops a
   * setup flow from promising a capability this build cannot carry out.
   */
  delegationTool?: string;
  /**
   * The tool that drafts a bot for the person to review, when this install has
   * it.
   *
   * Carried the same way as `delegationTool`, and for the same reason: the setup
   * flow grants it to the lead before starting a builder conversation, and a
   * second spelling of the name would grant nothing. Absent means the guided
   * creation path is not offered.
   */
  builderTool?: string;
}

/**
 * One connector as the agent's grant screen offers it.
 *
 * `enabled` is the server's own install-wide switch and not the grant: a
 * connector that is switched off is still listed, because the grant is kept on
 * the profile and a card that dropped it would silently forget which agents were
 * allowed a server that was merely unplugged for a while.
 */
export interface CatalogConnector {
  /** The server's own id, which is what a profile's grant stores. */
  id: string;
  name: string;
  /** Where it points, said to the person deciding rather than to the model. */
  blurb: string;
  enabled: boolean;
}

/** One tool as the settings screen offers it. */
export interface CatalogTool extends CatalogEntry {
  /**
   * What this tool does, said to the person deciding rather than to the model.
   *
   * `description` above is the text the model is given, and it is written for a
   * reader that already knows what a system prompt is. This is the same fact for
   * somebody who has never seen an agent's tool list, and the two are kept apart
   * because rewriting one for the other would make it worse at its own job.
   */
  blurb: string;
  /**
   * Whether a brand-new agent is granted it.
   *
   * The settings screen groups by this and nothing else, because it is the one
   * fact about a tool that cannot be wrong: it is the same value the grant is
   * computed from. An earlier version classified tools as "looking" or "acting"
   * from a hand-written list of names, and the list had already drifted from the
   * tools it described.
   */
  byDefault: boolean;
}

/**
 * What an agent may do, said as one choice rather than thirty switches.
 *
 * The list here is *tools*, not a description of them, and that is the whole
 * design: choosing a preset is a write to `enabledTools`, exactly like ticking
 * every switch it names would be. So this is a label on a state the profile
 * already holds rather than a second, quieter place where a grant lives — the
 * preset on screen is worked out by comparing that grant against these lists,
 * and a grant that matches none of them is simply "custom" without anything
 * having to record the fact.
 *
 * Where the names live is why this is filled in by the app: the tools are the
 * agent package's, and a preset naming a tool this build does not have grants
 * nothing rather than failing, which is what lets one list serve an install
 * with Discord and one without.
 */
export interface CapabilityPreset {
  id: string;
  /** What the card says. */
  label: string;
  /** One line under it, for somebody deciding. */
  blurb: string;
  /** The tool names choosing this grants. */
  tools: string[];
  /**
   * Whether this is what a brand-new agent gets.
   *
   * A field rather than "the second card", because the order is presentation and
   * this is behaviour: moving a card should not change what an agent can do.
   */
  recommended: boolean;
}

/**
 * The result of asking the OS to start or stop waking the runner.
 *
 * Failures are listed rather than thrown, so a partly-successful install can say
 * which step refused — which is the difference between "it did not work" and
 * "loginctl needs root, everything else is in place".
 */
export interface ServiceChange {
  installed: boolean;
  /** Steps that failed and did not matter. */
  notes: string[];
  /** Steps that failed and did. */
  failures: Array<{what: string; detail: string}>;
}

/**
 * How an MCP server is doing, as the window draws it.
 *
 * Structurally the manager's own status type — declared here because the window
 * reads it and the manager writes it, and two shapes for one badge is two
 * shapes that can disagree.
 */
export interface McpStatus {
  state: 'off' | 'connecting' | 'online' | 'error';
  /** One sentence, shown under the server's name. */
  detail: string;
  toolCount: number;
}

/**
 * The preload bridge, as the renderer sees it.
 *
 * `window.marimo` is the whole of the window's reach: no filesystem, no shell,
 * no unvalidated IPC. A sandboxed preload cannot import this module at runtime
 * (it is ESM and the preload is CommonJS), so it repeats the channel names and
 * `apps/desktop/tests/preload-channels.test.ts` asserts they still match.
 */
export interface AgentBridge {
  call<M extends AgentCallMethod>(
    method: M,
    params: AgentCallParams<M>,
  ): Promise<AgentCallResults[M]>;
  onEvent(listener: (event: AgentUiEvent) => void): () => void;
}
