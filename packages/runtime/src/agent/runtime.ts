/**
 * The agent, running.
 *
 * One object that owns everything a turn needs — the settings, the profiles, the
 * skills, the tools, and one `AgentHost` per profile — so that both processes can
 * have an agent without either of them owning the wiring.
 *
 * That "both processes" is the point. The window hosts this in the Electron main
 * process; the headless job runner hosts the same class in a plain Node process
 * with no `app`, no window and no display. The only difference is what the caller
 * supplies: the window passes a `safeStorage`-backed secret reader and a browser
 * for web search, and the runner passes the plain-text reader and nothing else.
 * Neither difference is visible from here.
 *
 * A host is kept per profile rather than rebuilt per turn, because it holds the
 * session service and the conversation state. What *is* rebuilt — the cached ADK
 * runner inside it — happens when the configuration actually changed, decided by
 * a cheap signature rather than by rebuilding every time: a runner built per turn
 * would re-read every skill and rebuild every tool on every message, and a
 * settings change that arrived mid-turn would abort the turn the user is
 * watching.
 */
import {rm} from 'node:fs/promises';
import {dirname} from 'node:path';

import {
  AgentHost,
  ASK_AGENT_TOOL,
  capabilityPresets,
  describeTools,
  MAX_MEMORY_BYTES,
  MemoryStore,
  resolvePersonMemoryFile,
  runReview,
  SAFE_DEFAULT_TOOLS,
  SKILLS,
} from '@marimo/agent';
import type {
  AgentConfig,
  DelegationResult,
  DeskService,
  DiscordService,
  JobService,
  RecallLookup,
  McpToolsetSource,
  PendingGate,
  Skill,
  WebSearchProvider,
} from '@marimo/agent';
import {
  availableBotTemplates,
  botPersonaFor,
  botRoleFor,
  botTemplateById,
  BOT_AVATAR_PRESETS,
  DEFAULT_AGENT_PERSONA,
  DEFAULT_AGENT_ROLE,
  DEFAULT_DREAM_KEEP_LOGS,
  DEFAULT_DREAM_RESULT_BYTES,
  DRAFT_BOT_TOOL,
} from '@marimo/protocol';
import type {BotDraft, ProviderId, SessionPurpose} from '@marimo/protocol';
import type {
  AgentModel,
  AgentProfile,
  AgentUiEvent,
  CatalogEntry,
  CompactResult,
  DismissedMemory,
  DocumentRead,
  DocumentRevision,
  DocumentWrite,
  FeedbackEntry,
  McpServer,
  MemoryProposal,
  MemoryProvenanceEntry,
  MemorySupersede,
  MemoryUsage,
  TranscriptMessage,
  ProfileCatalog,
  ProfilePatch,
  SessionSummary,
  SettingsPatch,
  SkillDraft,
  SkillHistoryEntry,
  StoredSettings,
  StoredSkill,
  Workspace,
  WorkspaceState,
} from '@marimo/protocol';
import {reviewDelay} from '@marimo/agent';

import type {AppPaths} from '../paths.js';
import {avatarFile} from '../paths.js';
import {DocumentService} from '../documents.js';
import {DreamStore} from '../dream-store.js';
import {ProfileStore} from '../profiles.js';
import type {ProfileFile} from '../profiles.js';
import {FeedbackStore} from '../feedback.js';
import {MemoryProposalStore} from '../memory-proposals.js';
import type {SecretRead} from '../secrets.js';
import {SettingsStore} from '../settings.js';
import {SkillStore} from '../skills.js';
import {RuntimeSkillService} from '../skill-service.js';
import {WorkspaceStore, workspaceRootFor} from '../workspaces.js';
import {resolveAgentConfig} from './resolve.js';
import {HarnessRuntime} from './harness-runtime.js';
import {HarnessVersionStore} from '../harness-versions.js';
import {BOT_BUILDER_INSTRUCTION} from './bot-builder.js';
import {turnInstruction} from './pet-turn.js';
import {turnContext} from './turn-context.js';

/** The services the app has that the agent's tools can use, if any. */
export interface RuntimeServices {
  jobService?: JobService;
  deskService?: DeskService;
  discordService?: DiscordService;
  /**
   * Recall, when this install has it switched on.
   *
   * **One instance per profile, for the life of the process.** The host drops its
   * cached runner whenever this changes identity, because a runner holds the tool
   * closures it was built with — so a supplier that built a new object per call
   * would rebuild the agent on every turn. It is the same rule the model and the
   * MCP connections follow: stable things are handed in, changing things are
   * notified.
   */
  recallService?: RecallLookup;
}

export interface AgentRuntimeOptions {
  paths: AppPaths;
  /** Present in the window, absent in the runner, which has no browser. */
  webSearch?: WebSearchProvider;
  /**
   * Reads one provider's key, already decrypted by the process that owns the
   * keychain.
   *
   * A function rather than a store, because the cipher is injected and the two
   * processes answer differently: the window has `safeStorage`, and the headless
   * runner has none — so a key stored for the runner is read by the runner and an
   * encrypted one comes back `unreadable`, with a sentence the caller can show.
   * Neither answer belongs in this file.
   */
  readSecret: (provider: ProviderId) => Promise<SecretRead>;
  /**
   * The rest of the app's tools, resolved per profile and folder.
   *
   * The folder is passed because recall's index lives inside it — a service
   * derived from one folder is the wrong service for another, and asking the app
   * to remember what the runtime last asked for would be a second copy of a fact
   * this function already has.
   *
   * May be asynchronous: the supplier reads a setting to decide whether recall
   * exists at all, and a callback that had to be synchronous would push that read
   * into whoever assembled the store.
   */
  services?: (
    profileId: string,
    workspaceRoot?: string,
  ) => RuntimeServices | Promise<RuntimeServices>;
  /**
   * The MCP servers that are connected right now.
   *
   * A function rather than a list because servers connect and drop while the app
   * runs, and a turn must be offered what is reachable at that moment rather than
   * what was reachable when the runtime was built.
   */
  mcpServers?: () => readonly McpToolsetSource[];
  /**
   * Where a helper's words go while the turn that asked for it is suspended.
   *
   * Out of band, because a tool call cannot yield into the stream that is
   * awaiting it: the turn is blocked inside `ask_agent`, so its own generator
   * cannot carry anything to the window until the helper has finished. The window
   * draws these as a labelled group inside the turn. The headless runner passes
   * nothing and simply does not have this view.
   */
  onEvent?: (event: AgentUiEvent) => void;
  appName?: string;
  /**
   * The recall engine, so the app can stop it on the way out.
   *
   * Only `stop`: whether it is running, and what it is doing, is the window's
   * business — this package starts nothing and describes nothing, and a runtime
   * that carried a status type would be a second place that could disagree about
   * which engine is up.
   */
  recall?: {stop: () => Promise<void>};
}

/** Either a host ready for a turn, or the sentence explaining why not. */
export type HostResult =
  | {ok: true; host: AgentHost; profile: AgentProfile}
  | {ok: false; problem: string};

export class AgentRuntime {
  /** The v2 turn path, built lazily so an install that never uses it pays nothing. */
  private harnessRuntime: HarnessRuntime | undefined;
  /** The frozen specs every v2 turn has run under, by hash. */
  private readonly harnessVersions: HarnessVersionStore;
  private readonly settingsStore: SettingsStore;
  private readonly profileStore: ProfileStore;
  /**
   * The folders every agent works in.
   *
   * Built from the profiles store's legacy fields when the document does not
   * exist yet: a `profiles.json` written before folders were install-wide holds
   * the only copy, and it is handed over here so the two stores never disagree
   * about which folders exist.
   */
  private readonly workspaceStore: WorkspaceStore;
  private readonly skillStore: SkillStore;
  /**
   * The user's skills, and the grants that switch them on.
   *
   * A field rather than a service handed in by the app, because a skill is always
   * possible: the folder exists, the store reads it, and the only question is
   * which profile carries which name. That is the lesson `save_skill` taught on
   * another branch — a capability with a slot an app can forget to fill is a
   * capability every unit test has and no install does.
   */
  private readonly skillService: RuntimeSkillService;
  /** The agent's suggestions, waiting for an answer. */
  private readonly proposals: MemoryProposalStore;
  /** What the user said about the agent's own answers. */
  private readonly feedbackStore: FeedbackStore;
  private readonly hosts = new Map<string, AgentHost>();
  /** The configuration each host was last built with, so changes are noticed. */
  private readonly applied = new Map<string, string>();
  /**
   * The discovery trees, when the user has Dream-RSI on.
   *
   * Built unconditionally and asked for nothing until a config enables it, which
   * is the shape the recall service has from the other side: the *store* costs a
   * path join, while the capability does not exist until a setting says so. Were
   * it built inside the settings read instead, the object a host holds its sink
   * from could change identity between one turn and the next.
   */
  private readonly dreamStore: DreamStore;
  /**
   * The tree cap, as of the last settings read.
   *
   * Cached because the store asks for it on every write and the answer comes from
   * a settings document that is already being read once per turn. A field rather
   * than a second read, so a turn's writes cannot disagree with the config that
   * turn is running under.
   */
  private cachedDreamKeepLogs = DEFAULT_DREAM_KEEP_LOGS;
  private cachedDreamResultBytes = DEFAULT_DREAM_RESULT_BYTES;

