# The harness rebuild: v2 of the agent core

This is the design the rewrite follows until it lands. It is deliberately
narrower than `TECHNICAL.md`: that file explains the app that exists, and this
one explains the one being built in its place. When the rebuild is finished this
file and `TECHNICAL.md` merge, and this one becomes the history of why the core
changed shape.

Status: **Phase 0 — design frozen, scaffolding started.** The last v1 commit is
tagged `v1-final`.

## Why the core is being rebuilt

The app is not being replaced. It keeps its window, its Electron shell, its
runtime services and Google ADK as the low-level agent plumbing. What is being
rewritten is the layer above ADK: the thing that decides what an agent is, what
it is told, what it may do, how a turn is run, how work is handed to another bot
and how the agent learns from what happened.

Two projects prompted the question. Neither is a foundation for this app:

- **Harness²** (`google-research/harness2`) is a Python 3.12 research harness for
  benchmarked recursive harness optimization. It has no product storage, UI, IPC,
  packaging or desktop runtime. Its _design_ is the useful part: eight editable
  harness components, and an improvement loop that keeps lessons across tasks.
- **DeepSeek Harness** is a developer preview whose own README promises
  breaking changes. A plugin built on it would inherit that instability and lose
  most of this app.

The current core also earned its keep. It carries twenty-three invariants, each
one discovered by a real failure, and 1,471 tests. A rewrite that throws those
away is worse than no rewrite. So the old code is deleted only after its
invariants have a named test in the new engine. See
[`harness-invariants.md`](./harness-invariants.md).

## What changes, what stays

| Area                                                                | Disposition                                          |
| ------------------------------------------------------------------- | ---------------------------------------------------- |
| `HarnessSpec`, resolution, versions                                 | New                                                  |
| Turn engine, event log, gates, budgets                              | New                                                  |
| Context assembly, memory block, skills index, compaction            | New                                                  |
| Tool policy and the built-in tool set                               | New                                                  |
| Delegation and group collaboration                                  | New                                                  |
| Learning: traces, proposals, versions, rollback                     | New                                                  |
| OpenAI-compatible transport, provider catalogue                     | Ported                                               |
| MCP client and wire format                                          | Ported                                               |
| Profiles, Spaces, documents, jobs, text recall, secrets, OS service | Kept, adapted                                        |
| Electron shell, preload, tray, companion window                     | Kept                                                 |
| Renderer shell and visual language                                  | Kept; pages added and replaced                       |
| Dream-RSI (standalone)                                              | Removed; the trace recorder idea moves into learning |
| Discord tools                                                       | Removed                                              |
| Notes / to-do desk                                                  | Removed                                              |
| Media recall (images, audio, video)                                 | Removed from the shipped app; text recall stays      |

## The shape

```
apps/desktop        Electron shell, IPC, tray, companion, renderer
packages/runtime    Node-side services: profiles, Spaces, documents, jobs,
                    recall, secrets, service plans, v2 stores
packages/agent      The clean-room core: harness, engine, context, policy,
                    tools, collab, learning, memory, skills, model gateway
packages/protocol   The typed contract; zod schemas only
```

Dependency direction is one way: `protocol ← agent ← runtime ← desktop`.

Two import rules are load-bearing:

1. **`@google/adk` may be imported only by the engine's adapter files**
   (`packages/agent/src/engine/adk.ts` and the model adapter). An ADK upgrade is
   then a one-file change, and ADK event shapes cannot leak into the rest of the
   app.
2. **`packages/*` import nothing from Electron.** The headless runner is the same
   agent core without a window; an Electron import in a package breaks it
   silently at boot.

## The harness contract

A turn is run by a frozen, versioned `HarnessSpec`. A profile stores sparse
overrides; the resolver combines them with the app defaults; the turn records the
resolved spec's hash. Nothing about a turn is decided by an object that could
change halfway through it.

