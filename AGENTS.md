# AGENTS.md — Marimo Bot

Working notes for anyone — human or agent — changing this repository. The
project's design decisions live in `TECHNICAL.md`, and the guide for people using
the app is `README.md`; this file is the shorter, blunter list of things that are
easy to get wrong and expensive to discover.

## What this is

A standalone, always-on desktop agent. A chat window and a floating companion,
an agent harness whose capabilities are opt-in, and a headless runner that keeps
scheduled jobs going while the app is closed. It carries no chat model of its
own — it answers through a provider somebody picks in Settings, so a fresh
install says nothing until one is chosen — and the folder it works in is what the
user calls a **Space**. Marimo Bot is the agent the person talks to; they also make
**bots**, each with its own name, instructions, tools and permissions. A chat can
hold more than one of them, and Marimo Bot can hand work to one.

## Layout

```
packages/protocol   The typed contract: zod schemas for every IPC call, the
                    AgentUiEvent union, the provider catalogue, the model pair,
                    cron, the profile and job documents, and the Role/Persona
                    seeds plus the starter roles. No Electron, no Node, no React.
packages/agent      Everything ADK: the OpenAI-compatible client, tool set,
                    skills that compose the system instruction, the file-backed
                    memory and session stores, AgentHost, and the
                    document-version machinery. No Electron.
packages/runtime    The Electron-free half of the app proper: where files live,
                    secrets with the cipher injected, the jobs/profiles/
                    workspaces/settings/skills/proposals stores, the documents
                    service a Space's library and editor go through, the provider
                    catalogue's settings and key paths, and the supervisor and
                    pins for the recall model. Re-exports the version machinery it
                    uses, so a caller still finds it beside them.
apps/desktop        The Electron app: src/main (window, IPC, tray, adapters),
                    src/preload (the sandboxed bridge), src/runner (the headless
                    job runner), src/renderer (React), src/shared.
```

**The dependency rule that matters:** `packages/*` import nothing from Electron.
That is not a style preference — it is what lets the _same_ agent core run in the
window and in the headless runner, which is the same binary started as plain
Node. Adding `import {app} from 'electron'` to a package breaks the background
service, quietly, at boot rather than at build time.

## The invariants

Each of these is silent when it breaks. That is the whole reason they are listed.

1. **One turn at a time, and the conversation on disk is the state machine.** A
   paused turn's pending calls are derived from the stored thread, never held in
   memory — that is what lets a reloaded window answer a card, and a restarted
   process lose a typing animation rather than a conversation.
2. **A gate is live only in the newest invocation.** A turn is one invocation,
   and starting a new one abandons whatever the previous turn was waiting on.
   Note the shape of a real approval: the question is asked in one invocation and
   answered in the _next_ one, because resuming is a new turn carrying the
   confirmation. So `pendingGatesIn` tracks the newest invocation rather than
   looking for unanswered calls anywhere — get this wrong and a card the user
   walked away from comes back on every reload, with an Approve button that asks
   ADK to confirm a call belonging to a finished turn.
3. **Every tool call gets an answer.** An assistant message with tool calls must
   be followed by one result per call or the provider refuses the whole request —
   on that turn _and every later turn of that conversation_.
4. **Reasoning is replayed.** DeepSeek rejects a tool-carrying turn whose
   `reasoning_content` is missing from a later request. It is not decoration.
5. **Gated means gated in code, not in the prompt.** Whether a call pauses the
   turn is decided before the tool is offered to the model.
6. **A refused path is refused after resolution.** `..`, an absolute path outside
   the workspace, and a symlink that leaves it are one refusal.
7. **Truncation is visible.** A capped tool result says so, so the model knows
   there is more rather than believing it read everything.
8. **Secrets never cross to the renderer.** Settings report whether a connector's
   secret is _set_, never its value — and there is a test that walks the payload
   rather than trusting one call site.
9. **A capability the user turned off is absent, not discouraged.** A connector
   an agent was not granted is the same rule one layer down: the host filters the
   toolsets it was handed, so an ungranted server is missing from the tool menu
   rather than refused when the model proposes it.
10. **One turn at a time holds across processes.** The app and the runner are
    serialised by a lock, not by hope.
11. **Unattended means unapproved stays unapproved.** A headless run never
    answers its own approval gate.
