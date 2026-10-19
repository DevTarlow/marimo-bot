/**
 * The contract a turn runs under.
 *
 * A turn used to be assembled from a profile, a settings document and a handful
 * of booleans that each reader interpreted for itself. The harness is the same
 * facts collected once, resolved once, and frozen for the life of a turn: who
 * the agent is, what it is told, what it may use, what it may delegate, which
 * model answers and how much it may spend. Every turn records the hash of this
 * object, so a question about what the agent was allowed to do at a particular
 * moment has an exact answer rather than a guess about a settings file that has
 * since changed.
 *
 * The shape follows Harness²'s eight editable components — identity/contract,
 * guardrails, memory, tool guidance, subagents, skills, plugins — with `scripts`
 * deliberately absent. There is no workflow here that a skill plus a tool cannot
 * already express, and a field nothing sets is a branch nobody tests.
 */
import {z} from 'zod';

import {agentModelSchema} from '@marimo/protocol';
import type {AgentModel} from '@marimo/protocol';

/** Bumped when a field's meaning changes, not when a default does. */
export const HARNESS_SPEC_VERSION = 1;

/**
 * What a gate is for one tool.
 *
 * `on-overwrite` is a gate over the call's arguments rather than over the tool:
 * creating a file is not destructive and replacing one is. The engine evaluates
 * it before the tool list is built and again before the call runs, because the
 * file can change while the user is reading the card.
 */
export const gateRuleSchema = z.enum([
  'always',
  'on-overwrite',
  'on-untrusted-server',
  'never',
]);

export type GateRule = z.infer<typeof gateRuleSchema>;

/**
 * A capability's guidance follows the tools it describes.
 *
 * This is the list the prompt may advertise, and it is derived from the grants
 * rather than stored twice. A guidance block whose tools were switched off would
 * be a prompt telling the model about a capability it does not have, which is
 * exactly the sentence the model then repeats to the user.
 */
export const CAPABILITY_GUIDANCE = [
  {
    id: 'files',
    tools: ['read_file', 'list_dir', 'write_file'],
  },
  {
    id: 'shell',
    tools: ['run_shell'],
  },
  {
    id: 'web',
    tools: ['web_search', 'http_fetch'],
  },
  {
    id: 'memory',
    tools: ['read_memory', 'update_memory', 'prune_memory'],
  },
  {
    id: 'recall',
    tools: ['recall'],
  },
  {
    id: 'knowledge',
    tools: ['search_knowledge_base'],
  },
  {
    id: 'jobs',
    tools: ['list_jobs', 'create_job', 'update_job', 'delete_job'],
  },
  {
    id: 'delegation',
    tools: ['ask_agent'],
  },
  {
    id: 'learning',
    tools: ['save_skill', 'load_skill'],
  },
] as const;

export type CapabilityGuidanceId = (typeof CAPABILITY_GUIDANCE)[number]['id'];

/**
 * The engine plugins a harness may carry.
 *
 * `loop-guard` refuses the third identical tool call, `trace` records the turn
 * when learning is on, and `redaction` keeps secrets out of logs. They are
 * named rather than passed as objects because the spec is data: a stored
 * harness cannot smuggle a function into a document.
 */
export const pluginIdSchema = z.enum(['loop-guard', 'trace', 'redaction']);

export type PluginId = z.infer<typeof pluginIdSchema>;

export const budgetSchema = z.object({
  /** Model requests in one turn, including the request that asks for a tool. */
  maxSteps: z.number().int().positive(),
  /** Tool calls in one turn, across every step. */
  maxToolCalls: z.number().int().positive(),
  /** Helper runs in one turn. Depth is one regardless. */
  maxDelegations: z.number().int().nonnegative(),
  /** Wall clock for the turn. */
  timeoutMs: z.number().int().positive(),
});

export type Budgets = z.infer<typeof budgetSchema>;

export const contextSchema = z.object({
  memory: z.object({
    scopes: z.array(z.enum(['person', 'space'])),
    /**
     * `all` puts the file in the prompt; `relevant` retrieves against the
     * question once the file is larger than the recalled block. The fallback is
     * always the whole file, never a silently smaller one.
     */
    policy: z.enum(['all', 'relevant']),
    softLimit: z.number().int().positive(),
  }),
  skills: z.object({
    enabled: z.array(z.string().min(1)),
    /** The prompt advertises name and one line. It never carries the body. */
    advertise: z.literal(true),
  }),
  compaction: z.object({
    maxContextTokens: z.number().int().positive(),
    reserve: z.number().int().nonnegative(),
  }),
  spaceContext: z.boolean(),
});

export type HarnessContext = z.infer<typeof contextSchema>;

export const toolPolicySchema = z.object({
  gates: z.record(z.string(), gateRuleSchema),
  network: z.enum(['default', 'private']),
});

export type ToolPolicy = z.infer<typeof toolPolicySchema>;

