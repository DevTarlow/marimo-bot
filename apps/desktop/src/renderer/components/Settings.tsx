/**
 * Settings.
 *
 * The screen that makes "every capability is something the user turns on" true
 * rather than a description of a state nobody can leave. Until this existed the
 * grants were a hardcoded default with no way to change them.
 *
 * There is one screen now. It used to come in two sizes, with a switch between
 * them; that switch made "the everyday settings" a mode somebody had to leave to
 * change their bot's identity, and it made the app look like two products. Every
 * capability is still a switch, and every switch is here.
 *
 * The repair that matters most is first in spirit. The app carries no model, so
 * a fresh install cannot answer until its server is connected — and the card
 * that does it, the Model server card, is where a launch with the server off
 * sends somebody. Connectors are on the same screen for the same reason from the
 * other end:
 * the card is where a server is added and trusted, and a capability nobody can
 * see is one nobody turns on.
 *
 * The tool list is drawn in two groups, and the grouping is the point. Twenty
 * checkboxes with no distinction between reading a file and running a shell
 * command is a list nobody can make a decision from — so the ones that merely
 * look are separated from the ones that can change something, and the second
 * group says what is at stake. The setup flow still offers three capability
 * cards when a bot is made, because that is the moment the choice is made.
 *
 * Above the switches, the same two control choices the first run asks about are
 * offered for the bot already on screen. They are a shortcut over the one grant,
 * not a mode: picking one writes `enabledTools`, every switch below stays
 * visible, and a switch turned afterwards simply makes the grant custom.
 *
 * **A bot is what the screen calls an agent.** The word on screen changed; the
 * code did not, because `agent` is a package name, an IPC namespace and a field
 * on disk, and renaming those means migrating data rather than changing copy. So
 * `profiles.*`, the `AgentProfile` type and `agentIds` all still say agent while
 * every sentence a user reads says bot. The split is deliberate rather than
 * half-finished, so that the next reader does not "fix" one side of it — the
 * same note `WorkspaceRail` carries for spaces.
 *
 * Saving is immediate per switch rather than behind a Save button. Each toggle
 * is one independent fact, and a form that can be abandoned leaves the screen
 * disagreeing with the file.
 */
import {useEffect, useRef, useState} from 'react';

import type {
  AgentProfile,
  CatalogConnector,
  CatalogTool,
  CompanionAnswerLength,
  McpStatus,
  HarnessReport,
  JobSummary,
  ProfileCatalog,
  PublicSettings,
  SkillDraft,
  SkillHistoryEntry,
  StoredSkill,
  UpdateCheck,
} from '@marimo/protocol';

import {
  BOT_AVATAR_PRESETS,
  COMMAND_IDS,
  COMMANDS,
  COMPANION_ANSWER_LENGTHS,
  defaultBotAvatarFor,
  SKILL_DESCRIPTION_MAX,
  SKILL_INSTRUCTIONS_MAX,
} from '@marimo/protocol';

import {chosenPreset} from '../capabilities.js';
import {describe} from '../describe.js';
import {BotAvatar} from './BotAvatar.js';
import {BotIconGrid} from './BotIconGrid.js';
import {BotMenu} from './BotMenu.js';
import {Connectors} from './Connectors.js';
import {ControlChoice} from './ControlChoice.js';
import {Jobs} from './Jobs.js';
import {Learning} from './Learning.js';
import {Memory} from './Memory.js';
import {ModelServerSection} from './ModelServerSection.js';
import type {PopoverAnchor} from './Popover.js';
import {Recall} from './Recall.js';
import {NewBotDialog} from './NewBotDialog.js';
import {ResetMarimo} from './ResetMarimo.js';
import {SettingsSection} from './SettingsSection.js';

/**
 * The three lengths, in the words the user is choosing between.
 *
 * Written here rather than derived from the enum: the value is what the agent's
 * instruction is keyed by, and this is what the person picking one is told. The
 * sentences the model actually gets live beside the agent, in `pet-turn.ts` —
 * they are prompt text, and a pick-list labelled with prompt text would be
 * describing the implementation rather than the choice.
 */
const ANSWER_LENGTH_LABELS: Record<CompanionAnswerLength, string> = {
  brief: 'Brief — a few lines, the answer and nothing else',
  balanced: 'Balanced — as long as the question deserves',
  detailed: 'Detailed — the full answer here, not deferred to the window',
};

interface Loaded {
  settings: PublicSettings;
  catalog: ProfileCatalog;
  /**
   * The skills on disk, as files.
   *
   * Read here rather than through `catalog.skills`, which carries only the name
   * and description the prompt advertises: the card edits the instructions and
   * needs the folder id, and a second read of the same folder would be a second
   * answer to what is in it.
   */
  skills: StoredSkill[];
  profile: AgentProfile | undefined;
  statuses: Record<string, McpStatus>;
  /** Whether the floating companion is on screen. */
  companionVisible: boolean;
  /**
   * Which space "wherever the rail is" currently means, when it means one.
   *
   * A fact about the rail rather than about the catalogue, which is why it comes
   * from `workspaces.list`: `profiles.catalog` lists the spaces, and the active
   * one is where somebody left the rail rather than something a space is.
   */
  activeSpaceName: string | undefined;
}



