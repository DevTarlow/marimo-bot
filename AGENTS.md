# AGENTS.md — Marimo Bot

Working notes for anyone — human or agent — changing this repository. The
project's design decisions live in `TECHNICAL.md`, and the guide for people using
the app is `README.md`; this file is the shorter, blunter list of things that are
easy to get wrong and expensive to discover.

## What this is

A standalone, always-on desktop agent. A chat window and a floating companion,
an agent harness whose capabilities are opt-in, and a headless runner that keeps
scheduled jobs going while the app is closed. It answers with **four small Liquid
AI models** — text, vision, audio and omni — run by a pinned llama.cpp on the
user's own computer, with the graphics card when there is one. There is no hosted
provider, no account and no API key for
the model. The first run downloads the Omni model, which answers text, sees
pictures and speaks; the dedicated text, vision and audio models are no longer
offered, and an old install can remove their leftover files in Settings. The
folder it works
in is what the user calls a **Space**. Marimo Bot is the agent the person talks
to; they also make **bots**, each with its own name, instructions, tools and
permissions. A chat can hold more than one of them, and Marimo Bot can hand work
to one.

## Layout

```
packages/protocol   The typed contract: zod schemas for every IPC call, the
                    AgentUiEvent union, the local model catalogue and task
                    schema, cron, the profile and job documents, and the
                    Role/Persona seeds. No Electron, no Node, no React.
packages/agent      Everything ADK: the OpenAI-compatible client, tool set,
                    skills that compose the system instruction, the file-backed
                    memory and session stores, AgentHost, and the
                    document-version machinery. No Electron.
packages/runtime    The Electron-free half of the app proper: where files live,
                    secrets with the cipher injected, the jobs/profiles/
                    workspaces/settings/skills/proposals stores, the documents
                    service, and the chat-model installer/host/speech plus the
                    recall supervisor and pins. Re-exports the version machinery
                    it uses.
apps/desktop        The Electron app: src/main (window, IPC, tray, adapters),
                    src/preload (the sandboxed bridge), src/runner (the headless
                    job runner), src/renderer (React), src/shared.
```

**The dependency rule that matters:** `packages/*` import nothing from Electron.
That is what lets the same agent core run in the window and in the headless
runner, which is the same binary started as plain Node. Adding
`import {app} from 'electron'` to a package breaks the background service,
quietly, at boot rather than at build time.

## The invariants

Each of these is silent when it breaks. That is the whole reason they are listed.

1. **One turn at a time, and the conversation on disk is the state machine.** A
   paused turn's pending calls are derived from the stored thread, never held in
   memory — that is what lets a reloaded window answer a card, and a restarted
   process lose a typing animation rather than a conversation.
2. **A gate is live only in the newest invocation.** A resume is a new turn
   carrying the confirmation. `pendingGatesIn` tracks the newest invocation rather
   than looking for unanswered calls anywhere — get this wrong and a card the user
   walked away from comes back on every reload.
3. **Every tool call gets an answer.** An assistant message with tool calls must
   be followed by one result per call or the engine refuses the whole request —
   on that turn _and every later turn of that conversation_.
4. **Reasoning is replayed.** A reasoning model rejects a tool-carrying turn whose
   `reasoning_content` is missing from a later request. It is not decoration.
   The local build runs with `--reasoning off` for speed, but a thought part that
   did arrive is still preserved and replayed.
5. **Gated means gated in code, not in the prompt.** Whether a call pauses the
   turn is decided before the tool is offered to the model.
6. **A refused path is refused after resolution.** `..`, an absolute path outside
   the workspace, and a symlink that leaves it are one refusal.
7. **Truncation is visible.** A capped tool result says so, so the model knows
   there is more rather than believing it read everything.
8. **Secrets never cross to the renderer.** Settings report whether a connector's
   secret is _set_, never its value — and there is a test that walks the payload
   rather than trusting one call site.
