/**
 * The first-run step that connects the model server.
 *
 * This is the one step the app cannot do for the person: it does not start the
 * server and it does not download anything. It asks for the address, tests it,
 * and shows the model the server reports. Continue is enabled only when that
 * test succeeded, because the flow's promise is that the window it closes onto
 * can answer.
 *
 * A server that answers but cannot call tools keeps that promise and breaks the
 * larger one: the chat opens and the bot cannot read a file or run a job. So it
 * is not refused — the person may want exactly that — but the warning sits
 * beside the button and the button stops pretending: it continues *without
 * tools*, in those words.
 *
 * It is the same form as Settings' card, deliberately: a second set of fields
 * here would be a second validation rule, and the two would drift the first
 * time one of them learned about a new kind of address.
 */
import {useState} from 'react';

import type {PublicSettings} from '@marimo/protocol';

import {ModelServerForm} from './ModelServerForm.js';
import {
  cannotCallTools,
  continueLabel,
  TOOLS_OFF_SETUP,
} from '../model-copy.js';

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
  /*
   * `state.ready` rather than the raw status: a half-typed address must not keep
   * a warning about a server that is no longer the one in the field.
   */
  const toolsOff =
    state.ready && cannotCallTools(settings.modelServerStatus);

  return (
    <div className="setup-body">
      <h2>Connect your model server</h2>
      <p className="onboarding-lead">
        Marimo Bot answers with a model you run on this computer. Start your
        server first, then put its address here. There is no account, no API key
        and no download.
      </p>
      <p className="onboarding-note">
        The setup this build is tested against is llama.cpp with Gemma 4 12B and
        its projector; the command is under the fields. The address is{' '}
        <code>http://127.0.0.1:8080/v1</code>, and only this computer is
        accepted: localhost, 127.0.0.1 and ::1. Any OpenAI-compatible server
        whose model can call tools works too.
      </p>

      <ModelServerForm
        settings={settings}
        onSettings={onSettings}
        onStatusChange={setState}
      />

      {toolsOff && (
        <p className="warning setup-tools-warning" role="status">
          <span>{TOOLS_OFF_SETUP}</span>
        </p>
      )}

      <div className="onboarding-actions">
        <button
          type="button"
          className="button button-primary"
          disabled={!state.ready || state.testing}
          onClick={onNext}
        >
          {continueLabel(toolsOff)}
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
