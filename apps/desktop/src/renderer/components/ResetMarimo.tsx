/**
 * The last card in Settings: take the app back to a fresh install.
 *
 * **Why it is built this way.**
 *
 * The action cannot be undone and cannot be partially done, so the card's job is
 * not to describe a setting — it is to make sure that whoever presses the button
 * knows what is about to be lost. That decides three things about it.
 *
 * **It lists what goes, one line each, and says what stays.** "This will erase
 * your data" is the kind of sentence people read past. A list naming bots, their
 * conversations, what they remembered, jobs, keys, the search model and the
 * service timer is one somebody can check against what they have, and the
 * counterpart — that the folders they loaded are never touched — is the fact
 * that makes the decision possible at all.
 *
 * **The button is armed by typing the phrase, not by a dialog.** A confirmation
 * is a click people learn to make; see `reset-phrase.ts`, which owns the words
 * and the comparison so the label and the check cannot drift apart.
 *
 * **It is on both screens, and last.** A repair hidden behind an advanced mode
 * is a repair nobody finds, which is the same reason the provider card and the
 * connector list are on both — and it is last because it is the thing fewest
 * people want.
 *
 * **It ends the app rather than starting it again.** Everything it deleted would
 * be read back out of the memories of the running process otherwise, so the
 * button says what it does — erase and quit — and the card says to open Marimo Bot
 * again, which is how somebody meets the first-run screen a second time. A reset
 * that quietly left a fresh install in the tray was tried and is worse: it looks
 * exactly like a reset that did not happen.
 *
 * What happens after the press is not drawn here: the process answers, empties
 * the folder and ends itself, so the sentence this card shows is the last thing
 * on the screen.
 */
import {useState} from 'react';

import {describe} from '../describe.js';
import {RESET_PHRASE, armsReset} from '../reset-phrase.js';
import {SettingsSection} from './SettingsSection.js';

export function ResetMarimo({
  opened,
  onToggle,
  folder,
  disabled,
}: {
  opened: ReadonlySet<string>;
  onToggle: (title: string, expanded: boolean) => void;
  /**
   * Where the app keeps everything this deletes.
   *
   * Shown so the warning is about a place rather than an abstraction, and so
   * the promise underneath it can be checked: the folders somebody loaded are
   * not under this one. Absent until `app.info` has answered.
   */
  folder?: string;
  /** True while another write is in flight, which is not when to reset. */
  disabled?: boolean;
}): React.JSX.Element {
  const [typed, setTyped] = useState('');
  const [resetting, setResetting] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const armed = armsReset(typed) && !disabled && !resetting;

  const reset = async (): Promise<void> => {
    setResetting(true);
    setProblem(null);
    try {
      await window.marimo.call('app.reset', {});
      /*
       * Nothing after a success. The main process empties the folder and ends
       * this window a moment later, so the sentence below is the last thing
       * drawn rather than the first frame of anything.
       */
    } catch (failure) {
      setResetting(false);
      setProblem(describe(failure));
    }
  };

  return (
    <SettingsSection
      title="Reset Marimo Bot"
      opened={opened}
      onToggle={onToggle}
      danger
    >
      <p className="settings-danger">
        This takes Marimo Bot back to the state it was in the first time you opened
        it. Everything Marimo Bot keeps for itself on this computer is erased,
        nothing is backed up, and there is no undo.
      </p>
      {folder !== undefined && (
        <p className="settings-muted">
          All of it is inside {folder}. Your own folders are not in there and
          are not touched.
        </p>
      )}

      <h4 className="settings-group">What goes, for good</h4>
      <ul className="settings-reset-list">
        <li>
          Every bot: its identity, its abilities, and its conversations —
          including this one.
        </li>
        <li>
          Everything the bots remembered, what they worked out about you, and
          every note saying an answer was wrong.
        </li>
        <li>Scheduled jobs, and the record of how their last run went.</li>
        <li>The list of folders you loaded.</li>
        <li>
          Every connector you added and every secret it holds — the ones you let
          the background runner read included. They cannot be recovered, and you
          will type them in again.
        </li>
        <li>
          The downloaded chat models, so the next launch downloads one again. If
          you pointed the models at a folder of your own, that folder is left
          alone.
        </li>
        <li>
          The search index and the downloaded search model, so switching search
          back on downloads it again.
        </li>
        <li>
          The window layout, where the moss was left, and every appearance
          choice.
        </li>
        <li>
          The switches that start Marimo Bot at login and run jobs while it is
          closed.
        </li>
      </ul>

      <h4 className="settings-group">What stays</h4>
      <p className="settings-muted">
        Your files and folders, exactly where they are. Marimo Bot never deletes
        anything inside a space: not your documents, and not the notes a bot
        kept there. If a bot is mid-answer right now, that answer is lost.
      </p>
      <p className="settings-muted">
        Marimo Bot closes when it is done, and does not come back on its own. Open
        it again and it will ask you to set it up as it did the first time.
      </p>

      <label className="settings-field">
        <span>
          Type <strong>{RESET_PHRASE}</strong> to arm the button
        </span>
        {/*
          The hint is a sibling rather than inside the span, which is the shape
          every other `.settings-field` uses: inside the span it runs on from the
          label as one sentence.
        */}
        <em className="settings-why">
          The button stays grey until the words match, so this cannot be a stray
          click.
        </em>
        <input
          className="settings-input"
          type="text"
          value={typed}
          disabled={resetting}
          spellCheck={false}
          autoComplete="off"
          aria-label={`Type ${RESET_PHRASE} to erase everything`}
          onChange={(event) => {
            setTyped(event.target.value);
          }}
        />
      </label>

      <div className="settings-row">
        <button
          type="button"
          className="button button-danger"
          disabled={!armed}
          onClick={() => {
            void reset();
          }}
        >
          {resetting
            ? 'Erasing everything… Marimo Bot is closing'
            : 'Erase everything and quit'}
        </button>
      </div>

      {problem !== null && (
        <div className="error" role="alert">
          <span>{problem}</span>
        </div>
      )}
    </SettingsSection>
  );
}
