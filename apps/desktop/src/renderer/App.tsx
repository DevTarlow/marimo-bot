/**
 * The window.
 *
 * A rail of conversations, the conversation, and the composer. The shape is
 * deliberately the familiar one: an assistant you talk to is not a place to
 * invent a layout, and every departure from the shape people already know is a
 * thing they have to learn before they can ask a question.
 *
 * The theme switch is a preview for now — the preference is a settings write
 * that lands with Settings — but the tokens underneath it are the real ones, so
 * what it previews is what will ship.
 */
import {useCallback, useEffect, useRef, useState} from 'react';

import {COMMAND_IDS, COMMANDS, PROVIDERS, THEME_MODES} from '@marimo/protocol';
import type {
  AgentModel,
  AppInfo,
  ProfileCatalog,
  PublicSettings,
  Theme,
  ThemeMode,
} from '@marimo/protocol';

import {Composer} from './components/Composer.js';
import {Documents} from './components/Documents.js';
import {NewBotDialog} from './components/NewBotDialog.js';
import {Onboarding} from './components/Onboarding.js';
import {Participants} from './components/Participants.js';
import {RecallIntro} from './components/RecallIntro.js';
import {Search} from './components/Search.js';
import {Settings, PROVIDER_SECTION} from './components/Settings.js';
import {Setup} from './components/Setup.js';
import {Transcript} from './components/Transcript.js';
import {WorkspaceRail} from './components/WorkspaceRail.js';
import {firstRunScreen} from './first-run.js';
import type {FirstRunPhase} from './first-run.js';
import {useAgent} from './hooks/useAgent.js';
import {modelChoicesFor} from './model-search.js';
import {sessionMembers} from './participants.js';
import {recallOfferOnRead} from './recall-offer.js';
import {spaceForSession} from './workspace-groups.js';

import './styles/chat.css';

