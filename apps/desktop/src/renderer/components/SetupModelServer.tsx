/**
 * The first-run step that connects the model server.
 *
 * This is the one step the app cannot do for the person: it does not start the
 * server and it does not download anything. It asks for the address, tests it,
 * and shows the model the server reports. Continue is enabled only when that
 * test succeeded, because the flow's promise is that the window it closes onto
 * can answer.
 *
 * It is the same form as Settings' card, deliberately: a second set of fields
 * here would be a second validation rule, and the two would drift the first
 * time one of them learned about a new kind of address.
 */
import {useState} from 'react';

import type {PublicSettings} from '@marimo/protocol';

import {ModelServerForm} from './ModelServerForm.js';

export function SetupModelServer({
  settings,
  onSettings,
  onBack,
  onNext,
  onLater,
}: {
  settings: PublicSettings;
  /** The write's own answer, so this step and the window cannot disagree. */
  onSettings: (next: PublicSettings) => void;
  onBack: () => void;
  /** Continues to the Space and bot steps, only when the server answers. */
  onNext: () => void;
  /** Closes the flow without making a bot, for somebody setting the rest up later. */
  onLater: () => void;
}): React.JSX.Element {
  const [state, setState] = useState({
    dirty: false,
    ready: settings.modelReady,
    testing: false,
  });

  return (
    <div className="setup-body">
      <h2>Connect your model server</h2>
      <p className="onboarding-lead">
        Marimo Bot answers with a model you run on this computer. Start your
        server first, then put its address here. There is no account, no API key
        and no download.
      </p>
      <p className="onboarding-note">
        The default is llama.cpp on <code>http://127.0.0.1:8080/v1</code>, with
        your model loaded. A server on another machine is refused: only
        localhost, 127.0.0.1 and ::1 are accepted.
      </p>

      <ModelServerForm
        settings={settings}
        onSettings={onSettings}
        onStatusChange={setState}
      />

      <div className="onboarding-actions">
        <button
          type="button"
          className="button button-primary"
          disabled={!state.ready || state.testing}
          onClick={onNext}
        >
          Continue
        </button>
        <button
          type="button"
          className="button button-quiet"
          disabled={state.testing}
          onClick={onBack}
        >
          Back
        </button>
        <button
          type="button"
          className="button button-quiet"
          disabled={state.testing}
          onClick={onLater}
        >
          Set this up later
        </button>
      </div>
    </div>
  );
}
