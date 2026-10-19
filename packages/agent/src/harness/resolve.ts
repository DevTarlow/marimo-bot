/**
 * Resolving a profile and a conversation into one frozen harness.
 *
 * The resolver is the only place that knows the precedence order, and the order
 * is the whole answer to "what was this turn allowed to do?". Conversation
 * choices win over a profile, a profile wins over the app, and a profile can
 * narrow the app's guardrails but never widen them: turning the app's private
 * network access off is not something a bot's document can undo, and
 * `run_shell` cannot lose its approval gate because a profile said so.
 */
import {agentModelSchema} from '@marimo/protocol';
import type {AgentModel} from '@marimo/protocol';

import {DEFAULT_HARNESS} from './defaults.js';
import {guidanceForTools, harnessSpecSchema} from './spec.js';
import type {
  Budgets,
  Collaborators,
  GateRule,
  HarnessAppDefaults,
  HarnessBuiltin,
  HarnessContext,
  HarnessOverrides,
  HarnessProfile,
  HarnessSpec,
  LearningPolicy,
  ToolPolicy,
} from './spec.js';

export interface ResolveHarnessInput {
  profile: HarnessProfile;
  /** The conversation's own choice, when it has one. */
  conversation?: {
    model?: AgentModel;
    /** Only `context` is read from a conversation; see below. */
    harness?: HarnessOverrides;
  };
  app: HarnessAppDefaults;
  /** A version is assigned by the store, not invented here. */
  version: number;
  /** Whether this turn has a Space to work in. */
  hasSpace?: boolean;
  /** Whether any connector is actually connected, not merely granted. */
  hasConnectors?: boolean;
  builtin?: HarnessBuiltin;
}

/**
 * How strong a gate is. A profile may move a gate up this scale and not down:
 * "always" survives an attempt to make it "never", because a bot's document is
 * not where the app's safety rules are decided.
 */
const GATE_STRENGTH: Record<GateRule, number> = {
  never: 0,
  'on-overwrite': 1,
  'on-untrusted-server': 1,
  always: 2,
};

function strongerGate(current: GateRule, next: GateRule): GateRule {
  return GATE_STRENGTH[next] >= GATE_STRENGTH[current] ? next : current;
}

function mergeGates(
  builtin: Record<string, GateRule>,
  override: Record<string, GateRule> | undefined,
): Record<string, GateRule> {
  const merged = {...builtin};
  for (const [tool, rule] of Object.entries(override ?? {})) {
    merged[tool] = strongerGate(merged[tool] ?? 'never', rule);
  }
  return merged;
}

function mergeContext(
  builtin: HarnessBuiltin['context'],
  profile: HarnessOverrides['context'],
  conversation: HarnessOverrides['context'],
  options: {
    hasSpace: boolean;
    memorySoftLimitBytes?: number;
  },
): HarnessContext {
  const scopes = (
    conversation?.memory?.scopes ??
    profile?.memory?.scopes ??
    builtin.memory.scopes
  ).filter((scope) => options.hasSpace || scope !== 'space');

  const softLimit =
    profile?.memory?.softLimit ??
    options.memorySoftLimitBytes ??
    builtin.memory.softLimit;

  return {
    memory: {
      scopes,
      policy:
        conversation?.memory?.policy ??
        profile?.memory?.policy ??
        builtin.memory.policy,
      softLimit,
    },
    skills: {
      enabled: [],
      advertise: true,
    },
    compaction: {
      ...builtin.compaction,
      ...profile?.compaction,
      ...conversation?.compaction,
    },
    spaceContext:
      options.hasSpace &&
      (conversation?.spaceContext ??
        profile?.spaceContext ??
        builtin.spaceContext),
  };
}

function mergeToolPolicy(
  builtin: HarnessBuiltin['tools'],
  overrides: HarnessOverrides['tools'],
  app: HarnessAppDefaults,
): {policy: ToolPolicy; budgets: Budgets} {
  /*
   * The app's consent is the ceiling. A profile may be stricter than the app;
   * it may not turn private-network access on when the person left it off.
   */
  const network = app.allowPrivateNetworkFetch
    ? (overrides?.policy?.network ?? 'private')
    : 'default';

  return {
    policy: {
      gates: mergeGates(builtin.policy.gates, overrides?.policy?.gates),
      network,
    },
    budgets: {
      ...builtin.budgets,
      ...overrides?.budgets,
    },
  };
}

function mergeCollaborators(
  builtin: HarnessBuiltin['collaborators'],
  overrides: HarnessOverrides['collaborators'],
): Collaborators {
  return {
    mode: overrides?.mode ?? builtin.mode,
    delegates: overrides?.delegates ?? [],
    maxDepth: 1,
  };
}

function pluginsFor(
  builtin: HarnessBuiltin['plugins'],
  learning: LearningPolicy,
): HarnessSpec['plugins'] {
  const plugins = [...builtin];
  if (
    learning.mode === 'propose' &&
    learning.retainTraces &&
    !plugins.includes('trace')
  ) {
    plugins.push('trace');
  }
  return plugins;
}

/**
 * Resolves one turn's harness.
 *
 * The returned spec is validated before it leaves this function: a malformed
 * override becomes a refusal at resolution time rather than a provider error in
 * the middle of a turn.
 */
export function resolveHarness(input: ResolveHarnessInput): HarnessSpec {
  const builtin = input.builtin ?? DEFAULT_HARNESS;
  const profileOverrides = input.profile.harness;
  const conversationOverrides = input.conversation?.harness;

  const hasSpace = input.hasSpace ?? false;
  const hasConnectors = input.hasConnectors ?? false;

  /*
   * A model is a pair. The conversation names a whole pair, then the profile,
   * then the app; taking a provider from one and an id from another is how a
   * window comes to name a model the turn is not using.
   */
  const model = agentModelSchema.parse(
    input.conversation?.model ?? input.profile.model ?? input.app.model,
  );

  const grants = [...input.profile.enabledTools];
  const mcpServerIds = input.profile.mcpServerIds ?? 'all';
  const connectorsAvailable =
    hasConnectors && (mcpServerIds === 'all' || mcpServerIds.length > 0);

  const context = mergeContext(
    builtin.context,
    profileOverrides?.context,
    conversationOverrides?.context,
    {
      hasSpace,
      ...(input.app.memorySoftLimitBytes === undefined
        ? {}
        : {memorySoftLimitBytes: input.app.memorySoftLimitBytes}),
    },
  );
  context.skills = {
    enabled: [...input.profile.enabledSkills],
    advertise: true,
  };

  const {policy, budgets} = mergeToolPolicy(
    builtin.tools,
    profileOverrides?.tools,
    input.app,
  );

  const collaborators = mergeCollaborators(
    builtin.collaborators,
    profileOverrides?.collaborators,
  );

  const learning: LearningPolicy = {
    mode: input.app.learning.mode,
    retainTraces: input.app.learning.retainTraces,
  };

  const persona = input.profile.persona?.trim();

  return harnessSpecSchema.parse({
    id: input.profile.id,
    version: input.version,
    identity: {
      name: input.profile.name,
      role: input.profile.role,
      ...(persona === undefined || persona.length === 0 ? {} : {persona}),
    },
    contract: [...builtin.contract],
    context,
    tools: {
      grants,
      guidance: guidanceForTools(grants, connectorsAvailable),
      mcpServerIds,
      policy,
      budgets,
    },
    collaborators,
    model,
    plugins: pluginsFor(builtin.plugins, learning),
    learning,
  });
}