9. **A capability the user turned off is absent, not discouraged.** An ungranted
   connector is missing from the tool list rather than refused when the model
   proposes it.
10. **One turn at a time holds across processes.** The app and the runner are
    serialised by a lock, not by hope.
11. **Unattended means unapproved stays unapproved.** A headless run never
    answers its own approval gate.
12. **A newer document is never overwritten.** See "Documents" below.
13. **The app and the runner resolve the same user-data directory.** When they do
    not, nothing errors: the window writes one `jobs.json`, the service reads
    another, finds nothing due, and exits 0. The model directory is the second
    half of the same fact and is resolved by the same `modelDir` helper: under
    `userData/model/`, or wherever `MARIMO_MODEL_DIR` points. The folder was
    `Marimo Agent` for the whole life of the app called Marimo, so the rename is
    `adoptFormerUserDataDir` in `shared/product.ts`, called by both entry points.
14. **An MCP server's tools cannot take a built-in name.** The reserved set is
    every built-in name _before_ the profile filter — a tool the profile has
    switched off still owns its name.
15. **A turn that says nothing is a failure, not an answer.** A small model can
    end a turn with reasoning in `thought` parts, no content and no tool call.
    `drive` treats a turn with no visible text and no pending gate as broken: it
    asks once more with the model's own reasoning handed back, stores the reply,
    and reports `turn.failed` if that is empty too.
16. **The only secret left belongs to a connector, and the runner must be able to
    read it.** The headless runner has no `app`, therefore no `safeStorage`, so a
    connector's secret is stored readable only when the user ticks that
    connector's "let the background runner read it" box. `keysReadableIn` answers
    for every enabled connector together. There is no provider key and no
    provider address in this build.
17. **A model is a pair, and the task chooses it.** `{provider: 'local',
    model: '<lfm3 id>'}` is the only shape stored or sent. Chat, an image and
    voice all use Omni; the Settings card has no task picker. A voice turn uses
    one model for the **whole turn** — not a text model
    with an audio model beside it. A resume uses the pair the turn started with,
    even if the task assignment has moved since.
18. **A delegation is a tool call in the same conversation.** `ask_agent` builds
    the helper over the parent's session service and session id — never
    `this.host(childProfileId)`. Depth is one by construction. A helper's gate is
    answered from the parent's card, and the parent's tool sends ADK the
    confirmation for the child's call rather than telling the child the news and
    asking it to redo the work.
19. **ADK ends the invocation at a gate, so a tool cannot wait inside one.** The
    helper parking on an approval ends *its* invocation, and a parent tool that
    sat waiting would leave the model's own call unanswered. `ask_agent` raises a
    card of its own with `requestConfirmation`, and the click resumes *it*.
20. **An editor write is refused against a stale revision, and the draft is
    kept.** A write carries the revision it was based on — size and modification
    time — and a mismatch writes *nothing* and answers with what is on disk now.
    A missing parent folder is never created, and a write over the read cap is
    refused.
21. **A Space's documents are the folder's files, not a second copy.** The
    library lists every regular file, hidden ones included, and the editor opens
    the UTF-8 text ones. `.marimo/` and `.git/` are skipped. A file that is not
    UTF-8 text is listed and refused when opened, never decoded into a string and
    saved back as damage. The caps (500 files, eight levels, one megabyte) say
    when they stopped rather than answering as if the folder ended there.
22. **A prompt must not advertise a capability the profile does not have.** The
    tool list and the prompt agree, or the model narrates a capability it was
    never given. `DEFAULT_AGENT_ROLE` / `DEFAULT_AGENT_PERSONA` are the agent the
    person talks to; `botRoleFor(name, template)` / `botPersonaFor(template)` are a
    bot. The starter roles name no tool; the capability skills follow the grant.
23. **A skill is advertised, not carried, and its grant is the switch.**
    `userData/skills/<name>/SKILL.md` prints its name and one line in the prompt;
    `load_skill` reads the body when a task matches. `enabledSkills` is the one
    grant and three things read it — the prompt, the library behind `load_skill`,
    and the Settings switches. A grant change is not a reason to drop a host.
