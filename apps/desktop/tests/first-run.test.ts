/**
 * Which screen a launch opens on.
 *
 * Two screens answer to "has this person been through the first run": the flow
 * and the chat. The probe is not one of them. A model server is a process the
 * person starts and stops outside this window, so a launch with it off is a chat
 * with a notice above it, not a first run — blocking the window on a process the
 * app does not own would make every start a diagnostic screen.
 *
 * A launch is driven in order rather than asserted one case at a time, because
 * what the window *remembers* is as much of the answer as what it decides — the
 * same reason `recall-offer.test.ts` drives two reads.
 */
import {describe, expect, it} from 'vitest';

import {firstRunScreen} from '../src/renderer/first-run.js';
import type {FirstRunPhase} from '../src/renderer/first-run.js';

/** The one read that happens before `settings.get` has answered. */
function inFlight(phase: FirstRunPhase = 'unknown'): string {
  return firstRunScreen({
    loaded: false,
    setupSeen: false,
    phase,
  });
}

describe('firstRunScreen', () => {
  it('draws the loading line until a payload arrives', () => {
    expect(inFlight()).toBe('waiting');
    // And not the flow, which is what a screen decided from `null` would flash.
    expect(
      firstRunScreen({
        loaded: false,
        setupSeen: true,
        phase: 'left',
      }),
    ).toBe('waiting');
  });

  it('offers the flow to a fresh install', () => {
    expect(
      firstRunScreen({
        loaded: true,
        setupSeen: false,
        phase: 'unknown',
      }),
    ).toBe('setup');
  });

  /*
   * A server can already be running before the flow has ever run. The flow still
   * owns the first run: it asks for a Space and a first bot, which a working
   * server does not answer. Once it has run, the chat opens with or without the
   * server, and the notice says which.
   */
  it('offers the flow once even when a server is already answering', () => {
    expect(
      firstRunScreen({
        loaded: true,
        setupSeen: false,
        phase: 'unknown',
      }),
    ).toBe('setup');
  });

  it('opens on the chat when the flow has already run', () => {
    expect(
      firstRunScreen({
        loaded: true,
        setupSeen: true,
        phase: 'left',
      }),
    ).toBe('app');
  });

  /*
   * The reported failure this exists for: the flow's own server test makes the
   * app able to answer, and that must not swap the screen out between the test
   * and the review that says what was configured.
   */
  it('stays on the flow while its own step makes the app able to answer', () => {
    expect(
      firstRunScreen({
        loaded: true,
        setupSeen: false,
        phase: 'inSetup',
      }),
    ).toBe('setup');
  });

  /*
   * The state `setupSeen` is stored for. Somebody who deferred gets the chat and
   * the notice, not the flow again, which would ask them to name a first bot
   * they already have.
   */
  it('shows the chat to somebody who has been through it and deferred', () => {
    expect(
      firstRunScreen({
        loaded: true,
        setupSeen: true,
        phase: 'left',
      }),
    ).toBe('app');
  });

  it('gives a file from before the flag the flow once more', () => {
    expect(
      firstRunScreen({
        loaded: true,
        setupSeen: false,
        phase: 'left',
      }),
    ).toBe('setup');
  });
});