12. **A newer document is never overwritten.** See "Documents" below.
13. **The app and the runner resolve the same user-data directory.** When they do
    not, nothing errors: the window writes one `jobs.json`, the service reads
    another, finds nothing due, and exits 0. **The name on screen and the name of
    the folder are two facts, and they have been allowed to differ**: the folder
    was `Marimo Agent` for the whole life of the app called Marimo, so moving it
    to `Marimo Bot` was a migration rather than a rename —
    `adoptFormerUserDataDir` in `shared/product.ts`, called by both entry points
    before either reads the directory, and the one place the old name survives.
    The window does not leave the question to Electron's derivation from
    `productName` either: `applyUserDataPath` pins it, both processes ask
    `userDataDirFor`, and `userDataDisagreement` reports it when they part
    company. **A service is the second half of that move**, because
    `runnerEnvironment` bakes the directory into an installed systemd unit and a
    rename cannot reach one that is already on disk: a timer written before this
    names a folder that is no longer there, so `userDataDirFor` reads an override
    naming the former folder as the folder that moved rather than as one that is
    missing. **The model used to
    be a second case of this and no longer is**: it was bundled, so the window
    found it through Electron's `process.resourcesPath` while the runner derived
    the path from its own executable; then it was downloaded, with the pins
    _imported_ rather than located. It is now not the app's at all — a provider's
    address comes from the catalogue or from the user, and both processes read the
    same document — while the recall engine's directory and pins are still
    imported by both, which is what keeps a window and a scheduled job searching
    the same index.
14. **An MCP server's tools cannot take a built-in name.** The reserved set is
    every built-in name _before_ the profile filter — a tool the profile has
    switched off still owns its name, because the profile can change between
    turns.
15. **A turn that says nothing is a failure, not an answer.** A small model can
    end a turn with reasoning in `thought` parts, no content and no tool call.
    ADK calls that a completed turn and the window draws an empty bubble, so
    `drive` treats a turn with no visible text and no pending gate as broken: it
    asks once more with the model's own reasoning handed back, stores the reply,
    and reports `turn.failed` if that is empty too. `tool-loop-plugin.ts` is its
    sibling and the same rule from the other end — the third identical tool call
    in a turn is refused rather than run, because a model that loops arrives at
    that silence by itself. Nothing here is a prompt: a prompt is what a small
    model loses first.
16. **No address belongs to a process any more, and one key has to reach two of
    them.** The app runs no backend of its own: every provider's address is the
    catalogue's or one the user typed, and the invariant that used to live here —
    a supervised engine's port existing only in the process that started it — is
    gone with the engine. What replaced it is a fact about credentials. The
    headless runner has no `app` object, therefore no `safeStorage`, therefore
    cannot decrypt a key; so a provider's key is stored readable *only* when the
    user ticks that provider's "let the background runner read it" box, and a job
    whose agent needs an encrypted key fails with a sentence saying so rather than
    with a 401. The same rule reaches connectors, which the runner now dials for a
    job: each one carries its own `secretStorage`, its secrets are stored readable
    only where the user says so, and `ServiceStatus.keysReadable` answers for the
    whole job — provider and every enabled connector together. The related trap is
    silent in the other direction: a plaintext key is written by the window and
    read by the runner through the *same* path, which is why
    `paths.providerSecrets` is derived from the catalogue rather than spelled out
    in either place.
17. **A model is a pair, never an id.** `{provider, model}` is the only shape this
    app stores or sends, because a model id means nothing without the endpoint
    that serves it — `glm-5.3-flash` at OpenCode Go and a file of the same name on
    somebody's own server are two different models. The resolver picks a
    conversation's own choice, then its agent's, then the app's, and that order is
    in one function (`modelChoiceFor`) because a second implementation of it would
    be a second answer to "which model is this", and the one a user reads would be
    the wrong one.
18. **A delegation is a tool call in the same conversation.** `ask_agent` builds
    the helper over the *parent's* session service and session id — never
    `this.host(childProfileId)`, which would be a second live host and a second
    turn running beside the one that asked for it. That is what keeps one turn at
    a time a fact rather than a hope, and it is the whole reason a helper's
    approval card is answerable: a helper writing to its own session would ask a
    question nobody could see, and the parent would wait for an answer that can
    never arrive. Depth is one by construction rather than by a number compared
    at runtime, because the host builds the helper without this tool. Nothing in
    it throws — an unknown name, an unknown Space and a blank task are sentences
    — because a throw ends the parent's turn and turns "no such helper" into
    "your request failed".