export function App(): React.JSX.Element {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  /**
   * The section Settings should open on, when something sent the user there.
   *
   * The composer's model picker is the caller that exists: a conversation pinned
   * to a provider nobody has fetched can offer that provider's names only as
   * placeholders, and the one button that asks an endpoint what it serves — Fetch
   * Models — lives in the Provider card. Landing on eight folded headings would
   * leave the user to finish the route they were just sent down.
   */
  const [settingsSection, setSettingsSection] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  /**
   * The New bot dialog, opened from the rail or from Settings' own button.
   *
   * A dialog rather than a screen: making a bot is one form, and taking the
   * conversation out of the window for it would be a bigger interruption than
   * the thing being made.
   */
  const [newBotOpen, setNewBotOpen] = useState(false);
  /**
   * The starter roles and tool names the dialog needs.
   *
   * Read once, beside settings, because the rail's `+` has to be ready before
   * it is pressed. Settings reads the same catalogue on its own; sharing it
   * through the window would mean a payload shaped for two consumers.
   */
  const [catalog, setCatalog] = useState<ProfileCatalog | null>(null);
  /**
   * Whether the documents drawer is open.
   *
   * The window's rather than the drawer's, because the drawer's column only
   * exists while it is open: the grid that lays the window out reads this.
   */
  const [documents, setDocuments] = useState(false);
  /**
   * Whether the recall offer is up.
   *
   * Shown at the one moment somebody is watching a download finish, and only
   * then: this is not a nag kept in a store, it is the second half of the first
   * run. A later launch — or a user who answered it — finds the switch in
   * Settings, where every other capability lives.
   */
  const [recallIntro, setRecallIntro] = useState(false);
  /**
   * The settings as the window needs them for the first-run question.
   *
   * Fetched here rather than inside `useAgent` because it is a fact about the
   * *pane*, not about the conversation: the agent is perfectly happy to hold a
   * conversation it cannot yet answer.
   */
  const [settings, setSettings] = useState<PublicSettings | null>(null);
  /**
   * Where this window is in the setup flow.
   *
   * The flow's own last step is what turns `modelReady` true, so the screen
   * cannot be recomputed from settings alone: saving a key would take the flow
   * away between the save and the sentence saying it worked. `inSetup` is that
   * latch, and `left` is the flow having closed, however it closed.
   */
  const [setupPhase, setSetupPhase] = useState<FirstRunPhase>('unknown');
  const agent = useAgent();

  /*
   * Stable, because an effect below depends on it: a function rebuilt on every
   * render would re-run that effect on every render, and this one writes state.
   */
  const loadSettings = useCallback((): void => {
    void window.marimo
      .call('settings.get', {})
      .then(({settings: loaded}) => {
        setSettings(loaded);
      })
      .catch(() => {
        // A settings read that fails is already reported by Settings itself; an
        // error here would be a second one over the conversation.
      });
  }, []);

  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  /*
   * The rail's New bot button is disabled until this lands rather than opening
   * a dialog with no starter roles in it. A failed read is not reported here:
   * Settings' own New bot dialog depends on the same call, so if it is broken the
   * app has a bigger problem than one button, and an error banner about it would
   * sit over the conversation with nothing the user could do.
   */
  useEffect(() => {
    let cancelled = false;
    void window.marimo
      .call('profiles.catalog', {})
      .then((loaded) => {
        if (!cancelled) {
          setCatalog(loaded);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  /*
   * Escape closes the New bot dialog from anywhere in it. A listener on the
   * window rather than a handler on the panel because the panel does not take
   * focus by itself, and a dialog whose only exit is the mouse is not a dialog.
   */
  useEffect(() => {
    if (!newBotOpen) {
      return;
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setNewBotOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [newBotOpen]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const value = await window.marimo.call('app.info', {});
        if (!cancelled) {
          setInfo(value);
        }
      } catch {
        // The agent surface reports its own failures; a missing version line is
        // not worth a second error on screen.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /*
   * The tray's Settings command. Written as an effect keyed on a counter rather
   * than handled inside the event listener, because the listener is registered
   * once and `setShowSettings` from inside it would be a second source of truth
   * about what the window is showing.
   */
  useEffect(() => {
    if (agent.openSettings > 0) {
      setShowSettings(true);
    }
  }, [agent.openSettings]);

  /*
   * `Ctrl/Cmd+K`, on the window rather than globally.
   *
   * An OS-wide hotkey works from any application, which is a decision about
   * somebody's whole desktop rather than about this app — and it is the kind of
   * thing that is far easier to add later than to explain away.
   */
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setSearching((open) => !open);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, []);

  /*
   * What the colours actually are.
   *
   * `system` is resolved against what the OS reported, so a machine that
   * switches to dark at sunset takes the window with it — which is the whole
   * point of the preference not being a boolean.
   */
  const theme: Theme =
    agent.themeMode === 'system' ? (info?.theme ?? 'dark') : agent.themeMode;
  useEffect(() => {
    document.documentElement.dataset['theme'] = theme;
  }, [theme]);

  /** Writes the preference. The event that comes back is what moves the switch. */
  const setThemeMode = (mode: ThemeMode): void => {
    void window.marimo
      .call('settings.set', {patch: {appearance: {theme: mode}}})
      .catch(() => undefined);
  };

  /*
   * The window's density is fixed now. It used to follow the simple/power
   * setting, and the only reason the compact scale existed was to keep the
   * power screen looking like the app always had. One screen means one scale;
   * `main.tsx` sets it before the first paint, and the companion keeps the
   * compact values because it is a fixed 340×460 bubble that measured them.
   */

  const busy = agent.busy;
  const disabled = agent.profile === undefined;

  /*
   * Who is in the open conversation, and which of them leads it.
   *
   * `agentIds` absent is a chat with one agent — the one that owns it — which is
   * every conversation written before groups existed. The lead is the first
   * member: the voice the conversation's own bubbles are in, the agent that
   * answers a message nobody addressed, and the one whose answers need no label.
   */
  const openSession = agent.sessions.find(
    (entry) => entry.id === agent.sessionId,
  );
  const members = sessionMembers({
    agentIds: openSession?.agentIds,
    ownerId: agent.profile?.id,
    agents: agent.agents,
  });
  const leadId = members[0]?.id;
  /*
   * Who a message may be addressed to: the members the roster still holds. An
   * `@` naming a deleted agent is one that could only be refused, and a list of
   * one is not a choice — with either, the composer draws no picker at all.
   */
  const mentionable = members.filter((member) => member.known);

  /*
   * The Space the documents drawer is about: the one the open conversation
   * works in, falling back to the one the rail is on. The same function that
   * answers the folder printed in the header, so the drawer cannot list a
   * folder other than the one named directly above its button.
   */
  const space = spaceForSession({
    workspaces: agent.workspaces,
    sessions: agent.sessions,
    sessionId: agent.sessionId,
    activeWorkspaceId: agent.activeWorkspaceId,
  });

  /*
   * Which model will answer, and where that choice lives.
   *
   * Three levels, resolved in one order: the conversation's own choice, then its
   * agent's, then the app's. `SessionSummary.model` and `AgentProfile.model` are
   * both absent until somebody picks one, so the picker needs the pair of facts —
   * what will answer, and whether there is a choice here to give up.
   *
   * A pair rather than an id throughout. The composer's list comes from one
   * provider's catalogue, so the pair is what says which endpoint a chosen id
   * belongs to; a bare string would let the same name from two services be
   * swapped for one another silently.
   */
  const sessionModel = agent.sessions.find(
    (entry) => entry.id === agent.sessionId,
  )?.model;
  const agentModel = agent.profile?.model;
  const appModel: AgentModel | undefined =
    settings === null
      ? undefined
      : {
          provider: settings.providers.active,
          model: settings.providers.configs[settings.providers.active].model,
        };
  const currentModel = sessionModel ?? agentModel ?? appModel;
  /*
   * The list the picker chooses within, and it is *this choice's* provider's.
   *
   * The resolution chain above has already decided which endpoint answers, so
   * what the control offers is that endpoint's models: the ones it reported when
   * the app has asked it, and the catalogue's names with `fetched: false` until
   * then. Reading the active provider's list here instead was the bug — an agent
   * or a conversation pinned elsewhere was handed an empty list belonging to an
   * endpoint it was not using.
   */
  const choices =
    currentModel === undefined
      ? undefined
      : modelChoicesFor(
          settings?.availableModels ?? {},
          currentModel.provider,
          currentModel.model,
        );
  /*
   * The provider behind those names, when nobody has asked it what it serves.
   *
   * Two things follow from it and both are about not stating a guess as an
   * answer: the picker says the names are this build's, and it offers the route
   * to the one control that can replace them — Fetch Models, which lives in the
   * Provider card because that is where the key it needs is.
   *
   * Nothing is claimed before the payload arrives: "nobody has asked" is a fact
   * about a settings file, and a window that had not read one yet would be saying
   * it about every provider it knows.
   */
  const unfetchedProvider =
    currentModel !== undefined &&
    settings !== null &&
    choices?.fetched === false
      ? currentModel.provider
      : undefined;
  const modelHint =
    unfetchedProvider === undefined
      ? undefined
      : `${PROVIDERS[unfetchedProvider].label} has not been asked what it ` +
        'serves yet, so these are the names this build ships with.';
  /*
   * What a model the conversation did not choose falls back to, in one word for
   * the trigger. Absent is meaningful: it says this conversation has a choice of
   * its own, which is the only state in which giving it up changes anything.
   */
  const inherited =
    sessionModel !== undefined
      ? undefined
      : agentModel !== undefined
        ? 'bot'
        : 'default';

  /*
   * The transition, not the state. `settings.modelReady` is true on every launch
   * for anybody who has used the app, and offering recall to somebody who is
   * already using it would be the nag this is shaped to avoid — so the offer
   * belongs to the moment it goes from false to true, which is the first run
   * being pointed at a provider that answers.
   *
   * What `wasReady` may not record is the `false` a payload that has not arrived
   * yet produces, or every launch looks like that transition. It is written only
   * once there is a payload to have an opinion about, and the decision itself is
   * in `recall-offer.ts` where it can be tested.
   */
  const modelReady = settings?.modelReady ?? false;
  const wasReady = useRef<boolean | null>(null);
  useEffect(() => {
    const read = recallOfferOnRead({
      loaded: settings !== null,
      wasReady: wasReady.current,
      modelReady,
      enabled: settings?.recall.enabled ?? false,
      introSeen: settings?.recall.introSeen ?? false,
    });
    if (read.offer) {
      setRecallIntro(true);
    }
    wasReady.current = read.remember;
  }, [modelReady, settings]);

  /*
   * Which screen the window is on, in one place.
   *
   * The flow, the short card and the chat are three answers to one question, and
   * the decision lives in `first-run.ts` because this package has no DOM test
   * environment: what is worth testing is the arithmetic, not the markup around
   * it.
   */
  const screen = firstRunScreen({
    loaded: settings !== null,
    modelReady,
    setupSeen: settings?.setupSeen ?? false,
    phase: setupPhase,
  });
  /*
   * The latch, set once the decision has said `setup`: from then on the flow
   * stays up until it closes itself, whatever its own writes do to `modelReady`.
   */
  useEffect(() => {
    if (screen === 'setup' && setupPhase === 'unknown') {
      setSetupPhase('inSetup');
    }
  }, [screen, setupPhase]);

  /**
   * What happens when the flow closes, either way.
   *
   * The flag is what makes the flow a first run rather than a screen that
   * returns whenever the app cannot answer: somebody who deferred gets the short
   * card next time, which names the problem and opens the one place that fixes
   * it. Not awaited and its failure not reported, for the reason the recall flag
   * is not: the worst outcome is the flow being offered once more after a later
   * launch, and an error about a flag the user never asked to see would be worse.
   *
   * The pane is reloaded behind it because bots were made here and a Space may
   * have been loaded, and neither is something the conversation hook notices by
   * itself.
   */
  const closeSetup = (): void => {
    setSetupPhase('left');
    void window.marimo
      .call('settings.set', {patch: {setupSeen: true}})
      .then(({settings: saved}) => {
        setSettings(saved);
      })
      .catch(() => undefined);
    void agent.reload();
  };

  /**
   * Leaves the setup flow in the conversation that builds a bot.
   *
   * Deliberately **not** `closeSetup` followed by a reload: that reload would
   * land on the newest conversation of the lead, which is a different chat from
   * the one that was just created. The purpose is stored on the session, so all
   * this has to do is make sure the lead is the active bot, start the session,
   * and let the latch down. A failure goes back to the Setup with a sentence.
   */
  const startBuilderFromSetup = async (): Promise<{
    ok: boolean;
    problem?: string;
  }> => {
    if (settings === null) {
      return {ok: false, problem: 'The settings have not loaded yet.'};
    }
    const lead = settings.profiles[0];
    if (lead === undefined) {
      return {ok: false, problem: 'This install has no bot to talk to.'};
    }
    try {
      if (settings.activeProfileId !== lead.id) {
        await agent.selectProfile(lead.id);
      }
      const started = await agent.startBotBuilder();
      if (!started.ok) {
        return started;
      }
      setSetupPhase('left');
      void window.marimo
        .call('settings.set', {patch: {setupSeen: true}})
        .then(({settings: saved}) => {
          setSettings(saved);
        })
        .catch(() => undefined);
      return {ok: true};
    } catch (failure) {
      return {
        ok: false,
        problem: failure instanceof Error ? failure.message : String(failure),
      };
    }
  };

  /**
   * The handoff every "talk it through" button makes: make the lead active,
   * start the builder, then let the caller close whatever screen it came from.
   *
   * The screens differ only in how they get out of the way — Settings closes
   * itself and the rail closes its dialog — so the part that can fail is here,
   * once, and a refusal stays in the dialog under the button.
   */
  const handOffToBuilder = async (
    after: () => void,
  ): Promise<{ok: boolean; problem?: string}> => {
    if (settings === null) {
      return {ok: false, problem: 'The settings have not loaded yet.'};
    }
    const lead = settings.profiles[0];
    if (lead === undefined) {
      return {ok: false, problem: 'This install has no bot to talk to.'};
    }
    try {
      if (settings.activeProfileId !== lead.id) {
        await agent.selectProfile(lead.id);
      }
      const started = await agent.startBotBuilder();
      if (!started.ok) {
        return started;
      }
      after();
      return {ok: true};
    } catch (failure) {
      return {
        ok: false,
        problem: failure instanceof Error ? failure.message : String(failure),
      };
    }
  };

  /** The same handoff from Settings, which closes itself. */
  const startBuilderFromSettings = async (): Promise<{
    ok: boolean;
    problem?: string;
  }> =>
    await handOffToBuilder(() => {
      setShowSettings(false);
      setSettingsSection(null);
      void loadSettings();
    });

  /** And from the rail's New bot dialog, which is an overlay in the window. */
  const startBuilderFromRail = async (): Promise<{
    ok: boolean;
    problem?: string;
  }> =>
    await handOffToBuilder(() => {
      setNewBotOpen(false);
      void loadSettings();
    });

  /**
   * Offers the flow again, from the short card.
   *
   * The latch goes back to `inSetup` rather than to `unknown`, so the flow is on
   * screen this render instead of waiting for a decision to be recomputed, and
   * the flag is cleared so a later launch does not put the card back in its
   * place. A failure of that write is not reported, for the reason the other two
   * flag writes are not: the worst outcome is the flow being offered once more
   * after a restart.
   */
  const restartSetup = (): void => {
    setSetupPhase('inSetup');
    void window.marimo
      .call('settings.set', {patch: {setupSeen: false}})
      .then(({settings: saved}) => {
        setSettings(saved);
      })
      .catch(() => undefined);
  };

  /*
   * The commands the `+` menu offers: the catalogue filtered by what the user
   * has switched off. Drawn from the protocol constant rather than from a list
   * here, so the menu and the Settings switches cannot describe different sets.
   */
  const disabledCommands = settings?.disabledCommands ?? [];
  const commands = COMMAND_IDS.filter(
    (id) => !disabledCommands.includes(id),
  ).map((id) => ({id, ...COMMANDS[id]}));

  /*
   * It stays up until the user answers *it*, rather than disappearing the moment
   * the setting flips: pressing "Turn on Recall" starts a 310 MB download, and
   * dropping somebody into the app mid-download would leave them with no sign it
   * is happening. The screen's own buttons close it.
   *
   * Deferred, and only deferred, while the setup flow is up. That flow's own
   * provider step is what raises this offer, and drawing a second full-window
   * question over the step that just made it would hide the sentence saying the
   * key worked. The offer is already standing by the time the flow closes, so
   * this is a pause rather than a lost question.
   */
  if (
    recallIntro &&
    settings !== null &&
    screen !== 'setup' &&
    agent.sessionPurpose !== 'bot-builder'
  ) {
    return (
      <RecallIntro
        onDone={() => {
          setRecallIntro(false);
          /*
           * Answering it, either way, is what makes it once. The write is not
           * awaited and its failure is not reported: the worst outcome is the
           * card being offered again after a later launch, and an error over the
           * conversation about a flag the user never asked to see would be worse
           * than that.
           */
          void window.marimo
            .call('settings.set', {patch: {recall: {introSeen: true}}})
            .then(({settings: saved}) => {
              setSettings(saved);
            })
            .catch(() => undefined);
        }}
      />
    );
  }

  if (showSettings) {
    return (
      <Settings
        onClose={() => {
          setShowSettings(false);
          // Cleared with the dialog: the next visit is the user's own, and a
          // section opened for them once must not keep opening itself.
          setSettingsSection(null);
          /*
           * The pane is re-read on the way back. A grant changed in Settings is
           * not visible in the conversation, and coming back to a window built
           * from settings that no longer apply is how a change looks like it did
           * not take.
           */
          void agent.reload();
          loadSettings();
        }}
        {...(settingsSection === null ? {} : {openSection: settingsSection})}
        lastReview={agent.lastReview}
        onStartBotBuilder={startBuilderFromSettings}
        {...(info === null ? {} : {userDataFolder: info.userData})}
      />
    );
  }

  return (
    <div className="app" data-documents={documents ? 'open' : undefined}>
      <Search
        open={searching}
        onClose={() => {
          setSearching(false);
        }}
      />

      {newBotOpen && catalog !== null && settings !== null && (
        <div
          className="new-bot-backdrop"
          role="dialog"
          aria-modal="true"
          aria-label="New bot"
          onClick={(event) => {
            // A click on the dim area closes it; a click inside must not.
            if (event.target === event.currentTarget) {
              setNewBotOpen(false);
            }
          }}
        >
          <NewBotDialog
            templates={catalog.botTemplates}
            {...(catalog.delegationTool === undefined
              ? {}
              : {delegationTool: catalog.delegationTool})}
            {...(catalog.builderTool === undefined
              ? {}
              : {builderTool: catalog.builderTool})}
            lead={settings.profiles[0]}
            onCreated={async () => {
              setNewBotOpen(false);
              /*
               * `profiles.create` switched the active bot to the one just made,
               * which is the rule the store has had since the beginning. A
               * reload lands on that bot's newest conversation, so the person is
               * looking at what they made rather than at the chat they left.
               */
              await agent.reload();
              loadSettings();
            }}
            onStartBuilder={startBuilderFromRail}
            onClose={() => {
              setNewBotOpen(false);
            }}
          />
        </div>
      )}

      <WorkspaceRail
        bots={agent.agents}
        activeProfileId={agent.profile?.id ?? null}
        workspaces={agent.workspaces}
        sessions={agent.sessions}
        activeSessionId={agent.sessionId}
        activeWorkspaceId={agent.activeWorkspaceId}
        disabled={disabled}
        onSelectProfile={(profileId) => {
          void agent.selectProfile(profileId);
        }}
        onNewBot={() => {
          setNewBotOpen(true);
        }}
        onOpenSession={(id) => {
          void agent.open(id);
        }}
        onNewSession={(workspaceId) => {
          void agent.newSession(workspaceId);
        }}
        onSelectWorkspace={(workspaceId) => {
          void agent.selectWorkspace(workspaceId);
        }}
        onLoadWorkspace={() => {
          void agent.loadWorkspace();
        }}
        onRenameWorkspace={(workspaceId, name) => {
          void agent.renameWorkspace(workspaceId, name);
        }}
        onRemoveWorkspace={(workspaceId) => {
          void agent.removeWorkspace(workspaceId);
        }}
        onOpenWorkspace={(workspaceId) => {
          void agent.openWorkspace(workspaceId);
        }}
        onMoveSession={(sessionId, workspaceId) => {
          void agent.moveSession(sessionId, workspaceId);
        }}
        onRenameSession={(sessionId, title) => {
          void agent.renameSession(sessionId, title);
        }}
        onDeleteSession={(sessionId) => {
          void agent.removeSession(sessionId);
        }}
      />

      <main className="main">
        <header className="head">
          <img className="head-mark" src="./marimo-logo.png" alt="" />
          <div className="head-who">
            <h1 className="head-name">
              {/*
                The conversation's own name: one agent, or the group's members
                with the lead first. Read from the members rather than from the
                active agent, because the two stop agreeing the moment a chat has
                a second one in it.
              */}
              {members.length > 0
                ? members.map((member) => member.name).join(', ')
                : 'Marimo Bot'}
            </h1>
            {info !== null && (
              <p className="head-sub">
                {info.name} v{info.version}
              </p>
            )}
            {/*
              Where this conversation works, moved out of Settings and onto the
              surface it is about. It is the open chat's space rather than the
              current one: a conversation remembers the space it was started in,
              and the two differ the moment another space is picked.
            */}
            {agent.activeFolder !== null && (
              <p className="head-sub head-workspace" title={agent.activeFolder}>
                {agent.activeFolder}
              </p>
            )}
          </div>
          <Participants
            members={members}
            agents={agent.agents}
            onAdd={(agentIds) => {
              const sessionId = agent.sessionId;
              if (sessionId !== null) {
                void agent.setParticipants(sessionId, agentIds);
              }
            }}
          />
          <button
            type="button"
            className="button button-quiet button-small"
            title="Search your space and memory (Ctrl+K)"
            onClick={() => {
              setSearching(true);
            }}
          >
            Search
          </button>
          <button
            type="button"
            className="button button-quiet button-small"
            title="The markdown files in this Space"
            /* Pressed is open: the same button closes it, which is what the
               `aria-expanded` says to anything that cannot see the column. */
            aria-expanded={documents}
            onClick={() => {
              setDocuments((shown) => !shown);
            }}
          >
            Documents
          </button>
          {/*
            The dot, and the whole reason the memory review is a feature rather
            than a setting: a suggestion nobody is told about only exists if the
            user happens to reopen a dialog. It is a dot rather than a count
            because nothing here needs acting on, and it is cleared when the
            dialog opens — the panel is where the list is, and the user is looking
            at it.
          */}
          <button
            type="button"
            className="button button-quiet button-small head-settings"
            title={
              agent.memoryWaiting > 0
                ? `${String(agent.memoryWaiting)} thing(s) worth remembering are waiting in Settings`
                : 'Settings'
            }
            onClick={() => {
              agent.clearMemoryWaiting();
              setShowSettings(true);
            }}
          >
            Settings
            {agent.memoryWaiting > 0 && (
              <span className="head-dot" aria-hidden="true" />
            )}
          </button>
          <div className="head-theme" role="group" aria-label="Theme">
            {THEME_MODES.map((mode) => (
              <button
                key={mode}
                type="button"
                className="theme-button"
                /* Pressed means "this is the preference", not "this is the
                   colour" — with `system` chosen, neither Light nor Dark is
                   pressed even though one of them is what you are looking at. */
                aria-pressed={agent.themeMode === mode}
                onClick={() => {
                  setThemeMode(mode);
                }}
              >
                {mode}
              </button>
            ))}
          </div>
        </header>

        {info?.warning !== undefined && (
          /*
           * Shown, not dismissible, and not styled as a failure: the app works
           * and one thing will not. A user who closes it has lost the only
           * explanation they would ever get for a job that never fires.
           */
          <div className="warning" role="status">
            <span>{info.warning}</span>
          </div>
        )}

        {agent.error !== null && (
          <div className="error" role="alert">
            <span>{agent.error}</span>
            <button
              type="button"
              className="button button-quiet button-small"
              onClick={agent.dismissError}
            >
              Dismiss
            </button>
          </div>
        )}

        {!agent.ready || screen === 'waiting' ? (
          /*
           * Nothing is drawn until the window knows which of its three screens
           * it is on. `waiting` is the moment before the first settings read
           * lands, which happens on every launch, and the flow is decided from
           * that payload — so anything here would be a guess, and the guess for
           * a fresh install is a chat it cannot answer in.
           */
          <p className="loading">Starting…</p>
        ) : settings !== null && screen === 'setup' ? (
          /*
           * The flow, once, for somebody who has not been through it.
           *
           * It replaces the conversation rather than sitting over it, because
           * there is no conversation yet: the chat behind it is the empty one
           * this window opened on, and the point of the flow is to make the app
           * able to answer before anybody is invited to type.
           */
          <Setup
            settings={settings}
            agent={agent}
            onSettings={setSettings}
            onStartBuilder={startBuilderFromSetup}
            onClose={closeSetup}
          />
        ) : screen === 'cannotAnswer' ? (
          /*
           * Asked before it is needed, rather than after. The refusal a turn
           * gives is honest and in the right place — but it is the *second*
           * thing a new user learns, and the first should have been the reason.
           *
           * There is no bundled model to wait for: what stops this install
           * answering is a provider that has no key, a key that cannot be read,
           * or an address nothing is listening on, and the sentence saying which
           * is written by the process that looked.
           *
           * This is the screen for somebody who has already met the flow and
           * still cannot answer — they deferred it, or their key stopped being
           * readable — which is why it offers Settings rather than the flow.
           */
          <Onboarding
            problem={
              settings?.modelProblem ??
              'The app has no way to answer yet. Settings will say what is missing.'
            }
            onOpenSettings={() => {
              setShowSettings(true);
            }}
            onRestart={restartSetup}
          />
        ) : (
          <Transcript
            messages={agent.messages}
            outbox={agent.outbox}
            live={agent.live}
            delegations={agent.delegations}
            agents={settings?.profiles ?? agent.agents}
            leadId={leadId}
            pending={agent.pending}
            onDecide={(callId, confirmed) => {
              void agent.decide(callId, confirmed);
            }}
            onFeedback={agent.noteCorrection}
            onBotCreated={(next) => {
              /*
               * Only the roster changed. A full `agent.reload()` would land on
               * the lead's newest conversation, which after making a bot is not
               * necessarily the builder conversation the card is in; the person
               * is reading that thread and should stay in it.
               */
              setSettings((current) =>
                current === null
                  ? current
                  : {
                      ...current,
                      profiles: next.profiles,
                      activeProfileId: next.activeProfileId,
                    },
              );
            }}
            builder={agent.sessionPurpose === 'bot-builder'}
            busy={busy}
          />
        )}

        {/*
          No box to type in until something can answer. The composer is the one
          control that promises a reply, so it appears with the reply rather than
          before it — an install with no provider, or a key that cannot be read,
          would otherwise offer a field whose every message ends in the same
          refusal.

          Which means the two states that cannot answer do not draw it at all,
          including the setup flow's own steps: the wizard is what turns that
          around, and a box beside it would be the thing it is there to replace.
        */}
        {screen === 'app' && (
          <Composer
            busy={busy}
            disabled={disabled || !agent.ready}
            model={currentModel}
            models={choices?.models ?? []}
            {...(modelHint === undefined ? {} : {modelHint})}
            {...(unfetchedProvider === undefined
              ? {}
              : {
                  modelAction: {
                    /*
                     * Named, because the card it opens shows the *app's* provider
                     * and the one that needs fetching is whichever this
                     * conversation answers through: a row saying only "in
                     * Settings" would leave the user to work out which of five
                     * entries the button they were sent to belongs to.
                     */
                    label:
                      `Fetch ${PROVIDERS[unfetchedProvider].label} models ` +
                      'in Settings…',
                    onUse: () => {
                      setSettingsSection(PROVIDER_SECTION);
                      setShowSettings(true);
                    },
                  },
                })}
            inherited={inherited}
            onSelectModel={async (model) => {
              const sessionId = agent.sessionId;
              if (sessionId !== null) {
                await agent.setSessionModel(sessionId, model);
              }
            }}
            /*
             * Asked for by conversation, not by space: the main process judges
             * every picked file against the space *this* conversation works in —
             * the same one its turn's file tools are confined to — so a file the
             * window would happily attach is one the agent can actually read.
             */
            onPickFiles={async () => {
              const profile = agent.profile;
              const sessionId = agent.sessionId;
              if (profile === undefined || sessionId === null) {
                throw new Error(
                  'There is no conversation open to attach a file to.',
                );
              }
              const {files, skipped} = await window.marimo.call('files.pick', {
                profileId: profile.id,
                sessionId,
              });
              return {files, skipped};
            }}
            commands={commands}
            participants={mentionable}
            onRunCommand={async (id) => {
              const profile = agent.profile;
              const sessionId = agent.sessionId;
              if (profile === undefined || sessionId === null) {
                throw new Error('There is no conversation open to act on.');
              }
              switch (id) {
                case 'compact': {
                  const result = await window.marimo.call('sessions.compact', {
                    profileId: profile.id,
                    sessionId,
                  });
                  /*
                   * Re-read before answering, so the note and the card appear
                   * together: the card *is* the news, and a sentence saying the
                   * conversation was compacted over a transcript that still shows
                   * the old messages is a window contradicting itself.
                   */
                  await agent.refresh();
                  return result.compacted ? null : (result.reason ?? null);
                }
              }
            }}
            onSend={async (text, agentId) =>
              await agent.send(text, 'window', agentId)
            }
            onStop={() => {
              void agent.stop();
            }}
          />
        )}
      </main>

      {/*
        The third column. Rendered after the conversation rather than inside it,
        because it is a column of the window and not a part of the transcript —
        and it is the only thing in that column.
      */}
      <Documents
        open={documents}
        space={space}
        profileId={agent.profile?.id}
        sessionId={agent.sessionId}
        sessionTitle={openSession?.title}
        /*
         * Whether there is a conversation to write down. Stored messages rather
         * than the live turn: `docs.saveChat` reads the conversation from disk,
         * so a chat whose first turn has not landed yet has nothing to save.
         */
        hasConversation={agent.messages.length > 0}
        onClose={() => {
          setDocuments(false);
        }}
      />
    </div>
  );
}
