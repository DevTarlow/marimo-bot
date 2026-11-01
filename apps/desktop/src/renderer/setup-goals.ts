/**
 * The first run's two directions and the goals it asks about, as data.
 *
 * The direction is not a mode. Regular and Power are the two `enabledTools`
 * presets the setup calls Standard and Power user, and choosing one writes the
 * same grant Settings' own control cards write. What the direction also does is
 * decide how much of the flow is worth showing: Power is the full tool grant,
 * and the one direction that can schedule jobs.
 *
 * The goals are a *plan for this run*, not a preference. Nothing here grants a
 * tool, and nothing is written down: the goals choose which steps appear, which
 * starter role is suggested, and whether the optional pictures/voice downloads
 * are offered. What they produce — a grant, a download, a bot, a service — is
 * written when it happens and visible in Settings afterwards. Storing the goals
 * would be a second, quieter place where a capability decision lived.
 *
 * `automation` is the only goal a Regular setup cannot take. The others either
 * use tools Standard already has, ask for a model rather than a tool, or are
 * done by a bot the person makes — a Writer has `write_file` on its own profile
 * even when Marimo Bot itself is on Standard. That distinction is why the goal
 * copy names the bot rather than claiming Marimo Bot can do it.
 *
 * The starter-role names are protocol data. This file maps a goal to a template
 * id rather than repeating its Role or tools, so the catalogue stays the one
 * place that says what a Writer is and what it may do.
 */
import {LOCAL_TASKS} from '@marimo/protocol';
import type {LocalModelId, LocalTask} from '@marimo/protocol';

/** The two answers to "how do you want to set this up". */
export type SetupDirection = 'regular' | 'power';

export interface SetupDirectionCard {
  id: SetupDirection;
  label: string;
}

/**
 * The two path cards, in the order they are drawn.
 *
 * Their blurbs come from `controlPresets` rather than from this file: the grant
 * is the catalogue's, and a second account of what Standard or Power includes
 * is how the two would drift. This is only the setup's framing of it, and
 * `presetIdForDirection` is the one mapping from the framing to the grant.
 */
export const SETUP_DIRECTIONS: readonly SetupDirectionCard[] = [
  {
    id: 'regular',
    label: 'Regular setup',
  },
  {
    id: 'power',
    label: 'Power setup',
  },
];

export function presetIdForDirection(
  direction: SetupDirection,
): 'standard' | 'power' {
  return direction === 'power' ? 'power' : 'standard';
}

/**
 * The direction a grant came from, or `null` for a mix somebody assembled.
 *
 * The direction step derives its lit card from the profile's grant through this
 * rather than storing the choice, for the reason `chosenPreset` exists: a switch
 * changed later has to make the question honestly unanswered rather than leave
 * a card claiming a grant the profile no longer has.
 */
export function directionForPresetId(
  id: string | undefined,
): SetupDirection | null {
  if (id === 'standard') {
    return 'regular';
  }
  if (id === 'power') {
    return 'power';
  }
  return null;
}

/** What a person wants to do with Marimo and the bots they make. */
export type SetupGoalId =
  | 'files'
  | 'research'
  | 'writing'
  | 'coding'
  | 'bots'
  | 'pictures'
  | 'voice'
  | 'automation';

export interface SetupGoal {
  id: SetupGoalId;
  label: string;
  blurb: string;
  /**
   * Whether this goal needs the Power grant.
   *
   * Only automation does. The rest are read-only work, a model download, or a
   * bot doing the acting with its own profile grant.
   */
  needsPower: boolean;
  /** Whether the flow should offer to make a bot for this goal. */
  needsBot: boolean;
  /** The starter role to suggest, when one fits. */
  templateId?: string;
  /** The model tasks this goal asks to have installed. */
  models?: readonly LocalTask[];
}