19. **ADK ends the invocation at a gate, so a tool cannot wait inside one.** The
    helper parking on an approval ends *its* invocation, and a parent tool that
    sat waiting for it would leave the model's own call unanswered — an assistant
    message with no result, which every provider refuses on the next request and
    not only that turn (invariant 3). So `ask_agent` raises a card of its own with
    `requestConfirmation`, the click resumes *it*, and it tells the helper what
    was decided in a sentence and runs it again. Resuming the child with a
    confirmation response was tried first and does not hold: a confirmation is
    bound to the call that raised it, and the child's gate belongs to an
    invocation that has already ended by the time the user clicks. The child's
    own card is still in the log, which is what stopped the child; invariant 2 has
    the sibling rule that keeps it from being cleared — an invocation id the log
    has already named is a turn *resuming*, not a new one asking something else.
20. **An editor write is refused against a stale revision, and the draft is
    kept.** Nothing versioned stands behind a file the app does not own (see
    "Documents"), so a write carries the revision it was based on — size and
    modification time — and a mismatch writes *nothing* and answers with what is
    on disk now. An agent rewriting a file while somebody has it open is the
    ordinary case this exists for, and a save that quietly won would delete the
    agent's work with no copy anywhere. The window keeps the draft and offers the
    choice, and "overwrite with my draft" re-reads the fresh revision first so the
    force is not a race. Two more refusals sit beside it: a missing parent folder
    is never created, and a write over the read cap is refused, because inventing
    a tree in somebody's project and saving a file the editor cannot reopen are
    both worse than a sentence.
21. **A Space's documents are the folder's files, not a second copy.** The
    library lists the markdown in the folder and the editor writes it, so an
    agent's `write_file` is in the drawer the moment the list is re-read and what
    a person types is what the agent reads next: two doors to one file, with no
    import or export to keep them in step. `.marimo/` is skipped because the
    agent's memory is not a document of the user's project, and the rest of the
    skip list is the agent's own `SKIPPED_DIRECTORIES` — a second list would be a
    second answer to which files are in this folder, and it shows up as a document
    the agent cannot mention. The caps (500 files, eight levels, one megabyte) say
    when they stopped rather than answering as if the folder ended there, which is
    invariant 7.
22. **A prompt must not advertise a capability the profile does not have.** The
    tool list and the prompt agree, or the model narrates a capability it was
    never given. `ProfileStore.create()` seeded every new profile with Marimo Bot's
    text, so a bot the user named Writer introduced itself as Marimo Bot and was told
    to hand work to other bots — with no `ask_agent` to hand anything to. What
    the person then sees is a bot greeting them as Marimo Bot, or announcing a
    delegation it never made, which reads exactly like one that did. This is
    invariant 9 one layer up, and the layer below was already right — the
    filtered tool list was correct and the prose lied about it. So there are two
    seeds. `DEFAULT_AGENT_ROLE` / `DEFAULT_AGENT_PERSONA` are the agent the person
    talks to; `botRoleFor(name, template)` / `botPersonaFor(template)` are a bot,
    which names itself, says this person made it and Marimo Bot hands it work, and
    asks it to write for the person — what it did, what it could not, what it would
    need — rather than work around a permission it does not have. The starter roles
    in `bots.ts` are the same rule at the level of a template: their Role and
    Persona name no tool, because the capability skills are what tell the model
    what it can do and they follow the grant. `ProfileCatalog.roleSeeds` and
    `personaSeeds` carry the texts keyed by profile id, so Reset puts back the seed
    for *that* profile and the window holds neither: a renderer with its own copy
    resets a bot to Marimo Bot, or to a version the app never shipped. The trap in
    the other direction is the same rule about the lead's prompt: it must not tell
    Marimo Bot to do everything alone either, because the person paid for the bots
    by making them — its text says when to hand work over, and that the person
    should hear about it. The builder's turn instruction is not an exception: the
    guided path grants `draft_bot` before the conversation starts, and
    `startBuilderSession` refuses in code if it is missing.

## Documents

Every file the app owns carries a `version` and is read through
`readVersionedDocument` in `@marimo/runtime`:

- **Older** → upgraded step by step by a declared migration.
- **Current** → used.
- **Newer** → refused, and the file is left untouched.
- **Unreadable** → the _reader_ decides. `load()` is lenient so the window still
  opens; `loadChecked()` reports the reason so the runner can exit non-zero; and
  `mutate()` moves an unreadable file aside (`.unreadable`) before writing.

The rule behind all of it: **a lenient read plus a write is how a user's data
disappears.** If you add a store that reads leniently, its write path must call
`assertWritable` or quarantine first.

`migrations.ts` lives in `packages/agent` rather than `packages/runtime`, because
the conversation index needs it and the dependency runs one way — `runtime`
imports `agent`, not the reverse. `runtime` re-exports it so a caller still finds
it beside the stores.