```ts
interface HarnessSpec {
  id: string;
  version: number;
  identity: {name: string; role: string; persona?: string};
  contract: string[];
  context: {
    memory: {
      scopes: ('person' | 'space')[];
      policy: 'all' | 'relevant';
      softLimit: number;
    };
    skills: {enabled: string[]; advertise: true};
    compaction: {maxContextTokens: number; reserve: number};
    spaceContext: boolean;
  };
  tools: {
    grants: string[];
    guidance: string[];
    mcpServerIds: string[] | 'all';
    policy: {gates: Record<string, GateRule>; network: 'default' | 'private'};
    budgets: {
      maxSteps: number;
      maxToolCalls: number;
      maxDelegations: number;
      timeoutMs: number;
    };
  };
  collaborators: {
    mode: 'lead' | 'participant';
    delegates: string[];
    maxDepth: 1;
  };
  model: {provider: ProviderId; model: string; maxOutputTokens?: number};
  plugins: string[];
  learning: {mode: 'propose' | 'off'; retainTraces: boolean};
}
```

Resolution order: conversation override → profile override → app default →
built-in default. The answer is stored under
`harness/versions/<profileId>/<n>.json`, with a parent hash and a canonical hash.
Rollback is selecting the parent.

The eight Harness² components map as follows:

| Harness² component | Here                                     |
| ------------------ | ---------------------------------------- |
| system prompt      | `identity` + `contract`                  |
| guardrails         | `tools.policy` and the engine's gates    |
| memory             | `context.memory`                         |
| tool guidance      | `tools.guidance`                         |
| subagents          | `collaborators`                          |
| skills             | `context.skills`                         |
| plugins            | `plugins` (loop guard, trace, redaction) |
| scripts            | Reserved, not implemented                |

Scripts are deliberately absent. A field nothing sets is a branch nobody tests,
and there is no workflow in this app that a skill plus a tool cannot already
express.

### Prompt assembly

The prompt is assembled in one place, in this order:

1. the app contract (unconditional, versioned with the app)
2. the Role
3. the Persona
4. Space context (folder, documents index)
5. memory: rules whole, facts selected by relevance when the file is large
6. the skills index (name and one line, never the body)
7. capability guidance, filtered to the tools actually granted
8. the turn's own instruction

Each layer records a hash and an estimated token count. The turn stores the
combined hash. A prompt that changes without a harness version changing is a
bug the trace will show.

Role, Persona and starter-role text name no tool. Capability guidance follows the
grant, so a prompt cannot advertise something the profile does not have.

## The turn

The event log is the state machine. It stores facts, not animations:

```
session.created   user.message      turn.started      assistant.message
reasoning         tool.call         tool.result       approval.requested
approval.decided  summary           participant.changed
handoff.*         task.*            turn.completed | turn.failed | turn.aborted
harness.pinned
```

Text and reasoning deltas are UI-only. They are never persisted, because the
finished message is.

Lifecycle:

```
idle → running → (gated → waiting → running) → completed | failed | aborted
```

Rules the engine owns:

- **One active turn per session, not per profile.** Two conversations of one bot
  may run at once; two turns in one conversation may not.
- **Pending gates are derived from the log.** A reloaded window and a restarted
  process see the same card, and a click resumes the invocation that asked.
- **Every tool call gets an answer.** Denied, abandoned and gated calls all
  produce a result the provider will accept.
- **Reasoning is replayed.** A tool-carrying turn without its reasoning is
  refused by some providers on that turn and every later one.
- **Gating happens before the tool list is built.** A tool the profile does not
  have is absent, not refused.
- **Budgets stop a turn with a sentence**, not a stack trace: steps, tool calls,
  delegations, tokens, wall clock.

The turn engine builds one ADK runner per turn from the pinned spec. The adapter
maps ADK events to the canonical events above; nothing above the adapter knows
what an ADK event is.

## Learning

The learning loop is the reason the rebuild is worth doing. It has four parts.