export function Settings({
  onClose,
  lastReview,
  openSection,
  userDataFolder,
  onStartBotBuilder,
  onOpenJobConversation,
}: {
  onClose: () => void;
  /**
   * Hands the window to the bot-builder conversation. The App closes Settings on
   * success; a refusal comes back here as a sentence under the dialog.
   */
  onStartBotBuilder?: () => Promise<{ok: boolean; problem?: string}>;
  /**
   * Opens a job's conversation and leaves Settings for it.
   *
   * A job can belong to another bot, so the App is the only layer that can move
   * the rail and the transcript together. Absent in a window that cannot
   * navigate; the card then leaves the button off.
   */
  onOpenJobConversation?: (
    entry: JobSummary,
  ) => Promise<{ok: boolean; problem?: string}>;
  /** What the last background look read and remembered, for the Learning card. */
  lastReview?: {events: number; remembered: number} | null;
  /**
   * A card to open on the first read, for a caller that sent the user here.
   *
   * Added to whatever the file already had open rather than replacing it: this
   * is somebody arriving with one question, not somebody rearranging the page.
   */
  openSection?: string;
  /**
   * The folder the reset card names as the place everything it erases lives.
   *
   * Passed in rather than read here, for the reason the window reads `app.info`
   * once: it is a fact about this install, and a second read from inside one
   * card would be a second answer that could disagree with the first. Absent
   * until that read has landed, and the card draws without it.
   */
  userDataFolder?: string;
}): React.JSX.Element {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  /**
   * The fields being edited. Committed on blur, not on every letter.
   *
   * `persona` is a string here and optional on the profile, because a text box
   * has no way to show "absent" and `''` is what an empty one means. `identity`
   * is the stored Role, and the field is labelled Role everywhere the person
   * reads it.
   */
  const [draft, setDraft] = useState<{
    name: string;
    identity: string;
    persona: string;
  } | null>(null);
  /**
   * The sections the user has opened, by title.
   *
   * Here rather than inside each panel because the file stores the list whole:
   * one write carries every open section, and a panel writing only its own name
   * would fold all the others. `null` until the file has been read, so an empty
   * list — every section folded — is never confused with not having looked yet.
   */
  const [openSections, setOpenSections] = useState<string[] | null>(null);
  /**
   * Which bot's name is being edited in the list, and the value so far.
   *
   * The list is where a bot is picked, so the list is where it is named. The
   * Name field further down edits whichever bot is *active*, which is no help
   * for the one somebody is looking at but has not selected.
   */
  const [renaming, setRenaming] = useState<{id: string; value: string} | null>(
    null,
  );
  /**
   * Whether the Persona field is asking before replacing the person's words.
   *
   * The Role's Reset is a button anybody can press without fear: it restores
   * text the app wrote. The Persona's template text is different — pressing it
   * would replace something only the person wrote — so it asks first, in place,
   * the same way removing a bot does.
   */
  const [confirmingPersona, setConfirmingPersona] = useState(false);
  /** Whether the new-bot panel is open under the roster. */
  const [newBotOpen, setNewBotOpen] = useState(false);
  /*
   * Escape has to beat the blur that follows it. Unmounting the input fires a
   * blur whose handler still closes over the old draft, so a cancelled edit
   * would otherwise be committed on the way out. Set before the state change,
   * consumed by whichever handler runs first, and cleared when the next edit
   * begins — the same trick the rail uses, for the same reason.
   */
  const cancelled = useRef(false);
  /**
   * Which bot's menu is open, and where its `…` was when it opened.
   *
   * One at a time, held here rather than in the row, because the menu is drawn
   * outside the list: a popover inside a scrolling card is clipped at its edge,
   * which is the same reason the rail holds one open menu rather than each row
   * holding its own.
   */
  const [menu, setMenu] = useState<{id: string; anchor: PopoverAnchor} | null>(
    null,
  );

  const load = async (): Promise<void> => {
    try {
      const {settings} = await window.marimo.call('settings.get', {});
      const {profiles} = await window.marimo.call('profiles.list', {});
      const profile = profiles.find(
        (entry) => entry.id === settings.activeProfileId,
      );
      const catalog = await window.marimo.call('profiles.catalog', {});
      const {skills} = await window.marimo.call('skills.list', {});
      const statuses = await window.marimo.call('mcp.statuses', {});
      const companion = await window.marimo.call('companion.status', {});
      const {workspaces, activeWorkspaceId} = await window.marimo.call(
        'workspaces.list',
        {},
      );
      setLoaded({
        settings,
        catalog,
        profile,
        skills,
        statuses,
        companionVisible: companion.visible,
        activeSpaceName: workspaces.find(
          (entry) => entry.id === activeWorkspaceId,
        )?.name,
      });
      setDraft(
        profile === undefined
          ? null
          : {
              name: profile.name,
              identity: profile.identity,
              persona: profile.persona ?? '',
            },
      );
      /*
       * Seeded once. Every later read is the reload that follows a write, and
       * that write came from the list already on screen — taking the file's copy
       * instead would be taking the same list back, or throwing away the fold
       * somebody just made if the write was slower than the read.
       */
      setOpenSections(
        (current) =>
          current ??
          (openSection === undefined
            ? settings.expandedSections
            : [...new Set([...settings.expandedSections, openSection])]),
      );
    } catch (failure) {
      setProblem(describe(failure));
    }
  };

  useEffect(() => {
    void load();
  }, []);

  /*
   * A confirmation about one bot's Persona is not a confirmation about
   * another's. Moving to a different bot cancels it rather than leaving a
   * Replace button pointed at words the person has not read.
   */
  useEffect(() => {
    setConfirmingPersona(false);
  }, [loaded?.profile?.id]);

  /**
   * Runs a change, and says so when it fails rather than pretending.
   *
   * Answers whether it landed, because the skills editor has a draft to keep:
   * closing it on a refused save would throw away what the person wrote and
   * leave only the sentence at the top of the screen.
   */
  const change = async (work: () => Promise<unknown>): Promise<boolean> => {
    setSaving(true);
    setProblem(null);
    try {
      await work();
      await load();
      return true;
    } catch (failure) {
      setProblem(describe(failure));
      return false;
    } finally {
      setSaving(false);
    }
  };

  /** Where a menu is drawn from: the trigger's place right now. */
  const anchorOf = (element: HTMLElement): PopoverAnchor => {
    const rect = element.getBoundingClientRect();
    return {top: rect.top, bottom: rect.bottom, left: rect.left};
  };

  const beginRename = (id: string, value: string): void => {
    cancelled.current = false;
    setRenaming({id, value});
  };

  /**
   * Commits the name in the list, or puts it back.
   *
   * A blank name is a refusal rather than a write: a bot nobody can pick out of
   * a list is one the list cannot offer, and the field is the only place that
   * says so. An unchanged name writes nothing, so a click away from a field
   * somebody never typed in is not a round trip.
   */
  const commitRename = (): void => {
    const edit = renaming;
    if (edit === null || cancelled.current) {
      cancelled.current = false;
      return;
    }
    setRenaming(null);
    const value = edit.value.trim();
    const current = loaded?.settings.profiles.find(
      (entry) => entry.id === edit.id,
    );
    if (current === undefined || value.length === 0 || value === current.name) {
      return;
    }
    void change(async () => {
      await window.marimo.call('profiles.update', {
        profileId: edit.id,
        patch: {name: value},
      });
    });
  };

  /**
   * Opens or folds one section, and stores the fact.
   *
   * The only control on this screen drawn before it is written. Every other
   * switch here is a fact about how the agent behaves; this is a fact about
   * where somebody is looking, and a panel that spent a round trip deciding
   * whether to close would feel like it had missed the click. A refused write
   * puts the list back where it was, so the dialog never disagrees with the
   * file about what is open.
   *
   * Deliberately not the `saving` flag the other writes set: that flag disables
   * every switch on the screen, and a fold changes none of them. Raising it here
   * greyed out the whole dialog — including the section being opened — for the
   * duration of a write about where a panel sits.
   */
  const fold = (title: string, expanded: boolean): void => {
    const before = openSections ?? [];
    const after = expanded
      ? [...new Set([...before, title])]
      : before.filter((name) => name !== title);
    setOpenSections(after);
    setProblem(null);
    void window.marimo
      .call('settings.set', {patch: {expandedSections: after}})
      .then(() => load())
      .catch((failure) => {
        setOpenSections(before);
        setProblem(describe(failure));
      });
  };

  const toggle = (tool: CatalogTool, on: boolean): void => {
    const profile = loaded?.profile;
    if (profile === undefined) {
      return;
    }
    const enabled = new Set(profile.enabledTools);
    if (on) {
      enabled.add(tool.name);
    } else {
      enabled.delete(tool.name);
    }
    writeTools(profile.id, [...enabled]);
  };

  /** Writes a grant, whoever asked for it — a switch or one of the cards. */
  const writeTools = (profileId: string, enabledTools: string[]): void => {
    void change(async () => {
      await window.marimo.call('profiles.update', {
        profileId,
        patch: {enabledTools},
      });
    });
  };

  /**
   * Switches one skill on or off for the active bot.
   *
   * The grant is the skill's name, so the switch and the prompt are the same
   * fact: a skill that is off is neither advertised nor loadable.
   */
  const toggleSkill = (name: string, on: boolean): void => {
    const profile = loaded?.profile;
    if (profile === undefined) {
      return;
    }
    const enabled = new Set(profile.enabledSkills);
    if (on) {
      enabled.add(name);
    } else {
      enabled.delete(name);
    }
    void change(async () => {
      await window.marimo.call('profiles.update', {
        profileId: profile.id,
        patch: {enabledSkills: [...enabled]},
      });
    });
  };

  if (loaded === null) {
    return (
      <div className="settings">
        <div className="settings-inner">
          <p className="settings-muted">
            {problem ?? 'Reading your settings…'}
          </p>
          <button
            type="button"
            className="button button-quiet"
            onClick={onClose}
          >
            Back
          </button>
        </div>
      </div>
    );
  }

  const granted = new Set(loaded.profile?.enabledTools ?? []);
  const opened = new Set(openSections ?? []);
  /*
   * The bot an open menu belongs to, looked up rather than held in the state: a
   * menu left open while another window removed that bot would otherwise offer
   * actions for a profile this list no longer has.
   */
  const menuBot =
    menu === null
      ? undefined
      : loaded.settings.profiles.find((entry) => entry.id === menu.id);
  /*
   * The two seeds, read from the catalogue rather than imported: the lead's are
   * the app constants, a starter bot's come from its template, and a custom
   * bot's are built from its own name — so one import could only ever be right
   * for one kind. The empty id is the no-profile case, where neither field is
   * drawn.
   */
  const resetRole = loaded.catalog.roleSeeds[loaded.profile?.id ?? ''];
  const resetPersona = loaded.catalog.personaSeeds[loaded.profile?.id ?? ''];
  /*
   * What "the default icon" means for this bot is its place in the roster, not
   * Marimo's mark: the first bot is the lead, and every one after it starts on
   * the next preset. Reading the same rule here keeps the clear button from
   * offering a no-op.
   */
  const defaultAvatarId = defaultBotAvatarFor(
    Math.max(
      0,
      loaded.settings.profiles.findIndex(
        (entry) => entry.id === loaded.profile?.id,
      ),
    ),
  ).id;
  /*
   * Reset would be a no-op only when the box already shows that text *and* that
   * is what is stored. A box showing the default it has not saved yet is a
   * change waiting to happen, and the button is how it gets saved.
   */
  const roleAtDefault =
    loaded.profile !== undefined &&
    draft?.identity === resetRole &&
    loaded.profile.identity === resetRole;
  /*
   * Grouped by the grant itself, which is the one fact about a tool that cannot
   * be out of date — it is the same value the switch is drawn from. An earlier
   * version grouped by a hand-written "looking" or "acting" classification, and
   * that list had already drifted from the tools it described.
   */
  const onByDefault = loaded.catalog.tools.filter((tool) => tool.byDefault);
  const offByDefault = loaded.catalog.tools.filter((tool) => !tool.byDefault);
  /*
   * The high-level choice, derived from the same grant the switches below read.
   * It is never stored: a profile granted exactly one of these lists is that
   * card, and a profile with one switch changed is neither, which is the honest
   * answer rather than a second place for the choice to disagree with the grant.
   */
  const controlPresets = loaded.catalog.controlPresets;
  const chosenControl = chosenPreset(
    controlPresets,
    loaded.profile?.enabledTools ?? [],
  );
  const connectors = loaded.catalog.connectors;
  const connectorGrant = grantedConnectors(connectors, loaded.profile);
  /*
   * Whether the agent's grant has ever been narrowed. `mcpServerIds` absent is
   * the wide answer — every connector the install switched on — so the switches
   * come up ticked and the line above them has to say why, or a wall of ticks
   * reads as a choice nobody made.
   */
  const connectorsUnchosen = loaded.profile?.mcpServerIds === undefined;

  const toggleConnector = (connector: CatalogConnector, on: boolean): void => {
    const profile = loaded.profile;
    if (profile === undefined) {
      return;
    }
    const next = new Set(connectorGrant);
    if (on) {
      next.add(connector.id);
    } else {
      next.delete(connector.id);
    }
    void change(async () => {
      await window.marimo.call('profiles.update', {
        profileId: profile.id,
        /*
         * The whole list rather than the one id that moved: the field is what
         * the agent may reach, and a list holding only the change would say it
         * may reach nothing else.
         */
        patch: {mcpServerIds: [...next]},
      });
    });
  };

  return (
    <div className="settings">
      <div className="settings-inner">
        <header className="settings-head">
          <h2>Settings</h2>
          <button
            type="button"
            className="button button-quiet"
            onClick={onClose}
          >
            Back to chat
          </button>
        </header>

        {problem !== null && (
          <div className="error" role="alert">
            <span>{problem}</span>
          </div>
        )}

        <SettingsSection title="Your bots" opened={opened} onToggle={fold}>
          <p className="settings-muted">
            Each bot has its own identity, its own abilities and its own
            conversations. The model server is chosen for the app in the Model
            server card, so every bot answers from the same server. Making a
            second bot is how you keep two jobs from sharing one memory.
          </p>
          {/*
            Once for the list rather than once per agent: with no spaces there is
            nothing for any row to choose, and the same sentence repeated under
            four agents is four times the noise for one fact.
          */}
          {loaded.catalog.spaces.length === 0 && (
            <p className="settings-muted">
              No spaces yet, so there is nothing here to choose. &ldquo;Load a
              space…&rdquo; in the rail is where one is added, and it appears
              here as soon as it is.
            </p>
          )}
          <div className="settings-agents">
            {loaded.settings.profiles.map((entry) => (
              <div className="settings-agent-row" key={entry.id}>
                {renaming?.id === entry.id ? (
                  /*
                   * The name gives way to a field in the same row rather than
                   * opening a dialog: what is being renamed is one pill among
                   * several, and a modal for it would hide the list it belongs
                   * to.
                   */
                  <input
                    className="settings-agent-input"
                    value={renaming.value}
                    aria-label={`Name for ${entry.name}`}
                    autoFocus
                    spellCheck={false}
                    disabled={saving}
                    onChange={(event) => {
                      setRenaming({...renaming, value: event.target.value});
                    }}
                    onBlur={commitRename}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault();
                        commitRename();
                      } else if (event.key === 'Escape') {
                        event.preventDefault();
                        cancelled.current = true;
                        setRenaming(null);
                      }
                    }}
                  />
                ) : (
                  <>
                    <button
                      type="button"
                      className="settings-agent"
                      aria-current={
                        entry.id === loaded.settings.activeProfileId
                          ? 'true'
                          : undefined
                      }
                      disabled={saving}
                      onClick={() => {
                        void change(async () => {
                          await window.marimo.call('profiles.select', {
                            profileId: entry.id,
                          });
                        });
                      }}
                    >
                      <BotAvatar profile={entry} size="sm" />
                      {entry.name}
                    </button>
                    <button
                      type="button"
                      className="settings-agent-menu"
                      aria-haspopup="menu"
                      aria-expanded={menu?.id === entry.id}
                      aria-label={`Actions for ${entry.name}`}
                      disabled={saving}
                      onClick={(event) => {
                        setMenu({
                          id: entry.id,
                          anchor: anchorOf(event.currentTarget),
                        });
                      }}
                    >
                      ⋯
                    </button>
                  </>
                )}
                {/*
                  Where this agent starts its chats, in the same row as its name:
                  it is a fact about that agent, and one list of agents is enough
                  to carry both.
                */}
                <AgentSpaceChoice
                  profile={entry}
                  spaces={loaded.catalog.spaces}
                  activeSpaceName={loaded.activeSpaceName}
                  disabled={saving}
                  onChoose={(profileId, spaceId) => {
                    void change(async () => {
                      await window.marimo.call('profiles.update', {
                        profileId,
                        patch: {spaceId},
                      });
                    });
                  }}
                />
              </div>
            ))}
            <button
              type="button"
              className="settings-agent settings-agent-new"
              disabled={saving}
              onClick={() => {
                setProblem(null);
                setNewBotOpen(true);
              }}
            >
              + New bot
            </button>
          </div>

          {newBotOpen && (
            <NewBotDialog
              templates={loaded.catalog.botTemplates}
              {...(loaded.catalog.delegationTool === undefined
                ? {}
                : {delegationTool: loaded.catalog.delegationTool})}
              {...(loaded.catalog.builderTool === undefined
                ? {}
                : {builderTool: loaded.catalog.builderTool})}
              lead={loaded.settings.profiles[0]}
              onCreated={async () => {
                setNewBotOpen(false);
                await load();
              }}
              onStartBuilder={
                onStartBotBuilder ??
                (async () => ({
                  ok: false,
                  problem: 'The builder is not available from this window.',
                }))
              }
              onClose={() => {
                setNewBotOpen(false);
              }}
            />
          )}
          {/*
            One menu, drawn outside the list and anchored to the trigger that
            opened it. Outside because a popover inside this card would be
            clipped at its edge, and one because two open menus is a state with
            no meaning.
          */}
          {menuBot !== undefined && menu !== null && (
            <BotMenu
              bot={menuBot}
              last={loaded.settings.profiles.length <= 1}
              anchor={menu.anchor}
              onClose={() => {
                setMenu(null);
              }}
              onRename={() => {
                setMenu(null);
                beginRename(menuBot.id, menuBot.name);
              }}
              onRemove={() => {
                setMenu(null);
                void change(async () => {
                  await window.marimo.call('profiles.remove', {
                    profileId: menuBot.id,
                  });
                });
              }}
            />
          )}
        </SettingsSection>

        {draft !== null && loaded.profile !== undefined && (
          <SettingsSection title="What it is" opened={opened} onToggle={fold}>
            <label className="settings-field">
              <span>Name</span>
              <input
                className="settings-input"
                value={draft.name}
                disabled={saving}
                onChange={(event) => {
                  setDraft({...draft, name: event.target.value});
                }}
                onBlur={() => {
                  const name = draft.name.trim();
                  if (name.length === 0 || name === loaded.profile?.name) {
                    // Put back rather than saved: an agent with no name is one
                    // nobody can pick out of the list, and the field is the only
                    // place that says so.
                    setDraft({...draft, name: loaded.profile?.name ?? ''});
                    return;
                  }
                  void change(async () => {
                    await window.marimo.call('profiles.update', {
                      profileId: loaded.profile?.id ?? '',
                      patch: {name},
                    });
                  });
                }}
              />
            </label>
            <BotIconChoices
              profile={loaded.profile}
              defaultPresetId={defaultAvatarId}
              disabled={saving}
              onPreset={(presetId) => {
                void change(async () => {
                  await window.marimo.call('profiles.update', {
                    profileId: loaded.profile?.id ?? '',
                    patch: {avatar: {kind: 'preset', id: presetId}},
                  });
                });
              }}
              onUpload={() => {
                void change(async () => {
                  await window.marimo.call('profiles.uploadAvatar', {
                    profileId: loaded.profile?.id ?? '',
                  });
                });
              }}
              onClear={() => {
                void change(async () => {
                  await window.marimo.call('profiles.update', {
                    profileId: loaded.profile?.id ?? '',
                    patch: {avatar: null},
                  });
                });
              }}
            />
            {/*
             * Persona first, because it is the field the person is here for.
             * The Role below is the app's brief: real, editable, and reset in
             * one press, but not something most people need to touch.
             *
             * Not a `<label>` around either field, because both hold buttons: a
             * click anywhere inside a label focuses its control, so the buttons
             * below would have been clicks on the text box. The names are
             * carried by `aria-label` instead.
             */}
            <div className="settings-field">
              <span>Persona</span>
              <em className="settings-why">
                Who this bot is, what it is for, and how you want to be spoken
                to. This is your text; the app seeds it once and never resets it
                on its own.
              </em>
              <textarea
                className="settings-input settings-preferences"
                rows={6}
                aria-label="Persona"
                placeholder="Dry and precise, never flatters me. Call me Tarlow, and say when you are unsure rather than guessing."
                value={draft.persona}
                disabled={saving}
                onChange={(event) => {
                  setDraft({...draft, persona: event.target.value});
                }}
                onBlur={() => {
                  const stored = loaded.profile?.persona ?? '';
                  if (draft.persona === stored) {
                    return;
                  }
                  const persona = draft.persona;
                  void change(async () => {
                    await window.marimo.call('profiles.update', {
                      profileId: loaded.profile?.id ?? '',
                      patch: {persona},
                    });
                  });
                }}
              />
              {/*
               * The template text is a seed, not a default: pressing this
               * replaces words only the person wrote, so it asks first. The
               * Role's Reset below does not need to, because everything it
               * restores is the app's.
               */}
              {resetPersona !== undefined &&
                resetPersona.length > 0 &&
                draft.persona !== resetPersona && (
                  <div className="settings-row">
                    {confirmingPersona ? (
                      <>
                        <span className="settings-muted">
                          Replace your persona with the starter text?
                        </span>
                        <button
                          type="button"
                          className="button button-quiet button-small"
                          disabled={saving}
                          onClick={() => {
                            setConfirmingPersona(false);
                          }}
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          className="button button-danger button-small"
                          disabled={saving}
                          onClick={() => {
                            setConfirmingPersona(false);
                            setDraft({...draft, persona: resetPersona});
                            void change(async () => {
                              await window.marimo.call('profiles.update', {
                                profileId: loaded.profile?.id ?? '',
                                patch: {persona: resetPersona},
                              });
                            });
                          }}
                        >
                          Replace
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        className="button button-quiet"
                        disabled={saving}
                        onClick={() => {
                          setConfirmingPersona(true);
                        }}
                      >
                        Use the starter text
                      </button>
                    )}
                  </div>
                )}
            </div>
            <div className="settings-field">
              <span>Role</span>
              <em className="settings-why">
                The app&rsquo;s brief for this bot: what it is for, what it may
                claim, and how it works. You can change it, but most bots do not
                need it touched.
              </em>
              <textarea
                className="settings-input settings-identity"
                rows={6}
                aria-label="Role"
                value={draft.identity}
                disabled={saving}
                onChange={(event) => {
                  setDraft({...draft, identity: event.target.value});
                }}
                onBlur={() => {
                  if (draft.identity === loaded.profile?.identity) {
                    return;
                  }
                  const identity = draft.identity;
                  void change(async () => {
                    await window.marimo.call('profiles.update', {
                      profileId: loaded.profile?.id ?? '',
                      patch: {identity},
                    });
                  });
                }}
              />
              <div className="settings-row">
                {/*
                 * Saved in the click rather than left to a blur: the blur fires
                 * first when the button takes focus, and would write whatever
                 * the box held *before* the reset. The store serialises the
                 * two, so the default is what lands.
                 */}
                <button
                  type="button"
                  className="button button-quiet"
                  disabled={saving || roleAtDefault}
                  onClick={() => {
                    setDraft({...draft, identity: resetRole});
                    void change(async () => {
                      await window.marimo.call('profiles.update', {
                        profileId: loaded.profile?.id ?? '',
                        patch: {identity: resetRole},
                      });
                    });
                  }}
                >
                  Reset to default
                </button>
              </div>
            </div>
          </SettingsSection>
        )}

        {/*
          What the agent may do. The two control choices are the same grant the
          setup flow asks about, as a shortcut over the switches below — not a
          mode, because every switch is still here. Both write the same
          `enabledTools`, so the profile remains the one truth.
        */}
        <SettingsSection
          title={`What ${loaded.profile?.name ?? 'this bot'} can do`}
          opened={opened}
          onToggle={fold}
        >
          <h4 className="settings-group">How much can it do?</h4>
          <ControlChoice
            presets={controlPresets}
            chosenId={chosenControl?.id}
            disabled={saving || loaded.profile === undefined}
            onChoose={(preset) => {
              if (
                loaded.profile === undefined ||
                chosenControl?.id === preset.id
              ) {
                return;
              }
              writeTools(loaded.profile.id, [...preset.tools]);
            }}
          />
          <p className="settings-why">
            This sets every switch below at once. Change any of them afterwards
            and the bot keeps your own mix.
          </p>
          {chosenControl === undefined && (
            <p className="settings-muted">
              This bot has its own mix of tools. Picking a card above replaces
              it.
            </p>
          )}

          <p className="settings-muted">
            A tool that is switched off is not offered to the model at all — it
            is not a suggestion it might ignore.
          </p>

          <h4 className="settings-group">On to begin with</h4>
          {onByDefault.map((tool) => (
            <ToolRow
              key={tool.name}
              tool={tool}
              on={granted.has(tool.name)}
              disabled={saving}
              onChange={toggle}
            />
          ))}

          <h4 className="settings-group">Off until you turn it on</h4>
          {offByDefault.map((tool) => (
            <ToolRow
              key={tool.name}
              tool={tool}
              on={granted.has(tool.name)}
              disabled={saving}
              onChange={toggle}
            />
          ))}

          {/*
            The third group, and the only one that can be empty — a heading
            over nothing reads as a feature this build lacks rather than as a
            step not taken yet, so an install with no connectors gets one line
            instead.
          */}
          {connectors.length === 0 ? (
            <p className="settings-muted">
              No connectors are set up on this machine, so there is nothing here
              to give a bot. The Connectors card below is where one is added,
              and it appears here as soon as it is saved.
            </p>
          ) : (
            <>
              <h4 className="settings-group">Connectors</h4>
              <p className="settings-why">
                {connectorsUnchosen
                  ? 'This bot has never had connectors chosen for it, so it may use every connector that is switched on. Unchecking one is what narrows it.'
                  : 'The connectors this bot may use. One that is not ticked is not offered to the model at all.'}
              </p>
              {connectors.map((connector) => (
                <ConnectorRow
                  key={connector.id}
                  connector={connector}
                  on={connectorGrant.has(connector.id)}
                  disabled={saving}
                  onChange={toggleConnector}
                />
              ))}
            </>
          )}
        </SettingsSection>

        <SettingsSection title="Harness" opened={opened} onToggle={fold}>
          {opened.has('Harness') && loaded.profile !== undefined ? (
            <HarnessCard
              profileId={loaded.profile.id}
              onRestored={() => {
                void load();
              }}
            />
          ) : (
            <p className="settings-muted">
              What the rebuilt engine has recorded for this bot.
            </p>
          )}
        </SettingsSection>

        {/*
          The procedures this bot can load.

          Separate from the tool list because a skill is not a tool: it is prompt
          text the model reads when a task matches, and the grant is per name.
          The editor is here so a person can write one without asking the model,
          and the save tool above is the other way in.
        */}
        <SettingsSection title="Skills" opened={opened} onToggle={fold}>
          <SkillsCard
            skills={loaded.skills}
            granted={new Set(loaded.profile?.enabledSkills ?? [])}
            canWrite={
              loaded.profile?.enabledTools.includes('save_skill') ?? false
            }
            disabled={saving}
            onGrant={toggleSkill}
            onSave={async (draft, id) =>
              await change(async () => {
                await window.marimo.call('skills.save', {
                  ...(id === undefined ? {} : {id}),
                  draft,
                });
              })
            }
            onRemove={async (id) =>
              await change(async () => {
                await window.marimo.call('skills.remove', {id});
              })
            }
            onHistory={async (id) => {
              try {
                const {entries} = await window.marimo.call('skills.history', {
                  id,
                });
                return entries;
              } catch {
                return null;
              }
            }}
            onRestore={async (id, entryId) =>
              await change(async () => {
                await window.marimo.call('skills.restore', {id, entryId});
              })
            }
          />
        </SettingsSection>

        {/*
          Every bot's scheduled work, in one place.

          It sits after Skills because a job is something a bot does rather than
          something it is, and before the companion because the list can be long
          and the cards below are short. The card reads across bots by design:
          a job belongs to the bot that was asked to make it, and the person
          should not have to remember which conversation that was.
        */}
        <Jobs
          opened={opened}
          onToggle={fold}
          profiles={loaded.settings.profiles}
          {...(onOpenJobConversation === undefined
            ? {}
            : {onOpenConversation: onOpenJobConversation})}
        />

        <SettingsSection
          title="Desktop companion"
          opened={opened}
          onToggle={fold}
        >
          <p className="settings-muted">
            A moss ball that floats above your other windows with its own chat
            bar, so you can ask something without opening this one. It shares
            this conversation — anything you say to it is here too.
          </p>
          <label className="settings-check">
            <input
              type="checkbox"
              checked={loaded.companionVisible}
              disabled={saving}
              onChange={(event) => {
                const visible = event.target.checked;
                void change(async () => {
                  await window.marimo.call('companion.setVisible', {visible});
                });
              }}
            />
            <span>
              Show the companion
              <em className="settings-why">
                Drag it by the moss to move it. Clicking through to whatever is
                behind works anywhere there is nothing to click.
              </em>
            </span>
          </label>

          <h4 className="settings-group">How it answers</h4>
          <p className="settings-muted">
            How long the answers are when you ask at the moss. This travels with
            the question rather than with the conversation, so asking here does
            not make the main window terse as well.
          </p>
          <select
            className="settings-input"
            value={loaded.settings.companion.answerLength}
            disabled={saving}
            aria-label="Answer length"
            onChange={(event) => {
              const answerLength = event.target.value as CompanionAnswerLength;
              void change(async () => {
                await window.marimo.call('settings.set', {
                  patch: {companion: {answerLength}},
                });
              });
            }}
          >
            {COMPANION_ANSWER_LENGTHS.map((length) => (
              <option key={length} value={length}>
                {ANSWER_LENGTH_LABELS[length]}
              </option>
            ))}
          </select>

          <h4 className="settings-group">How much it shows</h4>
          <label className="settings-field">
            <span>
              Messages above the moss
              <em className="settings-why">
                Older ones are always in the main window. Fewer keeps the pet to
                the answer that just arrived.
              </em>
            </span>
            <input
              className="settings-input"
              type="number"
              min={1}
              max={20}
              value={loaded.settings.companion.visibleMessages}
              disabled={saving}
              onChange={(event) => {
                const visibleMessages = Number(event.target.value);
                /*
                 * A field being cleared, or a keypress that would leave a 0 or a
                 * 40 in it, passes through values the schema refuses. Writing one
                 * would be a failed call and an error line under a spinner, so
                 * the field is allowed to disagree with the stored number for as
                 * long as it takes to type a good one — and the stored number is
                 * what is still in force.
                 */
                if (
                  !Number.isInteger(visibleMessages) ||
                  visibleMessages < 1 ||
                  visibleMessages > 20
                ) {
                  return;
                }
                void change(async () => {
                  await window.marimo.call('settings.set', {
                    patch: {companion: {visibleMessages}},
                  });
                });
              }}
            />
          </label>

          <label className="settings-check">
            <input
              type="checkbox"
              checked={loaded.settings.companion.alwaysOnTop}
              disabled={saving}
              onChange={(event) => {
                const alwaysOnTop = event.target.checked;
                void change(async () => {
                  await window.marimo.call('settings.set', {
                    patch: {companion: {alwaysOnTop}},
                  });
                });
              }}
            />
            <span>
              Float above other windows
              <em className="settings-why">
                Turn this off while presenting or watching something
                full-screen, and the moss stops covering it. It can then go
                behind the window you are working in, so it may need moving back
                out.
              </em>
            </span>
          </label>

          <label className="settings-check">
            <input
              type="checkbox"
              checked={loaded.settings.companion.clickThrough}
              disabled={saving}
              onChange={(event) => {
                const clickThrough = event.target.checked;
                void change(async () => {
                  await window.marimo.call('settings.set', {
                    patch: {companion: {clickThrough}},
                  });
                });
              }}
            />
            <span>
              Clicks pass through where there is nothing to click
              <em className="settings-why">
                On is what makes the moss sit on the desktop rather than in a
                box over it. Turn it off if the moss ever stops responding to
                the mouse — the window then keeps the mouse everywhere inside
                it, including the empty space around the moss.
              </em>
            </span>
          </label>
        </SettingsSection>

        {/*
          Commands act on the conversation itself rather than being said in it,
          which is why they are not a tool: a tool is something the model decides
          to use, and this is something the user decides to run. The list is the
          protocol's catalogue, so a command added there appears here, in the
          composer's menu, and nowhere else needs to know about it.
        */}
        <SettingsSection title="Commands" opened={opened} onToggle={fold}>
          <p className="settings-muted">
            Commands run against a conversation from the composer&rsquo;s +
            menu. They are off the model&rsquo;s list entirely when switched off
            here, rather than merely discouraged.
          </p>
          {COMMAND_IDS.map((id) => (
            <label className="settings-check" key={id}>
              <input
                type="checkbox"
                checked={!loaded.settings.disabledCommands.includes(id)}
                disabled={saving}
                onChange={(event) => {
                  const on = event.target.checked;
                  const next = COMMAND_IDS.filter((candidate) =>
                    candidate === id
                      ? !on
                      : loaded.settings.disabledCommands.includes(candidate),
                  );
                  void change(async () => {
                    await window.marimo.call('settings.set', {
                      patch: {disabledCommands: next},
                    });
                  });
                }}
              />
              <span>
                {COMMANDS[id].label}
                <em className="settings-why">{COMMANDS[id].blurb}</em>
              </span>
            </label>
          ))}
        </SettingsSection>

        {/*
          What answers.

          It is not tuning: a fresh install has nothing to think with until its
          server answers, and the card a first run's notice sends somebody to has
          to be able to fix that. The form writes into the loaded payload so the
          status beside the fields moves without a full reload.
        */}
        <ModelServerSection
          settings={loaded.settings}
          opened={opened}
          onToggle={fold}
          onSettings={(next) => {
            setLoaded((current) =>
              current === null ? current : {...current, settings: next},
            );
          }}
          onSaved={load}
        />

        {/*
          Learning sits before Memory because a change is about the next turn,
          while memory is about what the bot already carries. What waits here is
          only the changes that need a person; a remembered fact is written and
          shown in the Memory card below.
        */}
        <Learning
          opened={opened}
          onToggle={fold}
          {...(loaded.profile === undefined
            ? {}
            : {profileId: loaded.profile.id})}
          {...(lastReview === undefined ? {} : {lastReview})}
          onChange={() => {
            void load();
          }}
        />

        <Memory opened={opened} onToggle={fold} />
        {/*
          Recall sits beside memory because it is the same subject from the other
          end: memory is what the agent writes down, recall is how it finds it
          again — and the same file is one of the two things it indexes.
        */}
        <Recall opened={opened} onToggle={fold} />

        {/*
          Which connectors exist is not tuning: an install where nothing can be
          reached until a server is added would look like an app with no such
          feature. The per-agent grant lives with the agent, above; this card is
          the install's own list, and it is where a server is dialled.
        */}
        <Connectors
          servers={loaded.settings.mcpServers}
          statuses={loaded.statuses}
          encryptionAvailable={loaded.settings.encryptionAvailable}
          opened={opened}
          onToggle={fold}
          onChange={() => {
            void load();
          }}
        />

        {/*
          Last.

          The reset is last because it is the thing fewest people want, and
          because a card that erases the rest should not sit above any of it.

          `saving` is passed as well as the card's own state: a settings write
          already in flight can land after the folder is emptied, and a
          `settings.json` that comes back is a reset that silently undid itself.
        */}
        <Updates opened={opened} onToggle={fold} />

        <ResetMarimo
          opened={opened}
          onToggle={fold}
          disabled={saving}
          {...(userDataFolder === undefined ? {} : {folder: userDataFolder})}
        />
      </div>
    </div>
  );
}

