/**
 * The Back rule for the setup flow.
 *
 * The renderer has no DOM test environment, so what is pinned here is the
 * decision, not the button. The case worth keeping is `more`: it is a real step
 * with a bot behind it and a dead end without one, and the two must not land in
 * the same place.
 */
import {describe, expect, it} from 'vitest';

import {
  backTargetFor,
  landingSpaceAfterSetup,
} from '../src/renderer/setup-nav.js';

describe('setup back targets', () => {
  it('walks back through the steps in order', () => {
    expect(backTargetFor({screen: 'provider', hasMadeBot: false})).toBe(
      'control',
    );
    expect(backTargetFor({screen: 'space', hasMadeBot: false})).toBe(
      'provider',
    );
    expect(backTargetFor({screen: 'bot', hasMadeBot: false})).toBe('space');
    expect(backTargetFor({screen: 'persona', hasMadeBot: true})).toBe('bot');
  });

  it('returns to the welcome screen from the control choice', () => {
    expect(backTargetFor({screen: 'control', hasMadeBot: false})).toBe(
      'welcome',
    );
  });

  it('has nothing behind the welcome screen', () => {
    expect(backTargetFor({screen: 'welcome', hasMadeBot: false})).toBeNull();
  });

  it('returns to the Persona only when a bot was made', () => {
    expect(backTargetFor({screen: 'more', hasMadeBot: true})).toBe('persona');
    expect(backTargetFor({screen: 'more', hasMadeBot: false})).toBe('bot');
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