  constructor(private readonly options: AgentRuntimeOptions) {
    this.harnessVersions = new HarnessVersionStore({
      rootDir: options.paths.harnessVersions,
    });
    this.settingsStore = new SettingsStore(options.paths.settings);
    this.dreamStore = new DreamStore({
      dir: options.paths.dreamDir,
      // Read per write rather than captured at construction: a user who lowers
      // the cap in Settings should have the next turn's write trim the file, not
      // the next launch.
      keepLogs: () => this.cachedDreamKeepLogs,
    });
    this.profileStore = new ProfileStore({
      file: options.paths.profiles,
      /*
       * Two seeds, because there are two kinds of profile and the texts are not
       * interchangeable. `freshFile` makes the first one at install — the lead,
       * the agent the person talks to — and `DEFAULT_AGENT_ROLE` /
       * `DEFAULT_AGENT_PERSONA` describe exactly that one. Every profile
       * `create` makes afterwards is a bot, and its Role and Persona are
       * resolved from the starter role the person chose.
       *
       * A bot handed the lead's text is the defect these two exist to prevent:
       * it introduces itself as Marimo Bot — the one thing the bots feature is
       * built so that a user never sees — and it is told to hand work to bots,
       * which it has no `ask_agent` to do.
       *
       * Both are seeded rather than left blank because an agent with no stated
       * idea of who it is for narrates itself from whatever is left, and the
       * user has no text to edit back to. The Role stays editable and Reset puts
       * the seed back; the Persona is the person's and is never reset
       * automatically.
       */
      defaultRole: DEFAULT_AGENT_ROLE,
      defaultPersona: DEFAULT_AGENT_PERSONA,
      /*
       * A brand-new profile starts with no capabilities: every one of those is
       * something the user turns on, which is the whole shape of this app. What
       * it does start with is the safe core below — a fresh install can read,
       * remember and search; writing, running commands, fetching an arbitrary
       * URL and spawning helpers are all granted deliberately.
       *
       * The list lives beside the tools themselves so a rename cannot leave it
       * naming something that no longer exists — which would fail silently, as a
       * capability that is simply never offered.
       */
      defaultTools: [...SAFE_DEFAULT_TOOLS],
      /*
       * And no *user* skills, which is all this list can name.
       *
       * The app's own prompt is not gated here: the operating protocol is
       * unconditional and the memory and knowledge skills follow the tools just
       * granted, so a fresh agent carries the app's rules without anyone having
       * to switch them on. This empty list means "no `/learn` skills of mine",
       * which is the only thing a profile's `enabledSkills` decides.
       */
      defaultSkills: [],
    });
    this.workspaceStore = new WorkspaceStore({
      file: options.paths.workspaces,
      defaultWorkspaceRoot: options.paths.defaultWorkspace,
      /*
       * Where a build before this one seeded the only folder. The store's v1
       * upgrade moves it to `defaultWorkspace` when it is still the single
       * entry, keeping its id so every conversation stays filed.
       */
      formerDefaultWorkspaceRoot: options.paths.formerDefaultWorkspace,
      /*
       * The folders a pre-workspaces profiles file holds, read through the
       * profile store rather than by parsing that file a second time: it is the
       * same document, and two parsers for it is two chances to disagree.
       */
      adoptLegacy: async () => {
        const legacy = await this.profileStore.legacyWorkspaces();
        if (legacy === undefined) {
          return undefined;
        }
        const workspaces = legacy.flatMap((entry) => entry.workspaces);
        const active =
          legacy.find((entry) => entry.activeWorkspaceId !== null)
            ?.activeWorkspaceId ?? null;
        return {workspaces, activeWorkspaceId: active};
      },
      // Only after the document holding them exists, so a crash in between
      // leaves the folders where they were.
      onAdopted: async () => {
        await this.profileStore.clearLegacy();
      },
    });
    this.skillStore = new SkillStore({
      root: options.paths.skills,
      legacyFile: options.paths.legacySkills,
      /*
       * The names the app ships. A user skill may not take one, because the name
       * is a heading in the same prompt and `composeInstruction` would give it to
       * the built-in — a saved `memory` would be carried but never sent. Passed
       * in rather than imported by the store, so the store stays about the folder.
       */
      reserved: SKILLS.map((skill) => skill.name),
    });
    /*
     * No host is dropped when a *grant* changes. `enabledSkills` is not part of
     * the tool list a host is built with: the prompt's available-skills list is
     * recomputed from it on every turn, and the library reads it again on every
     * load. Dropping the host here would be dropping it during the very turn
     * that asked to save a skill.
     */
    this.skillService = new RuntimeSkillService({
      skills: this.skillStore,
      profiles: this.profileStore,
    });
    this.proposals = new MemoryProposalStore({
      file: options.paths.memoryProposals,
    });
    this.feedbackStore = new FeedbackStore({file: options.paths.feedback});
  }

  /** The settings as they are on disk right now. */
  async settings() {
    return await this.settingsStore.load();
  }

  /**
   * What this install can offer, so the settings screen builds its pick-lists
   * from what exists rather than from a list typed out a second time.
   *
   * Not per profile: the tools are the install's, the folder they are described
   * against is the current one, and which of them an agent may use is a grant on
   * the profile rather than a difference in the catalogue. It used to take a
   * profile id, back when each profile named its own folder.
   *
   * The tools are described by *constructing* them, which is the only way the
   * wording is guaranteed to be the wording the model is given — and the only
   * way a renamed tool cannot go on being offered under its old name, which
   * would grant nothing when ticked.
   */
  async catalog(): Promise<ProfileCatalog> {
    const workspaces = await this.workspaceStore.load();
    const workspaceRoot =
      workspaceRootFor(workspaces) ?? this.options.paths.defaultWorkspace;
    const settings = await this.settingsStore.load();
    /*
     * Read for the Reset seeds below, and allowed to fail.
     *
     * `ProfileStore.load()` refuses a document from a newer build rather than
     * emptying it, which is right, and it means this read can throw. Nothing else
     * here is about the profiles — the tools, the Spaces, the connectors and the
     * presets come from other documents — so the seeds are the one thing that
     * should go missing. A Settings page that lost all five cards because the
     * bots file was unreadable would be a worse answer than five cards with their
     * Reset buttons disabled and the profile card saying what is wrong.
     *
     * On a *first* read the folders adoption reaches the same file and throws
     * before this line (see `adoptLegacy`), which is older behaviour and not this
     * call's business: by then the workspace document exists, and this is the
     * only remaining way the profiles are read at all.
     */
    const profiles = await this.profileStore.profiles().catch(() => []);

    /*
     * The catalogue is drawn for the *app's* provider rather than for whichever
     * agent is selected, and that is the honest answer to what this call asks:
     * it is what this install could offer, and an agent's own model is a choice
     * made inside that. The one tool it decides is `GOOGLE_SEARCH`, which a
     * Gemini agent gets and the catalogue would not have listed — so it is listed
     * whenever the app's own provider is Gemini, and an agent pointed at Gemini
     * while the app is on DeepSeek is the one case where the switch is missing.
     */
    const provider = settings.providers.active;
    const tools = describeTools({
      workspaceRoot,
      model: settings.providers.configs[provider].model,
      provider,
      ...(this.options.webSearch ? {webSearch: this.options.webSearch} : {}),
      /*
       * The switch for recall exists exactly when recall does, which is the rule
       * the comment below is about: a tool the host builds but the catalogue omits
       * can never be granted, and one the catalogue lists but the host cannot
       * build grants nothing when it is ticked.
       */
      ...(settings.recall.enabled ? {recall: true} : {}),
      /*
       * And the helper tool, which this install always has: `ensureHost` hands
       * every host the delegation seam, because whether it can resolve a name is a
       * fact about the profile store rather than about a setting. A catalogue that
       * omitted it would be a capability with no switch — granted by the preset
       * and unswitchable in Settings, which is the failure the comment below is
       * about, in the direction that hides it.
       */
      delegate: true,
      /*
       * And every service this app wires, named explicitly. A tool the host
       * builds but the catalogue omits can never be granted — the switch for
       * it does not exist — so the two have to be kept in step, and the test
       * beside this file compares them.
       */
      jobs: true,
      /*
       * And the skill writer, which this install always has. Its off-by-default
       * switch is the grant in the profile, not the existence of the service:
       * `save_skill` changes prompt text on every later request, so a bot that
       * may write one is a decision the person makes rather than one the install
       * makes for them.
       */
      skills: true,
    });

    return {
      tools,
      skills: await this.skillCatalog(),
      /*
       * The spaces the install has, for the "works in" picker beside an agent.
       * Read from the document the rail reads rather than from a copy, so a
       * space the user just added is offerable without anything having to be
       * told about it.
       */
      spaces: workspaces.workspaces,
      /*
       * Every connector the install has, switched on or not, drawn from the
       * settings document rather than from the manager's connections. That is the
       * rule the recall switch follows and the reason is the same: a grant screen
       * has to exist *before* the server is reachable, or a connector that cannot
       * be dialled yet — a wrong command, a secret the runner cannot read — is
       * one nobody can decide about. A manager consulted here would answer "no
       * connectors" on the very install that needs the switches most.
       */
      connectors: settings.mcpServers.map((server) => ({
        id: server.id,
        name: server.name,
        blurb: connectorBlurb(server),
        enabled: server.enabled,
      })),
      /*
       * The same tools in three sizes, narrowed to the ones this install has.
       * The narrowing happens here rather than in the window so that whichever
       * screen offers a preset can write the list it was handed, and a name no
       * tool answers to never reaches a profile.
       */
      presets: capabilityPresets(tools.map((tool) => tool.name)),
      /*
       * The starter roles, narrowed the same way. A card that offered a tool
       * this build does not carry would be a choice that grants nothing.
       */
      botTemplates: availableBotTemplates(tools.map((tool) => tool.name)),
      /*
       * And the two tools the setup flow grants by name, carried the same way
       * the presets are: the names belong to the agent package, and a window
       * with its own copy of a string would grant a name nothing answers to.
       * Named here only when the narrowed tool list actually holds them.
       */
      ...(tools.some((tool) => tool.name === ASK_AGENT_TOOL)
        ? {delegationTool: ASK_AGENT_TOOL}
        : {}),
      ...(tools.some((tool) => tool.name === DRAFT_BOT_TOOL)
        ? {builderTool: DRAFT_BOT_TOOL}
        : {}),
      /*
       * What the two Reset buttons put back, per profile. The lead is the *first
       * profile in the document* — the one `freshFile` created at install — and
       * it is the only one `DEFAULT_AGENT_ROLE` / `DEFAULT_AGENT_PERSONA` were
       * written for; every other profile is a bot, seeded from its starter role
       * or from its own name. Delete the lead and the next first profile becomes
       * the lead, which is exactly what the seeding rule already does for it, so
       * this stays a fact about position rather than about an id that could go
       * stale.
       *
       * The two maps are separate because the buttons are: Role's Reset is safe
       * to press, and Persona's "use the template text" is the one that replaces
       * words the person wrote.
       */
      roleSeeds: Object.fromEntries(
        profiles.map((profile, index) => [
          profile.id,
          index === 0
            ? DEFAULT_AGENT_ROLE
            : botRoleFor(profile.name, botTemplateById(profile.templateId)),
        ]),
      ),
      personaSeeds: Object.fromEntries(
        profiles.map((profile, index) => [
          profile.id,
          index === 0
            ? DEFAULT_AGENT_PERSONA
            : botPersonaFor(botTemplateById(profile.templateId)),
        ]),
      ),
    };
  }

  /** The skills a profile can be granted: the ones that ship, plus the user's. */
  private async skillCatalog(): Promise<CatalogEntry[]> {
    const stored = await this.skillStore.load();
    return stored.map((skill) => ({
      name: skill.name,
      description: skill.description,
    }));
  }