function AgentSpaceChoice({
  profile,
  spaces,
  activeSpaceName,
  disabled,
  onChoose,
}: {
  profile: AgentProfile;
  spaces: ProfileCatalog['spaces'];
  /** Which space the rail is on, when it is on one. */
  activeSpaceName: string | undefined;
  disabled: boolean;
  /** `null` puts the agent back on wherever the rail is. */
  onChoose: (profileId: string, spaceId: string | null) => void;
}): React.JSX.Element | null {
  if (spaces.length === 0) {
    /*
     * Nothing to choose. The section says why above the list, so a picker with
     * no options — or the same explanation under every agent — would be noise.
     */
    return null;
  }

  const stored = profile.spaceId;
  /*
   * A space the rail no longer lists is treated as no choice at all, because
   * that is what it is: the runtime skips a name it cannot resolve and files the
   * chat where the rail is, so showing the stale id would describe something
   * that does not happen.
   */
  const chosen =
    stored !== undefined && spaces.some((space) => space.id === stored)
      ? stored
      : undefined;

  return (
    <>
      <span className="settings-why">Works in</span>
      <select
        className="settings-input"
        aria-label={`Works in for ${profile.name}`}
        value={chosen ?? ''}
        disabled={disabled}
        onChange={(event) => {
          onChoose(
            profile.id,
            event.target.value === '' ? null : event.target.value,
          );
        }}
      >
        <option value="">Wherever I am</option>
        {spaces.map((space) => (
          <option key={space.id} value={space.id}>
            {space.name}
          </option>
        ))}
      </select>
      {chosen === undefined && activeSpaceName !== undefined && (
        <em className="settings-why">Right now: {activeSpaceName}</em>
      )}
    </>
  );
}

