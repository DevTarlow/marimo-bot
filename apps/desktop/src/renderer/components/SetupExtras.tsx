/**
 * The voice preference in the first run.
 *
 * The Omni model is the required download in the model step, and it already
 * sees and speaks. There is no second model to fetch here; the only question is
 * whether answers should be read aloud. That stays off until the person turns
 * it on, because hearing every answer is a preference rather than a consequence
 * of downloading a file.
 *
 * The step appears only when the voice goal was chosen. Pictures need no switch:
 * attaching an image is the gesture, and the Omni model is already installed.
 */
import {useState} from 'react';

import {LOCAL_MODELS} from '@marimo/protocol';
import type {PublicSettings} from '@marimo/protocol';

import {describe} from '../describe.js';

export function SetupExtras({
  settings,
  onSettings,
  onBack,
  onNext,
}: {
  settings: PublicSettings;
  /** The write's own answer, so this step and the window cannot disagree. */
  onSettings: (next: PublicSettings) => void;
  onBack: () => void;
  onNext: () => void;
}): React.JSX.Element {
  const [speechSaving, setSpeechSaving] = useState(false);
  const [speechProblem, setSpeechProblem] = useState<string | null>(null);

  const voiceModelId = settings.localModels.tasks.voice;
  const voiceModel = LOCAL_MODELS[voiceModelId];
  const voiceInstalled = settings.localModels.models[voiceModelId].installed;
  const speechOn = settings.companion.speakReplies;

  const writeSpeech = async (on: boolean): Promise<void> => {
    setSpeechSaving(true);
    setSpeechProblem(null);
    try {
      const {settings: next} = await window.marimo.call('settings.set', {
        patch: {companion: {speakReplies: on}},
      });
      onSettings(next);
    } catch (failure) {
      setSpeechProblem(describe(failure));
    } finally {
      setSpeechSaving(false);
    }
  };

  return (
    <div className="setup-body">
      <h2>Talk out loud</h2>
      <p className="onboarding-lead">
        {voiceModel.label} handles chat, pictures and voice, so there is no
        extra model to download here. Turn on spoken replies if you want the
        answer read aloud.
      </p>
      <p className="onboarding-note">
        Spoken replies are off by default. You can change this later in
        Settings.
      </p>

      <div className="settings-field">
        <label className="settings-check">
          <input
            type="checkbox"
            checked={speechOn}
            disabled={!voiceInstalled || speechSaving}
            onChange={(event) => {
              void writeSpeech(event.target.checked);
            }}
          />
          <span>
            Talk to Marimo
            <em className="settings-why">
              A microphone button appears in the window and on the moss, and
              the answer is spoken aloud. A spoken turn uses {voiceModel.label}{' '}
              for the whole turn, so turn it off for harder work.
            </em>
          </span>
        </label>
        {!voiceInstalled && (
          <p className="settings-muted">
            {voiceModel.label} needs downloading first; the model step above
            fetches it.
          </p>
        )}
        {speechProblem !== null && (
          <p className="settings-problem">{speechProblem}</p>
        )}
      </div>

      <div className="onboarding-actions">
        <button
          type="button"
          className="button button-primary"
          disabled={speechSaving}
          onClick={onNext}
        >
          Continue
        </button>
        <button
          type="button"
          className="button button-quiet"
          disabled={speechSaving}
          onClick={onBack}
        >
          Back
        </button>
      </div>
    </div>
  );
}
