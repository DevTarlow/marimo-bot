/**
 * The screen for an install that cannot answer and has already met the flow.
 *
 * It used to be the first thing every new install saw: a card naming what was
 * missing, with one button into Settings. That job belongs to the setup flow now,
 * which asks for a Space, a bot and a provider in one pass — so what is left here
 * is the *second* visit. Somebody declined the flow ("set this up later"), or
 * their key stopped being readable after it ran, and either way they know what
 * the app is and want the one place that fixes it.
 *
 * The sentence is the main process's, not a rewrite of it here. A refusal
 * arrives as `modelProblem` because the failures have nothing in common — no
 * key, a key that cannot be decrypted, a provider this build does not know —
 * and a screen that said "not ready" for all of them would be a dead end for
 * each. The process that looked is the only one that knows which it is.
 *
 * `Run setup again` is here rather than nowhere because the flag that keeps the
 * flow from returning would otherwise be one-way: somebody who skipped it in a
 * hurry, or who wants the guided version months later, has no way back to it.
 *
 * Nothing here decides whether the app can answer. The main process does, before
 * this is ever rendered: a working provider means the app opens on a normal chat.
 */
export function Onboarding({
  problem,
  onOpenSettings,
  onRestart,
}: {
  /** Why it cannot answer yet, in the words of whoever knew. */
  problem: string;
  onOpenSettings: () => void;
  /** Offers the guided setup again, for somebody who skipped it the first time. */
  onRestart: () => void;
}): React.JSX.Element {
  return (
    <div className="onboarding">
      <img className="onboarding-mark" src="./marimo-logo.png" alt="" />
      <h2>Marimo Bot is not ready</h2>

      <p className="onboarding-lead">It needs a model before it can reply.</p>
      <p className="onboarding-note">{problem}</p>

      <div className="onboarding-actions">
        <button
          type="button"
          className="button button-primary"
          onClick={onOpenSettings}
        >
          Open Settings
        </button>
        <button
          type="button"
          className="button button-quiet"
          onClick={onRestart}
        >
          Run setup again
        </button>
      </div>

      <p className="onboarding-note onboarding-quiet">
        It can read files in the Space you choose and use the tools you switch
        on. It asks before running a command or replacing a file that is already
        there.
      </p>
    </div>
  );
}