function HarnessCard({
  profileId,
  onRestored,
}: {
  profileId: string;
  onRestored: () => void;
}): React.JSX.Element {
  const [report, setReport] = useState<HarnessReport | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [restoring, setRestoring] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setReport(null);
    setProblem(null);
    void window.marimo
      .call('harness.report', {profileId})
      .then((next) => {
        if (live) {
          setReport(next);
        }
      })
      .catch((failure: unknown) => {
        if (live) {
          setProblem(describe(failure));
        }
      });
    return () => {
      live = false;
    };
  }, [profileId, nonce]);

  if (problem !== null) {
    return <p className="settings-muted">{problem}</p>;
  }
  if (report === null) {
    return <p className="settings-muted">Reading the logs…</p>;
  }

  const number = (value: number): string => value.toLocaleString();
  const tokenTotal =
    report.usage.totalTokens ||
    report.usage.promptTokens + report.usage.completionTokens;

  return (
    <div className="harness-report">
      <div className="settings-row">
        <p className="settings-muted">
          Every conversation runs on the rebuilt engine. A chat from an older
          build is brought forward when you open or continue it, so the v1 count
          only covers conversations not opened since the rebuild.
        </p>
        <button
          type="button"
          className="button button-quiet button-small"
          onClick={() => {
            setNonce((value) => value + 1);
          }}
        >
          Refresh
        </button>
      </div>
      <dl>
        <div>
          <dt>Conversations</dt>
          <dd>
            {number(report.conversations.v2)} v2 ·{' '}
            {number(report.conversations.v1)} v1
          </dd>
        </div>
        <div>
          <dt>Turns</dt>
          <dd>{number(report.turns)}</dd>
        </div>
        <div>
          <dt>Tokens</dt>
          <dd>
            {number(tokenTotal)} total · {number(report.usage.promptTokens)}{' '}
            prompt · {number(report.usage.completionTokens)} completion
          </dd>
        </div>
        <div>
          <dt>Harness versions</dt>
          <dd>{number(report.harnessVersions)}</dd>
        </div>
        <div>
          <dt>Memory</dt>
          <dd>
            {number(report.pendingProposals)} waiting ·{' '}
            {number(report.reviewedConversations)} reviewed ·{' '}
            {number(report.dismissedProposals)} refused
          </dd>
        </div>
        <div>
          <dt>Skills</dt>
          <dd>
            {number(report.skills)} on disk · {number(report.skillVersions)}{' '}
            earlier versions
          </dd>
        </div>
        <div>
          <dt>Scheduled jobs</dt>
          <dd>{number(report.jobs)}</dd>
        </div>
      </dl>
      {report.unreadableLogs > 0 ? (
        <p className="settings-muted">
          {number(report.unreadableLogs)} v2 log
          {report.unreadableLogs === 1 ? '' : 's'} could not be read and{' '}
          {report.unreadableLogs === 1 ? 'is' : 'are'} not counted above.
        </p>
      ) : null}
      <div className="harness-versions">
        <h4>Recorded versions</h4>
        <p className="settings-muted">
          Restoring puts back this bot’s name, Role, Persona, tools, skills,
          connectors and model as they were. The Space, the icon and memory are
          left alone.
        </p>
        {report.versions.length === 0 ? (
          <p className="settings-muted">No versions recorded yet.</p>
        ) : (
          report.versions.slice(0, 10).map((version) => (
            <div className="harness-version" key={version.hash}>
              <span>
                {new Date(version.recordedAt).toLocaleString()} · v
                {version.harnessVersion} ·{' '}
                <code>{version.hash.slice(0, 10)}</code>
              </span>
              {confirming === version.hash ? (
                <span className="harness-version-actions">
                  <button
                    type="button"
                    className="button button-danger button-small"
                    disabled={restoring !== null}
                    onClick={() => {
                      setRestoring(version.hash);
                      void window.marimo
                        .call('harness.restore', {
                          profileId,
                          hash: version.hash,
                        })
                        .then(() => {
                          setRestoring(null);
                          setConfirming(null);
                          onRestored();
                          setNonce((value) => value + 1);
                        })
                        .catch((failure: unknown) => {
                          setRestoring(null);
                          setProblem(describe(failure));
                        });
                    }}
                  >
                    {restoring === version.hash ? 'Restoring…' : 'Restore'}
                  </button>
                  <button
                    type="button"
                    className="button button-quiet button-small"
                    disabled={restoring !== null}
                    onClick={() => {
                      setConfirming(null);
                    }}
                  >
                    Cancel
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  className="button button-quiet button-small"
                  onClick={() => {
                    setConfirming(version.hash);
                  }}
                >
                  Restore
                </button>
              )}
            </div>
          ))
        )}
      </div>
      <p className="settings-muted">
        Harness logs: <code>{report.paths.harnessSessions}</code>
        <br />
        Version ledger: <code>{report.paths.harnessVersions}</code>
      </p>
    </div>
  );
}