  /**
   * Changes a preference.
   *
   * Hosts are dropped when the change is one an agent was built around — how
   * literal its wording is, whether it may fetch from the private network — so
   * the next turn is built from what the settings now say rather than from what
   * they said when the host was made.
   *
   * The model used to be in that list, and it cannot be any more: there is one
   * model, so nothing a settings write can do changes what a host is built with.
   */
  async updateSettings(patch: SettingsPatch): Promise<StoredSettings> {
    const before = await this.settingsStore.load();
    const after = await this.settingsStore.patch(patch);

    const rebuild =
      before.maxOutputTokens !== after.maxOutputTokens ||
      before.allowPrivateNetworkFetch !== after.allowPrivateNetworkFetch;

    if (rebuild) {
      for (const profileId of [...this.hosts.keys()]) {
        this.dropHost(profileId);
      }
    }
    return after;
  }

  async updateProfile(
    profileId: string,
    patch: ProfilePatch,
  ): Promise<AgentProfile> {
    /*
     * A profile whose tools changed has a host holding the old tool set, so the
     * host is dropped rather than updated. It is rebuilt with the new grant on
     * the next turn, which is the same path a first turn takes — a cheaper and
     * better-tested route than pushing a new tool list into a live agent.
     */
    const updated = await this.profileStore.update(profileId, patch);
    this.dropHost(profileId);
    return updated;
  }

  /**
   * Makes a bot from the draft the person reviewed, and nothing else.
   *
   * The draft is allowed to be empty: that is the blank bot Settings has always
   * made. Everything the card did not decide is filled here from the starter
   * role or from the defaults, and the tools are filtered against what this
   * install actually has — a draft naming a tool this build does not carry must
   * grant nothing rather than store a name the host will silently drop.
   *
   * The Role is handed to the store as a function of the name because the store
   * is what makes a duplicate unique; see `NewProfileSeed`.
   */
  async createProfile(
    draft: BotDraft = {},
    sourceCallId?: string,
  ): Promise<AgentProfile> {
    const template = botTemplateById(draft.templateId);
    const catalog = await this.catalog();
    const available = new Set(catalog.tools.map((tool) => tool.name));
    const requested = draft.tools ?? template?.tools ?? [...SAFE_DEFAULT_TOOLS];
    const tools = [...new Set(requested)].filter((name) =>
      available.has(name),
    );
    const avatarId = draft.avatar ?? template?.avatar;
    const avatar = BOT_AVATAR_PRESETS.some((preset) => preset.id === avatarId)
      ? {kind: 'preset' as const, id: avatarId as string}
      : undefined;
    /*
     * Absent and empty are different answers here. Absent is a caller that
     * decided nothing — the step-by-step and starter forms — so the seed
     * applies. An empty string is somebody who cleared the box in the review
     * card, and storing the seed over that would be the app overruling them.
     */
    const persona = draft.persona;
    const name = draft.name ?? template?.suggestedName;
    return await this.profileStore.create({
      ...(name === undefined ? {} : {name}),
      role: (resolved) => botRoleFor(resolved, template),
      ...(persona === undefined ? {persona: botPersonaFor(template)} : {persona}),
      tools,
      ...(avatar === undefined ? {} : {avatar}),
      ...(template === undefined ? {} : {templateId: template.id}),
      ...(sourceCallId === undefined ? {} : {createdFromCall: sourceCallId}),
    });
  }

  async selectProfile(profileId: string): Promise<AgentProfile> {
    return await this.profileStore.select(profileId);
  }

  /**
   * Removes a bot, and everything the app kept for it.
   *
   * The order is the point of this method, and it is the reverse of the obvious
   * one. **The refusal comes first**, because a bot that turns out to be the last
   * one must be refused before anything of its is destroyed — and the profile
   * write can also refuse for a file from a newer build. Everything after it is
   * cleanup of things already doomed:
   *
   * - the conversations, through the host, which rewrites the index once for all
   *   of them and drops each from the recall index on the way out;
   * - their discovery trees, which must not outlive the user's ability to see the
   *   conversations they are about;
   * - the proposals, refusals, corrections and the person's half of memory — all
   *   keyed by a profile id that nothing will name again, so leaving them is
   *   keeping records about the user that no screen can show them;
   * - and the profile itself.
   *
   * What is deliberately *not* here: the memory files a bot kept inside a Space.
   * Those live in the user's own folder (`.marimo/<profile>/`), which this app
   * only visits, and removing a bot from the roster is not a request to delete
   * work inside somebody's project. The confirmation in Settings says so.
   */
  async removeProfile(profileId: string): Promise<ProfileFile> {
    await this.profileStore.assertRemovable(profileId);

    const file = await this.profileStore.remove(profileId);

    /*
     * After the profile write, so a refusal above leaves the bot whole. The host
     * is asked for the id rather than resolved from the profile — it holds the
     * session service, and deleting a conversation has never needed a profile to
     * exist.
     */
    const host = await this.ensureHost(profileId);
    const conversations = await host.deleteSessionsForProfile(profileId);
    for (const sessionId of conversations) {
      await this.dreamStore.forget(sessionId);
      await this.proposals.forget(sessionId);
    }
    await this.proposals.forgetProfile(profileId);
    await this.feedbackStore.forgetProfile(profileId);

    /*
     * The person's half of memory, by directory: it is exactly this profile's
     * own folder under `memory/`, so nothing another bot remembers is in reach of
     * the removal.
     */
    const memoryDir = dirname(
      resolvePersonMemoryFile(this.options.paths.personMemoryDir, profileId),
    );
    await rm(memoryDir, {recursive: true, force: true});

    /*
     * And the picture. It is the one file that exists only for this bot and is
     * not in a store keyed by it, so nothing else would remove it; a missing
     * file is the ordinary case for a bot that never had one, and is not worth
     * failing a removal that has already happened.
     */
    await rm(avatarFile(this.options.paths, profileId), {force: true});

    this.dropHost(profileId);
    return file;
  }

  /**
   * Reads a conversation back and proposes what is worth remembering.
   *
   * Answers what it added, so a caller can say so. Does nothing at all when the
   * agent cannot be built — a review is a background nicety, and an
   * unconfigured install has nothing to review *with*.
   *
   * The watermark is moved whether or not anything was found. That is the
   * difference between a feature and a nuisance: "I looked and found nothing" is
   * the answer most of the time, and not recording it means looking again on
   * every idle moment, forever.
   */
  async reviewMemory(
    profileId: string,
    sessionId: string,
  ): Promise<MemoryProposal[]> {
    const profile = await this.profileFor(profileId);
    if (profile === undefined) {
      return [];
    }
    /*
     * The same host a turn would get: the review reads the memory of the folder
     * this conversation works in, so what it proposes belongs to the project the
     * conversation is about.
     */
    const resolved = await this.host(profileId, sessionId);
    if (!resolved.ok) {
      return [];
    }
    const host = resolved.host;

    /*
     * The watermark counts final events, so the slice has to be taken from the
     * same list it was counted against — not from the raw log, where an event
     * still being written would shift every index after it.
     */
    const reviewable = (await host.eventsFor(sessionId)).filter(
      (event) => event.partial !== true,
    );
    const from = await this.proposals.reviewedUpTo(sessionId);
    if (reviewable.length <= from) {
      // Nothing new since last time. Not asking is the common case and the
      // reason the watermark exists.
      return [];
    }

    const memory = await host.memoryText();
    /*
     * What this agent has already been told no about. Read from the same document
     * the proposals live in, so a refusal and the queue it came from cannot
     * disagree — and scoped to the profile, because a fact refused in one agent's
     * conversation is not a refusal by the person in another's.
     */
    const refused = (await this.proposals.load()).dismissed
      .filter((entry) => entry.profileId === profileId)
      .map((entry) => ({text: entry.text}));
    /*
     * And what the user said about the agent's own answers. Newest last, and read
     * from this profile's entries only: one agent being told it was wrong about a
     * deployment is not a fact about the other one.
     */
    const corrections = (await this.feedbackStore.forProfile(profileId)).map(
      (entry) => ({excerpt: entry.excerpt, text: entry.correction}),
    );
    /*
     * Only what has not been read before, and only as much of it as one look
     * covers. `used` is what the look actually reached, which is what the
     * watermark may move past: a conversation longer than the cap drains over
     * successive looks instead of having its beginning marked read unread.
     */
    const found = await runReview({
      events: reviewable.slice(from),
      memory,
      refused,
      corrections,
      ask: async (prompt) => await host.ask(prompt),
    });

    const recorded = await this.proposals.record(
      sessionId,
      from + found.used,
      found.proposals.map((proposal) => ({
        sessionId,
        profileId,
        section: proposal.section,
        text: proposal.text,
        reason: proposal.reason,
        ...(proposal.replaces === undefined
          ? {}
          : {replaces: proposal.replaces}),
      })),
    );

    // The ids the store assigned, so the window can act on them.
    const added = new Set(found.proposals.map((proposal) => proposal.text));
    return recorded.proposals.filter((proposal) => added.has(proposal.text));
  }

  /** The suggestions waiting for this agent. */
  async memoryProposals(profileId?: string): Promise<MemoryProposal[]> {
    const file = await this.proposals.load();
    return profileId === undefined
      ? file.proposals
      : file.proposals.filter((proposal) => proposal.profileId === profileId);
  }

  /**
   * How full this agent's memory is, for the size control in Settings.
   *
   * The file size comes from the agent's own store when one is live, so the bar
   * and the agent's warning are measuring the same file. The *limit* comes from
   * settings rather than from the host: a host is handed its configuration at the
   * start of a turn, so a live one is still holding the previous limit in the
   * moment after the slider moves — and a control that snapped back to its old
   * value while the user was looking at it reads as a control that did not save.
   *
   * A profile with no host yet reads the file directly. Building one to answer
   * would mean dialling an MCP server to draw a bar.
   *
   * The hard cap is a constant of the store rather than a setting, so it is
   * reported from there instead of being recomputed here.
   */
  async memoryUsage(profileId?: string): Promise<MemoryUsage> {
    const settings = await this.settingsStore.load();
    const id = profileId ?? (await this.profileStore.activeProfile()).id;
    const host = this.hosts.get(id);
    if (host) {
      return {
        bytes: await host.memoryBytes(),
        limitBytes: settings.memorySoftLimitBytes,
        capBytes: MAX_MEMORY_BYTES,
        reviewEvents: settings.memoryReviewEvents,
      };
    }

    const profile = await this.profileFor(id);
    /*
     * The current folder, not the open conversation's: this answers a question
     * about the *agent* — how full its memory is — and Settings has no idea
     * which chat the window happens to be showing.
     */
    const workspace =
      workspaceRootFor(await this.workspaceStore.load()) ??
      this.options.paths.defaultWorkspace;
    const store = new MemoryStore({
      workspaceRoot: workspace,
      // The same directory the host's store uses, so the bar and the prompt are
      // measuring the same two files rather than one of them.
      personMemoryRoot: this.options.paths.personMemoryDir,
      softLimitBytes: settings.memorySoftLimitBytes,
      ...(profile !== undefined ? {profileId: profile.id} : {}),
    });
    return {
      bytes: await store.bytes(),
      limitBytes: store.softLimitBytes,
      capBytes: MAX_MEMORY_BYTES,
      reviewEvents: settings.memoryReviewEvents,
    };
  }