**Every document is covered**, and an audit is the only way to know that: the
session index was the last one missing the guard, and its lenient read plus an
unguarded write meant a corrupt index became an empty one on the very next
message — every conversation gone from the sidebar. When you add a store, add it
to that list. The two documents added since — `feedback.json`, and the bullet
dates in `memory/<profile>/provenance.json` — both read through
`readVersionedDocument` and call `assertWritable` before writing, and the second
one quarantines an unreadable file first because a date that cannot be trusted is
not a reason to lose the facts it describes.

**A Space's documents are the other kind of file, and the guard points the other
way.** Everything above is about a file the app *owns* and must not lose; a
document in a Space is the user's own file that the app only visits, so it
carries no version and is never migrated — what the write path carries instead is
the revision it read, and a mismatch is a refusal rather than a repair (invariant
20). `documents.ts` deliberately owns no second path checker: every path arrives
through `resolveInsideWorkspace`, the guard the agent's own file tools use, so
`..`, an absolute path and a symlink that leaves the space are one refusal with
one sentence.

**The discovery trees are the third, and the one that is off until asked for.**
`trees/<sessionId>.json` holds one conversation's turns as parent-child records
of what the agent tried, written only when Dream-RSI is on — so a fresh install
creates no such directory and a user who never turns it on leaves no trace of the
feature. Versioned, read through the shared reader, its write path asserting and
quarantining like the rest; the one difference is that a tree which fails to
validate is *dropped* rather than failing the read, because losing one turn beats
losing a conversation's history to one malformed entry. A conversation's file is
moved aside when the conversation is deleted, for the reason the recall index
drops its vectors: a record of what the agent did must not outlive the user's
ability to see the conversation it is about.

**Dream-RSI's cross-document rule is that the recorded policy is the truth.**
Every tree stores the two weights it ran under, and the replay reports a baseline
only when every turn agrees — so a log recorded under two different settings
says so rather than averaging them into a control no turn ever ran with. That is
deliberate: `settings.json` can change after a turn is recorded, so reading the
*current* weights as the baseline would mark a row as "what actually happened"
from a file that had nothing to do with it. When you add a field to the policy,
put it in the tree and not only in settings.

**Memory is the one document that is not versioned, and there are two of them.**
`memory.md` is plain markdown a user edits by hand, so a version field would be a
lie about a file the app does not own; the split between the person's half (under
user data) and the folder's half is by *layer*, and which layer goes where is
`scopeForSection` in `sections.ts`. The merge, the de-duplication and the one-time
adoption of a file written before the split are all in `MemoryStore`, and a store
built without `personMemoryRoot` is exactly the old one-file store — which is what
every test that predates the split still gets.


**One document's data sometimes has to move to another's.** The folders used to
be a field on each profile; they are `workspaces.json` now, adopted on the first
read of that file and _preserved_ on every profiles write until the adoption has
landed. That second half is the point: a migration in `migrations.ts` is a pure
function of one document and cannot write another, so the only thing standing
between a user's folders and a profile edit during the upgrade is the write path
carrying them forward until the new store has taken them.

**The workspaces document is the first at a version above 1, and it is not a
reason to move `DOCUMENT_VERSION`.** `WORKSPACES_VERSION` is passed as `current`
by its store: version 2 marks that the folder an older build seeded — the home
directory itself — has already been moved to `<home>/Marimo`, and a marker is
what keeps that move from running again on a later read. Bumping the shared
constant instead would tell every other store its current files are from the
future.

**A fresh install starts in `~/Marimo`, and that folder is created when the
document is seeded.** The store's own rule that it never touches a Space's
directory has exactly this exception, and the folder is deliberately outside
user data so a reset leaves it standing.

**A bot's uploaded icon is an app-owned file that is not a document.** It is one
PNG under `userData/avatars/`, named through `avatarFileName` in
`packages/runtime/src/paths.ts`, and the profile carries only a marker with a
version. The renderer cannot read the user-data directory, so the bytes reach it
through the app's `marimo-asset` scheme and a handler that serves nothing outside
that directory. The marker is optional and tolerant on purpose: `ProfileStore`
skips a profile the schema refuses, so a malformed or newer icon has to cost the
picture, not the bot. Removing a bot removes its file; a missing file falls back
to the name's initial. An uploaded picture is not a document in a Space and is
never indexed as one.

**There is one settings screen, and it is not a mode.** The simple/power switch
was removed because it made the Role and the per-tool switches reachable only by
leaving the everyday screen. Do not add a setting that decides which settings
exist; if a control is worth having, put it on the one screen.

## The loop

**A task is done when it is committed; the branch moves when a human says so.**
That is the whole rule, and the rest of this section is what makes it cheap to
follow.

