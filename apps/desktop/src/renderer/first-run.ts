/**
 * Which screen a launch opens on, as arithmetic rather than as an effect.
 *
 * Four screens answer to "the app cannot answer yet", and telling them apart is
 * the whole of this file. The flow is for somebody who has not met it; the short
 * card is for somebody who has, and whose app still cannot reply; the chat is
 * for an app that can. Getting this wrong is invisible in a way that matters —
 * a wizard that reappears every launch is a nag, and a wizard that never appears
 * is a first run with no way in.
 *
 * Two of the four rules are about *transitions* rather than states, and both
 * were learned the hard way:
 *
 * - **Nothing loaded is not a state to draw.** `settings` is `null` until the
 *   first read lands, and a screen decided from it would flash a wizard at
 *   somebody who has been using the app for months. `waiting` is the answer
 *   until a payload exists to have an opinion about.
 * - **The flow is sticky once it is up.** Its own model step is what turns
 *   `modelReady` true, and a rule that closed the flow the moment the app could
 *   answer would yank the screen away between a download finishing and reading
 *   what happened. `inSetup` outranks `modelReady` for exactly that reason.
 *
 * It lives here rather than inside `App.tsx` because this package has no DOM
 * test environment: the decision is the part worth a test, and a decision buried
 * in a component's render is a decision only a real window can check.
 */
export type FirstRunPhase =
  /** No payload has been read yet, so there is nothing to decide from. */
  | 'unknown'
  /** The flow is on screen until it says otherwise. */
  | 'inSetup'
  /** The flow has closed — finished, skipped, or deferred. */
  | 'left';

export type FirstRunScreen =
  /** A settings read is in flight. Draw the app's own loading line. */
  | 'waiting'
  /** The setup flow. */
  | 'setup'
  /** The short card: it cannot answer, and Settings is where that changes. */
  | 'cannotAnswer'
  /** A conversation, with a composer. */
  | 'app';

export interface FirstRunRead {
  /** Whether a settings payload has arrived at all. */
  loaded: boolean;
  /** Whether the app could answer a question right now, from that payload. */
  modelReady: boolean;
  /** Whether the flow has had its turn before, from settings. */
  setupSeen: boolean;
  /** Where this window is in the flow. */
  phase: FirstRunPhase;
}

export function firstRunScreen(read: FirstRunRead): FirstRunScreen {
  if (!read.loaded) {
    return 'waiting';
  }
  if (read.phase === 'inSetup') {
    return 'setup';
  }
  /*
   * The flow is the first run, not the "cannot answer" screen. A model can
   * already be on disk — preinstalled by a future build, or left by a previous
   * install that lost its settings — and the flow still asks what a working
   * model does not answer: which setup style and goals to use, which Space, and
   * whether a bot should be made. The other order made a preinstalled model
   * skip the introduction entirely, which is the one case where a person meets
   * the app with nothing configured.
   */
  if (!read.setupSeen) {
    return 'setup';
  }
  if (read.modelReady) {
    return 'app';
  }
  return 'cannotAnswer';
}