  /**
   * When each remembered bullet was first written.
   *
   * Built the same way `memoryUsage` is, and for the same reason: the panel can
   * be opened before any turn has run, and building a host to answer a question
   * about a file would dial every MCP server and start the model to draw a list.
   */
  async memoryProvenance(
    profileId?: string,
  ): Promise<MemoryProvenanceEntry[]> {
    const id = profileId ?? (await this.profileStore.activeProfile()).id;
    const host = this.hosts.get(id);
    if (host) {
      return await host.memoryProvenance();
    }
    const profile = await this.profileFor(id);
    const workspace =
      workspaceRootFor(await this.workspaceStore.load()) ??
      this.options.paths.defaultWorkspace;
    const store = new MemoryStore({
      workspaceRoot: workspace,
      personMemoryRoot: this.options.paths.personMemoryDir,
      ...(profile !== undefined ? {profileId: profile.id} : {}),
    });
    return await store.provenance();
  }

  /**
   * Accepts a suggestion, writing it into the agent's memory.
   *
   * Removed from the queue whether it is accepted or dismissed: both are
   * answers, and a suggestion that stayed after being refused would be asked
   * again on every look.
   */
  async resolveMemoryProposal(
    proposalId: string,
    accept: boolean,
  ): Promise<{ok: boolean; problem?: string; supersede?: MemorySupersede}> {
    const file = await this.proposals.load();
    const proposal = file.proposals.find((entry) => entry.id === proposalId);
    if (proposal === undefined) {
      return {ok: false, problem: 'That suggestion is no longer waiting.'};
    }

    let supersede: MemorySupersede | undefined;
    if (accept) {
      /*
       * Built for the conversation that proposed it rather than for whichever
       * one is current: the fact was learned in a project, and that is the
       * folder whose memory has to hold it.
       */
      const result = await this.host(
        proposal.profileId,
        proposal.sessionId ?? undefined,
      );
      if (!result.ok) {
        /*
         * Kept in the queue rather than dropped. The agent cannot be built right
         * now — no key, a bad model — and that is a reason to try again later,
         * not a reason to throw away something the user just agreed to.
         */
        return {ok: false, problem: result.problem};
      }
      /*
       * The outcome travels back to the window, and that is not a nicety. A
       * proposal that carries a correction and matches no existing bullet leaves
       * the old fact exactly where it was, so the one thing the person needs told
       * is that the correction did not take — and nothing downstream of this call
       * can work it out for itself.
       */
      supersede = await result.host.remember(
        proposal.section,
        proposal.text,
        proposal.replaces,
      );
    }

    /*
     * A refusal is recorded with the agent it was refused in. The fact may be
     * exactly what this same agent is told later — the user can refuse a
     * *suggestion* and then say the thing themselves — and that is fine: the
     * refusal only silences the reviewer, never `update_memory`.
     */
    await this.proposals.remove(
      proposalId,
      accept ? undefined : {profileId: proposal.profileId, text: proposal.text},
    );
    return supersede === undefined ? {ok: true} : {ok: true, supersede};
  }

  /**
   * What the user has refused, newest last.
   *
   * Read for the memory panel rather than for the reviewer, so it answers with
   * the whole list and lets the caller group it: the dialog shows how many
   * judgements are being carried, and that is a number about the app's behaviour
   * rather than about one agent.
   */  async dismissedMemory(): Promise<DismissedMemory[]> {
    return (await this.proposals.load()).dismissed;
  }

  /** Forgets every refusal, so the reviewer may propose them again. */
  async forgetDismissedMemory(): Promise<DismissedMemory[]> {
    return (await this.proposals.clearDismissed()).dismissed;
  }

  /**
   * Records that an answer was wrong, and what was right instead.
   *
   * Nothing is written to memory here and nothing is said back to the model: the
   * conversation log is left exactly as it was, because a correction is a note
   * *about* a turn rather than a turn in it. What it changes is the next review,
   * which reads it — and the review still only proposes, so the fact reaches
   * memory through the same human answer as everything else.
   *
   * The turn is recorded beside the message because the two documents that will
   * want this note name the turn differently: a transcript message is titled with
   * an event id, and the discovery log records an invocation. Carrying both is
   * what makes the mark readable back onto the answer it was about.
   *
   * The profile is the *active* one rather than the conversation's owner, and the
   * window is what resolves that: the correction is made from an open
   * conversation in the window's current agent, and a caller that could not name
   * one would be guessing.
   */
  async recordFeedback(params: {
    sessionId: string;
    messageId: string;
    invocationId?: string;
    excerpt: string;
    correction?: string;
  }): Promise<FeedbackEntry> {
    const profile = await this.profileStore.activeProfile();
    const file = await this.feedbackStore.record({
      profileId: profile.id,
      sessionId: params.sessionId,
      messageId: params.messageId,
      ...(params.invocationId === undefined
        ? {}
        : {invocationId: params.invocationId}),
      excerpt: params.excerpt,
      ...(params.correction === undefined
        ? {}
        : {correction: params.correction}),
    });
    // The entry just written, newest last, so the caller can acknowledge one
    // rather than the whole document.
    const last = file.entries[file.entries.length - 1];
    if (last === undefined) {
      throw new Error('The correction was not stored.');
    }
    return last;
  }

  /** Every correction on record, newest last. */
  async feedback(): Promise<FeedbackEntry[]> {
    return (await this.feedbackStore.load()).entries;
  }

  /** Forgets them all, so the reviewer stops being told about them. */
  async clearFeedback(): Promise<FeedbackEntry[]> {
    return (await this.feedbackStore.clear()).entries;
  }

  /**
   * How far the memory review has read a conversation.
   *
   * Asked so the idle timer can choose between waiting for the conversation to
   * end and reading it back in stretches. Deliberately built on `ensureHost`
   * rather than `host`: this runs at the end of every turn, and `host` starts the
   * model engine — which is seconds of work to answer a question about a counter.
   *
   * `total` counts the events the review counts — the settled ones — because a
   * partial event is not something anything should be reading, and the two
   * numbers have to be in the same units as the threshold they are compared
   * against.
   */
  async reviewProgress(
    profileId: string,
    sessionId: string,
  ): Promise<{reviewed: number; total: number}> {
    const host = await this.ensureHost(profileId);
    const events = await host.eventsFor(sessionId);
    const total = events.filter((event) => event.partial !== true).length;
    const reviewed = await this.proposals.reviewedUpTo(sessionId);
    return {reviewed, total};
  }

  /**
   * How long the idle timer should wait before reading this conversation back.
   *
   * Here rather than in the window because the threshold is a setting and this is
   * the layer that already reads settings — the app that arms the timer asks one
   * question and gets a number, and never learns that there were two rules behind
   * it. The two delays are passed in because they are the *caller's* judgement:
   * ten seconds rather than a minute is about what else is running on the machine,
   * which is the app's business rather than the agent's.
   */
  async reviewDelayFor(
    profileId: string,
    sessionId: string,
    delays: {idleMs: number; shortlyMs: number},
  ): Promise<number> {
    const settings = await this.settingsStore.load();
    const progress = await this.reviewProgress(profileId, sessionId);
    return reviewDelay({
      total: progress.total,
      reviewed: progress.reviewed,
      threshold: settings.memoryReviewEvents,
    }) === 'shortly'
      ? delays.shortlyMs
      : delays.idleMs;
  }

  async profiles(): Promise<AgentProfile[]> {
    return await this.profileStore.profiles();
  }

  async activeProfile(): Promise<AgentProfile> {
    return await this.profileStore.activeProfile();
  }

  /**
   * The user's skills, for the Settings card and for the prompt's catalogue.
   *
   * The editor's write path and the agent's `save_skill` share `skillService`, so
   * there is one set of name rules, one length cap and one folder layout rather
   * than a UI path and a tool path that can drift.
   */
  async skills(): Promise<StoredSkill[]> {
    return await this.skillService.list();
  }

  async saveSkill(
    draft: SkillDraft,
    id?: string,
  ): Promise<{skills: StoredSkill[]; saved: StoredSkill}> {
    return await this.skillService.saveFromEditor(draft, id);
  }

  async removeSkill(id: string): Promise<StoredSkill[]> {
    return await this.skillService.remove(id);
  }

  /** The earlier bodies of one skill, for the Settings history view. */
  async skillHistory(id: string): Promise<SkillHistoryEntry[]> {
    return await this.skillService.history(id);
  }

  /** Puts one earlier body back, and answers with the whole library. */
  async restoreSkill(
    id: string,
    entryId: string,
  ): Promise<{skills: StoredSkill[]; saved: StoredSkill}> {
    return await this.skillService.restore(id, entryId);
  }

  /**
   * The folders this install works in, for the rail.
   *
   * Every call that changes one answers with the whole list, so a window never
   * has to merge a single entry into a copy of its own — the order and the
   * current folder are decided in one place.
   */
  async workspaces(): Promise<WorkspaceState> {
    const file = await this.workspaceStore.load();
    return {
      workspaces: file.workspaces,
      activeWorkspaceId: file.activeWorkspaceId,
    };
  }

  /** Loads a folder and makes it current. */
  async addWorkspace(path: string, name?: string): Promise<WorkspaceState> {
    await this.workspaceStore.add(path, name);
    return await this.workspaces();
  }

  /** Makes a folder the one a new conversation is filed under. */
  async selectWorkspace(workspaceId: string): Promise<WorkspaceState> {
    await this.workspaceStore.select(workspaceId);
    return await this.workspaces();
  }

  async renameWorkspace(
    workspaceId: string,
    name: string,
  ): Promise<WorkspaceState> {
    await this.workspaceStore.rename(workspaceId, name);
    return await this.workspaces();
  }

