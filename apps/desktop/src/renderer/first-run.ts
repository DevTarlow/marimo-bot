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
 * - **The flow is sticky once it is up.** Its own server step is what makes the
 *   app able to answer, and a rule that closed the flow the moment the probe
 *   succeeded would yank the screen away between a test and reading what
 *   happened. `inSetup` outranks everything for exactly that reason.
 *
 * There is no "cannot answer" screen any more. A model server is a process the
 * person starts and stops outside this window; a launch with it off is a chat
 * with a notice above it, not a first run. Blocking the whole window on a
 * process this app does not own would make every start a diagnostic screen.
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
  /** A conversation, with a composer. */
  | 'app';

export interface FirstRunRead {
  /** Whether a settings payload has arrived at all. */
  loaded: boolean;
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
   * The flow is the first run, not a check on the server. A running server does
   * not answer what the flow asks: which setup style and goals to use, which
   * Space, and whether a bot should be made. The other order made a person with
   * a server already running skip the introduction entirely, which is the one
   * case where somebody meets the app with nothing configured.
   */
  if (!read.setupSeen) {
    return 'setup';
  }
  return 'app';
}