export const toolsSchema = z.object({
  grants: z.array(z.string().min(1)),
  guidance: z.array(z.string().min(1)),
  /**
   * `all` means every connected connector, which is what a profile written
   * before the field existed means. An empty array is a real answer: no
   * connectors.
   */
  mcpServerIds: z.union([z.array(z.string().min(1)), z.literal('all')]),
  policy: toolPolicySchema,
  budgets: budgetSchema,
});

export type HarnessTools = z.infer<typeof toolsSchema>;

export const collaboratorsSchema = z.object({
  mode: z.enum(['lead', 'participant']),
  delegates: z.array(z.string().min(1)),
  /** Depth is one by construction; this is the assertion, not a setting. */
  maxDepth: z.literal(1),
});

export type Collaborators = z.infer<typeof collaboratorsSchema>;

export const learningSchema = z.object({
  mode: z.enum(['propose', 'off']),
  retainTraces: z.boolean(),
});

export type LearningPolicy = z.infer<typeof learningSchema>;

export const harnessSpecSchema = z.object({
  /** The profile this spec was resolved for. */
  id: z.string().min(1),
  version: z.number().int().positive(),
  identity: z.object({
    name: z.string().trim().min(1),
    /** The app's brief for this bot. Human text; a proposal never edits it. */
    role: z.string(),
    /** The person's own text. Human text; a proposal never edits it. */
    persona: z.string().optional(),
  }),
  /** Unconditional app rules. Human text; a proposal never edits it. */
  contract: z.array(z.string().min(1)),
  context: contextSchema,
  tools: toolsSchema,
  collaborators: collaboratorsSchema,
  model: agentModelSchema.extend({
    maxOutputTokens: z.number().int().positive().optional(),
  }),
  plugins: z.array(pluginIdSchema),
  learning: learningSchema,
});

export type HarnessSpec = z.infer<typeof harnessSpecSchema>;

/**
 * A profile's sparse changes to the built-in harness.
 *
 * Sparse rather than complete because the defaults are the app's, and a profile
 * that copied them would freeze yesterday's defaults into one bot. Every field
 * is optional; an absent field means the layer below it answers.
 */
export const harnessOverridesSchema = z.object({
  context: z
    .object({
      memory: z
        .object({
          scopes: z.array(z.enum(['person', 'space'])).optional(),
          policy: z.enum(['all', 'relevant']).optional(),
          softLimit: z.number().int().positive().optional(),
        })
        .optional(),
      compaction: z
        .object({
          maxContextTokens: z.number().int().positive().optional(),
          reserve: z.number().int().nonnegative().optional(),
        })
        .optional(),
      spaceContext: z.boolean().optional(),
    })
    .optional(),
  tools: z
    .object({
      policy: z
        .object({
          gates: z.record(z.string(), gateRuleSchema).optional(),
          network: z.enum(['default', 'private']).optional(),
        })
        .optional(),
      budgets: budgetSchema.partial().optional(),
    })
    .optional(),
  collaborators: z
    .object({
      mode: z.enum(['lead', 'participant']).optional(),
      delegates: z.array(z.string().min(1)).optional(),
    })
    .optional(),
});

export type HarnessOverrides = z.infer<typeof harnessOverridesSchema>;

/**
 * The profile fields the resolver needs, and no others.
 *
 * Kept structural rather than importing the protocol's `AgentProfile`, because
 * the old profile document is being replaced and the harness must not depend on
 * a shape that is about to move. The v2 profile satisfies this interface; so
 * does a test fixture.
 */
export interface HarnessProfile {
  id: string;
  name: string;
  role: string;
  persona?: string;
  enabledTools: string[];
  enabledSkills: string[];
  mcpServerIds?: string[];
  model?: AgentModel;
  harness?: HarnessOverrides;
}

/** The conversation's own choice, when it has one. */
export interface HarnessConversation {
  model?: AgentModel;
  harness?: HarnessOverrides;
}

/** The app-level facts every profile starts from. */
export interface HarnessAppDefaults {
  model: AgentModel;
  allowPrivateNetworkFetch: boolean;
  memorySoftLimitBytes?: number;
  learning: LearningPolicy;
}

/** The versions of the app's own texts and defaults. */
export interface HarnessBuiltin {
  contract: readonly string[];
  context: Omit<HarnessContext, 'skills'> & {
    skills: Omit<HarnessContext['skills'], 'enabled'>;
  };
  tools: Omit<HarnessTools, 'grants' | 'guidance' | 'mcpServerIds'>;
  collaborators: Omit<Collaborators, 'delegates'>;
  plugins: readonly PluginId[];
}

export interface ResolveHarnessInput {
  profile: HarnessProfile;
  conversation?: HarnessConversation;
  app: HarnessAppDefaults;
  version: number;
  builtin?: HarnessBuiltin;
}

/** The capabilities whose tools are actually granted. */
export function guidanceForTools(
  grants: readonly string[],
  hasConnectors = false,
): string[] {
  const granted = new Set(grants);
  const ids = CAPABILITY_GUIDANCE.filter((capability) =>
    capability.tools.some((tool) => granted.has(tool)),
  ).map((capability) => capability.id as string);
  if (hasConnectors) {
    ids.push('connectors');
  }
  return ids;
}