  /**
   * Forgets a folder.
   *
   * Documents are *not* dropped for it: a host holds the session service and the
   * conversation state, and disposing one would kill a turn that is running in
   * entirely another folder. Nothing about a folder removal changes where an
   * in-flight turn is writing; the next turn resolves its own folder anyway.
   */
  async removeWorkspace(workspaceId: string): Promise<WorkspaceState> {
    await this.workspaceStore.remove(workspaceId);
    return await this.workspaces();
  }

  /** One folder by id, for the caller that opens it in the file manager. */
  async workspaceById(workspaceId: string): Promise<Workspace | undefined> {
    return await this.workspaceStore.byId(workspaceId);
  }

  /**
   * The folder a conversation works in — where its file tools are confined.
   *
   * The same two facts a turn resolves through: the folder the conversation was
   * filed under, falling back to the current one. Attaching a file is judged
   * against *this*, because the point of attaching it is that the agent can read
   * it, and a file outside the root the turn runs in is one that `read_file`
   * would refuse — after the user had already watched it appear in the message.
   *
   * Worth the method rather than a second derivation in the window: the two
   * answers have to be the same one, and they differ the moment browsing the
   * rail selects another folder.
   */
  async conversationFolder(
    profileId: string,
    sessionId: string,
  ): Promise<string | undefined> {
    const host = await this.ensureHost(profileId);
    const filed = await host.sessionWorkspaceId(sessionId);
    return workspaceRootFor(await this.workspaceStore.load(), filed);
  }

  /**
   * The documents of one space, for the library and the editor.
   *
   * The id is resolved through the workspaces document here, and that is the
   * whole safety story `docs.*` rests on: a window names a space and never a
   * path, so the only files it can reach are the ones inside a folder the user
   * loaded. An id nobody has is a sentence rather than an empty library — a
   * removed space's documents are not "none".
   *
   * A fresh service per call, and no cache: it holds nothing but the root, and
   * one that remembered a folder would be the thing that goes stale when a space
   * is moved.
   */
  async documentsFor(spaceId: string): Promise<DocumentService> {
    const workspace = await this.workspaceStore.byId(spaceId);
    if (workspace === undefined) {
      throw new Error(
        `There is no space called "${spaceId}". It may have been removed from the list.`,
      );
    }
    return new DocumentService({root: workspace.path});
  }

  /** One document's text, and the revision a write has to be based on. */
  async readDocument(spaceId: string, path: string): Promise<DocumentRead> {
    return await (await this.documentsFor(spaceId)).read(path);
  }

  /** Writes a document, or answers that it moved on since it was read. */
  async writeDocument(
    spaceId: string,
    path: string,
    text: string,
    revision: DocumentRevision,
  ): Promise<DocumentWrite> {
    return await (await this.documentsFor(spaceId)).write(path, text, revision);
  }

  /** A new, empty document in one of a space's folders. */
  async createDocument(
    spaceId: string,
    dir: string | undefined,
    name: string,
  ): Promise<DocumentRead> {
    return await (await this.documentsFor(spaceId)).create(dir, name);
  }

  /**
   * Writes a conversation into a space as a document.
   *
   * The messages come from this runtime's own `transcript` and the title from
   * the conversation index, rather than from a second reader of the session
   * files — so what the window drew and what the document says are the same
   * projection. The *authors* are resolved here too: a helper's words are tagged
   * with the agent that wrote them, and turning that id into the name the user
   * sees is a question for the profile store.
   */
  async saveChatAsDocument(
    profileId: string,
    sessionId: string,
    spaceId: string,
    path: string,
  ): Promise<DocumentRead> {
    const documents = await this.documentsFor(spaceId);
    const profile = await this.profileFor(profileId);
    if (profile === undefined) {
      throw new Error(`There is no bot called "${profileId}".`);
    }
    /*
     * The index rather than `conversationFor`, which would read every event of
     * the conversation a second time to answer one question the index already
     * holds. A conversation the index does not have is a stale id, and a
     * document made from it would be a stub in somebody's folder.
     */
    const summary = (await this.listSessions(profileId)).find(
      (entry) => entry.id === sessionId,
    );
    if (summary === undefined) {
      throw new Error(`There is no conversation called "${sessionId}".`);
    }
    const {messages} = await this.transcript(profileId, sessionId);
    const names = new Map(
      (await this.profiles()).map((entry) => [entry.id, entry.name]),
    );
    /*
     * The lead first: the conversation's own choice of who answers a message
     * nobody addressed, which is the agent that owns it unless a group chat
     * named somebody else first.
     */
    const leadId = summary.agentIds?.[0] ?? profileId;

    return await documents.saveChat(path, {
      title: summary.title,
      savedAt: new Date(),
      messages: messages.map((message) => ({
        author: authorOf(message, names.get(leadId) ?? profile.name, names),
        text: message.text,
      })),
    });
  }

  /**
   * Re-files a conversation, or unfiles it with `null`.
   *
   * The placeholder-config host, for the same reason `transcript` uses one:
   * filing a conversation has nothing to do with a model, and a missing key must
   * not be able to stop it.
   */
  async setSessionWorkspace(
    profileId: string,
    sessionId: string,
    workspaceId: string | null,
  ): Promise<SessionSummary> {
    const host = await this.ensureHost(profileId);
    return await host.setSessionWorkspace(
      sessionId,
      workspaceId ?? undefined,
      profileId,
    );
  }

  /**
   * Points a conversation at a model of its own, or back at its agent's.
   *
   * The next turn in that conversation resolves through `host()`, which reads the
   * entry this writes — so this is a write and nothing else. No host is rebuilt
   * and no turn is interrupted: choosing a model is a decision about the *next*
   * question, and a user who changes it mid-answer has not asked for the answer
   * they are reading to be thrown away.
   *
   * `null` means "follow the agent", which is a real answer rather than an absent
   * one: without it there would be no way to move a conversation back off a
   * choice it once made.
   */
  async setSessionModel(
    profileId: string,
    sessionId: string,
    model: AgentModel | null,
  ): Promise<SessionSummary> {
    const host = await this.ensureHost(profileId);
    return await host.setSessionModel(sessionId, model ?? undefined, profileId);
  }

  /**
   * Who is in a conversation: the agents the user put in it, lead first.
   *
   * `undefined` is a chat with one agent — the one that owns it — which is every
   * conversation that existed before this field and most of them after it.
   */
  async sessionParticipants(
    profileId: string,
    sessionId: string,
  ): Promise<string[] | undefined> {
    const host = await this.ensureHost(profileId);
    return await host.sessionParticipants(sessionId);
  }

  /**
   * Sets who is in a conversation. An empty list is "just the agent that owns it".
   *
   * `ensureHost` rather than `host`, for the reason `setSessionModel` uses it:
   * this writes metadata about a chat, so it must work on an install whose model
   * cannot be reached. Adding somebody to a conversation is a decision about the
   * next question, not a reason to refuse the write.
   */
  async setParticipants(
    profileId: string,
    sessionId: string,
    agentIds: string[],
  ): Promise<SessionSummary> {
    const host = await this.ensureHost(profileId);
    return await host.setParticipants(sessionId, agentIds, profileId);
  }

  /**
   * Records what a provider says it serves.
   *
   * The store does the writing, including moving that provider's default model
   * off a name the endpoint no longer offers. What this adds is the consequence
   * the store cannot have: every host drops what it had applied, so the next turn
   * resolves again — a conversation that was about to answer with a retired model
   * answers with the replacement instead of failing for a reason nobody can see.
   */
  async setAvailableModels(
    provider: ProviderId,
    models: string[],
  ): Promise<StoredSettings> {
    const stored = await this.settingsStore.setAvailableModels(provider, models);
    /*
     * The applied signatures are dropped and the hosts are left standing: the
     * placeholder-config host holds conversations and their file positions, so
     * rebuilding it would be work done to no purpose. What has to go is this
     * cache of "which config has this host been given", because the answer just
     * changed.
     */
    this.applied.clear();
    return stored;
  }

  async renameSession(
    profileId: string,
    sessionId: string,
    title: string,
  ): Promise<SessionSummary> {
    const host = await this.ensureHost(profileId);
    return await host.renameSession(sessionId, title, profileId);
  }

  /**
   * Replaces the older part of a conversation with a summary.
   *
   * Resolved through `host()` rather than `ensureHost()`, which is the opposite
   * of what the calls above do and deliberately so: those write metadata a
   * conversation can be filed or named without a model. This one *asks the
   * model*, so it needs the real configuration, and an engine that is not up has
   * to come back as the sentence the window already knows how to draw rather
   * than as a request to an empty endpoint.
   */
  async compact(profileId: string, sessionId: string): Promise<CompactResult> {
    const resolved = await this.host(profileId, sessionId);
    if (!resolved.ok) {
      throw new Error(resolved.problem);
    }
    return await resolved.host.compact(sessionId, profileId);
  }

  /** Deletes a conversation, aborting a run in it if there is one. */
  async deleteSession(profileId: string, sessionId: string): Promise<void> {
    const host = await this.ensureHost(profileId);
    await host.deleteSession(sessionId, profileId);
    /*
     * And its discovery tree, for the reason the recall index drops its vectors:
     * a record of what the agent did in a conversation must not outlive the
     * user's ability to see that conversation. Best effort — the deletion the
     * user asked for has already happened, and a log that could not be moved
     * aside is not a reason to report a failure that did not occur.
     */
    await this.dreamStore.forget(sessionId);
    /*
     * And the memory reviewer's watermark for it, which nothing else moves: the
     * entry names a conversation that no longer exists, so leaving it is a file
     * that grows by one line per deleted chat and can never be read back.
     */
    await this.proposals.forget(sessionId);
  }

  /**
   * The last discovery-log write that failed, or nothing.
   *
   * The window asks so the Dream-RSI card can stop claiming the agent is
   * recording when it is not. A status rather than news: the card is redrawn from
   * a payload the window reads for other reasons too.
   */
  dreamProblem(): string | undefined {
    return this.dreamStore.problem();
  }

  /** Every conversation, or one agent's. */
  /** The stored purpose of one conversation, without listing the rail. */
  async sessionPurpose(
    profileId: string,
    sessionId: string,
  ): Promise<SessionPurpose | undefined> {
    const host = await this.ensureHost(profileId);
    return await host.sessionPurpose(sessionId);
  }