24. **One model is resident at a time, and it is never stopped under a request.**
    `LocalModelHost` starts the model a turn needs and stops it after the
    configured quiet period (three minutes by default). `isBusy` and
    `inFlight` keep the idle timer from pulling the weights out between a tool
    call and its answer; a second model while one is in use is
    refused rather than swapped in. A pid file under `model/local-model.pid` lets
    the next launch reap an engine whose window crashed.
25. **A download is verified before it is used, and a marker is not a hint.**
    `installLocalModel` checks every file against a pinned SHA-256 and writes
    `local-model.json` only when all of them are in place. `localModelOnDisk`
    compares the marker's revision and file list against the pins; a size match
    under the wrong name is not installed. The shared engine carries its own
    `.pinned` marker, so a build that moves from the CPU archive to the GPU one,
    or from Vulkan to CUDA, replaces the binary instead of running the old
    engine. A half-written file is never loaded.
26. **A spoken answer belongs to the surface that asked.** `turn.completed`
    carries an origin that is not in the stored log; the window's speaking hook
    and the pet's each filter on it, so two voices never read one answer. The
    voice model is started before the turn, and the transcript is what is stored
    — the audio is not.

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
the conversation index needs it and the dependency runs one way. `runtime`
re-exports it.

**Every document is covered**, and an audit is the only way to know that: the
session index was the last one missing the guard, and its lenient read plus an
unguarded write meant a corrupt index became an empty one on the very next
message — every conversation gone from the sidebar. When you add a store, add it
to that list.

**A Space's documents are the other kind of file, and the guard points the other
way.** A document in a Space is the user's own file that the app only visits, so
it carries no version and is never migrated — what the write path carries instead
is the revision it read, and a mismatch is a refusal rather than a repair
(invariant 20). `documents.ts` owns no second path checker: every path arrives
through `resolveInsideWorkspace`, the guard the agent's own file tools use.

**Memory is the one document that is not versioned, and there are two of them.**
`memory.md` is plain markdown a user edits by hand, so a version field would be a
lie about a file the app does not own; the split between the person's half (under
user data) and the folder's half is by *layer*, and which layer goes where is
`scopeForSection` in `sections.ts`. A store built without `personMemoryRoot` is
exactly the old one-file store.

**A bot's uploaded icon is an app-owned file that is not a document.** It is one
PNG under `userData/avatars/`, served to the sandboxed renderer through the
`marimo-asset` scheme. A malformed icon costs the picture, not the bot.

**There is one settings screen, and it is not a mode.** Do not add a setting that
decides which settings exist; if a control is worth having, put it on the one
screen.

**The two control choices are not that switch back.** Standard and Power user are
pre-built `enabledTools` grants: the first run asks the question as **Regular** or
**Power setup**, Settings repeats it as Standard and Power user, choosing one
writes the same grant the switches show, and every switch stays on the one
screen. Power is the one preset that grants `run_shell`, because the person is
explicitly choosing full control there; the gate that asks before a command is
unchanged, and `request_tool` still refuses the shell.

**The goals after the direction are a plan, not a grant.** They are held in the
renderer and never written; they choose which steps appear (a bot step, the
voice preference, the jobs step), the suggested starter role, and nothing about
tools. Writing and coding are available on Regular because the
Writer or Coder bot carries `write_file` on its own profile; only scheduling is
Power-only, and a disabled goal is drawn with a switch to Power rather than
silently changing the grant.

## Models

The four models, their licences and their task capabilities are in
`packages/protocol/src/local-models.ts`. The repository revisions, file names,
sizes and digests are in `packages/runtime/src/local-model/chat-pins.ts`. The
default engine is a pinned llama.cpp build with one archive per platform —
Vulkan on Linux and Windows, Metal on macOS — and each archive contains the CPU
backend. `localModelArgs` asks for every layer, so a machine with a card offloads
the model and one without a usable device falls back to the processor.
`localModelArgs` is the one place the flags are written. The recall engine keeps
its own zero: that model's card warns about float16 NaN, and the CPU backend
accumulates in f32.

