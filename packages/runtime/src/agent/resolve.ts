/**
 * Turning what the user configured into what the agent runs on.
 *
 * This is the join between three documents that were written at different times
 * and never see each other: the settings (which service answers, and how warm the
 * model runs), the profile (who this agent is, where it works, what it may use)
 * and the secret store (the key). The agent wants one `AgentConfig`; this is
 * where that comes from.
 *
 * It is a pure function of its inputs apart from the secret read, deliberately.
 * Every failure it can have — a profile with no folder, a key that is missing, a
 * key that exists but cannot be decrypted, a provider this build does not know —
 * has to be reportable *before* a turn starts, because a turn that begins and
 * then dies at the provider gives the user a spinner and a stack trace instead of
 * a sentence. So it answers with a reason rather than throwing, and the caller
 * decides how to say it.
 */
import type {AgentConfig, Skill} from '@marimo/agent';

import {PROVIDERS, agentProfileSchema} from '@marimo/protocol';
import type {
  AgentModel,
  AgentProfile,
  ProviderConfig,
  ProviderId,
  Settings,
} from '@marimo/protocol';

import type {SecretRead} from '../secrets.js';

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
 * window as an error line, and "no API key" is a worse sentence than "DeepSeek
 * needs an API key — add one in Settings".
 */
export type ResolvedAgent =
  | {ok: true; config: AgentConfig; profile: AgentProfile}
  | {ok: false; problem: string};

export interface ResolveAgentOptions {
  settings: Settings;
  profile: AgentProfile;
  /** Reads the key for a provider. Never returns the value for logging. */
  readSecret: (providerId: ProviderId) => Promise<SecretRead>;
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
  /**
   * The model this conversation was pointed at, when it has one of its own.
   *
   * It outranks the profile's and the app's, and that order is the whole point of
   * the field: "answer this one question with the big model" is a decision about
   * a question, and the next conversation is unaffected by it.
   */
  sessionModel?: AgentModel;
}

/**
 * Which model answers this turn, in the order the evidence is good.
 *
 * Exported because two callers need the same answer: the resolver below, and
 * anything that has to *report* what a conversation would use without starting a
 * turn — a card, a test. Two implementations of this order would be two answers
 * to "which model is this", and the one a user reads would be the wrong one.
 *
 * The fallback config is unreachable through the schemas, which key the record by
 * the same enum the model names. It is here so the function is total: a
 * hand-edited file must not crash a turn at the moment it is being described.
 */
export function modelChoiceFor(
  settings: Settings,
  profile: AgentProfile,
  sessionModel?: AgentModel,
): {provider: ProviderId; config: ProviderConfig} {
  /*
   * The most specific choice wins *whole*: whichever of the conversation's and
   * the agent's names a provider also supplies the model id, and only when
   * neither does is the app's stored pair used as it stands.
   *
   * Taking the provider from one and the id from the other is the bug this
   * shape exists to prevent, and it is a quiet one: the id in the agent's
   * document would be ignored in favour of the settings file's, so a window
   * naming the agent's model would be describing a turn answered by a different
   * one. The renderer reads the same two documents by the same rule, which is
   * why the rule lives here rather than in either of them.
   */
  const choice = sessionModel ?? profile.model;
  const provider = choice?.provider ?? settings.providers.active;
  const stored =
    settings.providers.configs[provider] ??
    // Unreachable through the schemas, which key the record by the same enum the
    // model names. Here so the function is total: a hand-edited file must not
    // crash a turn at the moment it is being described.
    {baseUrl: '', model: '', keyStorage: 'keychain' as const};
  return {
    provider,
    config: choice === undefined ? stored : {...stored, model: choice.model},
  };
}

export async function resolveAgentConfig(
  options: ResolveAgentOptions,
): Promise<ResolvedAgent> {
  const {settings, profile} = options;

  const workspaceRoot = options.workspaceRoot;
  if (workspaceRoot === undefined) {
    return {
      ok: false,
      problem:
        `"${profile.name}" has no space to work in. Use “Load a space…” in the ` +
        'rail so its file tools have somewhere to work.',
    };
  }

  const {provider: providerId, config} = modelChoiceFor(
    settings,
    profile,
    options.sessionModel,
  );
  const provider = PROVIDERS[providerId];
  /*
   * A provider id this build has never heard of, which can only come from a
   * document written by a newer build — every record is keyed by the same enum.
   * Refused by name rather than dereferenced: the alternative is a turn that
   * fails on `undefined.label`, which reads as a crash rather than as an answer
   * about the settings.
   */
  if (provider === undefined) {
    return {
      ok: false,
      problem:
        `This conversation is set to “${String(providerId)}”, a service this ` +
        'build does not know. Choose another provider in Settings.',
    };
  }

  const secret = await options.readSecret(providerId);
  const apiKey = secret.state === 'present' ? secret.value : '';

  /*
   * A provider that needs a key and does not have one is refused here rather
   * than at the first request. The two cases are kept apart because the fix
   * differs: one is "add a key", the other is "the key is there and this machine
   * cannot read it", and telling a user to re-enter a key they already entered is
   * how a working install looks broken.
   */
  if (provider.requiresApiKey && apiKey.length === 0) {
    return {
      ok: false,
      problem:
        secret.state === 'unreadable'
          ? secret.reason
          : `${provider.label} needs an API key. Add one in Settings.`,
    };
  }

  return {
    ok: true,
    profile,
    config: {
      apiKey,
      /*
       * The address the user's document holds, with the catalogue's as the
       * fallback rather than the other way round: an empty string here is a field
       * somebody cleared, and the catalogue's default is a better answer than a
       * request to nowhere.
       */
      baseUrl:
        config.baseUrl.length > 0 ? config.baseUrl : provider.defaultBaseUrl,
      model:
        config.model.length > 0 ? config.model : provider.fallbackModels[0]!,
      provider: providerId,
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