**Traces.** When the user enables learning, a turn records its spec hash, prompt
hashes, tool calls and results, gates, model pair, usage, latency and outcome.
Traces are local, capped and deletable; a fresh install records nothing.

**Signals.** Feedback ("not quite"), approvals and denials, tool errors, retries,
task outcomes, edits to generated documents, abandoned turns.

**Proposals.** A reviewer proposes one of:

- a memory add, update, supersede or removal
- a skill creation, update, deprecation or grant
- a tool or connector grant, with refusal evidence
- a context policy change (memory policy, compaction threshold, budget)

The agent never proposes an edit to the Role, the Persona or the app contract.
Those are human text. The agent never grants itself a tool. `run_shell` in
particular is never proposed.

**Adoption.** A proposal carries a diff, evidence turn ids, a rationale and the
base version. It is checked deterministically (gates preserved, tools exist,
prompt budget respected, no duplicates), optionally replayed against recorded
traces, and shown in a Learning inbox. Approval writes a new version; rollback is
one click; rejection becomes a lesson so the same proposal is not repeated.

Defaults: memory review on, trace retention off until enabled, everything local,
no autonomous application, no model self-judging without an explicit run.

## Collaboration

A conversation has a lead and participants. The lead answers by default; `@name`
routes a message to a participant. Every event names its author.

- `ask_agent` stays synchronous and depth-1, inside the parent turn, with the
  parent gate routing to the helper's unanswered call.
- `delegate_task` is asynchronous: it returns a task id, runs in a task session
  with the same Space and pinned harness, and posts a completion event with a
  summary back to the origin conversation.
- A handoff note carries the task, constraints, what was tried, relevant files
  and acceptance criteria. A helper does not silently inherit the parent's whole
  conversation.
- Limits: depth 1, bounded delegations per turn, bounded concurrent tasks,
  cancellation, restart recovery. No bot-to-bot loop without a user message.
- A2A is a seam for later, not a feature in this rebuild.

## Data

V2 starts clean. On first launch the old documents are moved, not deleted, to
`userData/archive/v1-<timestamp>/`. Provider and connector secrets and window
state are preserved; re-entering API keys is a bad first run, and neither file is
part of the rebuilt model.

```
profiles.json                          v2 profile + harness overrides
workspaces.json                        folders and the current folder
settings.json                          one v2 settings document
harness/versions/<profile>/<n>.json    resolved specs, parent and hash
learning/traces/<session>.jsonl        only when learning is on
learning/proposals.json
learning/lessons.json
learning/signals.json
skills/<name>/SKILL.md                 versioned skills
memory/<profile>/memory.md             person-scope memory + index
<space>/.marimo/<profile>/memory.md    space-scope memory
harness/sessions/<id>.jsonl            canonical event log (v2)
sessions/<id>.jsonl                    the v1 ADK log, read until cutover
tasks.json
jobs.json
usage.json
```

Every document is versioned and read through the shared version machinery. A
newer document is refused, an unreadable one is quarantined before a write.
There is no SQLite in this rebuild: one user per install does not need it, and
avoiding a native dependency keeps packaging honest. The store interfaces leave
room for it later.

## Phase 1: what runs now

The v2 turn path is live behind one environment flag:

```bash
MARIMO_HARNESS_V2=1 pnpm --filter @marimo/desktop dev
```

With it set, a new, empty conversation runs on the v2 engine: the canonical log,
the ADK driver, the five core tools, approvals, denial, abort and the transcript
projection. A conversation that already has a v1 history stays on v1, and so do
the companion, `@`-addressed group messages and scheduled jobs. Turning the flag
off does not abandon a v2 conversation that is waiting on a card; its log is the
marker that keeps it on the engine that asked the question.

The old `AgentHost` is still present and still owns memory, skills, delegation,
jobs and the prompt assembly those features need. It is deleted when those
features have v2 homes, not before. That is the one place this document's phase
plan was too optimistic: deleting the old host in Phase 1 would have taken the
shipped product's memory and skills with it, so the cutover follows the feature
ports rather than the engine.

