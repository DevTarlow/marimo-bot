/**
 * Turning what the user configured into what the agent runs on.
 *
 * This used to be the join between three documents that never saw each other —
 * the settings (which provider answered), the profile and the provider's secret.
 * The secret is gone, and with it the provider. What is left is the (profile,
 * account) pair the turn will actually use: who this bot is, where it works, what
 * it may use, and the loopback address of the one local model that is running.
 *
 * It is a pure function of its inputs. Every failure it can have — a profile
 * with no folder, a model the host could not start — has to be reportable
 * *before* a turn starts, because a turn that begins and then dies gives the user
 * a spinner and a stack trace instead of a sentence. So it answers with a reason
 * rather than throwing, and the caller decides how to say it.
 *
 * The model and its address arrive as arguments rather than being read here: the
 * address exists only in the process that started the engine, and it changes
 * every time the engine is woken. A copy stored in this function would be an
 * address pointing at a process that died a minute ago.
 */
import type {AgentConfig, Skill} from '@marimo/agent';

import {agentProfileSchema} from '@marimo/protocol';
import type {
  AgentModel,
  AgentProfile,
  Settings,
} from '@marimo/protocol';

/** The skill shape the agent's instruction builder takes. */
export interface StoredSkillForPrompt {
  name: string;
  description: string;
  instructions: string;
}

/**
 * What a turn needs, or why it cannot start.
 *
 * `problem` is phrased for the person who will read it: these reach the chat
 * window as an error line, and "no local model" is a worse sentence than
 * "LFM3 1.7B is not downloaded — open Settings → Models".
 */
export type ResolvedAgent =
  | {ok: true; config: AgentConfig; profile: AgentProfile}
  | {ok: false; problem: string};

export interface ResolveAgentOptions {
  settings: Settings;
  profile: AgentProfile;
  /**
   * The model this turn runs on, already resolved and already running.
   *
   * The provider half is `local` for every new turn; the old ids can still be
   * read from an old log, but nothing passes one here.
   */
  model: AgentModel;
  /**
   * The engine's loopback address, `/v1` included.
   *
   * Supplied by the host that started it, not read from a document: a fixed
   * address would send a conversation to whatever else happened to be listening
   * on that port.
   */
  baseUrl: string;
  /** The skills this profile carries, already filtered to the ones it enabled. */
  skills?: readonly StoredSkillForPrompt[];
  /**
   * The folder this turn runs in.
   *
   * Supplied by the caller rather than read off the profile, because the answer
   * is a fact about the *conversation*: a chat is filed under a folder in the
   * install's workspace document, and the caller is the only one that knows
   * which conversation this turn belongs to. Absent means there is no folder to
   * work in at all, which is a refusal rather than a default.
   */
  workspaceRoot?: string;
}

export async function resolveAgentConfig(
  options: ResolveAgentOptions,
): Promise<ResolvedAgent> {
  const {settings, profile, model} = options;

  const workspaceRoot = options.workspaceRoot;
  if (workspaceRoot === undefined) {
    return {
      ok: false,
      problem:
        `"${profile.name}" has no space to work in. Use “Load a space…” in the ` +
        'rail so its file tools have somewhere to work.',
    };
  }

  return {
    ok: true,
    profile,
    config: {
      baseUrl: options.baseUrl,
      model: model.model,
      provider: model.provider,
      /*
       * No credential. The model runs on this machine and was started by this
       * process; the transport sends no `Authorization` header at all when the
       * key is empty, which is the honest shape for a server that takes none.
       */
      apiKey: '',
      ...(settings.maxOutputTokens !== undefined
        ? {maxOutputTokens: settings.maxOutputTokens}
        : {}),
      systemPrompt: profile.identity,
      /*
       * Carried beside the Role rather than folded into it: the two have
       * different owners, and the agent's prompt is composed so the person's
       * words outrank the app's on manner without outranking the app's method
       * rules. Blank is absent, which is what the composer reads.
       */
      ...(profile.persona !== undefined && profile.persona.trim().length > 0
        ? {persona: profile.persona}
        : {}),
      profileId: profile.id,
      workspaceRoot,
      memorySoftLimitBytes: settings.memorySoftLimitBytes,
      allowPrivateNetworkFetch: settings.allowPrivateNetworkFetch,
      enabledTools: [...profile.enabledTools],
      enabledSkills: [...profile.enabledSkills],
      /*
       * The connectors this agent may use. Carried only when the profile names
       * some, because absent means "every one of them" — what a profile written
       * before the field existed carries, so an upgrade offers exactly what it
       * offered before. An empty array is the opposite answer and travels as one:
       * the host filters the connected servers by this list, so "none" is the
       * absence of every connector's tools rather than a refusal when one is
       * called.
       */
      ...(profile.mcpServerIds !== undefined
        ? {mcpServerIds: [...profile.mcpServerIds]}
        : {}),
      ...(options.skills !== undefined && options.skills.length > 0
        ? {userSkills: options.skills.map(toAgentSkill)}
        : {}),
    },
  };
}

function toAgentSkill(skill: StoredSkillForPrompt): Skill {
  return {
    name: skill.name,
    description: skill.description,
    instructions: skill.instructions,
  };
}

/**
 * Reads a profile defensively.
 *
 * The store already validates on the way in, so this is for the file that was
 * hand-edited between two runs — the moment when a corrupt document would
 * otherwise reach the agent as an object with missing fields.
 */
export function parseProfile(raw: unknown): AgentProfile | undefined {
  const parsed = agentProfileSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}
