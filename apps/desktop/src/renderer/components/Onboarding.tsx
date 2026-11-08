/**
 * The screen for an install that cannot answer and has already met the flow.
 *
 * It used to be the first thing every new install saw: a card naming what was
 * missing, with one button into Settings. That job belongs to the setup flow now,
 * which asks for a Space, a bot and the first model in one pass — so what is left
 * here is the *second* visit. Somebody declined the flow ("set this up later"),
 * or upgraded from the provider build and has no local model yet, and either way
 * they know what the app is and want the one place that fixes it.
 *
 * The download is here rather than only in Settings because the upgrade path is
 * the common case this screen actually gets: a person who has been using the app
 * for months and is now told the model is gone should not have to find a card.
 * The Models card is still the place to manage the family afterwards.
 *
 * The sentence is the main process's, not a rewrite of it here. A refusal
 * arrives as `modelProblem` because the failures have nothing in common — no
 * model downloaded, no engine for this platform, a file removed from under it —
 * and a screen that said "not ready" for all of them would be a dead end for
 * each. The process that looked is the only one that knows which it is.
 *
 * Nothing here decides whether the app can answer. The main process does, before
 * this is ever rendered: a working model means the app opens on a normal chat.
 */
import {useEffect, useState} from 'react';

import {LOCAL_MODELS, variantBytes} from '@marimo/protocol';
import type {PublicSettings} from '@marimo/protocol';

import {describe} from '../describe.js';

export function Onboarding({
  settings,
  problem,
  onOpenSettings,
  onRestart,
  onChanged,
}: {
  settings: PublicSettings;
  /** Why it cannot answer yet, in the words of whoever knew. */
  problem: string;
  onOpenSettings: () => void;
  /** Offers the guided setup again, for somebody who skipped it the first time. */
  onRestart: () => void;
  /** Re-reads the settings after a download finishes. */
  onChanged: () => void | Promise<void>;
}): React.JSX.Element {
  const modelId = settings.localModels.tasks.chat;
  const status = settings.localModels.models[modelId];
  const model = LOCAL_MODELS[modelId];
  const [installing, setInstalling] = useState(false);
  const [progress, setProgress] = useState<{
    label: string;
    receivedBytes: number;
    totalBytes: number;
    percent?: number;
  } | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    if (!installing) {
      return;
    }
    const off = window.marimo.onEvent((event) => {
      if (event.type === 'model.progress' && event.modelId === modelId) {
        setProgress({
          label: event.label,
          receivedBytes: event.receivedBytes,
          totalBytes: event.totalBytes,
          ...(event.percent === undefined ? {} : {percent: event.percent}),
        });
      } else if (event.type === 'model.installed' && event.modelId === modelId) {
        setInstalling(false);
        setProgress(null);
        void onChanged();
      } else if (event.type === 'model.failed' && event.modelId === modelId) {
        setInstalling(false);
        setFailure(event.message);
      }
    });
    return off;
  }, [installing, modelId, onChanged]);

  const install = async (): Promise<void> => {
    setInstalling(true);
    setFailure(null);
    try {
      const variant =
        status.installedVariant ?? settings.localModels.recommendedVariant;
      const {started} = await window.marimo.call('models.install', {
        modelId,
        variant,
      });
      if (!started) {
        setInstalling(false);
        setFailure('Another download is already running. Let it finish first.');
      }
    } catch (error) {
      setInstalling(false);
      setFailure(describe(error));
    }
  };

  const size = variantBytes(
    modelId,
    status.installedVariant ?? settings.localModels.recommendedVariant,
  );
  const sizeLabel = `${(size / 1_000_000_000).toFixed(1)} GB`;

  return (
    <div className="onboarding">
      <img className="onboarding-mark" src="./marimo-logo.png" alt="" />
      <h2>Marimo Bot is not ready</h2>

      <p className="onboarding-lead">
        It needs its local model before it can reply.
      </p>
      <p className="onboarding-note">{problem}</p>

      {!status.installed && settings.localModels.engine.platformSupported && (
        <div className="onboarding-actions onboarding-download">
          {progress === null ? (
            <button
              type="button"
              className="button button-primary"
              disabled={installing}
              onClick={() => {
                void install();
              }}
            >
              {installing
                ? 'Starting…'
                : `Download ${model.label} (${sizeLabel})`}
            </button>
          ) : (
            <>
              <span className="onboarding-note">
                {progress.label} ·{' '}
                {progress.percent === undefined
                  ? `${Math.round(progress.receivedBytes / (1024 * 1024))} MB`
                  : `${String(progress.percent)}%`}
              </span>
              <progress
                className="model-progress"
                value={progress.receivedBytes}
                max={progress.totalBytes}
              />
              <button
                type="button"
                className="button button-quiet"
                onClick={() => {
                  void window.marimo
                    .call('models.cancel', {})
                    .then(() => {
                      setInstalling(false);
                      setProgress(null);
                    })
                    .catch((error: unknown) => {
                      setFailure(describe(error));
                    });
                }}
              >
                Cancel
              </button>
            </>
          )}
        </div>
      )}

      {failure !== null && <p className="settings-problem">{failure}</p>}

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