**CI exists, and it is `.github/workflows/ci.yml`.** Nothing in this file used to
mention it, which is how a push went up against a workflow whose first step could
not run. It re-runs what you just ran — `pnpm -r build`, `typecheck`, `test` —
and then does the two things a local shell usually skips: the smoke check under
`xvfb-run`, and a real `electron-builder` package whose unpacked runner is
started to prove asar is still off. Read it before changing a build script, a
dependency's version, or anything the package step assumes about
`apps/desktop/release/`.

**That step's first run found a real bug, which is the argument for keeping it.**
It builds an AppImage and starts the packaged runner out of
`release/linux-unpacked`, which is the one thing that works in development and can
be broken by packaging alone. On its first execution it packaged the app and then
died with `GitHub Personal Access Token is not set`, because electron-builder
publishes *implicitly* when it detects CI and this repository is on GitHub — Gitea
never set the variable that triggers it. Every `package*` script now passes
`--publish never`, which is also what electron-builder asks for in the warning it
prints when it guesses. Releasing stays a deliberate act rather than a side effect
of a green build.

`${{ runner.temp }}` in that step is the expression to watch, because an
unexpanded context fails the step rather than the job — and the runner's own
expectation is that it reports the recall model as not installed, which is a state
it has to handle anyway.

**It runs on a push to `main`, and on a pull request.** It ran on pull requests
and the Actions tab alone while the repository was private, because each run spent
metered minutes and a few pushes an hour was a bill for a verdict nobody reads.
Standard runners are free on a public repository, so that reason is gone — and
what it was buying was worth having back anyway, because this is pushed straight to
main: with rarely a pull request to trigger it, the smoke check waited for
somebody to remember the Actions tab, which is the wrong shape for the one check
that catches a preload which stopped matching the renderer.

What kept the workflow cheap was never only money, so all of it is still here.
`concurrency` cancels a superseded run rather than finishing a verdict on code
that has already changed, the job has a twenty-minute timeout so a hung step
cannot sit on a runner, a prose-only change is skipped — through one
`paths-ignore` list that both triggers share by anchor, since two copies is how
two triggers come to disagree about what a change is — and the packaging step
stays behind a `package` input on the manual trigger, because an AppImage built
to prove one thing is a release's business rather than a component's.

**Nothing in this workflow uploads an artifact, and that is a separate account
from the minutes.** The 500 MB a free account gets is shared by Actions
*artifacts* and GitHub Packages across every repository that account owns, while
caches have their own allowance and are not part of it — so the pnpm cache above
cannot fill it, and an `upload-artifact` step is what does. One added here needs a
`retention-days` of a day or two; a build output that is really a release belongs
in a release rather than an artifact. Public repositories get that storage free
too, which is what to check before adding an upload to one that is not.

Two consequences worth internalising. **A green local run is not a green CI
run** — the steps above are the difference, so when packaging, the preload or the
IPC schemas have moved, run the workflow on purpose rather than trusting the local
pass. And **a version belongs in exactly one place**:
`package.json`'s `packageManager` is the pnpm version, and the workflow
deliberately does not repeat it, because `pnpm/action-setup` fails outright when
both are present rather than picking one.

```bash
# 1. While working: the narrow loop, a few seconds each.
pnpm --filter @marimo/runtime exec vitest --watch   # one package, watching
pnpm --filter @marimo/desktop typecheck             # ~13s, desktop only

# 2. Before committing: prove the change, not the workspace.
pnpm typecheck        # ~27s, every project including the test ones
pnpm test             # ~34s, vitest everywhere

# 3. Before pushing, or when the change touches the window:
pnpm build            # tsc -b for every project
pnpm build:web        # then the renderer bundle — step 3 is two commands and
                      # `pnpm build` alone leaves the bundle stale
MARIMO_NO_SANDBOX=1 pnpm --filter @marimo/desktop smoke   # only where AppArmor
                                                          # cannot help; see below
```

**`--watch` has to be spelled out, and the _script_ cannot do it.** Each
package's `test` script is `vitest run`, and `run` ignores a `--watch` after it —
so `pnpm --filter @marimo/runtime test -- --watch` runs the suite once and exits,
looking like a watcher that never fires. Bare `exec vitest` is not reliable
either: with no TTY attached, as in an agent's shell, Vitest quietly falls back
to running once. `exec vitest --watch` is explicit and behaves the same either
way.

**Commit when the task is verified, not when the files are saved.** One commit
per task, and it is the agent's job to make it — nobody should have to ask. A
commit is not a push: it is local, reversible, and the thing that makes the next
task's diff readable.

