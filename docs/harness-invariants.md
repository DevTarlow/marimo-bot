# Harness invariants

Each rule below was learned from a real failure. The rebuild is allowed to
change code, file names and even the shape of a turn; it is not allowed to
change these answers. A rule is "ported" only when a test in the new core fails
without the code that enforces it.

The old code is deleted only when every row says **ported** and the full suite is
green. The status column is updated in the same commit as the test.

| # | Invariant | V1 home | V2 test target | Status |
| --- | --- | --- | --- | --- |
| 1 | One turn at a time per conversation, and the stored log is the state machine | `agent-host.ts` `drive`, `file-session-service.ts` | `engine/turn-engine.test.ts` — one active turn per session; two sessions run at once; restart derives the paused turn from the log | planned |
| 2 | A gate is live only in the newest invocation | `host/gates.ts`, `agent-host.ts` | `engine/gates.test.ts` — a card from a finished turn never returns after reload | planned |
| 3 | Every tool call gets an answer | `models/openai-mapping.ts`, `agent-host.ts` | `engine/tool-calls.test.ts` — denied, abandoned and gated calls all produce one result per call | planned |
| 4 | Reasoning is replayed | `models/openai-mapping.ts` | `engine/reasoning.test.ts` — a tool-carrying turn sends its reasoning on the next request | planned |
| 5 | Gated means gated in code, not in the prompt | `tools/index.ts`, `agent-host.ts` | `policy/gates.test.ts` — the tool list is filtered before the model sees it | planned |
| 6 | A refused path is refused after resolution | `tools/paths.ts` | `policy/paths.test.ts` — `..`, absolute and symlink escape are one refusal | planned |
| 7 | Truncation is visible | `host/tool-result.ts` | `tools/result.test.ts` — a capped result says it was capped | planned |
| 8 | Secrets never cross to the renderer | `main/ipc.ts`, `public-settings.ts` | `apps/desktop/tests/settings-payload.test.ts` — walk the whole payload, not one call site | planned |
| 9 | A capability the user turned off is absent | `tools/index.ts`, `agent-host.ts` | `policy/grants.test.ts` — an ungranted tool and MCP server are missing, not refused | planned |
| 10 | One turn at a time holds across processes | `runtime/lock.ts`, runner | `runtime/lock.test.ts` + runner integration — the app and the timer cannot run one job twice | planned |
| 11 | Unattended means unapproved stays unapproved | `runner/run-due.ts`, `agent-host.ts` | `runner.test.ts` — a headless run never answers its own gate | planned |
| 12 | A newer document is never overwritten | `migrations.ts`, every store | `runtime/documents-version.test.ts` — a newer file is refused and left intact | planned |
| 13 | The app and the runner resolve the same data directory | `runtime/paths.ts`, `shared/product.ts` | `runtime/paths.test.ts` — both entry points answer the same directory, including the former name | planned |
| 14 | An MCP tool cannot take a built-in name | `mcp/tools.ts` | `mcp/names.test.ts` — the reserved set is every built-in before the profile filter | planned |
| 15 | A turn that says nothing is a failure | `agent-host.ts` recovery, `tool-loop-plugin.ts` | `engine/silent-turn.test.ts` — one recovery attempt, then `turn.failed` | planned |
| 16 | A plaintext key is written and read through one path | `runtime/secrets.ts`, `paths.ts` | `runtime/secrets.test.ts` + runner — the window writes what the runner reads | planned |
| 17 | A model is a pair, never an id | `runtime/agent/resolve.ts` | `runtime/resolve.test.ts` — conversation, agent, app order; provider and id never mix | planned |
| 18 | A delegation is a tool call in the same conversation | `tools/ask-agent-tool.ts` | `collab/delegation.test.ts` — helper runs over the parent session, depth is one | planned |
| 19 | A helper's gate resumes the helper's call | `ask-agent-tool.ts`, `gates.ts` | `collab/gates.test.ts` — the parent's card resumes the helper's unanswered call; no duplicate card | planned |
| 20 | An editor write is refused against a stale revision | `runtime/documents.ts` | `runtime/documents.test.ts` — mismatch writes nothing, keeps the draft, force re-reads first | planned |
| 21 | A Space's documents are the folder's files | `runtime/documents.ts` | `runtime/documents.test.ts` — agent write appears in the library; no second copy | planned |
| 22 | A prompt never advertises a capability the profile lacks | `protocol/bots.ts`, `profiles.ts`, `skills/index.ts` | `harness/prompt.test.ts` — role/persona name no tool; guidance follows grants | planned |
| 23 | A skill is advertised, not carried | `skills/index.ts`, `tools/skill-tools.ts` | `skills/compose.test.ts` — the prompt has name and one line; `load_skill` reads the body | planned |

## Rules for the rewrite

- **A row moves to ported with a test, not with a promise.** The test must fail
  if the guard is removed.
- **Tests are named after the failure, not the function.** "a card from a finished
  turn never returns" is useful in a failure report; "gates work" is not.
- **The old suite is evidence, not a specification.** Some old tests encode
  details of ADK events that the new adapter legitimately changes. Port the
  answer, rewrite the mechanism.
- **New guards need a row.** If the rewrite introduces a rule worth keeping, add
  it here rather than leaving it in a comment.

## Invariants the rebuild adds

These are new answers the v2 core must keep; they get rows once tests exist.

| # | Invariant | Why |
| --- | --- | --- |
| 24 | A turn is pinned to one harness version and records its hash | A profile edited mid-turn must not change the turn that is running |
| 25 | One active turn per session, concurrency across sessions | Two conversations of one bot must not serialise behind each other |
| 26 | A proposal never edits Role, Persona or the app contract | The agent may improve its tools and memory; it may not rewrite who it is |
| 27 | A task runs in its own session and posts a result; it never shares a writer | Async work must not create two writers to one conversation |
| 28 | A trace is local, capped and deletable | Learning must not become a second, invisible copy of the user's conversations |