CUDA is an opt-in variant, not the default: the engine and its runtime are about
776 MB on Linux and 671 MB on Windows, and the pinned builds require a new enough
NVIDIA driver. `cuda.ts` owns the `nvidia-smi` probe and the driver floor;
`engineFilesFor` returns the two-archive bundle when the settings ask for CUDA,
and the host falls back to Vulkan when the probe says no. The switch lives in
Settings → Models, and switching back to Vulkan replaces the engine again.

Defaults: Chat, Images and Voice → `lfm3-omni-2b`. One download answers, sees
and speaks, so a first run never asks which model to use. Q8 is the quality
choice; Q4 is the small-laptop choice, and the host suggests it below 8 GB of
RAM. The dedicated `lfm3-1.7b`, `lfm3-vl-2b` and `lfm3-audio-2b` remain in the
catalogue and pins for the cleanup of an old install's files, not as a choice.

The surfaces are split on purpose: Settings → Models shows the one Omni model
and owns its download, variant, removal and sleep; the composer's badge only
reports whether it is warm and opens that card; the first run owns the required
Omni download and a voice-preference step that appears only when the voice goal
is chosen. The dedicated models are not offered; leftover files can be removed. Do not put a second task picker in the composer — the assignment
is an app-wide fact, not a fact about one conversation.

The speech endpoints are not the chat endpoint. Transcription is a chat
completion with an audio part and `Perform ASR in <language>.`; synthesis is
`POST /tts` at the server root and returns raw WAV. `speech.ts` validates the WAV
header and fixes the seed so the companion's voice does not change between
answers.

The window does not send the whole answer to `/tts` at once. `speechChunks`
splits the cleaned reply at sentence boundaries (160 characters a piece), plays
the first while the next is being synthesized, and bounds the total with the
protocol's `SPEECH_MAX_CHARS`; the host still caps one request with the same
number. A prefetched piece the user stops before is allowed to finish in the
background and is never played. A microphone press warms the voice model first,
so the load overlaps with the recording rather than landing after it.

**A live run needs weights.** `MARIMO_MODEL_DIR` points at a directory laid out
the way the app uses it:

```
model/
  engine/llama-server
  lfm3-omni-2b/LFM3-Omni-2B-Q4_K_M.gguf
  lfm3-omni-2b/mmproj-LFM3-Omni-2B-Q4_K_M.gguf
  lfm3-omni-2b/local-model.json
```

The marker is written by the installer, not by hand in normal use; a fixture for
a test or smoke check writes the same shape. The live check in this repository
uses the spike assets under `apps/desktop/.model-cache/`, which are gitignored.

## Learning

A fact the bot decides to remember is written; a change to what it can do waits
for a person.

- **Memory** is written by the review after its quote is verified, and the person
  searches and edits it in the Memory card afterwards.
- **Everything else** is `learning/proposals.json`: a grant, a policy or
  maintenance. That is the queue that needs an answer.
- **A proposal carries evidence.** A memory fact carries a quote verified against
  the transcript; a grant or policy carries the turn it came from.
- **`resolveLearningProposal` is the only write for a change.** The tool that
  asks cannot grant, and `run_shell` is refused by the tool, the catalogue and
  the write.
- **A refusal is a lesson.** It is keyed by subject, current for six months, and
  listed in the inbox with a way to clear it.
- **A turn records its outcome** on `turn.completed`/`failed`/`aborted`; the
  report adds the user's corrections.

## The loop

**A task is done when it is committed; the branch moves when a human says so.**
That is the whole rule, and the rest of this section is what makes it cheap to
follow.

