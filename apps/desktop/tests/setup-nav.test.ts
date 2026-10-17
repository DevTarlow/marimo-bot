/**
 * The Back rule for the setup flow.
 *
 * The renderer has no DOM test environment, so what is pinned here is the
 * decision, not the button. The case worth keeping is `more`: it is a real step
 * with a bot behind it and a dead end without one, and the two must not land in
 * the same place.
 */
import {describe, expect, it} from 'vitest';

import {backTargetFor} from '../src/renderer/setup-nav.js';

describe('setup back targets', () => {
  it('walks back through the steps in order', () => {
    expect(backTargetFor({screen: 'space', hasMadeBot: false})).toBe('provider');
    expect(backTargetFor({screen: 'bot', hasMadeBot: false})).toBe('space');
    expect(backTargetFor({screen: 'persona', hasMadeBot: true})).toBe('bot');
  });

  it('always returns to the Model step from the Space step', () => {
    expect(backTargetFor({screen: 'provider', hasMadeBot: false})).toBe(
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