**Never push on your own initiative.** Pushing is done when asked, usually after
a review of the commit. `origin` is `github.com/DevTarlow/marimo-bot` and `main`
tracks it, so the push is `git push` with no arguments and no second remote
invented for the job. The Gitea instance this project used to live on is kept as
a remote named `gitea` and nothing is pushed there any more — it is there to
fetch from if a branch turns out to be missing. If a push is refused for
authentication, say so — do not reach for a token or rewrite a remote.

Messages follow the history rather than a convention document:

- Subject is a sentence, capitalised, no `feat:`/`fix:` noise. Milestone work
  carries its tag — `M5: the desktop companion`; everything else is a plain
  clause — `Audit: three real defects, including two I introduced`.
- The body is where the value is: what was wrong, what it now does, and _why
  that shape_. Written in the same voice as the comments in the code, because
  it is the same kind of explanation with a longer shelf life.
- No `Generated with` footer and no co-author trailer. The author is already
  `DevTarlow`.
- A commit that only touches documentation still gets a body if a reader would
  otherwise wonder why it exists.

**Verification scales with the change, and the ordering matters.** A
renderer-only change needs `typecheck`, the desktop tests and `build:web` — not
the agent package's own suite, which is most of the workspace and none of what
changed. A change to `packages/agent` needs the lot, because that package is what
the window _and_ the headless runner both run. Anything that touches the preload,
the IPC schemas or the built bundles needs `build:web` and the smoke check,
because those three failing looks like something else.

**Two speed notes that are worth knowing before optimising.** TypeScript's
`-b` is not incremental here in practice — a warm `pnpm typecheck` costs about
the same as a cold one — so scoping it to the package you touched is the only
lever. And the suite's cost is process startup, not test count: one package's
tests are a few seconds, all four are ~34. Vitest watches a package well; it
watches the workspace poorly.

## Commands

```bash
pnpm install          # the store lives in .pnpm-store, per pnpm-workspace.yaml
pnpm build            # tsc -b for every project — but NOT the renderer bundle
pnpm build:web        # the renderer bundle: `tsc -b` + vite build, desktop only
pnpm typecheck        # including test projects
pnpm test             # vitest, everywhere
pnpm --filter @marimo/desktop dev     # tsc -b, then Vite + Electron
pnpm --filter @marimo/desktop smoke   # boot a real window and prove it works
pnpm --filter @marimo/desktop jobs-check   # prove a due job runs in the app
```

**Those last three open a real window, on whatever display you are running on,
and this app is tray-resident: closing its window does not end it.** That is the
point of it and it is also the trap — an agent left behind is an icon in
somebody's tray that only they can clear, holding the single-instance lock and a
user-data directory while it sits there.

The pid a launcher hands back is the trap inside the trap: `.bin/electron` is a
shim that execs a node script which _spawns_ the real binary, so a kill aimed at
that pid stops the wrapper and leaves the app running. `scripts/app-process.mjs`
is where that is handled once for both driver scripts — the app is started
`detached`, so it leads a process group, and `stopApp` signals the group and waits
for it to empty, on Ctrl-C as well as on the way out. Anything you start by hand
is still yours to put down. Before you call the work finished, check:

```bash
ps -eo pid,cmd | grep '[e]lectron/dist/electron'   # empty is the only good answer
```

If it is not empty, close it — the `^/` keeps this from matching the shell that
runs it:

```bash
pkill -f '^/.*electron/dist/electron'
```

**Only the renderer is hot, and the tray makes a "restart" easy to think you did.**
`dev` compiles the main process, the preload and the runner *once* and then starts
Vite: a save under `src/renderer` reloads the window, and a save under `src/main`,
`src/preload` or `src/runner` changes nothing until Electron is started again —
and `start` compiles nothing at all, it serves whatever `dist` already holds. A
window newer than the process behind it has exactly one signature: it calls a
method the running main process has never heard of and is told `Unknown IPC
method: <name>`, which reads like a typo in the caller and is not one. Restarting
properly means quitting the old instance first — from the tray, or with the
`pkill` above — because a second launch defers to the one already holding the
single-instance lock, so starting `dev` again looks like it did nothing.

`pnpm build` and `pnpm build:web` are not alternatives and neither implies the
other. The root `build` is `tsc -b` alone; the renderer bundle only comes from
the desktop package's own `build`, which is what `build:web` filters to. Running
one and believing you ran both is how a window is tested against a bundle that
predates the change — verified the tedious way, by watching `pnpm build` leave
`dist/renderer/index.html` untouched.

The job runner is the same binary started as plain Node, so it can be run by
hand the way the OS timer will:

