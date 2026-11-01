/**
 * Which screen a launch opens on.
 *
 * The flow, the short card and the chat are three answers to "can this app
 * reply", and two of the rules that pick between them are about moments rather
 * than states. Those are what this file drives: the payload in flight, and the
 * flow's own last write turning the app ready while somebody is still reading
 * the step.
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
    // Whatever the machine is like, there is no payload to say so yet.
    modelReady: false,
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
        modelReady: true,
        setupSeen: true,
        phase: 'left',
      }),
    ).toBe('waiting');
  });

  it('offers the flow to a fresh install', () => {
    expect(
      firstRunScreen({
        loaded: true,
        modelReady: false,
        setupSeen: false,
        phase: 'unknown',
      }),
    ).toBe('setup');
  });

  /*
   * A model can already be on disk before the flow has ever run — preinstalled,
   * or left by an install whose settings were lost. The flow still owns the
   * first run: it asks for a Space and a first bot, which a working model does
   * not answer. Once it has run, a working model opens the chat.
   */
  it('offers the flow once even when a model is already on disk', () => {
    expect(
      firstRunScreen({
        loaded: true,
        modelReady: true,
        setupSeen: false,
        phase: 'unknown',
      }),
    ).toBe('setup');
  });

  it('opens on the chat when the flow has already run and the app can answer', () => {
    expect(
      firstRunScreen({
        loaded: true,
        modelReady: true,
        setupSeen: true,
        phase: 'left',
      }),
    ).toBe('app');
  });

  /*
   * The reported failure this exists for: the flow's own provider step is what
   * turns `modelReady` true, and saving a key must not swap the screen out
   * between the save and the sentence saying it worked.
   */
  it('stays on the flow while its own write makes the app ready', () => {
    expect(
      firstRunScreen({
        loaded: true,
        modelReady: true,
        setupSeen: false,
        phase: 'inSetup',
      }),
    ).toBe('setup');
  });

  it('shows the chat once the flow closes on a working provider', () => {
    expect(
      firstRunScreen({
        loaded: true,
        modelReady: true,
        setupSeen: true,
        phase: 'left',
      }),
    ).toBe('app');
  });

  /*
   * The state `setupSeen` is stored for. Somebody who deferred, or whose key
   * stopped being readable later, gets the card that names the problem and opens
   * Settings — not the flow again, which would ask them to name a first bot they
   * already have.
   */
  it('shows the short card to somebody who has been through it', () => {
    expect(
      firstRunScreen({
        loaded: true,
        modelReady: false,
        setupSeen: true,
        phase: 'left',
      }),
    ).toBe('cannotAnswer');
  });

  it('gives a file from before the flag the flow once more', () => {
    expect(
      firstRunScreen({
        loaded: true,
        modelReady: false,
        setupSeen: false,
        phase: 'left',
      }),
    ).toBe('setup');
  });
});