  async listSessions(profileId?: string): Promise<SessionSummary[]> {
    const profile = profileId ?? (await this.profileStore.activeProfile()).id;
    const host = await this.ensureHost(profile);
    return await host.listSessions(profile);
  }

  /**
   * Starts a conversation.
   *
   * Deliberately does *not* require a working configuration. A conversation is a
   * file, and the window needs somewhere to put the refusal when the engine is
   * not up — gating this on a resolvable config would mean a fresh install could
   * not open the chat it is supposed to explain itself in.
   *
   * The profile and one space are stamped on at creation, which is what files
   * the conversation under the right agent and the right group in the rail. It
   * is recorded once rather than followed: a conversation that keeps running
   * after another space is selected is what lets the rail be browsed while an
   * answer streams.
   */
  async createSession(
    profileId: string,
    title?: string,
    spaceId?: string,
  ): Promise<SessionSummary | undefined> {
    const profile = await this.profileFor(profileId);
    if (!profile) {
      return undefined;
    }
    const host = await this.ensureHost(profileId);
    return await host.createSession(
      title,
      profileId,
      await this.spaceFor(profile, spaceId),
    );
  }

  /**
   * Starts the conversation that makes a bot.
   *
   * The tool is checked here rather than left to the instruction: the builder
   * conversation is a prompt, and a prompt that tells Marimo to call something
   * it was not granted is exactly the invariant about absent capabilities. The
   * window grants the tool before asking, so this is the code-level backstop.
   *
   * Nothing is created here. The purpose is written onto the session so every
   * turn carries the builder instruction, and the window draws the opening
   * question from the same constant the instruction quotes.
   */
  async startBuilderSession(profileId: string): Promise<SessionSummary> {
    const profile = await this.profileFor(profileId);
    if (!profile) {
      throw new Error(`Unknown bot: ${profileId}`);
    }
    if (!profile.enabledTools.includes(DRAFT_BOT_TOOL)) {
      throw new Error(
        'Marimo Bot cannot help make a bot because the draft-bot tool is ' +
          'switched off for it. Turn it on in Settings and try again.',
      );
    }
    const host = await this.ensureHost(profileId);
    const purpose: SessionPurpose = 'bot-builder';
    return await host.createSession(
      'Making a bot',
      profileId,
      await this.spaceFor(profile),
      undefined,
      purpose,
    );
  }

  /**
   * The space a new conversation is filed in.
   *
   * Three answers, in this order and no other: the space the *caller* named —
   * the rail's "new chat in this space" — else the agent's own, which is how a
   * user says once that their Writer drafts into the website repo, else wherever
   * the rail is. The third is what every conversation did before agents had a
   * space at all, so an agent with none behaves exactly as it always has.
   *
   * A candidate that names a space the document no longer holds is *skipped*
   * rather than stamped, and that is the same rule a removed folder already
   * follows for a session: the id would render as "Other chats", a group the
   * user has to go looking in. Naming a space that has since been removed is a
   * stale window asking, not a request to file a chat where nobody can see it.
   */
  private async spaceFor(
    profile: AgentProfile,
    named?: string,
  ): Promise<string | undefined> {
    const file = await this.workspaceStore.load();
    for (const candidate of [named, profile.spaceId]) {
      if (
        candidate !== undefined &&
        file.workspaces.some((entry) => entry.id === candidate)
      ) {
        return candidate;
      }
    }
    return file.activeWorkspaceId ?? undefined;
  }

  /**
   * Reads a conversation, which needs no model at all.
   *
   * Deliberately not `host()`. That resolves the model configuration and refuses
   * without a running engine — correctly, for a turn — but reading a stored
   * conversation has nothing to do with a model. Going through `host()` made
   * every conversation in the app appear *empty* whenever the engine could not be
   * started: the messages were on disk and the window showed nothing, which is
   * indistinguishable from having lost them.
   */
  async transcript(
    profileId: string,
    sessionId: string,
  ): Promise<{messages: TranscriptMessage[]; pending: PendingGate[]}> {
    const profile = await this.profileFor(profileId);
    if (!profile) {
      return {messages: [], pending: []};
    }
    /*
     * A v2 conversation's transcript comes from its own log. Reading a rebuilt
     * chat should not build the old host, and the old host has no events for it
     * anyway.
     */
    if (await this.harness().hasLog(sessionId)) {
      const messages = await this.harness().transcript(sessionId, profileId);
      const pending = await this.harness().pendingGates(sessionId);
      return {
        messages: await this.markFeedback(messages, sessionId),
        pending,
      };
    }
    /*
     * The placeholder-config host, which is the same one a turn uses before its
     * configuration is resolved. It has the session service and nothing else,
     * which is exactly what reading needs.
     */
    const host = await this.ensureHost(profileId);
    const {messages} = await host.getTranscript(sessionId, profileId);
    const pending = await host.pendingGates(sessionId);
    /*
     * And what the user said about those answers, joined here rather than in the
     * window.
     *
     * The mark belongs to the turn, so it is put on the message as it is read:
     * a component that kept it in its own state until reload showed a button
     * offering to note something it had already noted, and a reader with two
     * surfaces on one conversation had two different answers to "was this
     * wrong". Joining in the main process means the window, the pet and any later
     * reader get the same one.
     */
    return {messages: await this.markFeedback(messages, sessionId), pending};
  }

  /**
   * Puts the user's judgement back on the turns it was about.
   *
   * Matched by invocation first, because that is the turn's own name: a message
   * id is the first event's id, which is an internal name the discovery log has
   * never seen, while the invocation is what both records call this turn. The
   * message id is the fallback for entries recorded before the window sent one:
   * those are still about an answer the person marked, and refusing to show the
   * mark because it predates a field would turn an upgrade into an objection.
   *
   * A mark is copied rather than mutated onto the projected message. The
   * projection is a plain function of the log, and the log has nothing to do with
   * this document.
   */
  private async markFeedback(
    messages: TranscriptMessage[],
    sessionId: string,
  ): Promise<TranscriptMessage[]> {
    const entries = await this.feedbackStore.forSession(sessionId);
    if (entries.length === 0) {
      return messages;
    }
    const wrongTurns = new Set<string>();
    const wrongMessages = new Set<string>();
    for (const entry of entries) {
      if (entry.invocationId !== undefined) {
        wrongTurns.add(entry.invocationId);
      }
      wrongMessages.add(entry.messageId);
    }
    return messages.map((message) => {
      const wrong =
        (message.invocationId !== undefined &&
          wrongTurns.has(message.invocationId)) ||
        wrongMessages.has(message.id);
      return wrong ? {...message, markedWrong: true} : message;
    });
  }

  /**
   * One conversation's stored events and title, for the recall indexer.
   *
   * Raw events rather than the projected transcript, because the indexer renders
   * its own text from them — reasoning and tool payloads left out — and the
   * projection is shaped for drawing. Deliberately not `host()`: indexing a chat
   * has nothing to do with a model, and a conversation whose engine is not up
   * must still be findable by meaning.
   */
  async conversationFor(
    profileId: string,
    sessionId: string,
  ): Promise<{
    title: string;
    events: import('../recall/conversations.js').ConversationEvent[];
  }> {
    /*
     * A v2 conversation lives in its own log. The recall indexer asks this same
     * question for both engines, so answering it from the v2 transcript is what
     * lets a rebuilt chat be found by meaning alongside an old one.
     */
    if (await this.harness().hasLog(sessionId)) {
      const conversation = await this.harness().conversationFor(
        profileId,
        sessionId,
      );
      return conversation;
    }
    const host = await this.ensureHost(profileId);
    const events = await host.eventsFor(sessionId);
    const summary = (await host.listSessions(profileId)).find(
      (entry) => entry.id === sessionId,
    );
    return {title: summary?.title ?? '', events};
  }

  /**
   * The host for a profile, working in the folder a conversation is filed under,
   * and brought up to date with the settings on disk.
   *
   * The session id is optional because not every caller has a conversation: the
   * catalogue and the memory readout are about the agent, and answer against the
   * current folder. A turn always has one, and that is what decides where its
   * file tools are confined — the conversation remembers its own folder, so
   * browsing the rail cannot move a turn that is already running.
   *
   * Bringing it up to date on the way in — rather than requiring a caller to
   * remember to — is what makes "a capability the user turned off is absent"
   * true on the *next* turn rather than after a restart.
   */
  async host(profileId: string, sessionId?: string): Promise<HostResult> {
    const settings = await this.settingsStore.load();
    const profile = await this.profileFor(profileId);
    if (!profile) {
      return {ok: false, problem: `There is no bot called "${profileId}".`};
    }

    /*
     * The host next, because it is what reads the conversation index — and a
     * placeholder-config host is exactly what `transcript` and `approve`
     * already build. Resolving the configuration first would mean reading the
     * folder before knowing which conversation is asking.
     */
    const host = await this.ensureHost(profileId);
    const filed =
      sessionId === undefined
        ? undefined
        : await host.sessionWorkspaceId(sessionId);
    const workspaceRoot = workspaceRootFor(
      await this.workspaceStore.load(),
      filed,
    );
    /*
     * The conversation's own model, when it has one. Read here rather than in the
     * caller because this is the one place that already has the host — which is
     * what reads the index — and the folder it is about to resolve against.
     */
    const sessionModel =
      sessionId === undefined ? undefined : await host.sessionModel(sessionId);

    const resolved = await resolveAgentConfig({
      settings,
      profile,
      readSecret: this.options.readSecret,
      skills: await this.skillsFor(profile),
      ...(workspaceRoot === undefined ? {} : {workspaceRoot}),
      ...(sessionModel === undefined ? {} : {sessionModel}),
    });
    if (!resolved.ok) {
      return resolved;
    }

    /*
     * The two caps the recorder reads, refreshed from the same settings read that
     * produced this turn's config. Kept here rather than in the store because
     * this is the one place per turn that has already read the document — the
     * store is asked for them on every flush, which is several times a turn, and
     * a second read there would be both slower and a chance for the two answers
     * to disagree about which settings the turn is running under.
     */
    this.cachedDreamKeepLogs = settings.dream.keepLogs;
    this.cachedDreamResultBytes = settings.dream.resultBytes;

    host.updateConfig(resolved.config);
    this.applyMcpServers(host, profileId);
    /*
     * Recall is handed over here rather than in `ensureHost`, because whether it
     * is on is a *setting* and this is the one place that has read it. A setting
     * the user turned off leaves the host with nothing, which is how a capability
     * switched off becomes absent rather than discouraged — and the tool list the
     * model is offered is rebuilt from that on the next turn.
     */
    host.setRecallService(
      settings.recall.enabled
        ? (await this.options.services?.(profileId, workspaceRoot))
            ?.recallService
        : undefined,
    );

    return {ok: true, host, profile};
  }