```bash
ELECTRON_RUN_AS_NODE=1 ./apps/desktop/node_modules/.bin/electron \
  apps/desktop/dist/runner/run-due.js --json
```

It exits 0 when there was nothing to do, and non-zero only when it could not do
its job — an unreadable jobs file, a data directory it cannot read. Keep that
distinction: for a timer, "exit 0, nothing happened" and "exit 0, I could not
read the file" are the same observation, and the second is the failure nobody
notices.

The service layer that wakes it is in `packages/runtime/src/service` and is split
in two on purpose: `plan.ts` produces the unit/plist/task as _data_, and
`apply.ts` is the only part that touches the machine. Every mistake worth
catching is in the content of what gets written, so that is what the tests assert
on — a host is injected, and no test ever installs a timer.

`ELECTRON_RUN_AS_NODE=1` in those definitions is load-bearing rather than tidy.
Without it the timer launches a GUI, fails to find a display, and dies with
SIGTRAP — a service that is enabled, runs every minute, and does nothing. The
`MARIMO_USER_DATA_DIR` beside it is invariant 13 made structural: baking the path
in means the app and the service agree even for a portable install and after a
product-name change, which are exactly when they would silently stop agreeing.

If Electron's binary download fails with `ENOENT ... ~/.cache/electron`, the
environment does not allow writes outside the repository. Use the wrapper, which
points every tool cache inside it:

```bash
./scripts/with-local-caches.sh pnpm install
```

Electron aborts with `The SUID sandbox helper binary was found, but is not
configured correctly` when it cannot create the user namespace Chromium's sandbox
is built on. Ubuntu 24.04 made that a default rather than a container quirk:
`kernel.apparmor_restrict_unprivileged_userns` is 1, so the namespace sandbox is
unavailable and the setuid fallback is tried instead. Electron ships that
fallback as an ordinary user-owned 0755 file, which is what aborts.

`./scripts/fix-linux-sandbox.sh` installs the fix Ubuntu uses for its own
browsers — an AppArmor profile naming the binary and granting `userns,`. It has
to be re-run when the Electron version changes, because the profile attaches to
the versioned path inside `.pnpm`, and a stale one fails exactly the way no
profile did. The setuid alternative, `chown root:root` plus `chmod 4755` on
`chrome-sandbox`, works too but is undone by the next `pnpm install` that
re-extracts Electron.

The smoke check still takes `MARIMO_NO_SANDBOX=1` for the case AppArmor cannot
cover — a container — and nothing else does, because it is a real reduction in
isolation and must not become the quiet default.

Either way the symptom is misleading and worth recognising: the dev launcher
prints Vite's URL _first_ and Electron dies immediately after, so a host policy
that refused a syscall reads as a renderer that failed to paint.

## What answers, and where the key is

**The app runs no chat model of its own.** It used to: a llama.cpp engine it
downloaded, supervised on loopback and addressed by a port only the starting
process knew. That is gone, and the app now talks to a provider — DeepSeek,
Google Gemini, a llama.cpp server you run yourself, OpenCode Go, or OpenRouter.
One client serves all of them because every one of those speaks the OpenAI
chat-completions dialect, so switching provider is a base URL, a key and a model
id rather than a second transport.

**The catalogue is one file and it is data.** `packages/protocol/src/providers.ts`
holds the descriptors, and four facts about an *endpoint* travel with the id
rather than being decided in the transport: whether thinking arrives as
`reasoning_content`, whether `stream_options.include_usage` may be sent, which
header a gateway wants a conversation named in, and whether a key is needed. The
failure these prevent is not cosmetic — Gemini's compatibility layer answers an
unsupported field with an error, so asking it for usage fails every turn rather
than one.

**A key is encrypted unless the user says otherwise, and they say it per
provider.** See invariant 16: the headless runner has no keychain, so the
"background runner may read this" consent is what makes a scheduled job on a
hosted provider possible at all. The store is one file per provider under
`secrets/`, derived from the catalogue by `paths.providerSecrets`.

**The recall engine is the one engine left, and it is a different thing.** It
downloads its own embedding model and runs its own llama.cpp build under
`model/recall/`, supervised by the same `LocalModelService` the chat engine used
to use — kept precisely because recall still needs it. Everything in the
paragraphs that used to be here about `--jinja`, `--flash-attn` and quantized KV
caches still applies to it, and `pins.ts` still carries `RECALL_ENGINE` for the
same reason: the app's own build cannot load that model. What is gone is
`MODEL_PINS`, the tier plan and the hardware probe, because nothing chooses a
chat tier any more.

