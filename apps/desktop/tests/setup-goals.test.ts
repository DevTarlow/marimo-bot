/**
 * The first run's direction and goal rules.
 *
 * What is pinned here is the arithmetic, not the markup: which direction writes
 * which grant, which goals a Regular setup may offer, and what a set of goals
 * adds to the flow. The renderer has no DOM test environment, so these are the
 * decisions a real window would otherwise be the only way to check.
 */
import {describe, expect, it} from 'vitest';

import {
  SETUP_GOALS,
  directionForPresetId,
  goalAvailableIn,
  goalEffects,
  presetIdForDirection,
  recommendedTemplateId,
  setupGoalById,
} from '../src/renderer/setup-goals.js';
import type {SetupDirection, SetupGoalId} from '../src/renderer/setup-goals.js';

/** The goals a direction can offer, read the way the screen reads them. */
function availableGoals(direction: SetupDirection): SetupGoalId[] {
  return SETUP_GOALS.filter((goal) => goalAvailableIn(goal, direction)).map(
    (goal) => goal.id,
  );
}

describe('the setup direction', () => {
  it('maps Regular to the Standard grant and Power to the Power user grant', () => {
    expect(presetIdForDirection('regular')).toBe('standard');
    expect(presetIdForDirection('power')).toBe('power');
  });

  it('reads the direction back from the grant Settings shows', () => {
    expect(directionForPresetId('standard')).toBe('regular');
    expect(directionForPresetId('power')).toBe('power');
  });

  it('has no direction for a custom mix', () => {
    expect(directionForPresetId(undefined)).toBeNull();
    expect(directionForPresetId('chat')).toBeNull();
  });
});

describe('the goals a direction offers', () => {
  it('offers every goal in Power setup', () => {
    expect(availableGoals('power')).toEqual(SETUP_GOALS.map((goal) => goal.id));
  });

  it('holds back scheduling from a Regular setup', () => {
    const regular = availableGoals('regular');
    expect(regular).not.toContain('automation');
    // Everything else is a read, a model download, or a bot's own tools.
    expect(regular).toContain('writing');
    expect(regular).toContain('coding');
    expect(regular).toContain('pictures');
  });

  it('guards the power-only goal itself', () => {
    const automation = setupGoalById('automation');
    expect(automation).toBeDefined();
    expect(goalAvailableIn(automation!, 'regular')).toBe(false);
    expect(goalAvailableIn(automation!, 'power')).toBe(true);
    expect(goalAvailableIn(setupGoalById('files')!, 'regular')).toBe(true);
  });
});

describe('what the chosen goals add', () => {
  it('adds nothing for no goals', () => {
    expect(goalEffects([])).toEqual({
      needsBot: false,
      tasks: [],
      jobs: false,
    });
  });

  it('asks for the vision model when pictures were chosen', () => {
    expect(goalEffects(['pictures']).tasks).toEqual(['vision']);
    expect(goalEffects(['files']).tasks).toEqual([]);
  });

  it('reserves jobs for the automation goal', () => {
    expect(goalEffects(['files', 'writing']).jobs).toBe(false);
    expect(goalEffects(['automation']).jobs).toBe(true);
  });

  it('adds a bot step for the goals that need one', () => {
    expect(goalEffects(['files']).needsBot).toBe(false);
    expect(goalEffects(['bots']).needsBot).toBe(true);
    expect(goalEffects(['writing']).needsBot).toBe(true);
    expect(goalEffects(['automation']).needsBot).toBe(true);
  });

  it('selects the starter role of the first goal that names one', () => {
    expect(goalEffects(['writing']).templateId).toBe('writer');
    expect(goalEffects(['research', 'writing']).templateId).toBe('researcher');
    expect(goalEffects(['bots'])).not.toHaveProperty('templateId');
  });
});

describe('the suggested starter role', () => {
  const templates = [
    {id: 'writer'},
    {id: 'researcher'},
    {id: 'coder'},
    {id: 'assistant'},
  ];

  it('suggests the role the goal names', () => {
    expect(recommendedTemplateId(['writing'], templates)).toBe('writer');
    expect(recommendedTemplateId(['coding'], templates)).toBe('coder');
  });

  it('follows the goal order rather than the click order', () => {
    expect(recommendedTemplateId(['writing', 'research'], templates)).toBe(
      'researcher',
    );
  });

  it('suggests nothing when the catalogue has no such role', () => {
    expect(recommendedTemplateId(['writing'], [])).toBeUndefined();
    expect(recommendedTemplateId(['bots'], templates)).toBeUndefined();
  });

  it('falls through a missing role to the next goal that has one', () => {
    const partial = [{id: 'coder'}];
    expect(recommendedTemplateId(['research', 'coding'], partial)).toBe(
      'coder',
    );
  });
});

describe('the goal list itself', () => {
  it('has one card per decision', () => {
    const ids = SETUP_GOALS.map((goal) => goal.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('lets one goal be read back by id', () => {
    const wanted: SetupGoalId = 'pictures';
    expect(setupGoalById(wanted)?.label).toBe('Look at pictures');
    expect(setupGoalById('files')?.models).toBeUndefined();
  });
});
