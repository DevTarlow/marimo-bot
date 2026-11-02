/**
 * The required model, as a card: what it is, which copy, the download and its
 * progress.
 *
 * This is the one model the first run downloads. The card owns the installer
 * hook because it is the thing drawing progress; it reports `installing` up so
 * the step can disable its own buttons while a download runs.
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

import {useLocalModelInstall} from '../hooks/useLocalModelInstall.js';

export function ModelSetupCard({
  modelId,
  settings,
  onSettings,
  ready,
  downloadLabel = 'Download',
  check = false,
  extraProblem,
  onInstallingChange,
}: {
  modelId: LocalModelId;
  settings: PublicSettings;
  /** The write's own answer, so this card and the window cannot disagree. */
  onSettings: (next: PublicSettings) => void;
  /**
   * Whether the card should treat the model as usable.
   *
   * The required step passes `installed && modelReady`; a model that is on disk
   * but whose engine would not load is not ready for the Continue button, and
   * the card should offer the download again rather than claim otherwise.
   */
  ready?: boolean;
  downloadLabel?: string;
  /** Whether to offer the one-off engine check the required step uses. */
  check?: boolean;
  /** The process's own reason the app cannot answer, shown with this card. */
  extraProblem?: string;
  /** Reports installing/warming so a step can disable its own actions. */
  onInstallingChange?: (busy: boolean) => void;
}): React.JSX.Element {
  const model = LOCAL_MODELS[modelId];
  const status = settings.localModels.models[modelId];
  const {installing, warming, progress, problem, install, cancel, warm} =
    useLocalModelInstall({modelId, onSettings});
  const [variant, setVariant] = useState<LocalModelVariant>(
    status.installedVariant ?? settings.localModels.recommendedVariant,
  );

  useEffect(() => {
    onInstallingChange?.(installing || warming);
  }, [installing, warming, onInstallingChange]);

  const usable = ready ?? status.installed;
  const supported = settings.localModels.engine.platformSupported;
  const size = variantBytes(modelId, variant);
  const sizeLabel =
    size >= 1024 * 1024 * 1024
      ? `${(size / (1024 * 1024 * 1024)).toFixed(1)} GB`
      : `${Math.ceil(size / (1024 * 1024))} MB`;

  return (
    <div className="model-setup-card">
      <div className="model-setup-head">
        <span className="model-setup-name">{model.label}</span>
        <span className="model-setup-size">{sizeLabel}</span>
      </div>
      <p className="settings-muted">{model.blurb}</p>

      {!usable && (
        <div className="settings-field">
          <span>Copy</span>
          <div className="settings-row">
            {localModelVariantSchema.options.map((option) => (
              <label className="settings-check" key={option}>
                <input
                  type="radio"
                  name={`setup-model-variant-${modelId}`}
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
            onClick={() => {
              void cancel();
            }}
          >
            Cancel
          </button>
        </div>
      )}

      {!supported && (
        <p className="settings-problem">
          This build has no model engine for this computer. The models run on
          64-bit Linux, macOS and Windows; this looks like a platform the pinned
          engine does not publish a build for.
        </p>
      )}

      {!installing && !usable && (
        <button
          type="button"
          className="button button-primary"
          disabled={!supported}
          onClick={() => {
            void install(variant);
          }}
        >
          {downloadLabel}
        </button>
      )}

      {usable && (
        <div className="settings-field">
          <span>Downloaded and checked. The first message loads it.</span>
          {check && (
            <div className="settings-row">
              <button
                type="button"
                className="button button-primary"
                disabled={warming || installing}
                onClick={() => {
                  void warm();
                }}
              >
                {warming ? 'Checking…' : 'Check it loads now'}
              </button>
            </div>
          )}
        </div>
      )}

      {problem !== null && <p className="settings-problem">{problem}</p>}
      {extraProblem !== undefined && (
        <p className="settings-problem">{extraProblem}</p>
      )}

      <p className="settings-muted">
        The model is licensed by Liquid AI under the{' '}
        <a href={model.license.url} target="_blank" rel="noreferrer">
          {model.license.name}
        </a>
        .
      </p>
    </div>
  );
}