  /**
   * Runs one turn, or explains why it cannot.
   *
   * A refusal is reported as a failed turn rather than thrown, because that is
   * what the window already knows how to draw: a message in the conversation
   * saying what is wrong. An exception here would be a blank screen and a
   * console line the user never sees.
   *
   * `origin` is which surface asked — the window or the floating companion —
   * and it is the only thing here that is not in the message. The two share a
   * conversation and a profile, so the pet's shorter answers have to be decided
   * per turn and read from the settings at the moment it starts: a user who
   * moved the length slider while the moss was thinking gets the new length on
   * the next question, not this one.
   *
   * `agentId` is the agent the user addressed with `@`, when they did. The turn
   * is still the *conversation's* — one host, one session, one turn at a time —
   * but it is answered by that agent, with its identity, its tools and its model,
   * and its words are attributed to it. An id that is not a participant is
   * refused rather than answered by the lead: a message that looks delivered and
   * is not is worse than a refusal.
   */
  async *run(
    profileId: string,
    sessionId: string,
    text: string,
    origin?: 'window' | 'pet',
    agentId?: string,
  ): AsyncGenerator<AgentUiEvent> {
    const result = await this.host(profileId, sessionId);
    if (!result.ok) {
      yield refusal(sessionId, result.problem);
      return;
    }

    /*
     * Before the user's message is appended and before anything is sent: a
     * conversation whose active history has outgrown its budget is summarized
     * once, so the turn that follows is a request that fits. Automatic failure is
     * not a turn failure — `autoCompact` answers rather than throws, and the
     * provider's own refusal (if any) is the sentence the user sees.
     */
    await result.host.autoCompact(sessionId, profileId);

    /*
     * The addressed agent, resolved before anything is sent. Resolved through the
     * same function a helper is, so "who is in this chat" and "who may this turn
     * be answered by" cannot disagree about a name.
     */
    let as: {agentId: string; name: string; config: AgentConfig} | undefined;
    if (agentId !== undefined) {
      const participants =
        (await result.host.sessionParticipants(sessionId)) ?? [profileId];
      if (!participants.includes(agentId)) {
        yield refusal(
          sessionId,
          `"${await this.agentLabel(agentId)}" is not in this conversation. Add ` +
            'them to it first, or send the message without @.',
        );
        return;
      }
      const delegated = await this.resolveDelegate({agent: agentId});
      if ('problem' in delegated) {
        yield refusal(sessionId, delegated.problem);
        return;
      }
      as = {
        agentId: delegated.profile.id,
        name: delegated.profile.name,
        config: delegated.config,
      };
    }

    /*
     * Read before the turn, not after: ADK appends the user's message as the
     * turn runs, so a read afterwards would answer "how long since the message
     * you are about to answer" rather than "how long since they last spoke".
     */
    const activity = await result.host.sessionActivity(sessionId);
    /*
     * The builder instruction goes last, after the ordinary turn context. It is
     * the most specific thing this turn is for, and it is a stored fact about
     * the conversation rather than a flag the window has to remember across a
     * reload.
     */
    const purpose = await result.host.sessionPurpose(sessionId);
    const instruction = [
      turnInstruction(
        origin,
        (await this.settingsStore.load()).companion.answerLength,
        turnContext({
          now: new Date(),
          origin,
          ...(activity.lastActivity === undefined
            ? {}
            : {lastActivity: activity.lastActivity}),
          firstExchange: activity.firstExchange,
          text,
        }),
      ),
      purpose === 'bot-builder' ? BOT_BUILDER_INSTRUCTION : undefined,
    ]
      .filter((part): part is string => part !== undefined)
      .join('\n\n');
    yield* result.host.run(
      sessionId,
      text,
      instruction.length > 0 ? instruction : undefined,
      profileId,
      as,
    );
  }

  async *approve(
    profileId: string,
    params: {sessionId: string; callId: string; confirmed: boolean},
  ): AsyncGenerator<AgentUiEvent> {
    /*
     * No configuration check on purpose. A paused turn is already paid for and
     * already waiting; refusing to *answer* it because the key went missing
     * would strand a conversation that could still be finished — or, worse,
     * declined. The card is the user's to answer either way.
     */
    const profile = await this.profileFor(profileId);
    if (!profile) {
      return;
    }
    const host = await this.ensureHost(profileId);
    yield* host.approve({...params, sessionId: params.sessionId});
  }

  async pendingGates(
    profileId: string,
    sessionId: string,
  ): Promise<PendingGate[]> {
    if (!(await this.profileFor(profileId))) {
      return [];
    }
    const host = await this.ensureHost(profileId);
    return await host.pendingGates(sessionId);
  }

  abort(profileId: string, sessionId: string): boolean {
    return this.hosts.get(profileId)?.abort(sessionId) ?? false;
  }

  /** Whether any agent has a turn in flight. */
  isBusy(): boolean {
    for (const host of this.hosts.values()) {
      if (host.isBusy()) {
        return true;
      }
    }
    return false;
  }

  /** Which agent is mid-turn, for a caller that has to say something about it. */
  busyProfile(): string | undefined {
    for (const [profileId, host] of this.hosts) {
      if (host.isBusy()) {
        return profileId;
      }
    }
    return undefined;
  }

  /** Forgets a profile's host, so the next turn builds one from current state. */
  private dropHost(profileId: string): void {
    const host = this.hosts.get(profileId);
    if (host !== undefined) {
      host.dispose();
      this.hosts.delete(profileId);
      this.applied.delete(profileId);
    }
  }

  /**
   * Lets go of everything, including the engine if this process started one.
   *
   * Asynchronous because stopping a process is, and awaited by both callers on
   * their way out: the app before it quits, and the runner before it exits. A
   * child still loading weights when its parent disappears is a gigabyte of
   * memory and a spinning fan with no window left to explain it — which is
   * exactly the failure the pid file is the second line of defence against.
   */
  /**
   * The v2 turn path, over the same documents the v1 path reads.
   *
   * One set of stores, so a profile edited in Settings is the profile both
   * paths see. The facade is built lazily: a preview that is off is not a
   * second runtime doing work at boot.
   */
  harness(): HarnessRuntime {
    this.harnessRuntime ??= new HarnessRuntime({
      paths: this.options.paths,
      settings: this.settingsStore,
      profiles: this.profileStore,
      workspaces: this.workspaceStore,
      readSecret: this.options.readSecret,
      recallFor: async (profileId, workspaceRoot) =>
        (await this.options.services?.(profileId, workspaceRoot))
          ?.recallService,
      jobsFor: async (profileId, workspaceRoot) =>
        (await this.options.services?.(profileId, workspaceRoot))?.jobService,
      versions: this.harnessVersions,
      createSession: async (profileId, title) => {
        const created = await this.createSession(profileId, title);
        return created === undefined
          ? undefined
          : {
              id: created.id,
              ...(created.title === undefined ? {} : {title: created.title}),
            };
      },
      ...(this.options.webSearch === undefined
        ? {}
        : {webSearch: this.options.webSearch}),
    });
    return this.harnessRuntime;
  }

  async dispose(): Promise<void> {
    this.harnessRuntime?.dispose();
    for (const host of this.hosts.values()) {
      host.dispose();
    }
    this.hosts.clear();
    this.applied.clear();
    /*
     * The one engine left, and gigabytes of nobody's business if it is left
     * behind — 400 MB of weights and a fan with no window to explain them.
     */
    await this.options.recall?.stop();
  }

  private async profileFor(
    profileId: string,
  ): Promise<AgentProfile | undefined> {
    return (await this.profileStore.profiles()).find(
      (profile) => profile.id === profileId,
    );
  }

  /**
   * The agents this install has, by trimmed case-folded name *and* by id.
   *
   * Both, because a person reads names and a document refers to ids, and the
   * model is told the names. Two agents may share a name — the store only
   * guarantees they are distinguishable in the picker — so the *first* match is
   * the one the picker would draw first, which is the one the user meant.
   */
  private async profilesByName(): Promise<Map<string, AgentProfile>> {
    const byName = new Map<string, AgentProfile>();
    for (const profile of await this.profileStore.profiles()) {
      const name = profile.name.trim().toLocaleLowerCase();
      if (!byName.has(name)) {
        byName.set(name, profile);
      }
      if (!byName.has(profile.id.toLocaleLowerCase())) {
        byName.set(profile.id.toLocaleLowerCase(), profile);
      }
    }
    return byName;
  }

  /** What to call an agent the user has not named successfully. */
  private async agentLabel(agentId: string): Promise<string> {
    return (await this.profileFor(agentId))?.name ?? agentId;
  }

  /**
   * The agents a helper call could name, for the refusal that lists them.
   *
   * Ids are left out on purpose: a person asked for an agent by name and is owed
   * the names that exist, not the identifiers their document happens to use.
   */
  private async existingAgentNames(): Promise<string[]> {
    return (await this.profileStore.profiles()).map(
      (profile) => `"${profile.name}"`,
    );
  }

  /**
   * Resolves a named agent — and the space it works in — into a configuration.
   *
   * The one place both the `ask_agent` tool and an addressed message come
   * through, so "which agent is that" and "which folder does it work in" have a
   * single answer. A name nobody has, and a space nobody has, are *sentences*
   * rather than exceptions: both end up in front of the model or the user, and a
   * thrown error would arrive as a failed turn instead of as an explanation.
   *
   * The model is the agent's own rather than the conversation's, which is the
   * point of naming one: an agent configured for a bigger model is asked because
   * of it. The space is the conversation's unless the caller named one.
   */
  private async resolveDelegate(request: {
    agent: string;
    space?: string;
    sessionSpaceId?: string;
  }): Promise<DelegationResult | {problem: string}> {
    const profiles = await this.profilesByName();
    const profile = profiles.get(request.agent.trim().toLocaleLowerCase());
    if (profile === undefined) {
      const known = await this.existingAgentNames();
      return {
        problem:
          `There is no bot called "${request.agent.trim()}" on this computer. ` +
          (known.length > 0
            ? `The ones that exist are ${listOf(known)}.`
            : 'There are no other bots yet — they are created in Settings.'),
      };
    }

    const file = await this.workspaceStore.load();
    /*
     * The helper's folder, in the order the evidence is good: the Space the model
     * named, else the agent's own default — "my Writer drafts into the website
     * repo" — else the Space *this conversation* is filed under, and only then
     * whatever the rail happens to be on.
     *
     * That third step is the one worth stating: a turn's own file tools run in
     * the conversation's folder, and a helper that ran in whichever Space
     * somebody was browsing would be the one place in the app where clicking the
     * rail changes where work lands.
     */
    let spaceId = profile.spaceId ?? request.sessionSpaceId;
    if (request.space !== undefined) {
      const wanted = request.space.trim().toLocaleLowerCase();
      const named = file.workspaces.find(
        (entry) =>
          entry.name.trim().toLocaleLowerCase() === wanted ||
          entry.id.toLocaleLowerCase() === wanted,
      );
      if (named === undefined) {
        return {
          problem:
            `There is no Space called "${request.space.trim()}" on this ` +
            `computer. The ones that exist are ${listOf(
              file.workspaces.map((entry) => `"${entry.name}"`),
            )}.`,
        };
      }
      spaceId = named.id;
    }

    const root = workspaceRootFor(file, spaceId);

    const resolved = await resolveAgentConfig({
      settings: await this.settingsStore.load(),
      profile,
      readSecret: this.options.readSecret,
      skills: await this.skillsFor(profile),
      ...(root === undefined ? {} : {workspaceRoot: root}),
    });
    return resolved.ok
      ? {profile: resolved.profile, config: resolved.config}
      : {problem: resolved.problem};
  }

