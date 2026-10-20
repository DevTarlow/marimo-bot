/**
 * The agent, running.
 *
 * One object that owns everything a turn needs — the settings, the profiles, the
 * skills, the tools, and the v2 turn engine — so that both processes can
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
import {randomUUID} from 'node:crypto';
import {rm} from 'node:fs/promises';
import {dirname} from 'node:path';

import {
  ASK_AGENT_TOOL,
  capabilityPresets,
  controlPresets,
  describeTools,
  MAX_MEMORY_BYTES,
  FileSessionService,
  MemoryStore,
  pendingGatesIn as adkPendingGatesIn,
  projectTranscript,
  resolvePersonMemoryFile,
  SAFE_DEFAULT_TOOLS,
  SKILLS,
} from '@marimo/agent';
import type {
  DeskService,
  DiscordService,
  JobService,
  MemoryForgetRequest,
  RecallLookup,
  McpToolsetSource,
  SessionIndexEntry,
  PendingGate,
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
  DRAFT_BOT_TOOL,
  MAIN_AGENT_NAME,
} from '@marimo/protocol';
import type {BotDraft, ProviderId, SessionPurpose} from '@marimo/protocol';
import type {
  AgentModel,
  AgentProfile,
  AgentUiEvent,
  CatalogEntry,
  DismissedMemory,
  DocumentRead,
  DocumentRevision,
  DocumentWrite,
  FeedbackEntry,
  McpServer,
  MemoryProposal,
  MemoryProvenanceEntry,
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
import {ProfileStore} from '../profiles.js';
import type {ProfileFile} from '../profiles.js';
import {FeedbackStore} from '../feedback.js';
import {MemoryProposalStore} from '../memory-proposals.js';
import type {SecretRead} from '../secrets.js';
import {SettingsStore} from '../settings.js';
import {SkillStore} from '../skills.js';
import {RuntimeSkillService} from '../skill-service.js';
import {WorkspaceStore, workspaceRootFor} from '../workspaces.js';
import {HarnessRuntime} from './harness-runtime.js';
import {HarnessVersionStore} from '../harness-versions.js';

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

export class AgentRuntime {
  /** The v2 turn path, built lazily so an install that never uses it pays nothing. */
  private harnessRuntime: HarnessRuntime | undefined;
  /** The frozen specs every v2 turn has run under, by hash. */
  private readonly harnessVersions: HarnessVersionStore;
  /** The one session index every host shares, so its write queue is real. */
  private readonly sessionIndex: FileSessionService;
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
  /** The review's watermark and refusals, and the rare fact still waiting. */
  private readonly proposals: MemoryProposalStore;
  /** What the user said about the agent's own answers. */
  private readonly feedbackStore: FeedbackStore;

  constructor(private readonly options: AgentRuntimeOptions) {
    this.harnessVersions = new HarnessVersionStore({
      rootDir: options.paths.harnessVersions,
    });
    this.sessionIndex = new FileSessionService({
      rootDir: options.paths.sessions,
    });
    this.settingsStore = new SettingsStore(options.paths.settings);
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
       * The two answers to how much the bot may do, on the same list of names.
       * The power tier is every tool this install can offer, so it is derived
       * here rather than listed anywhere: a tool added to the catalogue appears
       * on the card without a second list to keep in step.
       */
      controlPresets: controlPresets(tools.map((tool) => tool.name)),
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
    return await this.settingsStore.patch(patch);
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
    const tools = [...new Set(requested)].filter((name) => available.has(name));
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
      ...(persona === undefined
        ? {persona: botPersonaFor(template)}
        : {persona}),
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
     * After the profile write, so a refusal above leaves the bot whole. The index
     * answers the ids; deleting a conversation has never needed a profile to
     * exist.
     */
    const conversations =
      await this.sessionIndex.deleteSessionsForProfile(profileId);
    for (const sessionId of conversations) {
      await this.proposals.forget(sessionId);
      await this.harness().forgetLearningSession(sessionId);
    }
    await this.proposals.forgetProfile(profileId);
    await this.harness().forgetLearningProfile(profileId);
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

    return file;
  }
  /** The facts still waiting for this agent, which is normally none. */
  async memoryProposals(profileId?: string): Promise<MemoryProposal[]> {
    const file = await this.proposals.load();
    return profileId === undefined
      ? file.proposals
      : file.proposals.filter((proposal) => proposal.profileId === profileId);
  }

  /**
   * How full this agent's memory is, for the size control in Settings.
   *
   * The file size comes from the same memory store the agent reads, so the bar
   * and the agent's warning measure the same file. The limit comes from settings
   * rather than from a built host, so a slider that moves while a turn is live is
   * the value the control shows. Nothing here builds a host, because answering a
   * question about size must not dial an MCP server.
   *
   * The hard cap is a constant of the store rather than a setting, so it is
   * reported from there instead of being recomputed here.
   */
  async memoryUsage(profileId?: string): Promise<MemoryUsage> {
    const settings = await this.settingsStore.load();
    const id = profileId ?? (await this.profileStore.activeProfile()).id;
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
  async memoryProvenance(profileId?: string): Promise<MemoryProvenanceEntry[]> {
    const id = profileId ?? (await this.profileStore.activeProfile()).id;
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
   * Forgets one remembered bullet, at the person's request.
   *
   * The same store the provenance list was drawn from, so the line removed is
   * the line they clicked. The text is also recorded as a refusal: removing a
   * fact is the same instruction as turning a suggestion down, and without it
   * the next review of a conversation that mentions the subject would put it
   * straight back.
   */
  async forgetMemoryFact(
    fact: MemoryForgetRequest,
    profileId?: string,
  ): Promise<{entries: MemoryProvenanceEntry[]; removed: boolean}> {
    const id = profileId ?? (await this.profileStore.activeProfile()).id;
    const profile = await this.profileFor(id);
    const workspace =
      workspaceRootFor(await this.workspaceStore.load()) ??
      this.options.paths.defaultWorkspace;
    const store = new MemoryStore({
      workspaceRoot: workspace,
      personMemoryRoot: this.options.paths.personMemoryDir,
      ...(profile !== undefined ? {profileId: profile.id} : {}),
    });
    const report = await store.forget(fact);
    if (report.removed) {
      await this.proposals.dismiss({profileId: id, text: fact.text});
    }
    return {entries: await store.provenance(), removed: report.removed};
  }

  /**
   * What the user has refused, newest last.
   *
   * Read for the memory panel rather than for the reviewer, so it answers with
   * the whole list and lets the caller group it: the dialog shows how many
   * judgements are being carried, and that is a number about the app's behaviour
   * rather than about one agent.
   */ async dismissedMemory(): Promise<DismissedMemory[]> {
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
   * which reads it — and that review writes the fact it can support, which the
   * person can then search and forget like any other.
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
    await this.assertIndexOwned(sessionId, profileId);
    const events = await this.sessionIndex.listEvents(sessionId);
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
    const after = await this.skillService.remove(id);
    await this.harness().forgetSkillUsage(id);
    return after;
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
    const entry = await this.assertIndexOwned(sessionId, profileId);
    return workspaceRootFor(
      await this.workspaceStore.load(),
      entry?.workspaceId,
    );
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
    await this.assertIndexOwned(sessionId, profileId);
    const entry = await this.sessionIndex.setSessionWorkspace(
      sessionId,
      workspaceId ?? undefined,
    );
    return summaryOf(requireEntry(entry, sessionId));
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
    await this.assertIndexOwned(sessionId, profileId);
    const entry = await this.sessionIndex.setSessionModel(
      sessionId,
      model ?? undefined,
    );
    return summaryOf(requireEntry(entry, sessionId));
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
    const entry = await this.assertIndexOwned(sessionId, profileId);
    return entry.agentIds;
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
    await this.assertIndexOwned(sessionId, profileId);
    const entry = await this.sessionIndex.setSessionParticipants(
      sessionId,
      agentIds,
    );
    return summaryOf(requireEntry(entry, sessionId));
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
    const stored = await this.settingsStore.setAvailableModels(
      provider,
      models,
    );
    /*
     * The applied signatures are dropped and the hosts are left standing: the
     * placeholder-config host holds conversations and their file positions, so
     * rebuilding it would be work done to no purpose. What has to go is this
     * cache of "which config has this host been given", because the answer just
     * changed.
     */
    return stored;
  }

  async renameSession(
    profileId: string,
    sessionId: string,
    title: string,
  ): Promise<SessionSummary> {
    await this.assertIndexOwned(sessionId, profileId);
    const entry = await this.sessionIndex.renameSession(sessionId, title);
    return summaryOf(requireEntry(entry, sessionId));
  }
  /** Deletes a conversation, aborting a run in it if there is one. */
  async deleteSession(profileId: string, sessionId: string): Promise<void> {
    await this.assertIndexOwned(sessionId, profileId);
    await this.sessionIndex.deleteSession({
      appName: MAIN_AGENT_NAME,
      userId: 'local',
      sessionId,
    });
    /*
     * And the memory reviewer's watermark for it, which nothing else moves: the
     * entry names a conversation that no longer exists, so leaving it is a file
     * that grows by one line per deleted chat and can never be read back.
     */
    await this.proposals.forget(sessionId);
    await this.harness().forgetLearningSession(sessionId);
  }

  /** Every conversation, or one agent's. */
  /** The stored purpose of one conversation, without listing the rail. */
  async sessionPurpose(
    profileId: string,
    sessionId: string,
  ): Promise<SessionPurpose | undefined> {
    await this.assertIndexOwned(sessionId, profileId);
    return (await this.sessionIndex.getIndexEntry(sessionId))?.purpose;
  }

  async listSessions(profileId?: string): Promise<SessionSummary[]> {
    const profile = profileId ?? (await this.profileStore.activeProfile()).id;
    const entries = await this.sessionIndex.getIndex();
    return entries
      .filter((entry) => entry.profileId === profile)
      .map(summaryOf)
      .sort(
        (left, right) =>
          Date.parse(right.updatedAt) - Date.parse(left.updatedAt),
      );
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
    return await this.createIndexedSession(
      profileId,
      title,
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
    return await this.createIndexedSession(
      profileId,
      'Making a bot',
      await this.spaceFor(profile),
      'bot-builder',
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
     * A v1 conversation is read from the same index and event store, without a
     * host: reading has never needed a model. `pendingGatesIn` is the old gate
     * projection, kept for the format those events are in.
     */
    await this.assertIndexOwned(sessionId, profileId);
    const events = await this.sessionIndex.listEvents(sessionId);
    const messages = projectTranscript(events);
    const pending = adkPendingGatesIn(events);
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
   * Brings a v1 conversation forward, when it is safe to do so.
   *
   * A waiting card is the one thing that must not move: its call belongs to the
   * old invocation and the click that answers it resumes that host. Everything
   * else is words, and a conversation that continues on v2 is better than one
   * that keeps needing the old engine forever.
   */
  async migrateLegacy(profileId: string, sessionId: string): Promise<boolean> {
    const entry = await this.assertIndexOwned(sessionId, profileId);
    const harness = this.harness();
    if (await harness.hasLog(sessionId)) {
      return false;
    }
    const events = await this.sessionIndex.listEvents(sessionId);
    const gates = adkPendingGatesIn(events);
    const profile = await this.profileFor(profileId);
    if (profile === undefined) {
      return false;
    }
    const messages = projectTranscript(events);
    if (messages.length === 0 && gates.length === 0) {
      return false;
    }
    const imported = await harness.importLegacy(
      profileId,
      sessionId,
      {
        title: entry.title,
        ...(entry.workspaceId === undefined
          ? {}
          : {spaceId: entry.workspaceId}),
        ...(entry.purpose === undefined ? {} : {purpose: entry.purpose}),
        ...(entry.agentIds === undefined ? {} : {agentIds: entry.agentIds}),
        ...(gates.length === 0 ? {} : {gates}),
        author: profile.name,
      },
      messages,
    );
    return imported.imported;
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
    const entry = await this.assertIndexOwned(sessionId, profileId);
    const events = await this.sessionIndex.listEvents(sessionId);
    return {title: entry.title, events};
  }

  /** Whether any agent has a turn in flight. */
  isBusy(): boolean {
    return this.harness().isRunningAny();
  }
  /** One conversation's index entry, if this bot owns it. */
  private async assertIndexOwned(
    sessionId: string,
    profileId: string,
  ): Promise<SessionIndexEntry> {
    const entry = await this.sessionIndex.getIndexEntry(sessionId);
    if (entry === undefined || entry.profileId !== profileId) {
      throw new Error(`Unknown session: ${sessionId}`);
    }
    return entry;
  }

  /**
   * Starts a conversation in the index, without a host.
   *
   * A conversation is a file and a row; nothing here needs a model, a tool or a
   * connector. The state fields are the ones the host wrote, so a session made
   * by this path is indistinguishable from one made before it.
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
      /*
       * The same store, not a second one over the same file: it caches what it
       * read, so a dismissal here and a watermark write there would each undo
       * the other.
       */
      memoryProposals: this.proposals,
      sessionSpace: async (sessionId) =>
        (await this.sessionIndex.getIndexEntry(sessionId))?.workspaceId,
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
      /*
       * The same live list the old host used. A connector is dialled by the
       * manager the app owns, and the facade must ask it per turn rather than
       * be handed a snapshot: a server that dropped while the window was open
       * is a tool the next turn must not be offered.
       */
      ...(this.options.mcpServers === undefined
        ? {}
        : {mcpServers: this.options.mcpServers}),
    });
    return this.harnessRuntime;
  }

  async dispose(): Promise<void> {
    this.harnessRuntime?.dispose();
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

  private async createIndexedSession(
    profileId: string,
    title: string | undefined,
    workspaceId: string | undefined,
    purpose?: SessionPurpose,
  ): Promise<SessionSummary> {
    const state: Record<string, unknown> = {profileId};
    if (title !== undefined && title.length > 0) {
      state['title'] = title;
    }
    if (workspaceId !== undefined) {
      state['workspaceId'] = workspaceId;
    }
    if (purpose !== undefined) {
      state['purpose'] = purpose;
    }
    const session = await this.sessionIndex.createSession({
      appName: MAIN_AGENT_NAME,
      userId: 'local',
      sessionId: randomUUID(),
      state,
    });
    const entry = await this.sessionIndex.getIndexEntry(session.id);
    if (entry !== undefined) {
      return summaryOf(entry);
    }
    const now = new Date().toISOString();
    return {
      id: session.id,
      title: title ?? 'New chat',
      createdAt: now,
      updatedAt: now,
      messageCount: 0,
      ...(workspaceId === undefined ? {} : {workspaceId}),
      ...(purpose === undefined ? {} : {purpose}),
    };
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

function requireEntry(
  entry: SessionIndexEntry | undefined,
  sessionId: string,
): SessionIndexEntry {
  if (entry === undefined) {
    throw new Error(`Unknown session: ${sessionId}`);
  }
  return entry;
}

/** The index's row, in the shape the window reads. */
function summaryOf(entry: SessionIndexEntry): SessionSummary {
  return {
    id: entry.id,
    title: entry.title,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    messageCount: entry.messageCount,
    ...(entry.workspaceId === undefined
      ? {}
      : {workspaceId: entry.workspaceId}),
    ...(entry.source === undefined ? {} : {source: entry.source}),
    ...(entry.purpose === undefined ? {} : {purpose: entry.purpose}),
    ...(entry.model === undefined ? {} : {model: entry.model}),
    ...(entry.agentIds !== undefined && entry.agentIds.length > 1
      ? {agentIds: entry.agentIds}
      : {}),
  };
}
