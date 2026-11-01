/**
 * The first-run model step.
 *
 * This is the one step the app cannot do for the person: it downloads 1.9GB of
 * model. Everything else in the flow is a choice; this is a wait, and the screen
 * has to say how long, how big, and what happens if it fails.
 *
 * Two deliberate differences from the Models card in Settings, which is the same
 * job for somebody who already knows the app:
 *
 * - **One model, one decision.** The first run downloads the chat model, because
 *   an app that cannot answer has nothing to demonstrate. Pictures and voice are
 *   add-ons somebody chooses later, when they know the machine.
 * - **It ends on a verification.** The install is not "done" when the files are
 *   on disk; it is done when the engine has loaded them once. The step waits for
 *   that, because a first chat that dies on a machine the app cannot run would be
 *   a worse first impression than a slower download.
 */
import {useEffect, useState} from 'react';

import {
  LOCAL_MODELS,
  localModelVariantSchema,
  variantBytes,
} from '@marimo/protocol';
import type {
  LocalModelId,
  LocalModelVariant,
  PublicSettings,
} from '@marimo/protocol';

import {describe} from '../describe.js';

export function SetupModel({
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
  /** Continues to the Space and bot steps, only when the app can answer. */
  onNext: () => void;
  /** Closes the flow without making a bot, for somebody setting the rest up later. */
  onLater: () => void;
}): React.JSX.Element {
  const modelId = settings.localModels.tasks.chat;
  const model = LOCAL_MODELS[modelId];
  const status = settings.localModels.models[modelId];
  const [variant, setVariant] = useState<LocalModelVariant>(
    status.installedVariant ?? settings.localModels.recommendedVariant,
  );
  const [installing, setInstalling] = useState(false);
  const [progress, setProgress] = useState<{
    label: string;
    receivedBytes: number;
    totalBytes: number;
    percent?: number;
  } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [warming, setWarming] = useState(false);

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
        void refresh();
      } else if (event.type === 'model.failed' && event.modelId === modelId) {
        setInstalling(false);
        setProblem(event.message);
      }
    });
    return off;
  }, [installing, modelId]);

  const refresh = async (): Promise<void> => {
    try {
      const {settings: next} = await window.marimo.call('settings.get', {});
      onSettings(next);
    } catch (failure) {
      setProblem(describe(failure));
    }
  };

  const install = async (): Promise<void> => {
    setInstalling(true);
    setProblem(null);
    try {
      const {started} = await window.marimo.call('models.install', {
        modelId,
        variant,
      });
      if (!started) {
        setInstalling(false);
        setProblem('Another download is already running. Let it finish first.');
      }
    } catch (failure) {
      setInstalling(false);
      setProblem(describe(failure));
    }
  };

  const cancel = (): void => {
    void window.marimo
      .call('models.cancel', {})
      .then(() => {
        setInstalling(false);
        setProgress(null);
      })
      .catch((failure: unknown) => {
        setProblem(describe(failure));
      });
  };

  const warm = async (): Promise<void> => {
    setWarming(true);
    setProblem(null);
    try {
      const result = await window.marimo.call('models.warm', {modelId});
      if (!result.ok) {
        setProblem(result.problem ?? 'The model did not start.');
      } else {
        await refresh();
      }
    } catch (failure) {
      setProblem(describe(failure));
    } finally {
      setWarming(false);
    }
  };

  const supported = settings.localModels.engine.platformSupported;
  const ready = status.installed && settings.modelReady;
  const size = variantBytes(modelId, variant);
  const sizeLabel =
    size >= 1024 * 1024 * 1024
      ? `${(size / (1024 * 1024 * 1024)).toFixed(1)} GB`
      : `${Math.ceil(size / (1024 * 1024))} MB`;

  return (
    <div className="setup-body">
      <h2>Give Marimo a local brain</h2>
      <p className="onboarding-lead">
        One download, and then the app answers on this computer. No account, no
        API key, and nothing you type is sent to a model service.
      </p>

      <div className="model-setup-card">
        <div className="model-setup-head">
          <span className="model-setup-name">{model.label}</span>
          <span className="model-setup-size">{sizeLabel}</span>
        </div>
        <p className="settings-muted">{model.blurb}</p>

        {!ready && (
          <div className="settings-field">
            <span>Copy</span>
            <div className="settings-row">
              {localModelVariantSchema.options.map((option) => (
                <label className="settings-check" key={option}>
                  <input
                    type="radio"
                    name="setup-model-variant"
                    checked={variant === option}
                    disabled={installing || warming}
                    onChange={() => {
                      setVariant(option);
                    }}
                  />
                  <span>
                    {option === 'q8' ? 'Best quality (8-bit)' : 'Smaller (4-bit)'}
                    <em className="settings-why">
                      {option === 'q8'
                        ? `${(variantBytes(modelId, 'q8') / (1024 * 1024 * 1024)).toFixed(1)} GB. The better answers.`
                        : `${(variantBytes(modelId, 'q4') / (1024 * 1024 * 1024)).toFixed(1)} GB. For a machine with less memory.`}
                    </em>
                  </span>
                </label>
              ))}
            </div>
          </div>
        )}

        {installing && (
          <div className="settings-field">
            <span>
              {progress?.label ?? 'Downloading'} ·{' '}
              {progress?.percent === undefined
                ? `${Math.round((progress?.receivedBytes ?? 0) / (1024 * 1024))} MB`
                : `${String(progress.percent)}%`}
            </span>
            <progress
              className="model-progress"
              value={progress?.receivedBytes ?? 0}
              max={progress?.totalBytes ?? size}
            />
            <button
              type="button"
              className="button button-quiet button-small"
              onClick={cancel}
            >
              Cancel
            </button>
          </div>
        )}

        {!supported && (
          <p className="settings-problem">
            This build has no model engine for this computer. The models run on
            64-bit Linux, macOS and Windows; this looks like a platform the
            pinned engine does not publish a build for.
          </p>
        )}

        {!installing && !ready && (
          <button
            type="button"
            className="button button-primary"
            disabled={!supported}
            onClick={() => {
              void install();
            }}
          >
            Download and continue
          </button>
        )}

        {ready && (
          <div className="settings-field">
            <span>Downloaded and checked. The first message loads it.</span>
            <div className="settings-row">
              <button
                type="button"
                className="button button-primary"
                disabled={warming}
                onClick={() => {
                  void warm();
                }}
              >
                {warming ? 'Checking…' : 'Check it loads now'}
              </button>
            </div>
          </div>
        )}

        {problem !== null && <p className="settings-problem">{problem}</p>}
        {!ready && settings.modelProblem !== undefined && (
          <p className="settings-problem">{settings.modelProblem}</p>
        )}

        <p className="settings-muted">
          The model is licensed by Liquid AI under the{' '}
          <a href={model.license.url} target="_blank" rel="noreferrer">
            {model.license.name}
          </a>
          .
        </p>
      </div>

      <div className="onboarding-actions">
        <button
          type="button"
          className="button button-primary"
          disabled={!ready || installing || warming}
          onClick={onNext}
        >
          Continue
        </button>
        <button
          type="button"
          className="button button-quiet"
          disabled={installing || warming}
          onClick={onBack}
        >
          Back
        </button>
        <button
          type="button"
          className="button button-quiet"
          disabled={installing || warming}
          onClick={onLater}
        >
          Set this up later
        </button>
      </div>
    </div>
  );
}

/** Kept for the compiler: the id is a union, and a typo must not compile. */
export function isLocalModelId(value: string): value is LocalModelId {
  return value in LOCAL_MODELS;
}