  /**
   * The user's skills a profile carries, in the shape the prompt wants.
   *
   * Filtered by `enabledSkills` rather than passing everything: a skill the user
   * switched off must not be advertisable, and `load_skill` checks the same grant
   * again so the prompt and the tool cannot disagree about what exists. What
   * rides in every request is the name and one-line description; the instructions
   * travel here too because the prompt composer needs a `Skill`, but it advertises
   * them rather than printing them.
   *
   * The built-in skills are not here at all — `composeInstruction` picks those up
   * from the profile's tools.
   */
  private async skillsFor(profile: AgentProfile): Promise<Skill[]> {
    return (await this.skillService.granted(profile)).map(
      (skill: StoredSkill) => ({
        name: skill.name,
        description: skill.description,
        instructions: skill.instructions,
      }),
    );
  }

  private async ensureHost(profileId: string): Promise<AgentHost> {
    const existing = this.hosts.get(profileId);
    if (existing) {
      return existing;
    }

    /*
     * Awaited, and the folder is deliberately not passed: this is the host a
     * caller builds before it knows which conversation is asking — reading a
     * transcript, filing a session — and recall's tools are chosen when a turn
     * runs, where `host()` has both.
     */
    const services = (await this.options.services?.(profileId)) ?? {};
    const host = new AgentHost({
      sessionsDir: this.options.paths.sessions,
      /*
       * Where the half of memory that is about the *person* lives. Under user
       * data rather than in a folder, because that is what makes it survive
       * switching projects — and it is passed on every host this process builds,
       * including the headless runner's, so both resolve one layout.
       */
      personMemoryDir: this.options.paths.personMemoryDir,
      // A placeholder config: `host()` resolves the real one and calls
      // `updateConfig` before any turn runs. Constructing with the settings
      // shape here would mean reading them twice and risking the two reads
      // disagreeing.
      config: {
        baseUrl: '',
        model: '',
        /*
         * The placeholder pair, for the same reason the address is empty: host()
         * replaces all of it before a turn runs, and a provider named here would
         * be a second answer to which service this agent uses. DeepSeek is the
         * catalogue's default, so a turn that somehow ran against this would be
         * refused for a missing key rather than sent somewhere nobody chose.
         */
        provider: 'deepseek',
        apiKey: '',
        systemPrompt: '',
        profileId,
        workspaceRoot: this.options.paths.defaultWorkspace,
        allowPrivateNetworkFetch: false,
      },
      ...(this.options.appName !== undefined
        ? {appName: this.options.appName}
        : {}),
      ...(this.options.webSearch ? {webSearch: this.options.webSearch} : {}),
      ...(services.jobService ? {jobService: services.jobService} : {}),
      ...(services.deskService ? {deskService: services.deskService} : {}),
      /*
       * The skill writer and the reader, per host because both are per profile.
       *
       * `save` is the adapter the tool sees; it writes the file and grants the
       * name to *this* bot, which is the one that asked. The library reads the
       * grant again on every call rather than capturing it, so switching a skill
       * off takes effect on the next load rather than on the next rebuild.
       */
      skillService: {
        save: async (input) =>
          await this.skillService.saveFromAgent(input, profileId),
      },
      skillLibrary: {
        load: async (name) => await this.skillService.load(profileId, name),
      },
      ...(services.discordService
        ? {discordService: services.discordService}
        : {}),
      /*
       * How a helper is built, handed over always.
       *
       * Always rather than only when some setting allows it, because the fact it
       * encodes is not a preference: this install has a profile store, so it may
       * have more than one agent, and `ask_agent` exists exactly when one does.
       * A host whose config names a profile that may delegate and whose seam has
       * nobody to name is the one combination that would offer the tool and fail
       * every call — and `resolveDelegate` answers that with a sentence listing
       * the agents that do exist.
       *
       * Deliberately *not* `this.host(childProfileId)`. That would build a second
       * live host for the helper — a second `active` flag, a second turn running
       * at the same time as the one that asked for it — and one-turn-at-a-time is
       * the invariant the whole app rests on. A helper is a *tool call* inside its
       * parent's turn: it shares this host's session service, its session id and
       * its stop button, and it is a fresh agent built from the child's own
       * configuration rather than a second host.
       */
      delegate: {
        resolve: async (request) => await this.resolveDelegate(request),
      },
      ...(this.options.onEvent === undefined
        ? {}
        : {onDelegateEvent: this.options.onEvent}),
      /*
       * Dream-RSI's sink, handed over unconditionally.
       *
       * The host decides whether anything is written, and it decides it from two
       * facts it holds: the config, which is the user's answer, and this sink,
       * which is the app's ability to store the result. Passing it always rather
       * than only when the setting is on is what keeps one source of truth for
       * "is this turn being recorded" — and the store creates no directory until
       * something is actually written, so an install that never turns the feature
       * on leaves no trace of it.
       */
      dreamSink: {
        append: (tree) => {
          /*
           * Deliberately not awaited, and the promise is deliberately dropped.
           * This is called from inside a tool callback, where waiting on a disk
           * would put a lock file and a write between the model and its result.
           * The store reports what it could not do through `takeProblem`.
           */
          void this.dreamStore.append(tree);
        },
      },
      dreamResultBytes: this.cachedDreamResultBytes,
      /*
       * The deletion sync, resolved lazily because the folder to purge from is
       * the one the *service* would have indexed into — and a service is built
       * from a setting this callback must read at the moment a chat is deleted,
       * not at the moment the host was made. The active folder is the honest
       * guess: another folder's index is settled by its own next refresh, which
       * drops any session that is no longer in the list.
       */
      onSessionsDeleted: async (sessionIds) => {
        const root = workspaceRootFor(await this.workspaceStore.load());
        const recall = (await this.options.services?.(profileId, root))
          ?.recallService;
        /*
         * Best effort, and deliberately swallowed. The conversation is already
         * deleted by the time this runs, and an index that cannot be rewritten —
         * a read-only folder, a full disk — must not turn a deletion that
         * happened into an error the window reports. The stale vectors are
         * dropped by that index's next refresh anyway, which is the backstop the
         * pruning in `refreshIndex` exists to be.
         */
        try {
          await recall?.forgetSessions?.(sessionIds);
        } catch (failure) {
          console.log(
            '[marimo] the deleted conversation could not be dropped from the recall index:',
            failure,
          );
        }
      },
    });
    host.init();
    this.hosts.set(profileId, host);
    return host;
  }

  /**
   * Hands the host the connected servers, if that set has changed.
   *
   * Compared by a signature of the names rather than by array identity, so a
   * caller that rebuilds its list on every call does not invalidate the runner
   * on every turn. What matters is whether the *model* would see a different
   * tool list.
   */
  private applyMcpServers(host: AgentHost, profileId: string): void {
    const sources = this.options.mcpServers?.() ?? [];
    const signature = sources
      .map(
        (source: McpToolsetSource) =>
          `${source.server.name}(${source.tools
            .map((tool) => tool.name)
            .join(',')})`,
      )
      .join('|');

    if (this.applied.get(profileId) === signature) {
      return;
    }
    this.applied.set(profileId, signature);
    host.setMcpServers(sources);
  }
}

/**
 * Who a message is written under in a saved document.
 *
 * A helper's words are tagged with the agent that wrote them and the lead's
 * carry no tag at all, so the tag wins where there is one and the lead answers
 * otherwise. An id no profile answers to is written as the id: a document that
 * says `a_9f3` is still true, where putting those words under the lead's name
 * would be a quotation from somebody who never said them.
 */
function authorOf(
  message: TranscriptMessage,
  lead: string,
  names: ReadonlyMap<string, string>,
): string {
  if (message.role === 'user') {
    return 'You';
  }
  if (message.agentId === undefined) {
    return lead;
  }
  return names.get(message.agentId) ?? message.agentId;
}

/**
 * A list of things to read, in a sentence.
 *
 * Quoted already by the caller, because the two callers quote different things —
 * agent names and space names — and this is the only part they should share.
 */
function listOf(items: readonly string[]): string {
  if (items.length === 0) {
    return 'none';
  }
  if (items.length === 1) {
    return items[0]!;
  }
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]!}`;
}

/**
 * What a connector is, for the person deciding whether an agent may use it.
 *
 * The address rather than a description, because there is nothing else true to
 * say: a connector's tools are whatever the server offers, and only the server
 * knows what they are — the description the model gets comes from it, tool by
 * tool. Where it points is the one fact this document holds, and it is the fact
 * that tells two connectors of the same kind apart.
 */
function connectorBlurb(server: McpServer): string {
  const where =
    server.transport === 'http'
      ? (server.url ?? 'an address it did not record')
      : [server.command ?? '', ...(server.args ?? [])].join(' ').trim() ||
        'a command it did not record';
  return `${server.transport === 'http' ? 'At' : 'Runs'} ${where}. Its own tools are offered beside the built-in ones.`;
}

/** A turn that never started, said in the shape the window already draws. */
function refusal(sessionId: string, problem: string): AgentUiEvent {
  return {
    type: 'turn.failed',
    sessionId,
    // No assistant message was ever written, so there is none to point at. The
    // window shows this beside the composer rather than under a bubble.
    messageId: '',
    code: 'not-configured',
    message: problem,
  };
}
