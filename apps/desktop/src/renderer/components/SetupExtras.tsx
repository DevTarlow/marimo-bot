/**
 * The optional pictures and voice downloads.
 *
 * These exist only because a goal asked for them, and they are optional even
 * then: the text model is what makes the app answer, and a vision or audio
 * download is a large file somebody may want to defer. So this step never
 * blocks Continue on an install, but it does block it while one is running —
 * walking away from a half-written model is the failure the required model step
 * already refuses, and the same rule is cheaper to keep in one place.
 *
 * The cards are grouped by the *assigned* model (Settings → Models owns that
 * assignment), not by task. A person who pointed Images and Voice at Omni gets
 * one card for one download, which is the point of Omni. Nothing here changes
 * an assignment, removes a model or puts one to sleep; those stay Settings'
 * business.
 *
 * Voice mode is a switch that only makes sense after the audio model is on
 * disk, so it is disabled until then and writes `companion.speakReplies` when
 * the person turns it on. The flow does not turn it on for them: hearing every
 * answer aloud is a preference, not a consequence of downloading a file.
 */
import {useEffect, useState} from 'react';

import {LOCAL_MODELS} from '@marimo/protocol';
import type {LocalModelId, LocalTask, PublicSettings} from '@marimo/protocol';

import {describe} from '../describe.js';
import {groupTasksByModel} from '../setup-goals.js';
import {ModelSetupCard} from './ModelSetupCard.js';

export function SetupExtras({
  settings,
  onSettings,
  tasks,
  onBack,
  onNext,
}: {
  settings: PublicSettings;
  /** The write's own answer, so this step and the window cannot disagree. */
  onSettings: (next: PublicSettings) => void;
  /** The model tasks the chosen goals asked for, in catalogue order. */
  tasks: readonly LocalTask[];
  onBack: () => void;
  onNext: () => void;
}): React.JSX.Element {
  const [busyModel, setBusyModel] = useState<LocalModelId | null>(null);
  const [speechSaving, setSpeechSaving] = useState(false);
  const [speechProblem, setSpeechProblem] = useState<string | null>(null);

  /*
   * One listener for the step rather than one per card: the installer runs one
   * download at a time, so a progress event names the model that owns the
   * Download button until it finishes or fails. A cancel does not emit an
   * event, so the card reports its own cancel back to clear this.
   */
  useEffect(() => {
    const off = window.marimo.onEvent((event) => {
      if (event.type === 'model.progress') {
        setBusyModel(event.modelId);
      } else if (
        event.type === 'model.installed' ||
        event.type === 'model.failed'
      ) {
        setBusyModel((current) => (current === event.modelId ? null : current));
      }
    });
    return off;
  }, []);

  const models = groupTasksByModel(tasks, settings.localModels.tasks);
  const voiceGoal = tasks.includes('voice');
  const voiceModelId = settings.localModels.tasks.voice;
  const voiceModel = LOCAL_MODELS[voiceModelId];
  const voiceInstalled = settings.localModels.models[voiceModelId].installed;
  const speechOn = settings.companion.speakReplies;
  const installBusy = busyModel !== null;
  const heading =
    tasks.length > 1
      ? 'Pictures and voice'
      : voiceGoal
        ? 'Talk out loud'
        : 'Look at pictures';

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
      <h2>{heading}</h2>
      <p className="onboarding-lead">
        {tasks.length > 1
          ? 'Images and voice are separate downloads.'
          : voiceGoal
            ? 'The voice model is a separate download.'
            : 'The vision model is a separate download.'}{' '}
        {tasks.length > 1
          ? 'You can skip these and add them later in Settings → Models.'
          : 'You can skip this and add it later in Settings → Models.'}
      </p>
      <p className="onboarding-note">
        The text model is the only download setup must finish. Nothing here
        changes which model does which task; that is in Settings.
      </p>

      {models.length === 0 ? (
        <p className="settings-muted">
          Nothing to download for the goals you chose.
        </p>
      ) : (
        <div className="setup-extras">
          {models.map(({modelId, tasks: modelTasks}) => (
            <ModelSetupCard
              key={modelId}
              modelId={modelId}
              settings={settings}
              onSettings={onSettings}
              tasks={modelTasks}
              downloadLabel="Download"
              installedNote={`Downloaded. ${
                modelTasks.includes('voice')
                  ? 'A spoken turn loads it.'
                  : 'Attaching a picture loads it.'
              }`}
              disabled={busyModel !== null && busyModel !== modelId}
              onCancelled={() => {
                setBusyModel((current) =>
                  current === modelId ? null : current,
                );
              }}
            />
          ))}
        </div>
      )}

      {voiceGoal && (
        <div className="settings-field">
          <label className="settings-check">
            <input
              type="checkbox"
              checked={speechOn}
              disabled={!voiceInstalled || speechSaving || installBusy}
              onChange={(event) => {
                void writeSpeech(event.target.checked);
              }}
            />
            <span>
              Talk to Marimo
              <em className="settings-why">
                A microphone button appears in the window and on the moss, and
                the answer is spoken aloud. A spoken turn uses{' '}
                {voiceModel.label} for the whole turn, so turn it off for harder
                work.
              </em>
            </span>
          </label>
          {!voiceInstalled && (
            <p className="settings-muted">
              Voice needs {voiceModel.label} — download it above to turn this
              on.
            </p>
          )}
          {speechProblem !== null && (
            <p className="settings-problem">{speechProblem}</p>
          )}
        </div>
      )}

      <div className="onboarding-actions">
        <button
          type="button"
          className="button button-primary"
          disabled={installBusy || speechSaving}
          onClick={onNext}
        >
          Continue
        </button>
        <button
          type="button"
          className="button button-quiet"
          disabled={installBusy || speechSaving}
          onClick={onBack}
        >
          Back
        </button>
      </div>
    </div>
  );
}
