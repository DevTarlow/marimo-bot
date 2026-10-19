/**
 * Runtime configuration for the agent.
 *
 * Everything here comes from the active agent profile and the app's own
 * preferences: which service answers and where, the credential it is reached
 * with, the Role and Persona, the folder it works in, and the tools and skills
 * it is allowed to use.
 */
import type {ProviderId} from '@marimo/protocol';

import type {Skill} from './skills/types.js';

export interface AgentConfig {
  /**
   * The address requests go to.
   *
   * The whole of it is stored now: the app runs no backend of its own, so every
   * provider's address is either the catalogue's default or something the user
   * typed, and nothing here is a placeholder waiting for a live port.
   */
  baseUrl: string;
  /** The request's `model`, as the chosen provider names it. */
  model: string;
  /**
   * Which provider `baseUrl` belongs to.
   *
   * Carried beside the address rather than folded into it because the two are
   * read by different things: the transport sends the address, and the provider id
   * decides which *flags* travel with the request — whether usage may be streamed,
   * whether a reasoning channel exists, and which header names the conversation.
   */
  provider: ProviderId;
  /**
   * The credential, already decrypted by the process that owns the keychain.
   *
   * Empty for a server that needs none, which is a real state rather than a
   * missing one: the transport sends no `Authorization` header at all when this is
   * empty, because an empty bearer token is refused where no header is ignored.
   */
  apiKey: string;
  maxOutputTokens?: number;
  /** The profile's Role: what this agent is for and what it may claim. */
  systemPrompt: string;
  /**
   * The person's Persona: the character, the job in their words, and how they
   * want to be spoken to.
   *
   * Here rather than in `systemPrompt` because the two have different owners:
   * the Role is the app's text and Settings can restore it, so the person's own
   * words must not live inside it. Read per request like `enabledSkills` below,
   * and for the same reason — it is prompt text, so editing it does not abort a
   * turn that is already running. Absent or blank means they wrote none.
   */
  persona?: string;
  /**
   * Prompt text for this turn only, appended to the instruction.
   *
   * The one caller is the desktop companion: it shares the conversation with the
   * window, so "answer briefly" cannot be a property of the conversation and has
   * to travel with the turn that asked for it. The runtime sets it from the
   * turn's own argument, so it is never carried over: a turn that asks for
   * nothing clears whatever the last one left behind.
   *
   * Read per request like `enabledSkills` below, and for the same reason: it is
   * prompt text, so changing it between turns is not a reason to abort the one
   * in flight.
   */
  instruction?: string;
  /**
   * Agent profile this configuration belongs to. It decides which `memory.md`
   * is read and written, so switching profile switches remembered facts as well
   * as identity. Absent means the default profile.
   */
  profileId?: string;
  /** File tools are confined here; also the default working directory. */
  workspaceRoot: string;
  /**
   * How large `memory.md` may get before the agent is told to prune.
   *
   * Absent means the built-in default. A preference rather than a fact about the
   * agent, so it travels with the configuration and is applied to the memory
   * store when the config changes — which is what makes moving it in Settings
   * affect the next tool call rather than the next launch.
   */
  memorySoftLimitBytes?: number;
  allowPrivateNetworkFetch: boolean;
  /**
   * Tool names this profile may use. Absent means "no restriction", which is
   * what a caller with no profile concept (a test, a future CLI) wants;
   * an empty array means the agent gets no tools at all.
   */
  enabledTools?: string[];
  /**
   * The connectors this profile may use, by server id.
   *
   * Absent means every connected server, which is what every profile written
   * before the field existed carries — an upgrade must not quietly take a user's
   * connectors away from the agent that was using them. An empty array means
   * none, and the two are therefore different answers rather than the same one,
   * exactly as they are for `enabledTools` above.
   *
   * It is a grant over *servers* rather than over their tools, because a server's
   * tool list is discovered when it connects and changes when it is upgraded: a
   * per-tool grant would be a list that silently stopped covering what the server
   * now offers, and the model would be offered a tool nobody had approved.
   */
  mcpServerIds?: string[];
  /**
   * Names of the *user's* skills to carry in the instruction.
   *
   * Not the built-in ones: the operating protocol is unconditional and a
   * capability skill follows `enabledTools`, so this list names only what came
   * out of `/learn`. Absent means all of the user's, an empty array none of them
   * — which is what every profile written before skills could be saved carries,
   * and correctly means "no skills of mine" rather than "no prompt at all".
   */
  enabledSkills?: string[];
  /**
   * The user's skills themselves, for the agent to select from by name.
   *
   * Part of the configuration rather than a host option because it is prompt
   * content, exactly like `systemPrompt` beside it: the runner is rebuilt when
   * this changes, and the next request already carries the new skill.
   */
  userSkills?: readonly Skill[];
}