**CI exists, and it is `.github/workflows/ci.yml`.** It re-runs `pnpm -r build`,
`typecheck`, `test`, then the smoke check under `xvfb-run` and a real
`electron-builder` package whose unpacked runner is started to prove asar is
still off. Read it before changing a build script, a dependency's version, or
anything the package step assumes about `apps/desktop/release/`.

Every `package*` script passes `--publish never`, because electron-builder
publishes implicitly when it detects CI. `${{ runner.temp }}` is the expression to
watch in the workflow. The smoke check's model fixture is local and sparse, so CI
does not download four gigabytes to prove a window opens.

`concurrency` cancels a superseded run, the job has a twenty-minute timeout, a
prose-only change is skipped through one `paths-ignore` list both triggers share,
and the packaging step stays behind a `package` input on the manual trigger.
Nothing in the workflow uploads an artifact.

A green local run is not a green CI run — the steps above are the difference, so
when packaging, the preload or the IPC schemas have moved, run the workflow on
purpose rather than trusting the local pass. A version belongs in exactly one
place: `package.json`'s `packageManager` is the pnpm version, and the workflow
deliberately does not repeat it.

```bash
# 1. While working: the narrow loop, a few seconds each.
pnpm --filter @marimo/runtime exec vitest --watch   # one package, watching
pnpm --filter @marimo/desktop typecheck             # desktop only

# 2. Before committing: prove the change, not the workspace.
pnpm typecheck        # every project including the test ones
pnpm test             # vitest everywhere

# 3. Before pushing, or when the change touches the window:
pnpm build            # tsc -b for every project
pnpm build:web        # the renderer bundle — step 3 is two commands
MARIMO_NO_SANDBOX=1 pnpm --filter @marimo/desktop smoke
```

**`--watch` has to be spelled out, and the _script_ cannot do it.** Each
package's `test` script is `vitest run`, and `run` ignores a `--watch` after it.
Bare `exec vitest` also falls back to running once without a TTY. `exec vitest
--watch` is explicit and behaves the same either way.

**Commit when the task is verified, not when the files are saved.** One commit
per task. A commit is not a push. **Never push on your own initiative.** `origin`
is `github.com/DevTarlow/marimo-bot`; the Gitea remote is kept only to fetch from.

Messages follow the history: subject is a sentence, capitalised, no
`feat:`/`fix:` noise; milestone work carries its tag. The body says what was
wrong, what it now does, and why that shape. No `Generated with` footer and no
co-author trailer.

**Verification scales with the change.** A renderer-only change needs
`typecheck`, the desktop tests and `build:web`. A change to `packages/agent` or
`packages/runtime` needs the lot. Anything that touches the preload, the IPC
schemas or the built bundles needs `build:web` and the smoke check.

## Commands

```bash
pnpm install          # the store lives in .pnpm-store
pnpm build            # tsc -b for every project — but NOT the renderer bundle
pnpm build:web        # the renderer bundle
pnpm typecheck        # including test projects
pnpm test             # vitest, everywhere
pnpm --filter @marimo/desktop dev     # tsc -b, then Vite + Electron
pnpm --filter @marimo/desktop smoke   # boot a real window and prove it works
pnpm --filter @marimo/desktop jobs-check   # prove a due job runs in the app
```

**The last three open a real window, and this app is tray-resident.** The app is
started detached by `scripts/app-process.mjs`, so `stopApp` can signal the process
group; the pid a launcher hands back is a wrapper, not the app. Before calling the
work finished, check:

```bash
ps -eo pid,cmd | grep '[e]lectron/dist/electron'   # empty is the only good answer
pkill -f '^/.*electron/dist/electron'
```

**Only the renderer is hot.** A save under `src/main`, `src/preload` or
`src/runner` changes nothing until Electron is restarted; a window newer than the
process behind it calls an unknown IPC method. Quit the old instance from the tray
(or `pkill`) before starting `dev` again.

