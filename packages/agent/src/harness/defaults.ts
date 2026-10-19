/**
 * The app's own harness, before any profile or conversation touches it.
 *
 * These are the facts the app ships: the rules every agent works under, the
 * defaults a profile inherits, and the plugin set that keeps a turn honest.
 * They are data rather than code paths so a version can be stored, diffed and
 * restored without replaying a constructor.
 *
 * The contract is the old `reasoning` skill's text, split into rules. It moved
 * here because it is app-owned and unconditional: a person editing their Role
 * cannot reach it, and a profile reset cannot lose it. The capability skills
 * remain separate and follow the grants.
 */
import type {HarnessBuiltin} from './spec.js';

/** Default ceilings. A profile may lower them; nothing may remove them. */
export const DEFAULT_BUDGETS = {
  maxSteps: 24,
  maxToolCalls: 32,
  maxDelegations: 3,
  timeoutMs: 10 * 60_000,
} as const;

/**
 * The app contract.
 *
 * Written as rules rather than prose because a model follows a short list more
 * reliably than a paragraph, and because a rule that changes can be diffed in a
 * harness version. It says nothing about which tools exist: that is the
 * capability guidance's job, and it follows the grant.
 */
export const APP_CONTRACT: readonly string[] = [
  'Decompose anything that is not a single lookup into a short numbered plan before calling a tool, and say which step you are on.',
  'Call one tool at a time. Read its result before deciding the next call, and never batch calls whose arguments depend on an earlier result.',
  'If a tool fails or returns something unexpected, say what went wrong, then change the approach. After two failures of the same approach, change it or ask the user.',
  'Touch files, the network or the shell only when the request needs it. Prefer reading over running a command, and prefer the smallest action that answers the question.',
  'Never claim a tool ran, a file was read, or a search returned something when it did not.',
  'A large tool result is truncated and says so. Pass the truncation on rather than guessing at the rest.',
  'A refusal is an answer. If a capability is switched off, name it and say where to turn it on; do not look for another route to the same effect.',
  'Use only the tools you were given. A capability that is not offered is not available, and saying so is better than pretending it ran.',
  'A gated call pauses the turn and waits for the user. Leave it waiting. On an unattended run nobody may be there to approve it, and that is the intended outcome.',
  'A greeting, an opinion, or a question about you is not a task. Answer it as yourself: no plan, no search, and no narration of steps.',
  'Write GitHub-flavoured Markdown, fence code with a language tag, and keep prose tight: no filler preamble and no restating the question.',
];

/**
 * The built-in harness.
 *
 * `memory.scopes` carries both layers by default. A profile that has no Space
 * still gets the person half, and the resolver never invents a Space scope for a
 * turn that does not have a folder.
 */
export const DEFAULT_HARNESS: HarnessBuiltin = {
  contract: APP_CONTRACT,
  context: {
    memory: {
      scopes: ['person', 'space'],
      // Relevant retrieval only narrows a large file; the fallback is whole.
      policy: 'relevant',
      softLimit: 8 * 1024,
    },
    skills: {
      advertise: true,
    },
    compaction: {
      // Room for the stable layers and the recent turns. A model with a larger
      // window can raise this in its profile without changing the engine.
      maxContextTokens: 96_000,
      reserve: 8_000,
    },
    spaceContext: true,
  },
  tools: {
    policy: {
      gates: {
        // The two calls that can destroy something. `write_file` creates without
        // a gate and gates the replacement; the tool's predicate decides which.
        run_shell: 'always',
        write_file: 'on-overwrite',
      },
      network: 'default',
    },
    budgets: DEFAULT_BUDGETS,
  },
  collaborators: {
    mode: 'lead',
    maxDepth: 1,
  },
  // Trace is added by the resolver only when the user asked for retention.
  // Redaction and the loop guard are always on: neither records anything.
  plugins: ['redaction', 'loop-guard'],
};
