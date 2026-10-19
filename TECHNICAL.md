# Marimo Bot: technical notes

How the app is built, why it is built that way, and how to work on it. If you
want to know what the app does and how to use it, read
[README.md](./README.md). The blunt working notes, and the rules that break
silently when you get them wrong, are in [AGENTS.md](./AGENTS.md).

## Running from source

```bash
pnpm install
pnpm build
pnpm test

# Linux only, once per Electron version: let Electron's sandbox start. It asks
# for sudo. Distribution versions that do not restrict user namespaces exit
# immediately, so it is safe to paste blindly.
./scripts/fix-linux-sandbox.sh

# Open the app
pnpm --filter @marimo/desktop dev

# Prove a real window opens and its renderer mounted
pnpm --filter @marimo/desktop smoke
```

**A checkout answers with whatever service you point it at.** There is no chat
model to fetch: the app carries none, and a development run configures a provider
the way a user's does — except that a checkout usually points it at a llama.cpp
server on the machine, which is the entry that needs no account and no network.
The one download left is recall's; `MARIMO_MODEL_DIR` is how a live run finds
those weights, and a run without them skips the two live tests rather than
failing.

Two environment quirks are worth knowing about up front, both covered in
[AGENTS.md](./AGENTS.md):

- If Electron's binary download fails with `ENOENT ... ~/.cache/electron`, wrap
  the command: `./scripts/with-local-caches.sh pnpm install`. The project keeps
  every tool cache inside the repository.
- The sandbox line is the only step in the quick start that fixes the machine
  rather than the checkout, which makes it the one place a failure has nothing to
  do with the code. Without it Electron dies — _after_ Vite has printed its URL,
  so it reads as a renderer that failed to paint rather than a host policy that
  refused a syscall:
  `The SUID sandbox helper binary was found, but is not configured correctly`.
  In a container, where AppArmor cannot be configured at all, the smoke check
  takes `MARIMO_NO_SANDBOX=1` instead.

If you change the Electron version, run the sandbox script again: the AppArmor
profile is attached to the versioned path inside `.pnpm`, so a stale one stops
matching and the abort returns.

The wider loop — what to run before a commit, and what has to be true before a
push — is in [AGENTS.md](./AGENTS.md). The short version:

```bash
pnpm typecheck   # every project, including the test ones
pnpm test        # vitest everywhere
pnpm build       # tsc -b for every project, but not the renderer bundle
pnpm build:web   # the renderer bundle — `build` alone leaves it stale
```

## What is built