What the v2 path does not have yet: memory, the user's skills, recall, jobs,
documents, bot drafting, group collaboration and the companion's shorter answer.
Those are Phase 2 and Phase 4.

## Phase 2: memory, skills and a review

The v2 turn now has the two things that make an agent improve rather than just
answer.

**Memory** is read into the prompt and written through `read_memory`,
`update_memory` and `prune_memory`. The files are the same two-scope markdown
files v1 uses (`memory/<profile>/memory.md` and
`<space>/.marimo/<profile>/memory.md`), so a fact the person can read is a fact
both engines know. The prompt is rebuilt per request, so a write lands in the
very next request of the turn that made it, not only the next turn.

**Skills** are advertised by name and one line, and `load_skill` reads the body
on demand. `save_skill` is gated and writes the same `skills/<name>/SKILL.md`
the Settings editor writes. A replacement keeps the previous body under
`skills/<name>/history/`, capped at twenty, so improving a procedure is
reversible. The prompt is rebuilt per request here too, so a skill saved during
a turn is advertised to the model before that turn ends.

**The review** reads a v2 conversation after a quiet minute, asks the profile's
own model, and records proposals in the existing `memory-proposals.json`. The
existing Memory card lists them and resolves them through the v2 facade, which
writes to the same memory files. The watermark lives in the proposal store, so a
conversation is not reviewed twice. A reviewer can be injected in tests; the
app uses a one-shot model call with no tools.

Not yet in Phase 2: a harness-version ledger and rollback, a learning dashboard,
and usage accounting. The turn already records its harness version and hash, so
the identity of a turn is reproducible before the ledger exists.

## Phase 3: participants, so far

A v2 conversation can hold more than its owner. The log records a
`participants.changed` event with the membership the window set, and a turn can
name the profile that should answer: `run(owner, session, text, addressed)`
resolves that bot's harness, tools, model and memory, records the reply with its
`agentId`, and leaves the conversation owned by the original bot. Approval cards
record the answering agent too, so a restart resumes the bot that asked rather
than the owner.

There is also an `ask_agent` tool. It asks another bot for its answer with that
bot's own Role, Persona and memory, in a single model call with no tools and no
session. That is a conversation, not a delegation of work: the asking bot gets
an opinion or a specialty, not a file written or a command run. The old
`ask_agent` path still owns tool-using delegation, scheduled jobs, group sessions
that predate the v2 log and the companion.

The sidebar merges a v2 session's own title, message count and membership over
the v1 index entry, so a reloaded group does not look like one bot and a chat
does not look empty. Those reads are per v2 session; a large install pays for
them only on the sessions that have a v2 log.

Not yet in Phase 3: a delegated bot that can use tools and raise its own
approval cards, asynchronous tasks, and merging delegated work into the parent
transcript.

## Phase 4: recall

`recall` is a v2 tool now. It is offered only when the install has an index for
this profile, so a capability with no corpus behind it is absent rather than a
tool that answers "nothing available". The result keeps the v1 honesty notes —
what was searched, a size cap, a stale file — because a short list that reads as
"the folder holds only this" is the failure those notes exist for.

Documents, jobs, the companion and the bot builder are still on the old path.
Jobs in particular cannot move yet: a v2-created job would point at a conversation
the old scheduler runs, so the job tools stay off in v2 until the runner does.

## What is not in scope

- Hosted multi-tenant accounts, a server, team Spaces.
- A2A, third-party plugins, a skill marketplace.
- Scripts as a harness component.
- Rebuilding the visual language from scratch.
- Content migration from v1.

## Phases

Phase 0 is this document, the invariant matrix, the removal of the shelved
features and the scaffolding. Phase 1 lands the engine and chat. Phase 2 lands
memory, skills and learning. Phase 3 lands collaboration. Phase 4 ports the kept
features. Phase 5 hardens and releases. The phase acceptance criteria live in the
plan that started this work and in the commits that follow it.
