/**
 * Where the setup flow can go, as arithmetic rather than as a switch in each
 * screen.
 *
 * The flow is a graph now, not a list. The direction and the goals decide which
 * steps exist: an optional pictures/voice download, a bot step only when a goal
 * calls for a bot, the Persona and "more bots" steps only after one was made,
 * and a jobs step only for Power setup with the automation goal. Drawing the
 * progress bar and choosing Back both read this one answer, so a step cannot be
 * on screen without being in the list, and a conditional step cannot leave a
 * dead end behind it.
 *
 * Labels rather than "step 2 of 5": what is being decided is the useful half,
 * and a count is only how much is left.
 *
 * `hasMadeBot` is deliberately separate from `needsBot`. A bot step that has
 * been made adds the Persona and more-bots steps; a person who goes back and
 * deselects every bot goal loses the step but keeps the bot that was already
 * written, and the flow simply stops asking about it.
 */
import {goalEffects} from './setup-goals.js';
import type {SetupDirection, SetupGoalId} from './setup-goals.js';

/** Every screen the flow can be on. `welcome` is the shell around the steps. */
export type SetupStage =
  | 'welcome'
  | 'direction'
  | 'goals'
  | 'model'
  | 'extras'
  | 'space'
  | 'bot'
  | 'persona'
  | 'more'
  | 'jobs'
  | 'finish';

/** One screen in the progress bar, excluding the welcome screen. */
export interface SetupStep {
  id: Exclude<SetupStage, 'welcome'>;
  label: string;
}

const STEP_LABELS: Record<SetupStep['id'], string> = {
  direction: 'Control',
  goals: 'Goals',
  model: 'Model',
  extras: 'Pictures & voice',
  space: 'Space',
  bot: 'A bot',
  persona: 'Persona',
  more: 'More bots',
  jobs: 'Jobs',
  finish: 'Ready',
};

export interface SetupRead {
  direction: SetupDirection;
  goals: readonly SetupGoalId[];
  /** Whether a bot has been made in this run, not whether one exists. */
  hasMadeBot: boolean;
}

/**
 * The summary Back and Next both read.
 *
 * The order is the flow's, and every conditional is decided here:
 *
 * - Extras is for a model the goals asked to have installed.
 * - The bot step is for a goal that wants one. Persona and more-bots follow a
 *   bot that actually exists, so they cannot appear before the step that makes
 *   one.
 * - Jobs is Power *and* automation. The goal alone is not enough: a Regular
 *   run never offered the job tools and must not leave an empty service screen.
 */
export function setupSteps(read: SetupRead): SetupStep[] {
  const effects = goalEffects(read.goals);
  const steps: SetupStep[] = [];
  const add = (id: SetupStep['id']): void => {
    steps.push({id, label: STEP_LABELS[id]});
  };

  add('direction');
  add('goals');
  add('model');
  if (effects.tasks.length > 0) {
    add('extras');
  }
  add('space');
  if (effects.needsBot) {
    add('bot');
    if (read.hasMadeBot) {
      add('persona');
      add('more');
    }
  }
  if (read.direction === 'power' && effects.jobs) {
    add('jobs');
  }
  add('finish');
  return steps;
}

/**
 * The screen a step's Continue goes to, or `null` at the end.
 *
 * Welcome is not in the list, so it is answered explicitly rather than by an
 * index. The bot step is usually advanced by its own form (a made bot goes to
 * the Persona that now exists); this is the path for the steps that have one
 * obvious next screen.
 */
export function nextStage(
  steps: readonly SetupStep[],
  screen: SetupStage,
): SetupStage | null {
  if (screen === 'welcome') {
    return 'direction';
  }
  const index = steps.findIndex((step) => step.id === screen);
  if (index === -1) {
    return null;
  }
  return steps[index + 1]?.id ?? null;
}

/**
 * The screen Back goes to, or `null` where there is nothing behind it.
 *
 * Direction backs to the welcome screen, which draws no Back of its own. Any
 * other step is the one before it in the resolved list, which is what makes
 * every step a real step rather than a screen whose Back was remembered by
 * hand: Persona backs to the bot list, extras backs to the model, and the
 * finish backs to whichever of jobs, more bots or the bot step applied.
 */
export function previousStage(
  steps: readonly SetupStep[],
  screen: SetupStage,
): SetupStage | null {
  if (screen === 'welcome') {
    return null;
  }
  if (screen === 'direction') {
    return 'welcome';
  }
  const index = steps.findIndex((step) => step.id === screen);
  if (index <= 0) {
    return 'welcome';
  }
  return steps[index - 1]?.id ?? 'welcome';
}

/**
 * The Space a finished flow should open a new chat in.
 *
 * Only a Space the person chose in the flow. An install that kept the folder the
 * app started them in is already there: the conversation the window opened on is
 * filed in it, and opening a second empty one would be a chat nobody asked for.
 * The window's own starter chat is empty and unlisted in the rail, so when this
 * answers a Space the old conversation simply stops being the one on screen.
 */
export function landingSpaceAfterSetup(
  pickedSpaceId: string | null,
): string | undefined {
  return pickedSpaceId ?? undefined;
}
