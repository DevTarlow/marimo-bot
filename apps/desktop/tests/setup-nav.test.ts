/**
 * The setup flow's step graph.
 *
 * The renderer has no DOM test environment, so what is pinned here is the
 * arithmetic: which steps a direction and a set of goals produce, and what Back
 * and Continue do on the resolved list. The cases worth keeping are the ones a
 * hand-written switch got wrong — a Persona with no bot behind it, a jobs step
 * in a Regular run, and a Back that led to a form which would make a second bot.
 */
import {describe, expect, it} from 'vitest';

import {
  landingSpaceAfterSetup,
  nextStage,
  previousStage,
  setupSteps,
} from '../src/renderer/setup-nav.js';
import type {SetupStep} from '../src/renderer/setup-nav.js';

import type {SetupDirection, SetupGoalId} from '../src/renderer/setup-goals.js';

function stepsFor(
  direction: SetupDirection,
  goals: readonly SetupGoalId[],
  hasMadeBot = false,
): SetupStep[] {
  return setupSteps({direction, goals, hasMadeBot});
}

function ids(steps: readonly SetupStep[]): string[] {
  return steps.map((step) => step.id);
}

describe('the steps a setup produces', () => {
  it('keeps a chat-only Regular run short', () => {
    expect(ids(stepsFor('regular', []))).toEqual([
      'direction',
      'goals',
      'model',
      'space',
      'finish',
    ]);
  });

  it('adds the bot, Persona and more-bots steps for a research goal', () => {
    expect(ids(stepsFor('regular', ['research']))).toEqual([
      'direction',
      'goals',
      'model',
      'space',
      'bot',
      'finish',
    ]);
    expect(ids(stepsFor('regular', ['research'], true))).toEqual([
      'direction',
      'goals',
      'model',
      'space',
      'bot',
      'persona',
      'more',
      'finish',
    ]);
  });

  it('does not add a step for pictures, now that the one model handles them', () => {
    expect(ids(stepsFor('power', ['pictures']))).toEqual([
      'direction',
      'goals',
      'model',
      'space',
      'finish',
    ]);
  });

  it('adds the jobs step only to Power with automation', () => {
    expect(ids(stepsFor('power', ['automation']))).toEqual([
      'direction',
      'goals',
      'model',
      'space',
      'bot',
      'jobs',
      'finish',
    ]);
    expect(ids(stepsFor('power', ['automation'], true))).toEqual([
      'direction',
      'goals',
      'model',
      'space',
      'bot',
      'persona',
      'more',
      'jobs',
      'finish',
    ]);
    // The goal cannot be chosen in Regular, and even a stale list must not
    // produce a service screen the grant cannot back.
    expect(ids(stepsFor('regular', ['automation']))).not.toContain('jobs');
  });

  it('never puts a Persona before the bot that makes one', () => {
    const cases = [
      stepsFor('regular', []),
      stepsFor('regular', ['files'], true),
      stepsFor('regular', ['research'], true),
      stepsFor('power', ['pictures', 'automation'], true),
      stepsFor('power', ['automation'], false),
    ];
    for (const steps of cases) {
      const listed = ids(steps);
      if (!listed.includes('bot')) {
        expect(listed).not.toContain('persona');
        expect(listed).not.toContain('more');
      }
      if (listed.includes('persona')) {
        expect(listed.indexOf('persona')).toBeGreaterThan(
          listed.indexOf('bot'),
        );
      }
      if (listed.includes('more')) {
        expect(listed.indexOf('more')).toBeGreaterThan(
          listed.indexOf('persona'),
        );
      }
    }
  });

  it('always starts with the direction and ends on the review', () => {
    const steps = stepsFor('power', ['writing', 'pictures'], true);
    expect(steps[0]?.id).toBe('direction');
    expect(steps[0]?.label).toBe('Control');
    expect(steps.at(-1)?.id).toBe('finish');
    expect(steps.at(-1)?.label).toBe('Ready');
    for (const step of steps) {
      expect(step.label.length).toBeGreaterThan(0);
    }
  });
});

describe('moving through the resolved steps', () => {
  const steps = stepsFor('power', ['writing', 'pictures'], true);

  it('takes the welcome screen to the first step', () => {
    expect(nextStage(steps, 'welcome')).toBe('direction');
    expect(previousStage(steps, 'welcome')).toBeNull();
  });

  it('walks forward to the review and stops', () => {
    const walked: string[] = [];
    let screen = nextStage(steps, 'welcome');
    while (screen !== null) {
      walked.push(screen);
      screen = nextStage(steps, screen);
    }
    expect(walked).toEqual(ids(steps));
  });

  it('walks back to the welcome screen and stops', () => {
    const walked: string[] = [];
    let screen = previousStage(steps, 'finish');
    while (screen !== null && screen !== 'welcome') {
      walked.push(screen);
      screen = previousStage(steps, screen);
    }
    expect(screen).toBe('welcome');
    expect(walked).toEqual([...ids(steps).slice(0, -1)].reverse());
    expect(walked.at(-1)).toBe('direction');
  });

  it('gives every step but the first one a way back', () => {
    for (const step of steps) {
      const back = previousStage(steps, step.id);
      if (step.id === 'direction') {
        expect(back).toBe('welcome');
      } else {
        expect(back).not.toBeNull();
      }
    }
    expect(previousStage(steps, 'finish')).toBe('more');
  });

  it('returns the Persona to the bot list, not a form that makes a second bot', () => {
    expect(previousStage(steps, 'persona')).toBe('bot');
    expect(previousStage(steps, 'more')).toBe('persona');
  });
});

/*
 * Where a finished flow opens a conversation. Only a Space the person picked is
 * a landing: an install that kept the folder the app started in already has the
 * conversation the window opened on, filed there.
 */
describe('the Space a finished flow lands in', () => {
  it('opens a new chat in the Space the person picked', () => {
    expect(landingSpaceAfterSetup('ws-b')).toBe('ws-b');
  });

  it('opens none when they kept the starting folder', () => {
    expect(landingSpaceAfterSetup(null)).toBeUndefined();
  });
});