export const SETUP_GOALS: readonly SetupGoal[] = [
  {
    id: 'files',
    label: 'Use my files',
    blurb:
      'Read and search the folder you choose, and answer from what is in it.',
    needsPower: false,
    needsBot: false,
  },
  {
    id: 'research',
    label: 'Research the web',
    blurb:
      'Search, fetch pages, and keep the sources straight. Suggests a ' +
      'Researcher bot.',
    needsPower: false,
    needsBot: true,
    templateId: 'researcher',
  },
  {
    id: 'writing',
    label: 'Write and edit',
    blurb:
      'Draft, revise and save text. Suggests a Writer bot, which can save ' +
      'files even when Marimo Bot itself is on Standard.',
    needsPower: false,
    needsBot: true,
    templateId: 'writer',
  },
  {
    id: 'coding',
    label: 'Work on code',
    blurb:
      'Read the code, make small changes, and say what could break. Suggests ' +
      'a Coder bot.',
    needsPower: false,
    needsBot: true,
    templateId: 'coder',
  },
  {
    id: 'bots',
    label: 'Build a team of bots',
    blurb:
      'Make named helpers and let Marimo Bot hand them work. Suggests the ' +
      'first one.',
    needsPower: false,
    needsBot: true,
  },
  {
    id: 'pictures',
    label: 'Look at pictures',
    blurb:
      'Answer questions about screenshots, charts and photographs. Downloads ' +
      'the vision model.',
    needsPower: false,
    needsBot: false,
    models: ['vision'],
  },
  {
    id: 'voice',
    label: 'Talk out loud',
    blurb:
      'Ask by microphone and hear the answer. Downloads the audio model and ' +
      'turns voice mode on when it is ready.',
    needsPower: false,
    needsBot: false,
    models: ['voice'],
  },
  {
    id: 'automation',
    label: 'Run jobs on a schedule',
    blurb:
      'Recurring work that keeps going when the window is closed. Needs ' +
      'Power setup, and suggests a Personal assistant bot.',
    needsPower: true,
    needsBot: true,
    templateId: 'assistant',
  },
];

/** One goal by id, for a caller reading a list of ids. */
export function setupGoalById(id: SetupGoalId): SetupGoal | undefined {
  return SETUP_GOALS.find((goal) => goal.id === id);
}

/** Whether this direction can offer the goal. */
export function goalAvailableIn(
  goal: SetupGoal,
  direction: SetupDirection,
): boolean {
  return !goal.needsPower || direction === 'power';
}

/**
 * What the chosen goals add to the flow.
 *
 * `tasks` is filtered through `LOCAL_TASKS` rather than kept in the order the
 * cards were clicked: the list is the model catalogue's order, and an order
 * that depended on clicks would make the extras step's cards jump around.
 * `jobs` is data, not a claim about this path — `setupSteps` is what decides
 * whether a Regular run may show the jobs step, and only Power may.
 */
export interface GoalEffects {
  needsBot: boolean;
  templateId?: string;
  tasks: LocalTask[];
  jobs: boolean;
}

export function goalEffects(goals: readonly SetupGoalId[]): GoalEffects {
  const selected = new Set(goals);
  const tasks = new Set<LocalTask>();
  let needsBot = false;
  let jobs = false;
  let templateId: string | undefined;

  for (const goal of SETUP_GOALS) {
    if (!selected.has(goal.id)) {
      continue;
    }
    needsBot ||= goal.needsBot;
    templateId ??= goal.templateId;
    for (const task of goal.models ?? []) {
      tasks.add(task);
    }
    jobs ||= goal.id === 'automation';
  }

  return {
    needsBot,
    ...(templateId === undefined ? {} : {templateId}),
    tasks: LOCAL_TASKS.filter((task) => tasks.has(task)),
    jobs,
  };
}

/** One download card: a model, and the task(s) that use it. */
export interface TaskModelGroup {
  modelId: LocalModelId;
  tasks: LocalTask[];
}

/**
 * The extras step's cards, one per assigned model.
 *
 * Settings owns the task assignment, so two tasks can point at one model — Omni
 * is exactly that — and a step that drew one card per task would offer the same
 * download twice. Grouping by the assignment is also why this is not a property
 * of the goals: the same goals produce a different card list after somebody
 * changes the assignment in Settings.
 */
export function groupTasksByModel(
  tasks: readonly LocalTask[],
  assignments: Record<LocalTask, LocalModelId>,
): TaskModelGroup[] {
  const byModel = new Map<LocalModelId, LocalTask[]>();
  for (const task of tasks) {
    const modelId = assignments[task];
    const list = byModel.get(modelId);
    if (list === undefined) {
      byModel.set(modelId, [task]);
    } else {
      list.push(task);
    }
  }
  return [...byModel.entries()].map(([modelId, modelTasks]) => ({
    modelId,
    tasks: modelTasks,
  }));
}

/**
 * The starter role to suggest on the bot step.
 *
 * The first selected goal in presentation order that names a role this install
 * actually has. It is a suggestion only: the bot step still shows every role,
 * and a goal whose template is missing from the catalogue simply recommends no
 * role rather than a name nothing answers to.
 */
export function recommendedTemplateId(
  goals: readonly SetupGoalId[],
  templates: readonly {id: string}[],
): string | undefined {
  const available = new Set(templates.map((template) => template.id));
  for (const goal of SETUP_GOALS) {
    if (!goals.includes(goal.id)) {
      continue;
    }
    if (goal.templateId !== undefined && available.has(goal.templateId)) {
      return goal.templateId;
    }
  }
  return undefined;
}
