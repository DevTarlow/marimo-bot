/**
 * The first run, as a branching set of steps rather than a fixed list.
 *
 * A fresh install is missing several things at once, and they are not all
 * worth asking about: it needs a model that answers, a folder to work in, and
 * perhaps a bot, a picture model, a voice, or a job timer. So the flow asks two
 * questions first and then draws only the steps those answers call for. The
 * step graph itself is in `setup-nav.ts`; this component is the machine that
 * holds the answers and performs the writes.
 *
 * The rules that shape it:
 *
 * - **The direction is the control question.** Regular setup writes the
 *   Standard grant and Power writes the Power user grant — the same
 *   `enabledTools` the switches in Settings show. The direction also decides
 *   how much of the flow exists, but it is not a mode: there is no settings
 *   field for it, and every switch stays on the one Settings screen.
 * - **The goals grant nothing.** They choose the suggested starter role, the
 *   optional model downloads and the jobs step. A goal that needs a tool the
 *   current direction does not have is drawn and disabled rather than silently
 *   writing a grant.
 * - **The model is the only required step.** Until the text model is on disk
 *   and the engine can load it, the window offers no message box at all.
 *   Pictures and voice are optional even when a goal asked for them; the jobs
 *   service is optional even when automation asked for it.
 * - **The bot step is conditional.** A person who only wants chat, files,
 *   pictures or voice is not asked to make a bot. The finish step says where
 *   the `+` is.
 * - **It writes as it goes.** Every control writes the moment it is used,
 *   exactly as Settings does, so quitting mid-flow loses only the answers that
 *   were not yet applied.
 * - **Every step is in the resolved list, and every step but the first has a
 *   Back.** `previousStage` reads that list, so a step cannot be on screen
 *   without being on the path, and Persona backs to the bot list rather than to
 *   the form that would make a second bot.
 * - **A bot exists before its Persona is asked about.** The bot step creates
 *   the profile and the step after it edits what now exists, which is why
 *   backing out of that second step returns to the list of bots.
 * - **The Role is shown, not edited.** It is the app's brief for the bot and the
 *   thing that shapes how it works with the others, so the Persona step displays
 *   it greyed with a caution and points at Settings for a change.
 * - **It reads what already exists.** A model already loaded, bots already made,
 *   a service already installed: the steps say so and move on rather than
 *   creating a second copy of anything.
 * - **The lead is put back.** `profiles.create` switches the active profile, so
 *   every bot made here is followed by a `select` back to Marimo Bot.
 * - **Finishing lands where the person chose.** A Space picked here is where the
 *   window opens a new chat when the flow closes; `landingSpaceAfterSetup` is
 *   the rule.
 *
 * The model step, the optional extras, the jobs switch and the review are their
 * own components; the two bot-creation forms are in `SetupBots.tsx`.
 */
import {useCallback, useEffect, useState} from 'react';

import {defaultBotAvatarFor} from '@marimo/protocol';
import type {
  AgentProfile,
  BotDraft,
  CapabilityPreset,
  ProfileCatalog,
  PublicSettings,
} from '@marimo/protocol';

import {chosenPreset} from '../capabilities.js';
import {describe} from '../describe.js';
import type {AgentController} from '../hooks/useAgent.js';
import {
  directionForPresetId,
  goalAvailableIn,
  goalEffects,
  recommendedTemplateId,
  setupGoalById,
} from '../setup-goals.js';
import type {
  SetupDirection as SetupDirectionId,
  SetupGoalId,
} from '../setup-goals.js';
import {
  landingSpaceAfterSetup,
  nextStage,
  previousStage,
  setupSteps,
} from '../setup-nav.js';
import type {SetupStage} from '../setup-nav.js';
import {BotIconGrid} from './BotIconGrid.js';
import {PersonaForm} from './PersonaForm.js';
import {BotForm, TemplateBotForm} from './SetupBots.js';
import {SetupDirection} from './SetupDirection.js';
import {SetupExtras} from './SetupExtras.js';
import {SetupFinish} from './SetupFinish.js';
import {SetupGoals} from './SetupGoals.js';
import {SetupJobs} from './SetupJobs.js';
import {SetupModel} from './SetupModel.js';

type BotPath = 'template' | 'step' | null;