| State       | Feature                                                                                                                                                                                                                                                                                                                                                 |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Done        | Five providers to answer with — DeepSeek, Google Gemini, OpenCode Go, OpenRouter, and a llama.cpp server of your own — each with its own address, model and key. The catalogue is data, the transport is one OpenAI-compatible client, and a key is encrypted unless you say otherwise                                                                  |
| Removed     | The model the app used to carry and run itself: Qwen3.5-4B on a llama.cpp engine it downloaded and supervised. Two tiers chosen from what the GPU reported, no account and no key — and 2.7 GB before the first answer                                                                                                                                  |
| Done        | The chat: streamed answers rendered as markdown, tool calls that fold away, copy buttons, a rail of Spaces with the conversations filed under the one they work in, light and dark following the OS or chosen                                                                                                                                           |
| Done        | Spaces: a folder that holds its own chats, its agents and its documents — the markdown files in it, listed in a library and editable in the window, with a revision on every write so a stale tab cannot clobber what an agent wrote                                                                                                                    |
| Done        | A chat with more than one agent: the lead answers and `@` addresses a member on the v2 engine; `ask_agent` asks another bot a tool-less question in the same thread, and `start_task` gives another bot a real turn in its own conversation and posts the result back. The old same-conversation helper with its own gate still serves v1 conversations |
| Done        | One settings screen, and bots at the top of the sidebar with their own icons — five shipped presets and an uploaded image, changed in Settings                                                                                                                                                                                                          |
| Done        | The agent core: new conversations run on the v2 harness — a canonical append-only JSONL log, a frozen versioned spec, one ADK adapter behind a boundary test, and a tool set whose availability follows the grant. `AgentHost` remains for v1 history and the same-conversation helper gate, not for new work. See `docs/harness-v2.md`                 |
| Done        | Approvals that survive a restart, because a pending call is derived from the stored conversation rather than held in memory                                                                                                                                                                                                                             |
| Done        | MCP connectors: add one from either settings screen, test it from the same form, and choose whether to trust it — untrusted servers ask before every call. An agent uses the ones it was granted, and a scheduled job dials them too                                                                                                                    |
| Done        | Per-agent capabilities: every tool is a switch, and a tool that is off is not offered to the model at all                                                                                                                                                                                                                                               |
| Done        | The stores: jobs, profiles, settings, skills, memory proposals — with format versioning that refuses to overwrite a document it cannot read                                                                                                                                                                                                             |
| Done        | Secrets: one file per provider key and per connector secret, encrypted in the OS keychain, stored readable only when the user asks for that one to be readable by the background runner, and a machine with no keychain told so rather than written to in the clear                                                                                     |
| Done        | Scheduled jobs while the app is open, and a headless runner plus an OS service that keeps them going while it is closed                                                                                                                                                                                                                                 |
| Done        | The desktop companion: a frameless, transparent, click-through moss ball that answers in bubbles above itself, with its own chat bar underneath and its own settings for how long it answers, how much it shows, and whether it floats                                                                                                                  |
| Done        | A first run in five steps: load a Space, make a bot (and as many more as you want, or none), say how you want to be talked to, and choose the service that answers — with no message box anywhere until the app can actually answer, and one flag so the flow is a first run rather than a screen that comes back                                       |
| Done        | A memory review: after a conversation goes quiet the agent proposes what is worth remembering and asks before writing it — reading a long session in stretches rather than only once it ends, and remembering the facts you turned down                                                                                                                 |
| Done        | Memory in two halves: who the user is, which follows them between projects, and what this folder is, which does not — with a correction able to replace an old fact rather than sit beside it, and every bullet dated                                                                                                                                   |
| Done        | A way to say an answer was wrong. It is recorded, never written straight into memory, and the next review reads it                                                                                                                                                                                                                                      |
| Done        | Recall: find things by what they mean rather than by the words they use, across the folder you loaded, memory, your own conversations and — with one more download — images, audio and video, from a search box or the agent's own tool                                                                                                                 |
| Done        | Dream-RSI: off by default, a turn's search recorded as a tree of what was offered, proposed and run, and a command that re-decides those turns under other settings without a model                                                                                                                                                                     |
| In progress | Windows and macOS installers (the config is written and both package; the installers are unbuilt — see [Building a release](#building-a-release))                                                                                                                                                                                                       |

## Why it is built this way

### Three packages, and none of them know about Electron

`@marimo/protocol` is the typed contract — every IPC call, every event, the
profile and job documents. `@marimo/agent` is the agent itself. `@marimo/runtime`
is where files live, how the app's own documents are versioned, what a Space's
files are read and written through, and where the recall engine is supervised.

None of them import Electron, and that is load-bearing rather than tidy. The
background service that keeps scheduled jobs running while the app is closed is
**the same binary started as plain Node** (`ELECTRON_RUN_AS_NODE=1`). That is what
gives it the same agent core and the same conversation files without a second
runtime or a second copy of the logic — and it is what lets it run from a timer at
boot, over SSH, or in a container, none of which a plain Electron process can do.

The cost is real and worth stating: with no `app` object there is no
`safeStorage`, so an encrypted secret cannot be read. It stopped mattering for a
while, when the app answered with a bundled model and the runner dialled no
connectors; it matters again now that a job answers through a provider and may use
the connectors its agent was granted. Both kinds of secret — the active provider's
key, and each enabled connector's — are therefore stored readable only where the
user says so, per key and per connector, and a job whose secret is encrypted says
so rather than failing with a `401`. What the runner also needs is the same
user-data directory the window is using, which is why the service definition bakes
that path in.

### What answers, and where the key is

**The app runs no chat model of its own, and that is a deliberate inversion.**
For most of its life it downloaded a llama.cpp engine and a quantized Qwen, started
it on loopback and answered from it — no account, no key, nothing typed into the
chat leaving the machine. What that cost was 2.7 GB on a first run, a graphics
card as a hard requirement, and a model whose ceiling was the machine it ran on.
It now talks to a _provider_, and the honest consequence is on the first screen
rather than hidden: a fresh install cannot answer until somebody picks one.

**Five of them, and one keeps the old promise.** DeepSeek, Google Gemini, OpenCode
Go and OpenRouter are hosted services reached with an API key; a llama.cpp server
you run yourself is reached at an address you type and is the entry that needs no
account and sends nothing off the machine. The catalogue lives in
`packages/protocol/src/providers.ts`, and it is plain data: label, blurb, default
address, placeholder models, whether a key is required, and four facts about the
_endpoint_ — whether thinking arrives as `reasoning_content`, whether
`stream_options.include_usage` may be sent, which header a gateway wants a
conversation named in, and whether a key is needed at all.

**One transport serves all five, which is why the flags matter.** Every one of
these speaks the OpenAI chat-completions dialect, so switching provider is an
address, a key and a model id. What is _not_ uniform is which fields may be sent:
Gemini's compatibility layer answers an unsupported `stream_options` with an error
rather than ignoring it, so a transport that always asked for usage would fail
every turn there, and one that never asked would leave the token counts blank
everywhere else. Those decisions travel with the provider id, so the transport has
no `if (provider === ...)` in it.

**A key is encrypted, and the runner is the exception that proves it.** Secrets
are one file per provider under `secrets/`, named from the catalogue by
`paths.providerSecrets`, and encrypted with the OS keychain. The headless job
runner has no `app` object and therefore no `safeStorage`, so it cannot decrypt
anything — which is why each provider carries a `keyStorage` of `keychain` or
`plaintext`, why the card has a box that says exactly what storing it readable
means, and why a scheduled job whose agent needs an encrypted key fails with a
sentence rather than a 401.

**A model is a pair.** `{provider, model}` is the only shape stored or sent,
because an id means nothing apart from the endpoint that serves it — and the
resolution order is one function, `modelChoiceFor`: the conversation's choice,
then its agent's, then the app's. Each level contributes its provider _and_ its
model id, because taking one from each is how a window comes to name a model the
turn is not using.

**The one engine left is recall's.** It downloads its own embedding model and runs
its own llama.cpp build under `model/recall/`, supervised by the same
`LocalModelService` the chat engine used to use — kept precisely because recall
still needs it. So the pin discipline, the verified resumable download and the
never-leave-an-engine-behind rule all still apply; what is gone is the tier plan,
the hardware probe and the chat weights, because nothing chooses a chat tier any
more.

### A connector belongs to the install; a grant belongs to an agent

**A connector is software the user did not write, offering tools that can do
anything its process can**, which is why `trusted` is off by default and an
untrusted server's every call takes the same approval path as `write_file` — one
gate, not a second kind. The layer above that is which agent may use it at all.

**The connection is the install's and the grant is the profile's.** `mcpServers`
in the settings document says how to reach a server once — a command, an address,
where its secret goes — and `mcpServerIds` on a profile says which of them that
agent may use. Absent means every connector, and that is what every profile
written before the field means: an upgrade must not take a user's connectors away
from the agent that was using them. An array names exactly those, and an empty
one means none, which is a real answer a person can give — so clearing the grant
is a `null` rather than `[]`, the same distinction `model` needs. The ids are the
servers' own rather than their names, because a rename must not lose a grant and a
name freed by a delete must not be inherited by a new server the agent was never
given.

**The filter sits where a runner is built, so an ungranted server is absent rather
than refused.** `grantedMcpServers` narrows the toolsets as a model is built for
an agent, and a model that never sees a tool cannot propose it — invariant 9 one
layer down. It is read at that moment rather than when the servers were handed
over, because both halves move: a server can connect after the profile was
written, and the profile can be edited while the app runs.

**The switch is drawn from the settings document, not from live connections.** A
grant screen has to exist _before_ the server is reachable, or a connector that
cannot be dialled yet — a wrong command, a secret this process cannot read — is
one nobody can decide about. Adding, testing and trusting a server is on the one
settings screen, because that is a capability the user has; the grant itself is
one switch per connector per agent, beside the tool switches.

**A connector's secret carries the same consent a provider's key does, and the
consent has to travel with the write.** `secretStorage` is per connector and
defaults to `keychain`; a scheduled job runs in a process with no keychain, so a
connector that job is meant to use has to be readable by one, and only the user
can say so. The trap here is ordering rather than storage: the consent is a field
of the same unsaved form as the value, so reading it back off the _saved_
connector leaks in one direction — untick it, type a new value, save the secret
without saving the connector, and the file is written readable while the screen
says encrypted. `mcp.setSecret` takes the consent instead, and a test pins both
directions of the disagreement.

**And a scheduled job dials them.** `run-due` builds the window's own
`McpManager` over the same settings document and hands its toolsets to the
runtime, with a `FileSecretStore` that has no cipher — the reader the provider key
beside it already had. Before that it dialled nothing and said nothing, so a job's
agent was the agent the window runs minus every tool a connector offers. One quiet
failure was found in the same place: a connector secret that could not be read was
silently skipped, so the server was dialled without its credential and answered a
401 that reads as a wrong token. The reader now raises the store's own sentence,
which the manager turns into the connector's status and the runner reports.

### Recall: finding things by meaning, on the machine that has them

Searching for a word finds the places that word appears. Recall finds the places a
thing is _about_, which is the only kind of search that works when somebody
half-remembers something — the file about retries, the preference they stated two
weeks ago, the picture with the receipt in it. It is a second model rather than a
second feature bolted onto the first: embeddinggemma-2, a 270M backbone at Q8_0
(310 MB, 768 dimensions, 8K of context), served by its own pinned llama.cpp build
on loopback. "Its own" is load-bearing, and it was learned by running the build
rather than by reading about it: the engine the app used to answer with predates
this model's architecture entirely (`unknown model architecture: gemma-embedding2`),
so recall pins a newer build instead of moving onto one whose template has never
been verified against anything.

**It is off until somebody asks.** Turning it on downloads 310 MB and starts a
process of its own, so it is not a default; the question is asked once, on the
screen that follows the provider choice, and afterwards the switch lives in
Settings where every other capability does. The corpora are separate switches
because they are separate consents: the folder is the work, memory is what the
agent wrote down _about_ the user, a conversation is everything they said, and
media needs a second
555 MB download — not a preference but the image and audio encoder itself, absent
from the process unless it is fetched. A corpus that is off is not searched and
not offered: the tool's own scope enum is built from what exists, so a model
cannot ask for something the service would answer "nothing" about.

**The index holds no text.** It holds vectors and a digest per record, so a hit is
read back from its source and checked before it is shown; a file that changed
since it was indexed comes back marked changed, with no text, rather than quoted
from a copy that is no longer there. The index refreshes when a question is asked
rather than on a timer, in bounded slices that report what they covered. And there
is a floor below which a nearest vector is not an answer — measured at 0.68 rather
than chosen, because a list of the least-unrelated things in a folder reads as a
list of answers. The window can ask for the withheld ones when the phrasing, and
not the corpus, was the problem; a tool call cannot, and should not.

**It runs on the processor, and the index lives with the folder it describes.**
The reason it used to give is gone with the chat engine — there is no tier
estimated on the engine having every byte of device memory, because the app no
longer runs a chat model at all — and the choice stands on its own. This model's
card warns that its activations exceed float16's range and return NaN in it, while
the CPU backend accumulates in f32; an embedding is a single pass over at most 8K
tokens, which is the other half of why a GPU buys less here than it did for a
conversation. The index sits in `<folder>/.marimo/<agent>/recall/` beside memory,
so a project that moves takes its index with it; an agent with no folder loaded
gets one under user data instead.

**Two ways in, one service behind them.** The window has a search box on `Ctrl+K`
that returns the same hits, scores and staleness claims the tool does — somebody
who half-remembers where something is should not need a model to look it up. The
agent gets `recall` beside `search_knowledge_base`: one takes the identifier, the
other takes the description, and a model that knows the words should not have to
phrase them as a question. Memory is a third caller rather than a way in, and it
is the one that changes every turn: when recall is on, the memory block is
narrowed to the bullets that answer the question instead of the whole file, with
the whole file as the fallback whenever retrieval did not work. The sections that
constrain behaviour — tone, conventions, boundaries — ride along whole whatever
was asked, because a missed rule is a wrong action and a missed fact is only a
worse answer.

### Memory is two files, and the layer decides which

Memory is markdown, and there are two of them. `memory/<profile>/memory.md` under
user data holds the facts about the _person_ — who they are, how they want to be
talked to, what they have asked never to happen. `<folder>/.marimo/<profile>/`
holds the facts about _this workspace_ — its conventions, its paths, one pointer
per project to wherever it keeps its state.

The split is by **layer**, and the vocabulary already knew which was which: the
canonical sections in `sections.ts` carry a `scope`, separate from the `always`
flag. It had to be separate. `Environment and conventions` rides along whole in
every prompt _and_ is a fact about one repository, so collapsing the two axes
would have put one project's rules in every other project's prompt.

Both files are read as one document, so everything above this — the prompt block,
the recall index, the staleness hash, the block that narrows memory per question —
never learned there are two. Only the write path knows, and it routes by section:
a canonical name answers its own scope, and a heading the app never named stays in
the workspace file, which is where it already is. That default is the careful
half — nothing a user typed by hand moves on upgrade.

The move itself happens once, on the first read after upgrading, and it is the
same shape as the folders' adoption: data moving between two documents cannot be
a migration, which is a pure function of one. Person-level sections are copied out
of the workspace file and then removed from it, in that order, because the other
order loses them if it throws in between. The merged read de-duplicates bullets,
so the transient state where a fact is in both is invisible rather than doubled.

Two things this deliberately does not do. A prune that never mentions the person
leaves that half exactly as it was and says so in the tool result: the document
the model sends replaces memory, and with two files "I did not mention it" and "I
want it gone" are otherwise the same sentence. And no layer is ever deleted for
being old — `provenance.json` records when each bullet was first written and the
Memory card shows them oldest first, so what is stale is visible and the decision
stays with the person.

### An answer can be judged, and the judgement goes to the reviewer

Everything in this app could be corrected except the thing the agent actually
said. A fact can be replaced, a suggestion refused, a manner written down — but
"you had that wrong, it is like this" had nowhere to go, and that is the
difference between a store of facts and something that improves.

There is now a quiet **Not quite** under an answer, in the window and on the moss,
which records an optional line about what was right instead. Nothing is written to
memory and nothing is said back: the conversation log is left as it was, because a
correction is a note _about_ a turn rather than a turn in it. What reads it is the
next memory review, which gets the corrections as a block of their own — the
strongest evidence it ever receives, because the person has already done the work
of stating what is true. It is deliberately not the same as a refusal: a refusal
says "do not remember that", a correction says "this is right".

**The note carries the turn, and that is what makes it a fact rather than a
comment.** A message is named by its first event's id, which the discovery log has
never seen; a turn is named by its invocation, which both records have. So the
entry stores the invocation too, the transcript puts it on the message, and every
read joins the two. Two things follow. Reopening a conversation shows **Noted**
where it used to offer to note the same answer again — the old mark lived in one
component's state and died with it. And the offline replay can count how many of
the turns it is scoring the person judged wrong, which is the first outcome the
replay has ever had. It is counted, not scored: an answer is usually wrong about
what it said rather than about which tool ran, so the mark splits the sample and
explains nothing on its own. Entries written before the field existed are still
matched by message id, because an upgrade is not an objection to the person's own
note.

The store holds the user's words verbatim and bounded, and it is scoped to the
profile, because one agent being told it was wrong about a deployment is not a
fact about the other one. It reads leniently so a corrupt file still opens the
window, and it moves that file aside before writing rather than over it.

### Dream-RSI: the search is recorded, so it can be re-decided offline

A turn is a search. The model proposes a tool call, the controller decides whether
it may be taken, the tool answers, and the turn either continues or ends. For a
long time only the last of those was visible: the transcript shows one path
through the work and has no way to represent the actions that were considered and
refused, so "which tools should this turn have been offered" was not a question
anybody could ask.

Dream-RSI is the three pieces that make it askable. It is off until the user turns
it on, and off means absent rather than discouraged: no recorder is constructed,
and the runner is given the repeat-only plugin it has always had.

**The recorder writes a tree, and a proposal is not a call.** `dream/recorder.ts`
emits a `turn` node per model request, a `propose` node per call the model asked
for, and a `call` node per call that ran, linked by `parentId`. Splitting those last
two is the whole point: between them sits the entire policy, so collapsing them
loses the only measurement the feature has — a withheld action would be
indistinguishable from one the model never thought of. Trees are appended as whole
snapshots rather than mutated in place, so a process killed mid-turn leaves a
readable prefix rather than a truncated object; the turn most worth replaying is
the one that crashed.

**The controller is pure, and that is load-bearing.** `dream/search.ts` is
`SearchPolicy`: UCB1 over an action's visit count and mean reward, an explicit
exploration weight, and a pruning threshold. It takes history as an argument
rather than reading it from anywhere, which is what lets the live turn and the
offline replay call the _same function_ — so a setting measured offline is the
setting that runs live, by construction rather than by two implementations kept in
step. Every temptation to make the score cleverer had to survive that constraint,
which is why the reward is an arithmetic function of the recorded result rather
than a model's opinion of it: a reward that needs a model cannot be recomputed
from a log, and a replay that cannot recompute it is either impossible or a liar.

The action's statistics and the repeat rule are deliberately separate numbers.
`visits` counts calls that ran, and drives the reward estimate; `attempts` counts
proposals whether or not they ran, and drives the loop breaker inherited from
`RepeatedToolCallPlugin`. Confusing them is a real bug rather than a tidiness
question — `read_file` three times on three different files is a model doing its
job, and one counter cannot tell that from a loop. A withheld call is counted as an
attempt and _not_ as a visit, because counting a refusal as a zero-reward visit
would make pruning self-reinforcing: the evidence for pruning an action would be
the pruning itself.

**Pruning removes the tool from the menu.** It is applied through ADK's
`beforeToolSelection`, so a pruned tool is not merely refused — it is absent, and
the model spends no tokens proposing it and the turn spends no round trip saying
no. `beforeToolCallback` is the safety net beneath it, catching a call already in
flight and the repeat rule, which is about a specific call rather than a tool set.
The default threshold prunes nothing, and that direction is deliberate: the failure
mode of pruning too eagerly is invisible from the outside — the agent answers from
less than it could have, competently and wrongly — while the failure mode of
pruning too little is a slow turn. With the file and shell tools in the menu, the
choice between actions is real, which is what makes the threshold worth measuring
rather than decorative.

**The log records the world, not what one policy approved of.** The `offered` set
on a step node is the _unfiltered_ tool set. Recording the narrowed set would be
the obvious thing and it would quietly make the replay useless: a pruned tool would
be absent from its own history, so no candidate threshold could ever be evaluated
against it. Off-policy evaluation needs the whole action space the turn had.

**The replay reports what a setting would have withheld, and refuses to report an
outcome.** `pnpm --filter @marimo/desktop replay:dream` reads the logs, re-decides
every recorded step under a grid of weights and thresholds, and prints a table —
with no model call and no tool call, because every number comes from a log that
already exists. Withheld actions, and how many of those the model actually reached
for, are counts in that log. What would have happened _next_ is not: the model
chose each step from the result of the one before it, so withholding a step changes
the conversation, and the recorded continuation is the one that happened under the
old settings. The output says so in its own words rather than leaving a reader to
assume the numbers are a prediction.

One consequence is worth stating because it bounds what a threshold can do. The
first step of a turn has no history, so every action on the menu is untried and
saves every threshold — the first call always happens. A setting can save the
second and third attempts, never the first, which is why the honest pitch is "the
turn stops sooner" rather than "the turn does not go wrong".

**The card reports the last write, not the last error message.** The trees are
written from inside a tool callback, where a full disk must not fail the turn — so
the store keeps the last failure and the card in Settings says so while it is true.
It is a status rather than a one-shot notice because the card is drawn from a
settings payload the window reads for its own reasons, and a message that cleared
on read could be swallowed by a read nobody was showing the card for.

### One settings screen, and one grant behind it

Everything the app can do is a switch somebody turns on, and there is one screen
to turn it on from. It used to come in two sizes with a switch between them; that
switch made the bot's identity and the individual tool switches reachable only by
leaving "the everyday settings", which made the same app look like two products
and hid the controls from the people most likely to need them. The setup flow
still offers three capability cards at the moment a bot is made, because that is
where a person is choosing what it is _for_; Settings offers every tool as its own
switch. Both write `enabledTools`, the card that is lit is worked out by comparing
that grant against the lists, and the profile remains the one source of truth for
what an agent may do.

The provider card is not tuning and has never been optional: the app carries no
model, so a fresh install cannot answer until it is pointed at one. The connector
list is on the same screen for the reason from the other end — a capability nobody
can see is one nobody turns on. The per-bot connector grant lives with the bot,
above.

**An icon is a profile field and a file, and the field can never cost the bot.**
`avatar` is optional on the profile: a preset names one of five shipped SVGs, and
a custom icon names a version while the bytes live under `userData/avatars/`,
served to the sandboxed renderer through the app's `marimo-asset` scheme. A
malformed icon falls back to the default or the name's initial, which is the same
rule the profile schema follows everywhere: an optional field that a newer build
wrote must not make `ProfileStore.parseFile` skip the profile.

### A skill is a file, and the prompt only advertises it

A user's skill is one folder under `userData/skills/`, holding a `SKILL.md`:
frontmatter with a `name` and a one-line `description`, then the instructions.
The shape is the one the agent ecosystem already uses, which is the point — a
skill written for another harness can be dropped in, edited in any text editor,
and copied between machines as a folder. It is plain markdown rather than a
versioned document, for the reason `memory.md` is: the user owns it and may edit
it by hand, so a version field would be a lie. What the write path guarantees
instead is that a folder this build could not parse is refused rather than
overwritten, and a replaced folder is moved aside before it is removed.

**The instructions do not ride in every request.** `composeInstruction` lists each
granted skill's name and description under `# Available skills`, and the
`load_skill` tool reads the body when a task matches. That is what makes a
28 KB procedure like humanizer worth having: the prompt pays one line for it, not
a context window. The cap on instructions exists for the loaded request, and the
much smaller cap on the description exists because that one _is_ carried every
turn.

The grant is per bot and it is the switch: `enabledSkills` names the skills the
profile may use, the prompt is built from that list, and the library `load_skill`
reads refuses every name outside it — one fact, three readers. `save_skill` is an
ordinary tool grant now, gated by a confirmation per call, and the Settings editor
writes the same store through the same service. The agent's save writes the file
and then grants the name; the editor does not grant, because a list of switches is
where the person makes that decision. A rename carries every bot that had the old
name, and a removal drops the grant with the file.

An older build kept skills in `skills.json`. It is imported into folders once and
renamed to `skills.json.imported`, not deleted: the file is still the user's, and
a failed import must not be the only copy.

### A conversation that stays bounded without being rewritten

Automatic compaction is the manual `sessions.compact` brought forward to the
moment before a turn, and it uses the same mechanism: a compacted event is an
ordinary event carrying a summary and the span it stands for, so nothing on disk
is rewritten and ADK's `getActiveEvents` does the rest. The trigger is a character
budget (`AUTO_COMPACT_AT_CHARS`), not a token count: this app has no tokenizer and
the provider catalogue carries no context-window metadata, so the number is a
deliberately conservative estimate — four characters to a token is ADK's own
rule — with room left for the instruction, tool schemas and the reply. The
measurement counts reasoning, tool arguments and full tool results, which the
summary renderer deliberately caps.

The difference from the command is what happens when it cannot run. A manual
compaction returns the reason and leaves the conversation alone; an automatic one
returns the reason too, but the turn continues with the full history rather than
failing, because the question the person just asked is not the summary's hostage.
A pending approval is never compacted in either path.

**The first run itself is a five-step flow, and one flag decides whether it is
offered.** A fresh install has two things missing at once — a bot to give work to
and the service that answers — and a starting Space the app chose rather than the
person, which the flow offers to change. The flow is model first: until a provider
is chosen and readable the window offers no message box at all, and a wizard that
asked for a Space and a bot before it had a model would be asking somebody to
describe work nothing can do. A provider that cannot answer is the one step that
cannot be continued past; "set this up later" closes the flow rather than walking
into screens that cannot work. It writes as it goes, exactly as Settings does, so
quitting in the middle loses nothing, and each step reads what already exists
rather than creating a second copy of it.

**Finishing the flow lands in the Space the person chose, with a new chat.** The
conversation the window opened on was created by the app before the flow ran, in
the folder the app started them in; leaving them in it after they picked another
Space is the unfinished half of asking. `landingSpaceAfterSetup` is the rule (only
a Space picked in the flow counts), the window creates that chat first and reloads
after it because `boot` opens the newest conversation, and the starter chat is
empty and unlisted in the rail. An install that kept the starting folder opens no
second chat, because the one it is already in is the right one.

**A bot can be made three ways, and they share one draft.** A starter role gives a
name, a Role, a first Persona, a grant and an icon in one click; the step-by-step
form asks for a role, a name and abilities; and the guided path hands the rest of
the conversation to Marimo. All three end in `profiles.create` with the same
`BotDraft`, so the store cannot tell which door somebody came through and the
Persona is never a second, quieter way of describing a bot. The starter roles are
protocol data, narrowed against the tools this install actually has before a card
is drawn — a card that granted a tool this build does not carry would be a choice
that does nothing.

**The step after a bot is made owns its Persona**, the field that replaced "How to
talk to me". It is the one thing about a bot that is the person's own text rather
than the app's: what it is for, how it should sound, and how they want to be spoken
to. It is sent after the Role so it wins where the two disagree, and a field nobody
opens a settings screen to find stays empty — so it is asked for at the moment
somebody is thinking about the bot at all. The bot exists by then: the step edits a
profile on the roster rather than a draft in a form, which is why going back from
it returns to the list of bots and never to the form that would make a second one.
Adding another bot goes through the same path, so a Persona is offered for every
bot rather than for the first one only.

**The guided path is a conversation with a stored purpose.** `sessions.startBuilder`
creates an ordinary session titled "Making a bot" with `purpose: 'bot-builder'`,
after checking in code that the lead actually has the `draft_bot` tool. Every turn
of that session carries `BOT_BUILDER_INSTRUCTION` after the ordinary turn context:
ask one question at a time, and when there is enough, call `draft_bot`. The opening
question is a card the window draws from the purpose and the same constant the
instruction quotes, not a seeded model message — an assistant-first history is
accepted by some providers and not others, and a small model can lose an
instruction it was never given. The tool never creates anything. The window draws
its arguments as a review card, the person edits the name, Persona and template,
and only their Create press reaches `profiles.create`. `createdFromCall` on the
profile is what stops a card revisited after a reload making the same bot twice.

Which screen a launch gets is `firstRunScreen` in
`apps/desktop/src/renderer/first-run.ts` — four answers (`waiting`, `setup`,
`cannotAnswer`, `app`) from four facts — and it lives outside `App.tsx` because
this package has no DOM test environment: the arithmetic is worth testing, and two
of its four rules are about moments rather than states. Nothing loaded is not a
state to draw, or every launch flashes a wizard at somebody whose app works. And
the flow is _sticky_ once it is up, because its own last step is what turns
`modelReady` true and a screen recomputed from settings alone would vanish between
saving a key and reading what happened.

`setupSeen` is what makes the flow a first run rather than a screen that returns
whenever the app cannot answer. It is set when the flow closes either way — a
provider working, or "set this up later" — and an install that still cannot answer
afterwards gets the short card that names the problem and opens Settings, which is
also where an existing install lands when its key stops being readable later. The
flag is not a claim about readiness; `modelReady` is that claim, and it is the main
process's.

The one grant the flow writes on the user's behalf is `ask_agent` on the lead,
offered as a checkbox in plain words: Marimo Bot is told by its own identity to hand
work to the bots the person makes, and without that tool it cannot. The tool's name
travels to the window through `ProfileCatalog.delegationTool` rather than being
spelled out in the renderer, for the reason the capability presets do — a grant
naming a tool that does not exist is filtered away at the host rather than refused,
so a second copy of the string would tick a box and change nothing.

### The window and the service must agree about where data lives

Electron derives its user-data directory from the app's `productName`, and the
runner has no `app` to ask — so neither process leaves it to a derivation. The
folder held every installed copy's conversations, jobs and keys under the name it
was given first, `Marimo Agent`, through an app that has been called Marimo Agent,
Marimo and now Marimo Bot. Following the name to `Marimo Bot` is therefore a
migration, `adoptFormerUserDataDir`, and not a rename: a rename that moved the
folder would look exactly like a fresh install that had lost everything.
`userDataDirFor` in `apps/desktop/src/shared/product.ts` is the single rule both
processes ask: the `MARIMO_USER_DATA_DIR` override, else the platform's
application-data directory plus `USER_DATA_NAME`. The window then pins Electron to
that answer with `applyUserDataPath` rather than letting it derive one. If the two
ever disagree, nothing errors: the window writes one `jobs.json`, the service
reads another, finds nothing due, and exits 0 — a background service that looks
healthy and never does anything. `tests/product-name.test.ts` holds the two names
apart and covers the move, `tests/paths.test.ts` covers the pin, and the app
checks the two paths against each other at launch.

### Documents are versioned, and a newer one is never overwritten

Every store the app owns carries a `version`. Reading is explicit about the five
outcomes — absent, current, older, newer, unreadable — because the alternative is
what the previous generation of this code did: a schema mismatch made the read
return an empty document, the user watched their jobs disappear, and the next
save made it true on disk.

When a file is unreadable the reader decides what it deserves. The window reads
leniently so the app still opens and can be fixed by hand. The runner reads
strictly so it can exit non-zero, which is the only signal a timer gets. And the
write path refuses a file from a newer build, or moves a corrupt one aside,
rather than storing an empty document over it.

Everything above is about a file the app _owns_, and the word is doing work. A
Space's documents are the other kind — the user's files, whose format this app has
no say in — so they carry no version and are never migrated; what guards a write
to one is the revision rule in the sections below, where a mismatch is a refusal
rather than a repair.

### A Space is a folder, and the code keeps the older word

**What a person reads says Space; what a reader of `workspaces.json` sees says
`workspace`, and that split is deliberate.** A Space is more than the path it
points at: it is what its chats are filed under, what its documents are, and what
an agent can be pointed at to work in. That is what made a name worth having. What
did not follow is the vocabulary of the file: `workspaces.json`, `Workspace` and
`workspaceId` are what the document, every session index entry and every migration
already name, so renaming them would mean a data migration to reach a word the
user reads the same either way. It is the argument `PROVIDERS.llamacpp` makes
about its id — the label moves, the id stays — and the schema carries a comment
saying so, because a split like that reads as an oversight otherwise.

**A Space is a place on the machine rather than a fact about who is talking**, so
it belongs to the install: two agents asked about the same project work in the
same folder, under the same confinement, with the same
`<folder>/.marimo/<agent>/` memory.

**A fresh install starts in a folder the app made, not in the home directory.**
`defaultWorkspace` is `<home>/Marimo`, and `WorkspaceStore` creates it when it
seeds the document. The old default was the home directory itself, and the failure
was not cosmetic: the file tools are confined to the folder a Space points at, so
an install that never chose one was confined to everything the person owned, and
the header showed that as if it were a project. The starting folder is still
outside the user-data directory, so a reset leaves it standing — it holds the
person's files, not the app's — and the picker opens there rather than at home.

**The document is version 2 because the move must not happen twice.** A v1
document with exactly one folder whose path is the former home root is the app's
own seed, so the upgrade moves it to the starting folder **keeping the id**: the
session index files conversations by id, and replacing the entry would move every
chat to "Other chats". A label the person typed is kept; a list with more than one
folder, or a folder somebody chose, is untouched and only stamped. If the move had
no version marker it would run on every read, so a user who later re-added home as
their only Space would be moved away from it again. The upgrade also applies to a
`profiles.json` that predates `workspaces.json`, because adoption is the same
moment for that install.

**Which Space a new conversation lands in has three answers and one function.**
`AgentRuntime.spaceFor` takes the space the _caller_ named — the rail's "new chat
in this space" — else the agent's own, else wherever the rail is. The middle one
is what makes "my Writer drafts into the website repo" need no sentence in a
prompt: it is `spaceId` on the profile, said once in Settings, with `null` as the
way back to following the rail. It has to be optional, and that is not tidiness:
`ProfileStore.parseFile` skips a profile that fails its schema, so a required
field would quarantine every existing agent on upgrade. And a candidate naming a
space the document no longer holds is _skipped_ rather than stamped on, because
that id files the chat under "Other chats" — the rule a conversation whose folder
was removed already follows, and the reason it falls back rather than vanishing.

### A conversation is filed under the folder it works in

The folder is what an agent's file tools and shell are confined to, and
`memory.md` travels with it in `<folder>/.marimo/<agent>/`, so a project carries
its own remembered facts. What the rail does with the list — load one, rename it,
open it in your file manager, forget it — is the Space section above.

The folder a turn runs in is resolved **from the conversation**, at the moment
the turn starts, rather than from whichever folder the rail has current. That is
not a detail: opening a chat is a read, and a read that moved the working folder
would abort an answer that is still streaming — so a turn that began in one
project finishes there even if the user has since clicked around. The current
folder is only what a _new_ chat is filed under, and the fallback for a
conversation whose folder has been forgotten.

Forgetting a folder only forgets it. The directory, everything in it and every
conversation file are untouched, and the chats filed under it stay reachable
under "Other chats" until they are moved somewhere else. Conversations the app
started rather than the user — a Discord mention, once that connector is wired —
are listed under "Social" instead of inside a folder that had nothing to do with
them.

### A chat can hold several agents, and a delegation is a tool call

**A group chat is one conversation with more than one agent in it, and the lead is
first.** `agentIds` on the session index names them — declared in the schema
rather than left to `.passthrough()`, because a value nothing declares is dropped
on the next write — and the first is the lead: the one that answers a message
nobody addressed, and the one whose model and identity the conversation's own
bubbles are written with. A conversation with no such field is a chat with one
agent, which is every conversation that existed before it and most of them after.

**`@` addresses somebody, and the mention is kept.** A stored user message carries
no addressee, so stripping `@Writer` would leave a transcript in which nobody can
see whom the question was for; the renderer keeps the text and routes the turn
with an `agentId` of its own. An id that is not a participant is refused in a
sentence rather than answered by the lead, because a message that looks delivered
and is not is worse than a refusal. The addressed agent answers with its own
identity, tools and model, and its words are attributed to it: `MAIN_AGENT_NAME`
is the conversation's own agent, every other author is a profile id encoded into
something ADK accepts as an identifier, and the projection decodes it back into
`TranscriptMessage.agentId`. A change of author closes the bubble, which is what
stops one turn reading as one voice.

**`ask_agent` is the lead handing work to a named agent.** It resolves a name the
install has — an unknown name, an unknown Space and a blank task are all refusals
in words, never a throw, because a throw ends the parent's turn and turns "no such
helper" into "your request failed" — and the host builds the helper from that
profile, so it runs with its own identity, tools, skills, model and Space. Depth
is one by construction rather than by a number compared at runtime: the host
builds the helper _without_ this tool, so recursion is not something a model can
talk its way into. The bounds are 60 model turns, five minutes, 8,000 characters
with the cut stated, and three helpers per turn, because a helper is the one part
of a turn the user cannot watch closely, which makes it the part that most needs a
ceiling. Its steps reach the window as the ordinary `tool.started` and
`tool.finished` events, so its thread has work in it rather than a blank stretch
and then a paragraph, and its words arrive out of band — the parent's turn is
blocked inside the tool call, so its own generator cannot carry them.

**A helper's approval is the tool's own gate, and that is the discovery this
change is built on.** The obvious design, where the tool waits while the helper's
card is answered, cannot work. ADK ends the invocation at a gate, so the helper's
runner stops _inside_ the parent's tool call and the parent's call would sit there
with no result — an assistant message with an unanswered call, which every
provider refuses on the next request and not only that turn (invariant 3). So
`ask_agent` raises a card of its own through `requestConfirmation`, and the click
resumes _this_ tool. That is the one place the two sides can be joined: the card
the user answered belongs to this call, and the work that has to carry on belongs
to the helper.

The click then answers the helper's own gate rather than telling it the news. The
host reads the helper's unanswered gate out of the session — `gatesAskedBy`, which
is deliberately not the newest-invocation rule in `pendingGatesIn` — and sends ADK
the confirmation response for _that_ call; ADK binds it to the original call and
executes it. That is what makes the approved `write_file` actually run. A sentence
carrying only "the user approved" left the helper with no task and no pending
call, so it re-planned, re-proposed the write and the loop never converged; the
sentence now survives only as the fallback for a caller with no session to read,
and it carries the task with it.

The child's own gate stays in the log because it is the call the click resumes,
but it is not a second question. Once the parent's invocation is the newest,
`pendingGatesIn` reports only the parent's card. Treating an invocation id seen
before as the parent "resuming" and keeping its gates was the duplicate-card bug:
ADK gives a resume a new id, so what that kept was the child's dead card beside
the parent's live one.

### A Role is seeded, and a Persona is the person's

**The stored field is still `identity`, and the window calls it Role.** Renaming it
would be a document migration for a word the person never reads, and every existing
file already uses this one — the same decision `workspace`/Space makes. The Role is
the app's brief: what the bot is for, what it may claim, and the contract every bot
in this app has. `composeInstruction` puts it first. Blank is not a neutral default
and was never the answer: an agent with nothing said about whom it is for narrates
itself from whatever is left, and the person has no text to edit back to. So
`ProfileStore` seeds a new profile, and Settings' Role Reset is that same seed put
back.

**The Persona follows the Role, and it is the one piece of the prompt the person
owns.** It is `persona` on the profile: character, the job in their own words, and
how they want to be spoken to. It is sent after the Role so it wins the manner
conflicts that actually happen, and before the operating protocol so it cannot
license a claim that a tool ran or a capability the profile does not have. It is
never reset automatically; Settings offers the starter text as a replacement and
asks first. `preferences` — the old "How to talk to me" — is adopted into it on
read, under a heading if both exist, so an upgrade loses neither half. That is the
one layout decision in this section that is a _move_ rather than a rename: the two
fields had different owners, and one user-authored text is the simpler model the
person asked for.

**There are two seeds because there are two kinds of profile, and they are not
interchangeable.** `DEFAULT_AGENT_ROLE` / `DEFAULT_AGENT_PERSONA` are Marimo Bot, the
agent the person talks to; `botRoleFor(name, template)` / `botPersonaFor(template)`
are a bot they made. The difference matters because a prompt is a claim about what
the profile can do. A bot seeded with Marimo Bot's text would introduce itself as
Marimo Bot — the one confusion bots exist to avoid — and would be told to hand work
to other bots, which is an instruction it has no `ask_agent` to follow. What that
produces is silence in the tool log and a sentence in the transcript: a model
narrating a delegation it never made. So the bot's Role names the bot, says this
person made it and Marimo Bot hands it work, and asks it to write for the person —
what it did, what it could not, what it would need — and to name a permission it
lacks rather than work around it.

**The starter roles are data, and neither half names a tool.** `BOT_TEMPLATES` in
`packages/protocol/src/bots.ts` carries the Role, the first Persona, the grant and
the icon for Writer, Marketer, Researcher, Coder, Analyst and Personal assistant.
A Role that said "you can search the web" would be a prompt claiming a capability
the profile may not have; the capability skills already tell the model what its
tools are, and they follow the grant. The runtime narrows each template's tools
against the install before the window sees it, and filters again on create.

**`ProfileCatalog.roleSeeds` and `personaSeeds` carry the texts to the window.** The
two maps are separate because the buttons are: Role's Reset is safe to press, and
Persona's "use the starter text" replaces words only the person wrote. The renderer
holds neither: a window with its own copy could reset a bot to Marimo Bot, or to a
version the app never shipped, and look like the button working.

### A Space's documents are the markdown files in it

**There is no second store, and that is the feature.** `DocumentService` is built
over a root — the space's own folder, resolved from an id by the runtime — and its
library is the `.md` and `.markdown` files under it, so an agent's `write_file`
appears the moment the listing is re-read and what a person types in the editor is
what the agent reads next. Every call names a _space_ rather than a path, so a
window can only reach inside the folders the user loaded. Dot-directories are
skipped because one of them is the app's own `.marimo/<profile>/memory.md`, and
the rest of the skip list is the agent walk's own `SKIPPED_DIRECTORIES`: a second
list would be a second answer to which files are in this folder, and the
disagreement shows up as a document the agent cannot mention. Symlinks are skipped
for the reason the agent's walk skips them, and every path arrives through that
same `resolveInsideWorkspace`, so this module owns no second checker and `..`, an
absolute path and a symlink that leaves the space are one refusal.

**A revision guards every write, and the revision is size and modification time.**
The question a write has to answer is "has this changed since I read it", and both
are facts the filesystem already keeps; a hash would mean reading the whole file
in order to _write_ it, which is a strange price for a check that only has to be
right about a file somebody held open for a few seconds. The read returns the text
and its revision through one handle, because a stat followed by a read can be
separated by another writer's rename, and a revision from a file the caller never
saw would let their next save overwrite the one they did not see.

**A conflict is a value rather than an error, and nothing is written on that
path.** A file changing underneath the editor is not a failure of anything: the
person has a draft and the folder has a newer file, and the window has to offer a
choice rather than an apology. So the write answers with the revision actually on
disk, the drawer keeps the draft, and the two buttons are Reload (discards my
draft) and Overwrite with my draft — the second re-reading the fresh revision
first, so the force is not a race with whatever wrote it. A file that does not
exist is written only by a caller whose revision is the zero one, which is the
statement "I believe this is new". The write itself goes beside the document and
is renamed into place, so a crash leaves the original exactly as it was and a
`.tmp` nobody reads rather than half a file, and the temporary name carries no
markdown extension so it cannot appear in a listing while it lives.

**Two refusals sit beside the conflict, and both are the careful direction.** A
missing parent folder is never created: inventing a tree inside somebody's project
hides a mistyped or stale path, and the folder is theirs. A write over the read
cap is refused, because a document the editor cannot reopen is one this feature
produced and then lost. The listing's own caps — 500 files, eight levels — speak
when they stop rather than answering as if the folder ended there, which is
invariant 7 in a place where the alternative is a library that quietly lies about
what a Space holds.

**Saving a conversation writes a document too.** The chat is rendered as markdown
with each message under its author's name — a helper's words under the helper's —
and it refuses a name that is already taken, because saving a chat makes a
document, the alternative is quietly replacing one the user wrote, and a
conversation saved twice should be two files rather than one file with the first
version gone. The window then opens the file it made, so the thing just saved is
the thing that can be edited.

### The companion shares the conversation, not the manner

The floating moss ball is not a second agent. It reads and writes the same
thread the window does, through the same profile, tools and grants — so asking it
something and reading the answer in the window later is one conversation rather
than two that drift apart. What it does _not_ share is how long the answer should
be: a question asked over whatever you are working in wants the answer, and a
bookmarklet-sized bubble cannot hold a survey.

So "answer briefly" travels with the turn instead of living on the conversation.
The renderer says which surface asked, the runtime turns the settings into a
sentence, and the v2 turn stores it on `turn.started` and appends it to the
per-request prompt for that turn only — cleared on the way into the next one, so
a question asked at the pet does not make the window terse as well. It is prompt
text, like a skill, which is why changing it never aborts a turn in flight.

## Layout

```
packages/protocol   The typed contract. No Node, no Electron, no React.
packages/agent      The agent: ADK, the OpenAI-compatible client, tools, skills,
                    memory, sessions.
packages/runtime    Where files live, secrets, the stores, document versions,
                    the documents a Space holds, the recall engine, the OS
                    service plans.
apps/desktop
  src/main          Window, IPC, tray, the OS service, path and secret adapters,
                    the recall host, media decoding
  src/preload       The sandboxed bridge — the window's entire reach
  src/runner        The headless job runner
  src/renderer      The React UI, including the search panel, the documents
                    drawer and the group chat
  src/shared        Facts both entry points need, such as the product name
  scripts/smoke.mjs Boots a real window and proves the bridge and the UI work
```

## Data

Everything lives under the app's user-data directory — on Linux,
`~/.config/Marimo Bot`, which spent the app's whole life as `Marimo Agent` and was
moved to follow the name once, by `adoptFormerUserDataDir`.
`MARIMO_USER_DATA_DIR` relocates all of it,
which is how development, the tests and the smoke check keep their state out of
yours.

```
secrets/                one file per secret — a provider's key or a connector's,
                        encrypted unless the user asked for that one to be
                        readable by the background runner; without that ask, a
                        machine with no keychain is refused rather than written
                        readable
sessions/               one JSONL file per conversation, plus an index
memory/<profile>/       the half of memory that is about the *person*, plus the
                        dates of every remembered bullet — it lives under user
                        data because it has to outlive the folder
profiles.json           the agents: identity and capabilities
workspaces.json         the folders every agent can work in, and the current one
                        — version 2, the marker that the seeded home folder was
                        moved to the app's starting folder
jobs.json               scheduled jobs and how their last run went
settings.json           preferences and connectors
skills/<name>/SKILL.md  a procedure you wrote or copied in
memory-proposals.json   what the agent would remember, waiting for an answer
feedback.json           answers the user said were wrong, each naming the turn it
                        was about: the next review reads the words, the replay
                        reads the mark
trees/<session>.json    what the agent tried on each turn — only while the
                        recording is on, so an install that never turns it on
                        creates no directory at all
window-state.json       where the main window was left
companion-state.json    where the moss was left
recall.pid              the embedding engine, for the same reason
recall/                 the search index, when a profile has no folder to keep it in
app.lock                the running app, so the headless runner leaves the jobs alone
```

The other half of memory is the project's, and it is not here: it is
`<folder>/.marimo/<profile>/memory.md`, so a folder you put on a stick takes its
own remembered conventions with it and none of your personal facts.

A Space's documents are not in there either, and that is the point rather than an
omission. A document _is_ the markdown file in the folder the user loaded, so the
library and the editor are two views of their own directory: nothing is copied
into user data, and the only thing the app keeps about a file is the revision a
caller read — size and modification time — long enough to refuse a write based on
a version that is no longer there.

The recall model is in there too, under `model/recall/`: its engine, its weights
and a marker naming the engine asset they were unpacked from, so a build that
moves to a new llama.cpp re-fetches rather than misloading. It is downloaded
rather than bundled, which is why it lives beside the rest of the user's data
instead of inside the app — and why `MARIMO_MODEL_DIR` points one process at a
different copy, which is what a checkout and the live tests do.

Each store document carries a `version`, and a file written by a _newer_ build is
refused rather than overwritten — including the one holding your agents, which is
the reason the rule exists. A file that cannot be read is moved aside rather than
replaced, so a parse bug is never the end of your data. The exceptions are the two
geometry files, the secret files and the search index: geometry is rewritten every
time a window moves, a secret says in its own prefix whether it is encrypted, and
the index is rebuilt from the folder it describes rather than being the only copy
of anything.

**The settings file is the exception that proves it.** It has never carried a
version, so every settings file in existence looks like an older format; treating
that as "not mine" would reset everybody's connectors and preferences on upgrade.
It names its version explicitly, and stamps one from the next write on. A file
written by a build that had the provider catalogue still loads: the fields this
build no longer knows are ignored, and every preference beside them survives.

**Reset Marimo Bot erases this folder, and the folder is the unit.** The card at the
bottom of Settings — behind a typed phrase, because it cannot be undone — stops
the agent, takes the OS timer and the start-at-login switch down, empties the
user-data directory and quits. It does not start the app again: everything it
deleted would otherwise be written back out of the memories of the running
process, and a fresh install left sitting in the tray reads as a reset that never
happened. The person opens Marimo Bot again and meets the first-run screen.
`resetInstall` enumerates that directory's contents rather than naming a list of
documents, and that is the design: a list would have to be kept true as stores are
added, and the way a stale one fails is one file surviving a factory reset, in
silence. Two things are therefore safe by construction instead of by care — the
folders the user loaded, and the weights `MARIMO_MODEL_DIR` points elsewhere —
because neither is under that directory; the starting folder is `<home>/Marimo`,
outside it too, because its files are the person's and a factory reset that took
them would be worse than one that left the app's own cache behind. The function
only ever enumerates the one path it was given. It sweeps twice, because a writer
can put a file back mid-sweep: a
`settings.json` that comes back is read by the next launch as a current file, so
the first-run screen never appears and the reset has undone itself invisibly. The
app sweeps once more after the pause that lets the window paint, immediately
before the exit, which is the same rule from the other end — the process has to
end, because every store reads its document once and keeps the answer.

## Status and next steps

Everything in the M0–M8 plan is built, and recall landed after it. What is left is
verification rather than construction — the two installers above that cannot be
produced from Linux, and code signing, which needs certificates.

Known gaps, stated plainly:

- **No auto-update.** A release is a file you download again.
- **A `.deb` is not built.** It needs a `homepage` in its metadata and this
  project has no published URL; the AppImage is self-contained and runs anywhere.
- **Discord and the notes/to-do desk are not wired into the app.** The tools and
  the schemas are there and the settings schema still carries the fields, but
  nothing in the window configures them, so they are unreachable. They are
  scheduled for nothing — somebody should either wire them or remove them.
- **Vulkan is the only GPU backend pinned, and the recall engine barely uses it.**
  macOS's Metal needs no choice. CUDA and ROCm exist upstream and are not pinned:
  Vulkan is 32 MB and covers NVIDIA, AMD and Intel from one asset per platform,
  while the Windows CUDA build is 264 MB and needs a further 391 MB of cudart
  DLLs. Adding one later is an asset in `pins.ts` and nothing else. The engine is
  started with no GPU offload anyway — see `args.ts` for why this model wants the
  f32 CPU path — so the graphics backend in the archive is mostly there because
  that is how llama.cpp publishes a build with a CPU backend in it.
- **The recall download is verified but not signed.** Each file is checked against
  a sha256 pinned in the app, which catches a corrupted or substituted download
  over a hostile network only as far as the pin itself is trusted — there is no
  signature chain behind it. Nothing else is downloaded at all.
- **The `.deb` and the two installers** need a platform each; see the table
  above for what is verified and what is not.

## Building a release

```bash
pnpm --filter @marimo/desktop package       # Linux AppImage
pnpm --filter @marimo/desktop package:win   # Windows NSIS installer
pnpm --filter @marimo/desktop package:mac   # macOS DMG
pnpm --filter @marimo/desktop package:dir   # unpacked, no installer
```

All four are plain builds. They used to fetch the model first and copy ~1.1 GB of
weights into the app's resources, with `MARIMO_SKIP_MODEL=1` as the escape hatch
CI needed; then a first run downloaded a pinned model instead. Now there is no
chat model anywhere in the chain, so there is nothing to fetch and no variable to
remember. A packaged app ships an app that asks which service should answer, which
is also the state a checkout is in and the state the smoke check runs in.

Each is built on its own platform in the normal way. What has actually been
verified, and where:

| Target          | State                                                                                        |
| --------------- | -------------------------------------------------------------------------------------------- |
| Linux AppImage  | **Built and run.** Both windows open, the bridge answers, and the packaged runner exits 0.   |
| Windows `--dir` | **Packages.** `marimo-agent.exe` and a converted `.ico`, built from Linux.                   |
| Windows NSIS    | Not built. Needs Wine on Linux, macOS to sign. Config is written; the installer is unproven. |
| macOS `.app`    | **Packages**, with a converted `.icns`, built from Linux.                                    |
| macOS DMG       | Not built. Needs `sips`, which is macOS-only.                                                |
| Code signing    | Not configured. Needs certificates, and they are the maintainer's to buy.                    |

**`asar` is off, and that is deliberate rather than an oversight.**
electron-builder warns about it and suggests `asarUnpack` instead. It cannot be
used here: the job runner is this same binary started with
`ELECTRON_RUN_AS_NODE=1`, and in that mode Electron does not patch `fs` to read
inside an asar archive — a script inside one fails with `Invalid package`. So a
packaged app with `asar` on has a background runner that cannot start, which is
the whole of "jobs run while the app is closed" broken in every release while
working perfectly in development. `asarUnpack` would mean enumerating every
transitive dependency of the runner, which is a list that goes stale silently.

## Licence

Apache-2.0. See [LICENCE](./LICENCE) and [NOTICE](./NOTICE).