function SkillsCard({
  skills,
  granted,
  canWrite,
  disabled,
  onGrant,
  onSave,
  onRemove,
  onHistory,
  onRestore,
}: {
  skills: StoredSkill[];
  granted: Set<string>;
  canWrite: boolean;
  disabled: boolean;
  onGrant: (name: string, on: boolean) => void;
  onSave: (draft: SkillDraft, id?: string) => Promise<boolean>;
  onRemove: (id: string) => Promise<boolean>;
  onHistory: (id: string) => Promise<SkillHistoryEntry[] | null>;
  onRestore: (id: string, entryId: string) => Promise<boolean>;
}): React.JSX.Element {
  const [editing, setEditing] = useState<{
    id?: string;
    draft: SkillDraft;
  } | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [writing, setWriting] = useState(false);
  const [history, setHistory] = useState<{
    id: string;
    entries: SkillHistoryEntry[];
    error: string | null;
  } | null>(null);
  const [restoring, setRestoring] = useState<string | null>(null);

  const blank = (): SkillDraft => ({
    name: '',
    description: '',
    instructions: '',
  });
  const draft = editing?.draft;
  const ready =
    draft !== undefined &&
    draft.name.trim().length > 0 &&
    draft.description.trim().length > 0 &&
    draft.instructions.trim().length > 0 &&
    draft.description.length <= SKILL_DESCRIPTION_MAX &&
    draft.instructions.length <= SKILL_INSTRUCTIONS_MAX;
  const busy = disabled || writing;

  const save = async (): Promise<void> => {
    if (editing === null || !ready) {
      return;
    }
    setWriting(true);
    const saved = await onSave(
      {
        name: editing.draft.name.trim(),
        description: editing.draft.description.trim(),
        instructions: editing.draft.instructions.trim(),
      },
      editing.id,
    );
    setWriting(false);
    // On a refusal the draft stays open: the sentence at the top of Settings is
    // the explanation, and the text is the thing the person would otherwise have
    // to write again.
    if (saved) {
      setEditing(null);
    }
  };

  return (
    <div className="skills-card">
      <p className="settings-muted">
        A skill is instructions this bot loads when a task matches one. It sees
        each skill&rsquo;s name and one-line description in every conversation,
        and reads the procedure only when it needs it.
      </p>
      <p className="settings-why">
        {canWrite
          ? 'This bot may also write a skill itself: ask it to remember a way of working, or run /learn after a conversation.'
          : 'This bot cannot write a skill itself. Switch on “save_skill” above if you want it to, or write one here.'}
      </p>

      {editing === null ? (
        <div className="settings-row">
          <button
            type="button"
            className="button"
            disabled={disabled}
            onClick={() => {
              setEditing({draft: blank()});
            }}
          >
            New skill
          </button>
        </div>
      ) : (
        <div className="skills-editor">
          <label className="settings-field">
            <span>Name</span>
            <input
              className="settings-input"
              value={editing.draft.name}
              disabled={busy}
              placeholder="weekly-inbox-triage"
              onChange={(event) => {
                setEditing({
                  ...editing,
                  draft: {...editing.draft, name: event.target.value},
                });
              }}
            />
            <em className="settings-why">
              Short and kebab-case. It becomes the folder name and the name the
              bot loads.
            </em>
          </label>

          <label className="settings-field">
            <span>Description</span>
            <input
              className="settings-input"
              value={editing.draft.description}
              disabled={busy}
              maxLength={SKILL_DESCRIPTION_MAX}
              placeholder="Sort the inbox every Monday morning."
              onChange={(event) => {
                setEditing({
                  ...editing,
                  draft: {...editing.draft, description: event.target.value},
                });
              }}
            />
            <em className="settings-why">
              One line saying when to use it. This is what the bot sees on every
              turn, so keep it to the trigger.
            </em>
          </label>

          <label className="settings-field">
            <span>Instructions</span>
            <textarea
              className="settings-input skills-instructions"
              value={editing.draft.instructions}
              disabled={busy}
              maxLength={SKILL_INSTRUCTIONS_MAX}
              rows={12}
              placeholder={
                '1. Read the unread mail.\n2. Group it by sender.\n3. …'
              }
              onChange={(event) => {
                setEditing({
                  ...editing,
                  draft: {...editing.draft, instructions: event.target.value},
                });
              }}
            />
            <em className="settings-why">
              The procedure, in the imperative. This text is loaded only when
              the skill is used.
            </em>
          </label>

          <p className="settings-muted">
            {editing.draft.instructions.length.toLocaleString()} /{' '}
            {SKILL_INSTRUCTIONS_MAX.toLocaleString()} characters
          </p>

          <div className="settings-row">
            <button
              type="button"
              className="button"
              disabled={!ready || busy}
              onClick={() => {
                void save();
              }}
            >
              {editing.id === undefined ? 'Save skill' : 'Save changes'}
            </button>
            <button
              type="button"
              className="button button-quiet"
              disabled={busy}
              onClick={() => {
                setEditing(null);
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {skills.length === 0 ? (
        <p className="settings-muted">
          No skills yet. Write one above, or ask the bot to remember a way of
          working after a conversation.
        </p>
      ) : (
        <div className="skills-list">
          {skills.map((skill) => (
            <div className="skills-row" key={skill.id}>
              <label className="settings-check">
                <input
                  type="checkbox"
                  checked={granted.has(skill.name)}
                  disabled={disabled}
                  onChange={(event) => {
                    onGrant(skill.name, event.target.checked);
                  }}
                />
                <span>
                  <code className="settings-tool">{skill.name}</code>
                  <em className="settings-why">{skill.description}</em>
                </span>
              </label>
              <div className="skills-actions">
                <button
                  type="button"
                  className="button button-quiet"
                  disabled={disabled}
                  onClick={() => {
                    setEditing({
                      id: skill.id,
                      draft: {
                        name: skill.name,
                        description: skill.description,
                        instructions: skill.instructions,
                      },
                    });
                  }}
                >
                  Edit
                </button>
                <button
                  type="button"
                  className="button button-quiet"
                  disabled={busy}
                  onClick={() => {
                    if (history?.id === skill.id) {
                      setHistory(null);
                      return;
                    }
                    void onHistory(skill.id).then((entries) => {
                      setHistory(
                        entries === null
                          ? {
                              id: skill.id,
                              entries: [],
                              error: 'Could not read the saved versions.',
                            }
                          : {id: skill.id, entries, error: null},
                      );
                    });
                  }}
                >
                  History
                </button>
                {removing === skill.id ? (
                  <>
                    <button
                      type="button"
                      className="button button-quiet"
                      disabled={disabled}
                      onClick={() => {
                        void onRemove(skill.id).then((removed) => {
                          if (removed) {
                            setRemoving(null);
                          }
                        });
                      }}
                    >
                      Remove it
                    </button>
                    <button
                      type="button"
                      className="button button-quiet"
                      disabled={disabled}
                      onClick={() => {
                        setRemoving(null);
                      }}
                    >
                      Keep
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="button button-quiet"
                    disabled={disabled}
                    onClick={() => {
                      setRemoving(skill.id);
                    }}
                  >
                    Remove
                  </button>
                )}
              </div>
              {history?.id === skill.id && (
                <div className="skills-history">
                  {history.error !== null ? (
                    <p className="settings-muted">{history.error}</p>
                  ) : history.entries.length === 0 ? (
                    <p className="settings-muted">
                      No earlier versions yet. Each save keeps the body it
                      replaces.
                    </p>
                  ) : (
                    history.entries.map((entry) => (
                      <div className="skills-history-row" key={entry.id}>
                        <div>
                          <strong>
                            {new Date(entry.savedAt).toLocaleString()}
                          </strong>
                          <em className="settings-why">{entry.description}</em>
                          <p className="settings-muted">
                            {entry.instructions.slice(0, 240)}
                            {entry.instructions.length > 240 ? '…' : ''}
                          </p>
                        </div>
                        <button
                          type="button"
                          className="button button-quiet"
                          disabled={busy || restoring !== null}
                          onClick={() => {
                            setRestoring(entry.id);
                            void onRestore(skill.id, entry.id).then(
                              (restored) => {
                                setRestoring(null);
                                if (restored) {
                                  setHistory(null);
                                }
                              },
                            );
                          }}
                        >
                          {restoring === entry.id ? 'Restoring…' : 'Restore'}
                        </button>
                      </div>
                    ))
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ToolRow({
  tool,
  on,
  disabled,
  onChange,
}: {
  tool: CatalogTool;
  on: boolean;
  disabled: boolean;
  onChange: (tool: CatalogTool, on: boolean) => void;
}): React.JSX.Element {
  return (
    <label className="settings-check">
      <input
        type="checkbox"
        checked={on}
        disabled={disabled}
        onChange={(event) => {
          onChange(tool, event.target.checked);
        }}
      />
      <span>
        <code className="settings-tool">{tool.name}</code>
        <em className="settings-why">{tool.blurb}</em>
      </span>
    </label>
  );
}

/**
 * Which connectors an agent may use, as the switches are drawn.
 *
 * No list at all means every connector the install has switched on. That is the
 * schema's own meaning rather than a convenience: the field narrows a grant, so
 * its absence has to be the wide answer — read as "none", every agent written
 * before the field existed would come back able to reach nothing.
 *
 * A connector named by the agent's own list stays in this set even when it is
 * switched off at the install level, because the grant is not the connection:
 * unplugging a server for a while must not quietly cost the agents that were
 * allowed it, and the switch drawn beside it is disabled rather than absent so
 * that fact is visible.
 */
function grantedConnectors(
  connectors: readonly CatalogConnector[],
  profile: AgentProfile | undefined,
): Set<string> {
  const chosen = profile?.mcpServerIds;
  return new Set(
    connectors
      .filter((connector) =>
        chosen === undefined
          ? connector.enabled
          : chosen.includes(connector.id),
      )
      .map((connector) => connector.id),
  );
}

/**
 * One connector, as this agent's grant reaches it.
 *
 * Drawn like a tool, because it is the same decision: a connector that is not
 * ticked is not offered to the model. The one that differs is switched off at
 * the install level, and that one is an unavailable switch rather than a working
 * one — the app will not dial it, so a control that could be ticked would be a
 * promise nothing keeps. What it shows is the grant, which survives the server
 * being unplugged, and the line under it says so.
 */
function ConnectorRow({
  connector,
  on,
  disabled,
  onChange,
}: {
  connector: CatalogConnector;
  on: boolean;
  disabled: boolean;
  onChange: (connector: CatalogConnector, on: boolean) => void;
}): React.JSX.Element {
  return (
    <label className="settings-check">
      <input
        type="checkbox"
        checked={on}
        disabled={disabled || !connector.enabled}
        onChange={(event) => {
          onChange(connector, event.target.checked);
        }}
      />
      <span>
        <code className="settings-tool">{connector.name}</code>
        <em className="settings-why">
          {connector.enabled
            ? connector.blurb
            : `${connector.blurb} ${
                on
                  ? 'Switched off in the Connectors card, so it is not connected — this bot keeps its grant for when it is switched back on.'
                  : 'Switched off in the Connectors card, so no bot can use it. Turn it on there and it can be given to this one.'
              }`}
        </em>
      </span>
    </label>
  );
}

/**
 * Which icon this bot wears.
 *
 * Five shipped presets and one upload, in that order of reversibility. A preset
 * is a profile write with no file behind it; an upload is a picker in the main
 * process and one PNG in the user's data directory. Clearing goes back to the
 * default for this bot's place in the roster, which is what "no choice" means.
 *
 * The preview is the same component the rail draws, so what the user is choosing
 * is literally the picture that will appear beside the conversations.
 */
function BotIconChoices({
  profile,
  defaultPresetId,
  disabled,
  onPreset,
  onUpload,
  onClear,
}: {
  profile: AgentProfile;
  /** The preset this bot's place in the roster starts on. */
  defaultPresetId: string;
  disabled: boolean;
  onPreset: (presetId: string) => void;
  onUpload: () => void;
  onClear: () => void;
}): React.JSX.Element {
  const custom = profile.avatar?.kind === 'custom';
  const presetId =
    profile.avatar?.kind === 'preset' ? profile.avatar.id : undefined;
  const atDefault =
    profile.avatar === undefined || presetId === defaultPresetId;
  const presetLabel =
    BOT_AVATAR_PRESETS.find((preset) => preset.id === presetId)?.label ??
    'default';

  return (
    <div className="settings-field">
      <span>Icon</span>
      <em className="settings-why">
        What this bot looks like in the sidebar. Upload a PNG or JPEG, or choose
        one of the icons this app ships.
      </em>
      <div className="settings-avatar-current">
        <BotAvatar profile={profile} size="md" />
        <span className="settings-why">
          {custom
            ? 'Using the image you uploaded.'
            : `Using the ${presetLabel} icon.`}
        </span>
      </div>
      <BotIconGrid
        profile={profile}
        selectedId={presetId}
        disabled={disabled}
        onSelect={onPreset}
      />
      <div className="settings-row">
        <button
          type="button"
          className="button button-quiet"
          disabled={disabled}
          onClick={onUpload}
        >
          {custom ? 'Upload a different image…' : 'Upload an image…'}
        </button>
        {!atDefault && (
          <button
            type="button"
            className="button button-quiet"
            disabled={disabled}
            onClick={onClear}
          >
            Use the default icon
          </button>
        )}
      </div>
    </div>
  );
}

function Updates({
  opened,
  onToggle,
}: {
  opened: ReadonlySet<string>;
  onToggle: (title: string, expanded: boolean) => void;
}): React.JSX.Element {
  const [result, setResult] = useState<UpdateCheck | null>(null);
  const [checking, setChecking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const check = async (): Promise<void> => {
    setChecking(true);
    setProblem(null);
    try {
      setResult(await window.marimo.call('updates.check', {}));
    } catch (failure) {
      setProblem(describe(failure));
    } finally {
      setChecking(false);
    }
  };

  return (
    <SettingsSection title="Updates" opened={opened} onToggle={onToggle}>
      <p className="settings-muted">
        This build checks the published releases only when you ask. It does not
        download or install an update; a new version is a link you choose to
        open.
      </p>
      <div className="settings-row">
        <button
          type="button"
          className="button button-quiet"
          disabled={checking}
          onClick={() => {
            void check();
          }}
        >
          {checking ? 'Checking…' : 'Check for updates'}
        </button>
      </div>
      {problem !== null ? (
        <p className="settings-muted">{problem}</p>
      ) : result === null ? null : result.error !== undefined ? (
        <p className="settings-muted">{result.error}</p>
      ) : result.available ? (
        <p className="settings-muted">
          {result.latestVersion} is available; this build is{' '}
          {result.currentVersion}.{' '}
          {result.url === undefined ? null : (
            <a href={result.url} target="_blank" rel="noreferrer">
              Read the release
            </a>
          )}
        </p>
      ) : (
        <p className="settings-muted">
          This build is {result.currentVersion}
          {result.latestVersion === undefined
            ? '.'
            : `, and ${result.latestVersion} is the latest published release.`}
        </p>
      )}
    </SettingsSection>
  );
}