export function Setup({
  settings,
  agent,
  onSettings,
  onStartBuilder,
  onClose,
}: {
  settings: PublicSettings;
  /** For the two things this screen does to the window: load a Space, read which one is current. */
  agent: AgentController;
  /** Every write's own answer, so one copy of the settings is live. */
  onSettings: (next: PublicSettings) => void;
  /**
   * Hands the rest of the flow to Marimo. Answers a problem instead of
   * throwing: a refusal has to leave this screen up with a sentence on it.
   */
  onStartBuilder: () => Promise<{ok: boolean; problem?: string}>;
  /**
   * Closes the flow, either because it finished or because the user deferred.
   *
   * The argument is the Space the person chose in the flow, when they chose
   * one: the window opens a new chat there rather than leaving them in the
   * starter conversation the app made before the flow ran. Absent when they
   * kept the folder the app started them in.
   */
  onClose: (pickedSpaceId?: string) => void;
}): React.JSX.Element {
  const [screen, setScreen] = useState<SetupStage>('welcome');
  /**
   * The setup style, once chosen.
   *
   * `null` means the direction step has not been answered in this window yet.
   * It is not the same as "Regular": a custom grant has no direction, and the
   * direction step has to ask rather than assume.
   */
  const [direction, setDirection] = useState<SetupDirectionId | null>(null);
  const [goals, setGoals] = useState<SetupGoalId[]>([]);
  const [catalog, setCatalog] = useState<ProfileCatalog | null>(null);
  /**
   * The Space the person chose in this flow, if they chose one.
   *
   * `undefined` is not the same answer as the current Space: every install has a
   * starting Space, and the difference between "kept the one the app made" and
   * "picked another" is what decides whether finishing opens a new chat.
   */
  const [pickedSpaceId, setPickedSpaceId] = useState<string | null>(null);
  /**
   * The bot the flow is in the middle of, between making it and giving it a
   * Persona. Held as an id rather than as a draft because the profile exists
   * from the moment it is created: the step after this one edits a bot that is
   * already on the roster, so a reload in between loses nothing.
   */
  const [madeId, setMadeId] = useState<string | null>(null);
  const [path, setPath] = useState<BotPath>(null);
  /** The starter-role card the person clicked, when they changed the suggestion. */
  const [selectedTemplateId, setSelectedTemplateId] = useState<
    string | undefined
  >(undefined);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  /**
   * Reads the catalogue, once and again on a retry.
   *
   * Nothing is written by it: the presets, the starter roles and the two tool
   * names are the agent package's and the protocol's, and this window reads them
   * rather than spelling them out. A retry is a button because the direction
   * step cannot draw its cards without them, and a failed read would otherwise
   * be a dead end with nothing to press.
   */
  const loadCatalog = useCallback((): void => {
    setProblem(null);
    void window.marimo
      .call('profiles.catalog', {})
      .then((loaded) => {
        setCatalog(loaded);
      })
      .catch((failure: unknown) => {
        setProblem(describe(failure));
      });
  }, []);

  useEffect(() => {
    loadCatalog();
  }, [loadCatalog]);

  /*
   * The lead is the first profile in the document, which is what `freshFile`
   * created at install. Read from position rather than from an id kept anywhere,
   * because deleting the lead promotes the next profile and that rule is already
   * how the agent package seeds identities.
   */
  const lead: AgentProfile | undefined = settings.profiles[0];
  const bots = settings.profiles.slice(1);
  /*
   * The bot the Persona step is about. Read back out of the roster rather than
   * kept as a copy: `profiles.update` answers with the whole file, so the name
   * in that step's heading is the name the store holds.
   */
  const justMade =
    madeId === null
      ? undefined
      : settings.profiles.find((entry) => entry.id === madeId);
  const delegateTool = catalog?.delegationTool;
  const builderTool = catalog?.builderTool;
  const presets = catalog?.presets ?? [];
  const controlPresets = catalog?.controlPresets ?? [];
  const chosenControl = chosenPreset(controlPresets, lead?.enabledTools ?? []);
  /*
   * The direction the flow is treating as chosen. The state is set when a card
   * is clicked; a person who pressed Continue with the grant already in place
   * answered with that grant, so it is read back here. A custom mix falls back
   * to Regular only for drawing a progress preview — the direction step still
   * asks, and Continue there will not accept a custom grant as an answer.
   */
  const activeDirection =
    direction ?? directionForPresetId(chosenControl?.id) ?? 'regular';
  const templates = catalog?.botTemplates ?? [];
  const effects = goalEffects(goals);
  const steps = setupSteps({
    direction: activeDirection,
    goals,
    hasMadeBot: justMade !== undefined,
  });
  const recommendedId = recommendedTemplateId(goals, templates);
  const selectedTemplate =
    selectedTemplateId ?? recommendedId ?? templates[0]?.id;
  /*
   * The icon the bot was given when it was made. `create` always writes one, so
   * this is only a fallback for a profile from before icons existed.
   */
  const madeAt = Math.max(
    0,
    settings.profiles.findIndex((entry) => entry.id === madeId),
  );
  const selectedPresetId =
    justMade?.avatar?.kind === 'preset'
      ? justMade.avatar.id
      : justMade?.avatar === undefined
        ? defaultBotAvatarFor(madeAt).id
        : undefined;

  const go = (next: SetupStage): void => {
    setProblem(null);
    setPath(null);
    setScreen(next);
  };

  /** The one Back button, so every step points at the same rule. */
  const back = (): void => {
    const target = previousStage(steps, screen);
    if (target !== null) {
      go(target);
    }
  };

  /** The one Continue for steps that have one obvious next screen. */
  const advance = (): void => {
    const target = nextStage(steps, screen);
    if (target !== null) {
      go(target);
    }
  };

  const backButton = (): React.JSX.Element => (
    <button
      type="button"
      className="button button-quiet"
      disabled={busy}
      onClick={back}
    >
      Back
    </button>
  );

  /** Applies a profile-list answer to the one settings copy the window holds. */
  const applyProfiles = (next: {
    profiles: AgentProfile[];
    activeProfileId: string;
  }): void => {
    onSettings({
      ...settings,
      profiles: next.profiles,
      activeProfileId: next.activeProfileId,
    });
  };

  /**
   * Loads a Space, and remembers that it is where the person chose to be.
   *
   * The starter chat is not moved here: the window opens a new conversation in
   * the picked Space when the flow closes, and the chat it started on is empty
   * and unlisted in the rail. Moving it instead would make the flow's own
   * "finish" do nothing visible, and a chat somebody has since typed in belongs
   * where it was started.
   */
  const loadSpace = async (): Promise<void> => {
    setBusy(true);
    setProblem(null);
    try {
      const {added, activeWorkspaceId} = await agent.loadWorkspace();
      if (!added) {
        // A closed picker is an answer, not a failure.
        return;
      }
      if (activeWorkspaceId !== null) {
        setPickedSpaceId(activeWorkspaceId);
      }
    } catch (failure) {
      setProblem(describe(failure));
    } finally {
      setBusy(false);
    }
  };

  /** The one way out, so every close passes the Space the flow chose. */
  const finish = (): void => {
    onClose(landingSpaceAfterSetup(pickedSpaceId));
  };

  /**
   * Writes the setup style onto the lead.
   *
   * The card is a shortcut over the same `enabledTools` array Settings shows as
   * switches, not a mode: picking one replaces the whole grant, and anything
   * added later (delegation, the builder tool) makes it a custom mix rather than
   * silently lighting a card that no longer describes it.
   *
   * The direction is only set after the write succeeds. A failure has to leave
   * the old grant and the old answer in place, with a sentence under them, or
   * the flow would walk on believing it had changed access it had not.
   */
  const chooseDirection = async (
    next: SetupDirectionId,
    preset: CapabilityPreset,
  ): Promise<void> => {
    if (lead === undefined) {
      setProblem('This install has no bot to configure. Reopen the app.');
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      if (chosenControl?.id !== preset.id) {
        const updated = await window.marimo.call('profiles.update', {
          profileId: lead.id,
          patch: {enabledTools: [...preset.tools]},
        });
        applyProfiles(updated);
      }
      setDirection(next);
      if (next === 'regular') {
        /*
         * A goal that needed Power is no longer part of this path. Dropping it
         * here, rather than leaving it selected and ignoring it, is what makes
         * Back to the direction step an honest change of mind.
         */
        setGoals((current) =>
          current.filter((id) => {
            const goal = setupGoalById(id);
            return goal !== undefined && goalAvailableIn(goal, 'regular');
          }),
        );
      }
    } catch (failure) {
      setProblem(describe(failure));
    } finally {
      setBusy(false);
    }
  };

  /**
   * Continues from the direction step.
   *
   * A click on a card already set the direction. A person who presses Continue
   * without clicking is answering with the grant the profile already has, so
   * the direction is read back from it; a custom mix has no direction, and the
   * question is asked rather than guessed.
   */
  const continueDirection = (): void => {
    if (direction !== null) {
      go('goals');
      return;
    }
    const derived = directionForPresetId(chosenControl?.id);
    if (derived === null) {
      setProblem('Choose Regular setup or Power setup to continue.');
      return;
    }
    setDirection(derived);
    go('goals');
  };

  /** The goals step's branch into the full grant. */
  const switchToPower = async (): Promise<void> => {
    const preset = controlPresets.find((entry) => entry.id === 'power');
    if (preset === undefined) {
      setProblem('This build has no Power setup to switch to.');
      return;
    }
    await chooseDirection('power', preset);
  };

  /**
   * Adds or removes one goal.
   *
   * Nothing is written: the goal is a plan for the steps, and the only effects
   * it can have are the downloads and the bot suggestion the later steps make.
   * The availability guard is here as well as on the card, so a stale click
   * cannot put a Power-only goal into a Regular run.
   */
  const toggleGoal = (id: SetupGoalId): void => {
    const goal = setupGoalById(id);
    if (goal === undefined || !goalAvailableIn(goal, activeDirection)) {
      return;
    }
    setGoals((current) =>
      current.includes(id)
        ? current.filter((entry) => entry !== id)
        : [...current, id],
    );
  };

  /**
   * Makes one bot, then puts Marimo Bot back in charge.
   *
   * The `finally` is the point: `profiles.create` switches the active profile to
   * the new bot, so a refusal anywhere after it would otherwise leave the window
   * on a bot that was never finished being set up. Whoever failed, the person is
   * talking to Marimo Bot.
   */
  const makeBot = async (
    draft: BotDraft,
    delegate: boolean,
  ): Promise<AgentProfile | null> => {
    if (lead === undefined) {
      setProblem('This install has no bot to put back. Reopen the app.');
      return null;
    }
    setBusy(true);
    setProblem(null);
    let made: AgentProfile | null = null;
    try {
      const created = await window.marimo.call('profiles.create', {draft});
      made = created.created;
      if (
        delegate &&
        delegateTool !== undefined &&
        !lead.enabledTools.includes(delegateTool)
      ) {
        /*
         * Additive, like every other grant this app writes on somebody's
         * behalf: nothing the user already allowed is taken away, and the one
         * tool added is the one that makes the bots they just made reachable.
         */
        const updated = await window.marimo.call('profiles.update', {
          profileId: lead.id,
          patch: {enabledTools: [...lead.enabledTools, delegateTool]},
        });
        applyProfiles(updated);
      }
    } catch (failure) {
      setProblem(describe(failure));
    } finally {
      try {
        const restored = await window.marimo.call('profiles.select', {
          profileId: lead.id,
        });
        applyProfiles(restored);
      } catch (failure) {
        setProblem((current) => current ?? describe(failure));
      }
      setBusy(false);
    }
    return made;
  };

  /**
   * Making a bot leads to asking about its Persona, always.
   *
   * That is the one question about a bot the app cannot answer for the person,
   * and it is about the bot they have just named — so the step after this one is
   * about the profile that now exists rather than a draft still in a form.
   */
  const submitBot = async (
    draft: BotDraft,
    delegate: boolean,
  ): Promise<void> => {
    const made = await makeBot(draft, delegate);
    if (made !== null) {
      setMadeId(made.id);
      go('persona');
    }
  };

  /**
   * Writes the user's own words onto the bot just made.
   *
   * An empty box writes an empty Persona rather than being skipped: the starter
   * text was shown, so somebody who deleted it meant to. "Keep the starter text"
   * is the button that writes nothing.
   *
   * `next` is the difference between continuing and going back: both save, so
   * backing out of this step cannot discard a paragraph somebody just wrote.
   */
  const savePersona = async (
    text: string,
    next: 'more' | 'bot',
  ): Promise<void> => {
    if (madeId === null) {
      go(next);
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      const updated = await window.marimo.call('profiles.update', {
        profileId: madeId,
        patch: {persona: text},
      });
      applyProfiles(updated);
      go(next);
    } catch (failure) {
      setProblem(describe(failure));
    } finally {
      setBusy(false);
    }
  };

  /**
   * Writes one preset onto the bot just made.
   *
   * The same call Settings uses, and the same immediate write: an icon is a
   * choice somebody made, not a draft waiting for a Save button.
   */
  const saveIcon = async (presetId: string): Promise<void> => {
    if (madeId === null) {
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      const updated = await window.marimo.call('profiles.update', {
        profileId: madeId,
        patch: {avatar: {kind: 'preset', id: presetId}},
      });
      applyProfiles(updated);
    } catch (failure) {
      setProblem(describe(failure));
    } finally {
      setBusy(false);
    }
  };

  /**
   * Hands the bot-making conversation to Marimo.
   *
   * The tool is granted first, additively, because an install that made its lead
   * before this feature existed has no `draft_bot` checkbox ticked. The grant is
   * written before the session starts so the runtime's own check passes; the App
   * closes this flow only after the session exists.
   */
  const startBuilder = async (): Promise<void> => {
    if (lead === undefined) {
      setProblem('This install has no bot to talk to. Reopen the app.');
      return;
    }
    if (builderTool === undefined) {
      setProblem(
        'This build cannot draft bots. Use one of the other two ways, or ' +
          'update the app.',
      );
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      if (!lead.enabledTools.includes(builderTool)) {
        const updated = await window.marimo.call('profiles.update', {
          profileId: lead.id,
          patch: {enabledTools: [...lead.enabledTools, builderTool]},
        });
        applyProfiles(updated);
      }
      const started = await onStartBuilder();
      if (!started.ok) {
        setProblem(started.problem ?? 'Could not start the conversation.');
      }
    } catch (failure) {
      setProblem(describe(failure));
    } finally {
      setBusy(false);
    }
  };

  /**
   * Leaves the bot step without making another bot.
   *
   * A bot that was already made has a Persona step and a "more bots" step
   * behind it, so skipping a second bot goes to the list it came from. With no
   * bot made, the next step is whatever the resolved path says — jobs or the
   * review.
   */
  const skipBot = (): void => {
    if (justMade !== undefined) {
      go('more');
      return;
    }
    const target = nextStage(steps, 'bot');
    if (target !== null) {
      go(target);
    }
  };

  const space = agent.workspaces.find(
    (entry) => entry.id === agent.activeWorkspaceId,
  );
  const landingSpace = agent.workspaces.find(
    (entry) => entry.id === (pickedSpaceId ?? agent.activeWorkspaceId),
  );

  return (
    <div className="onboarding setup">
      <div className="setup-inner">
        {screen !== 'welcome' && (
          <ol className="setup-steps" aria-label="Setup steps">
            {steps.map((entry) => (
              <li
                key={entry.id}
                className="setup-step"
                aria-current={entry.id === screen ? 'step' : undefined}
              >
                {entry.label}
              </li>
            ))}
          </ol>
        )}

        {screen === 'welcome' && (
          <div className="setup-body">
            <img className="onboarding-mark" src="./marimo-logo.png" alt="" />
            <h2>Welcome to Marimo Bot</h2>
            <p className="onboarding-lead">
              Marimo Bot is the bot you talk to. It can also run the bots you
              make.
            </p>
            <p className="onboarding-note">
              First choose <strong>Regular</strong> or <strong>Power</strong>{' '}
              setup, then tell it what you want to get done. That decides which
              steps are worth showing: the model that answers, the folder it
              works in, a bot if one fits, and the optional pictures, voice or
              scheduled jobs.
            </p>
            <p className="onboarding-note">
              You can change any of this later in Settings.
            </p>
            <div className="onboarding-actions">
              <button
                type="button"
                className="button button-primary"
                onClick={() => {
                  go('direction');
                }}
              >
                Get started
              </button>
              <button
                type="button"
                className="button button-quiet"
                onClick={finish}
              >
                Skip setup
              </button>
            </div>
          </div>
        )}

        {screen === 'direction' && (
          <SetupDirection
            presets={controlPresets}
            chosenId={chosenControl?.id}
            busy={busy}
            catalogLoading={catalog === null && problem === null}
            problem={problem}
            onChoose={(next, preset) => {
              void chooseDirection(next, preset);
            }}
            onContinue={continueDirection}
            onBack={back}
            onRetry={loadCatalog}
          />
        )}

        {screen === 'goals' && (
          <SetupGoals
            direction={activeDirection}
            goals={goals}
            busy={busy}
            powerAvailable={controlPresets.some(
              (preset) => preset.id === 'power',
            )}
            onToggle={toggleGoal}
            onSwitchToPower={() => {
              void switchToPower();
            }}
            onContinue={advance}
            onBack={back}
          />
        )}

        {screen === 'model' && (
          <SetupModel
            settings={settings}
            onSettings={onSettings}
            onBack={back}
            onNext={advance}
            onLater={finish}
          />
        )}

        {screen === 'extras' && (
          <SetupExtras
            settings={settings}
            onSettings={onSettings}
            tasks={effects.tasks}
            onBack={back}
            onNext={advance}
          />
        )}

        {screen === 'space' && (
          <div className="setup-body">
            <h2>Where should it work?</h2>
            <p className="onboarding-lead">
              A Space is a folder on your computer. Bots can read and write
              files there, and nowhere else.
            </p>
            <p className="onboarding-note">
              Every chat remembers the Space it started in. Markdown files in it
              show up under Documents.
            </p>
            <p className="onboarding-note">
              Marimo starts you in a folder it creates, so the first Space is a
              project rather than your whole home folder. Choose another if the
              work is already somewhere else.
            </p>
            {space !== undefined && (
              <p className="settings-muted">
                You already have <strong>{space.name}</strong> loaded, at{' '}
                <code>{space.path}</code>.
              </p>
            )}
            <div className="onboarding-actions">
              <button
                type="button"
                className="button button-primary"
                disabled={busy}
                onClick={() => {
                  if (space === undefined) {
                    void loadSpace();
                    return;
                  }
                  advance();
                }}
              >
                {space === undefined ? 'Choose a folder…' : 'Continue'}
              </button>
              {space !== undefined && (
                <button
                  type="button"
                  className="button button-quiet"
                  disabled={busy}
                  onClick={() => {
                    void loadSpace();
                  }}
                >
                  Choose another folder…
                </button>
              )}
              {space === undefined && (
                <button
                  type="button"
                  className="button button-quiet"
                  disabled={busy}
                  onClick={advance}
                >
                  Later
                </button>
              )}
              {backButton()}
            </div>
          </div>
        )}

        {screen === 'bot' && (
          <div className="setup-body">
            <h2>{bots.length > 0 ? 'Another bot' : 'Your first bot'}</h2>
            {bots.length > 0 && (
              <p className="settings-muted">
                So far: {bots.map((bot) => bot.name).join(', ')}.
              </p>
            )}

            {path === null && (
              <>
                <p className="onboarding-lead">
                  A bot is for one kind of work. Give it a name and a starting
                  point. Marimo Bot can hand it jobs and add it to a chat.
                </p>
                {recommendedId !== undefined && (
                  <p className="onboarding-note">
                    Your goals suggest{' '}
                    <strong>
                      {templates.find(
                        (template) => template.id === recommendedId,
                      )?.label ?? 'a starter role'}
                    </strong>
                    . It is a starting point, not a requirement.
                  </p>
                )}
                <div className="setup-path-cards">
                  <button
                    type="button"
                    className="setup-path-card"
                    disabled={busy}
                    onClick={() => {
                      setProblem(null);
                      setPath('template');
                    }}
                  >
                    <span className="setup-path-label">Start from a role</span>
                    <em className="setup-path-blurb">
                      Writer, Marketer, Researcher and more. Each comes with a
                      Role and a Persona you can change.
                    </em>
                  </button>
                  <button
                    type="button"
                    className="setup-path-card"
                    disabled={busy}
                    onClick={() => {
                      setProblem(null);
                      setPath('step');
                    }}
                  >
                    <span className="setup-path-label">
                      Build it step by step
                    </span>
                    <em className="setup-path-blurb">
                      Pick a role or start blank, choose what it can do, then
                      write its Persona.
                    </em>
                  </button>
                  <button
                    type="button"
                    className="setup-path-card"
                    disabled={busy || builderTool === undefined}
                    onClick={() => {
                      void startBuilder();
                    }}
                  >
                    <span className="setup-path-label">
                      Talk it through with Marimo
                    </span>
                    <em className="setup-path-blurb">
                      {builderTool === undefined
                        ? 'This build cannot draft bots.'
                        : 'Marimo asks a few questions, drafts the bot, and shows it to you before anything is made.'}
                    </em>
                  </button>
                </div>
              </>
            )}

            {path === 'template' && (
              <TemplateBotForm
                templates={templates}
                selectedId={selectedTemplate}
                recommendedId={recommendedId}
                busy={busy}
                delegateTool={delegateTool}
                lead={lead}
                onSelect={setSelectedTemplateId}
                onSubmit={submitBot}
                onBack={() => {
                  setPath(null);
                }}
              />
            )}

            {path === 'step' && (
              <BotForm
                templates={templates}
                presets={presets}
                recommendedId={recommendedId}
                busy={busy}
                delegateTool={delegateTool}
                lead={lead}
                submitLabel="Make this bot"
                onSubmit={submitBot}
                onBack={() => {
                  setPath(null);
                }}
              />
            )}

            {path === null && (
              <div className="onboarding-actions">
                {/*
                  Three different exits, because this step is reached three ways.
                  With a bot just made, the way forward is the Persona step that
                  belongs to it rather than a second bot. Without one, skipping
                  is a real answer and the resolved path says where it goes.
                */}
                {justMade !== undefined && (
                  <button
                    type="button"
                    className="button button-quiet"
                    disabled={busy}
                    onClick={() => {
                      go('persona');
                    }}
                  >
                    Finish {justMade.name}&rsquo;s Persona
                  </button>
                )}
                <button
                  type="button"
                  className="button button-quiet"
                  disabled={busy}
                  onClick={skipBot}
                >
                  {bots.length === 0 ? 'Skip the bot for now' : 'Never mind'}
                </button>
                {backButton()}
              </div>
            )}
          </div>
        )}

        {screen === 'persona' && (
          <div className="setup-body">
            <h2>Make {justMade?.name ?? 'this bot'} yours</h2>
            <p className="onboarding-lead">
              The Persona is how {justMade?.name ?? 'this bot'} behaves: what it
              works on, how it sounds, and how it talks to you.
            </p>

            {justMade !== undefined && (
              <>
                <div className="settings-field">
                  <span>Role</span>
                  <pre className="setup-role-text" aria-label="Role">
                    {justMade.identity}
                  </pre>
                  <em className="settings-why">
                    The brief this bot follows at work. It shapes how the bot
                    answers and how it works with your other bots. You can edit
                    it in Settings, but change it with care.
                  </em>
                </div>

                <div className="settings-field">
                  <span>Icon</span>
                  <em className="settings-why">
                    Pick a look for the sidebar. You can upload your own image
                    later in Settings.
                  </em>
                  <BotIconGrid
                    profile={justMade}
                    selectedId={selectedPresetId}
                    disabled={busy}
                    onSelect={(presetId) => {
                      void saveIcon(presetId);
                    }}
                  />
                </div>
              </>
            )}

            <p className="onboarding-note">
              Every bot keeps its own Persona, Marimo Bot included.
            </p>
            <PersonaForm
              name={justMade?.name ?? 'this bot'}
              initial={justMade?.persona ?? ''}
              busy={busy}
              onSubmit={async (text) => {
                await savePersona(text, 'more');
              }}
              onBack={async (text) => {
                await savePersona(text, 'bot');
              }}
              onSkip={() => {
                go('more');
              }}
            />
          </div>
        )}

        {screen === 'more' && (
          <div className="setup-body">
            <h2>Any more bots?</h2>
            <p className="onboarding-lead">
              Each bot has its own memory and its own chats. Make another one,
              or finish here.
            </p>
            {bots.length > 0 && (
              <p className="settings-muted">
                So far: {bots.map((bot) => bot.name).join(', ')}.
              </p>
            )}
            <div className="onboarding-actions">
              <button
                type="button"
                className="button button-primary"
                disabled={busy}
                onClick={() => {
                  go('bot');
                }}
              >
                Add another bot
              </button>
              <button
                type="button"
                className="button button-quiet"
                disabled={busy}
                onClick={advance}
              >
                That&rsquo;s enough for now
              </button>
              {backButton()}
            </div>
          </div>
        )}

        {screen === 'jobs' && <SetupJobs onBack={back} onNext={advance} />}

        {screen === 'finish' && (
          <SetupFinish
            settings={settings}
            direction={activeDirection}
            goals={goals}
            bots={bots}
            spaceName={landingSpace?.name}
            accessLabel={chosenControl?.label ?? 'Your own mix'}
            onBack={back}
            onStart={finish}
          />
        )}

        {problem !== null && <p className="settings-problem">{problem}</p>}
      </div>
    </div>
  );
}