Two things about the engine remain worth keeping in mind. **Never leave it
behind** — it is hundreds of megabytes of weights and a spinning fan with no
window to explain it, so `LocalModelService` stops it on the way out and writes a
pid file the next run reaps; the command to check by hand is
`pgrep -x llama-server`. And **the live address still exists only in the process
that started *that* engine**, which is why `resolveAgentConfig` refuses rather
than defaulting for anything that needs one: a fixed port would send a
conversation to whatever else is listening there.

```bash
MARIMO_MODEL_DIR=$PWD/apps/desktop/.model-cache/live-model \
  pnpm --filter @marimo/runtime test:live
```

## Packaging

```bash
pnpm --filter @marimo/desktop package   # AppImage into apps/desktop/release/
```

**Packaging no longer fetches anything, and there is nothing to bundle.** It used
to be a build plus 1.1 GB of weights inside the app, then a build plus a pin set
that a first run downloaded from. Now the chat model is not the app's at all, so
`package`, `package:win` and `package:mac` are plain builds and there is no
variable to remember. What a packaged app ships is an app that asks which service
should answer — which is the state a checkout is in too, and the state the smoke
check runs in.

**`asar` stays off.** The runner is this binary started with
`ELECTRON_RUN_AS_NODE=1`, and Node mode has no asar support: reading a file
inside one fails with `Invalid package`. Turning it on produces a release whose
background runner cannot start — verified, not assumed — and it works perfectly
in development, so nothing catches it until somebody installs the app.
`asarUnpack` is the tempting alternative and a worse one: it means enumerating
the runner's whole transitive dependency tree.

Packaging changes what `app.getAppPath()` returns, and the OS service plan
writes the runner's path into a systemd unit. Check `pnpm --filter
@marimo/desktop package` still produces a runnable runner when that path moves.

## House style

- **Comments explain why.** The code says what it does. A comment that restates
  the line below it is noise; one that records the failure the line prevents is
  the most valuable thing in the file.
- **No dead code, no speculative options.** A flag nothing sets is a branch
  nobody tests.
- Reach for the existing helper before writing a new one. `window-state.ts`,
  `migrations.ts` and the theme tokens all exist because a version of this app
  got them wrong once.

## Testing

- Unit and integration tests sit beside the code (`src/**/*.test.ts`) in packages,
  and in `apps/desktop/tests` for the app.
- `scripts/smoke.mjs` boots a real window, attaches over the DevTools protocol
  and asserts the bridge answers and React mounted — then screenshots it. It is
  the only check that proves the preload and the renderer bundle agree;
  `--theme light` checks the other token block.
- Tests that touch the filesystem use `mkdtemp` under the working directory
  (`.marimo-*`, gitignored) rather than `/tmp`, so a sandbox that only permits
  writes inside the repository still runs them.
- **Two tests load the real embedding model, and both are skipped unless asked
  for.** One is `packages/runtime/src/recall/memory-retrieval.live.test.ts`, which
  asserts that a question actually retrieves the memory bullet that answers it,
  through the pinned model, revision, prefixes and pooling — the one thing a fake
  embedder cannot check, because a regression there returns a plausible result
  list rather than an error. The other is
  `packages/runtime/src/recall/same-fact.live.test.ts`, which *measures* the
  threshold `update_memory` uses to call two bullets the same fact: that number
  ships conservative and unmeasured, and this is what says which way to move it.
  Run both by hand when you touch `prefixes.ts`, the scoring floor, the pooling,
  the model pins, or `SAME_FACT_SCORE`:

  ```bash
  # a directory holding the weights, the pinned engine in engine/, and nothing else
  MARIMO_MODEL_DIR=$PWD/apps/desktop/.model-cache/live-model \
    pnpm --filter @marimo/runtime test:live
  ```

  `$PWD` and not a relative path: the filter runs the suite with the package as
  its working directory, so `apps/desktop/...` from inside `packages/runtime/` is
  a directory that does not exist — which reports as a skipped test rather than as
  a bad path.

  The directory has to be laid out the way the app uses it — weights at its root,
  engine in `engine/` — because that is where the supervisor takes the engine's
  shared libraries from, so an engine binary kept elsewhere is given the app's
  libraries and fails with `unknown model architecture`. That is also why
  `pins.ts` carries a second `RECALL_ENGINE`: the app's own build cannot load this
  model at all, and there is no fetch command for it, so a live run means
  pointing this at a directory assembled by hand — symlinking the pinned weights
  beside an extracted `RECALL_ENGINE` archive is enough. An unset
  environment, missing weights or a missing engine all report as skipped rather
  than failing, because none of them is a broken build.