`pnpm build` and `pnpm build:web` are not alternatives. The root `build` is
`tsc -b` alone; the renderer bundle comes from the desktop package's build.

The job runner is the same binary started as plain Node:

```bash
ELECTRON_RUN_AS_NODE=1 ./apps/desktop/node_modules/.bin/electron \
  apps/desktop/dist/runner/run-due.js --json
```

It exits 0 when there was nothing to do, and non-zero only when it could not do
its job. Keep that distinction.

If Electron's binary download fails with `ENOENT ... ~/.cache/electron`, use
`./scripts/with-local-caches.sh pnpm install`. If Electron aborts with the SUID
sandbox helper error, `./scripts/fix-linux-sandbox.sh` installs the Ubuntu fix.
The smoke check still takes `MARIMO_NO_SANDBOX=1` for a container, and nothing
else does.

## Testing

- Unit and integration tests sit beside the code (`src/**/*.test.ts`) in packages,
  and in `apps/desktop/tests` for the app.
- `scripts/smoke.mjs` boots a real window, attaches over the DevTools protocol and
  asserts the bridge answers and React mounted — then screenshots it. It writes a
  sparse model fixture and a stand-in engine so it never downloads the real
  weights. `--theme light` checks the other token block.
- Tests that touch the filesystem use `mkdtemp` under the working directory
  (`.marimo-*`, gitignored) rather than `/tmp`.
- **Two tests load the real embedding model, and both are skipped unless asked
  for.** `memory-retrieval.live.test.ts` and `same-fact.live.test.ts`. Run them
  when you touch `prefixes.ts`, the scoring floor, the pooling, the pins, or
  `SAME_FACT_SCORE`:

  ```bash
  MARIMO_MODEL_DIR=$PWD/apps/desktop/.model-cache/live-model \
    pnpm --filter @marimo/runtime test:live
  ```

  `$PWD`, not a relative path: the filter runs with the package as its working
  directory. The directory has to be laid out the way the app uses it — weights at
  the root or in a model's own subdirectory, engine in `engine/` — because that is
  where the supervisor takes the shared libraries from.
- The chat models have their own live check. The repository's spike assets are
  under `apps/desktop/.model-cache/`; a manual run of `LocalModelHost` with
  `MARIMO_MODEL_DIR` pointing at a directory of real weights is the only thing
  that proves the pinned engine, the projector and the speech endpoints together.

## Packaging

```bash
pnpm --filter @marimo/desktop package   # AppImage into apps/desktop/release/
```

**Packaging ships no model.** The app downloads the one the user chooses, so the
installer is small and the same on every machine. `package`, `package:win` and
`package:mac` are plain builds and there is no variable to remember.

**`asar` stays off.** The runner is this binary started with
`ELECTRON_RUN_AS_NODE=1`, and Node mode has no asar support: reading a file inside
one fails with `Invalid package`. Turning it on produces a release whose
background runner cannot start — verified, not assumed — and it works perfectly in
development, so nothing catches it until somebody installs the app.

Packaging changes what `app.getAppPath()` returns, and the OS service plan writes
the runner's path into a systemd unit. Check that
`pnpm --filter @marimo/desktop package` still produces a runnable runner when that
path moves. The model downloads land under the user-data directory, not inside the
installer, so a packaged app and a checkout find them the same way.

## House style

- **Comments explain why.** The code says what it does. A comment that restates
  the line below it is noise; one that records the failure the line prevents is
  the most valuable thing in the file.
- **No dead code, no speculative options.** A flag nothing sets is a branch
  nobody tests.
- Reach for the existing helper before writing a new one. `window-state.ts`,
  `migrations.ts` and the theme tokens all exist because a version of this app
  got them wrong once.
- A local model is a process, a file and a licence. When adding one, update the
  protocol catalogue, the pins, the installer's asset lookup, the task defaults
  and the Models card — in one change. A model the UI offers and the installer
  cannot fetch is a download button that fails at 0 percent.
