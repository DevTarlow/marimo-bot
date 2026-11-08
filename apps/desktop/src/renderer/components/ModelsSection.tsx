/**
 * Models: the one model, its copy, and what is running.
 *
 * The app has one model now. It answers Chat and Images, so there is no second
 * download to choose. This card owns the model's download, variant, sleep state
 * and removal.
 *
 * Older installs may still have the LFM3 files on disk. They are not used by
 * anything any more; a short cleanup list removes them without offering them as
 * a choice.
 *
 * A download is not a modal. It starts, the card grows a progress bar, and the
 * rest of Settings stays usable — the one long operation in this app should not
 * hold the screen hostage.
 */
import {useEffect, useState} from 'react';

import {
  LOCAL_MODELS,
  LOCAL_MODEL_VARIANTS,
  RETIRED_MODEL_LABELS,
  variantBytes,
} from '@marimo/protocol';
import type {
  LocalModelId,
  LocalModelVariant,
  PublicSettings,
  RetiredModelId,
  SettingsPatch,
} from '@marimo/protocol';

import {describe} from '../describe.js';
import {SettingsSection} from './SettingsSection.js';

export const MODELS_SECTION = 'Models';

/**
 * The one model this build runs.
 *
 * The catalogue has exactly this entry. Old LFM3 directories are a separate,
 * removable list rather than models the app can start.
 */
const PRIMARY_MODEL: LocalModelId = 'qwen2.5-vl-7b';

type Downloading = {
  label: string;
  receivedBytes: number;
  totalBytes: number;
  percent?: number;
};

export function ModelsSection({
  settings,
  opened,
  onToggle,
  onSaved,
}: {
  settings: PublicSettings;
  opened: ReadonlySet<string>;
  onToggle: (title: string, expanded: boolean) => void;
  onSaved: () => void | Promise<void>;
}): React.JSX.Element {
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [variants, setVariants] = useState<
    Partial<Record<LocalModelId, LocalModelVariant>>
  >({});
  const [downloading, setDownloading] = useState<
    Partial<Record<LocalModelId, Downloading>>
  >({});
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);

  useEffect(() => {
    const off = window.marimo.onEvent((event) => {
      if (event.type === 'model.progress') {
        setDownloading((current) => ({
          ...current,
          [event.modelId]: {
            label: event.label,
            receivedBytes: event.receivedBytes,
            totalBytes: event.totalBytes,
            ...(event.percent === undefined ? {} : {percent: event.percent}),
          },
        }));
      } else if (event.type === 'model.installed') {
        setDownloading((current) => {
          const next = {...current};
          delete next[event.modelId];
          return next;
        });
        void onSaved();
      } else if (event.type === 'model.failed') {
        setDownloading((current) => {
          const next = {...current};
          delete next[event.modelId];
          return next;
        });
        setProblem(event.message);
      }
    });
    return off;
  }, [onSaved]);

  const save = async (patch: SettingsPatch): Promise<void> => {
    setSaving(true);
    setProblem(null);
    try {
      await window.marimo.call('settings.set', {patch});
      await onSaved();
    } catch (failure) {
      setProblem(describe(failure));
    } finally {
      setSaving(false);
    }
  };

  const install = async (
    modelId: LocalModelId,
    variant: LocalModelVariant,
  ): Promise<void> => {
    setProblem(null);
    try {
      const {started} = await window.marimo.call('models.install', {
        modelId,
        variant,
      });
      if (!started) {
        setProblem('Another download is already running. Let it finish first.');
      }
    } catch (failure) {
      setProblem(describe(failure));
    }
  };

  const remove = async (modelId: LocalModelId): Promise<void> => {
    setSaving(true);
    setProblem(null);
    try {
      await window.marimo.call('models.remove', {modelId});
      setConfirmRemove(null);
      await onSaved();
    } catch (failure) {
      setProblem(describe(failure));
    } finally {
      setSaving(false);
    }
  };

  const removeRetired = async (modelId: RetiredModelId): Promise<void> => {
    setSaving(true);
    setProblem(null);
    try {
      await window.marimo.call('models.removeRetired', {modelId});
      setConfirmRemove(null);
      await onSaved();
    } catch (failure) {
      setProblem(describe(failure));
    } finally {
      setSaving(false);
    }
  };

  const sleep = async (): Promise<void> => {
    try {
      await window.marimo.call('models.sleep', {});
      await onSaved();
    } catch (failure) {
      setProblem(describe(failure));
    }
  };

  const wake = async (modelId: LocalModelId): Promise<void> => {
    setProblem(null);
    try {
      const result = await window.marimo.call('models.warm', {modelId});
      if (!result.ok) {
        setProblem(result.problem ?? 'The model did not start.');
      }
      await onSaved();
    } catch (failure) {
      setProblem(describe(failure));
    }
  };

  const anyDownloading = Object.keys(downloading).length > 0;
  const supported = settings.localModels.engine.platformSupported;
  const active = settings.localModels.active;
  const cuda = settings.localModels.engine.cuda;
  const backend = settings.localModels.engine.backend;
  const cudaSize =
    cuda.bytes > 0
      ? `${String(Math.round(cuda.bytes / 1_000_000))} MB`
      : 'the CUDA engine and runtime';
  // The default engine is Vulkan on Linux and Windows, and Metal on macOS.
  const defaultEngine =
    settings.hardware.platform === 'darwin' ? 'Metal' : 'Vulkan';
  const retired = settings.localModels.retired;

  return (
    <SettingsSection
      title={MODELS_SECTION}
      opened={opened}
      onToggle={onToggle}
    >
      <p className="settings-muted">
        One model handles Chat and Images, including the image encoder. It runs
        on this computer; nothing you type is sent to a model service. It is the
        only model in memory, and after a quiet spell it stops.
      </p>
      {!supported && (
        <p className="settings-problem">
          This build has no model engine for this computer, so a download here
          would fail. The engine ships for 64-bit Linux, macOS and Windows; this
          looks like a platform the pinned engine does not publish a build for.
        </p>
      )}

      <div className="settings-field">
        <span>Graphics engine</span>
        <div className="settings-row">
          {cuda.available ? (
            <label className="settings-check">
              <input
                type="checkbox"
                checked={settings.localModels.engineBackend === 'cuda'}
                disabled={saving || anyDownloading || active !== undefined}
                onChange={(event) => {
                  void save({
                    localModels: {
                      engineBackend: event.target.checked ? 'cuda' : 'vulkan',
                    },
                  });
                }}
              />
              <span>
                Use CUDA on {cuda.device ?? 'the NVIDIA card'}
                <em className="settings-why">
                  Faster than Vulkan, and downloads about {cudaSize} of engine
                  and runtime. Vulkan is the smaller default. After switching,
                  press Download on a model to fetch the chosen engine.
                  {active === undefined
                    ? ''
                    : ' Put the running model to sleep before switching.'}
                </em>
              </span>
            </label>
          ) : (
            <span className="settings-muted">
              {cuda.reason ??
                'CUDA is not available on this machine; Vulkan is being used.'}
            </span>
          )}
        </div>
      </div>
      {!settings.localModels.engine.present && (
        <p className="settings-muted">
          The {backend === 'cuda' ? 'CUDA' : defaultEngine} engine is not
          downloaded. Press Download on a model to fetch it.
        </p>
      )}

      <div className="settings-field">
        <span>Let the model rest after</span>
        <select
          className="settings-input"
          value={settings.localModels.idleMinutes}
          disabled={saving}
          onChange={(event) => {
            void save({
              localModels: {idleMinutes: Number(event.target.value)},
            });
          }}
        >
          {[1, 3, 5, 10, 30].map((minutes) => (
            <option value={minutes} key={minutes}>
              {minutes} minute{minutes === 1 ? '' : 's'} of quiet
            </option>
          ))}
        </select>
      </div>

      {active !== undefined && (
        <div className="settings-row">
          <button
            type="button"
            className="button button-quiet"
            onClick={() => {
              void sleep();
            }}
          >
            Put {LOCAL_MODELS[active.id].shortLabel} to sleep
          </button>
        </div>
      )}

      {[PRIMARY_MODEL].map((modelId) => {
        const model = LOCAL_MODELS[modelId];
        const status = settings.localModels.models[modelId];
        const chosenVariant =
          variants[modelId] ??
          status.installedVariant ??
          settings.localModels.recommendedVariant;
        const progress = downloading[modelId];
        const q8 = variantBytes(modelId, 'q8');
        const q4 = variantBytes(modelId, 'q4');
        const q8Label = `${(q8 / 1_000_000_000).toFixed(1)} GB`;
        const q4Label = `${(q4 / 1_000_000_000).toFixed(1)} GB`;

        return (
          <div className="model-card" key={modelId}>
            <div className="model-setup-head">
              <span className="model-setup-name">{model.label}</span>
              <span className="model-setup-size">
                {model.params} · {model.contextTokens / 1024}K context
              </span>
            </div>
            <p className="settings-muted">{model.blurb}</p>
            <p className="settings-muted">
              {status.installed
                ? `Installed: ${status.installedVariant === 'q4' ? '4-bit' : '8-bit'}.`
                : status.missing.includes('engine') &&
                    !status.missing.includes('weights')
                  ? `The ${backend === 'cuda' ? 'CUDA' : defaultEngine} engine needs downloading.`
                  : `Not downloaded.`}
            </p>

            {progress !== undefined ? (
              <div className="settings-field">
                <span>
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
                  className="button button-quiet button-small"
                  onClick={() => {
                    setDownloading((current) => {
                      const next = {...current};
                      delete next[modelId];
                      return next;
                    });
                    void window.marimo
                      .call('models.cancel', {})
                      .catch((failure: unknown) => {
                        setProblem(describe(failure));
                      });
                  }}
                >
                  Cancel
                </button>
              </div>
            ) : status.installed ? (
              <div className="settings-row">
                {status.state === 'ready' ? (
                  <button
                    type="button"
                    className="button button-quiet button-small"
                    onClick={() => {
                      void sleep();
                    }}
                  >
                    Sleep now
                  </button>
                ) : (
                  <button
                    type="button"
                    className="button button-quiet button-small"
                    onClick={() => {
                      void wake(modelId);
                    }}
                  >
                    Wake now
                  </button>
                )}
                {confirmRemove === modelId ? (
                  <>
                    <button
                      type="button"
                      className="button button-primary button-small"
                      onClick={() => {
                        void remove(modelId);
                      }}
                    >
                      Remove {model.label}
                    </button>
                    <button
                      type="button"
                      className="button button-quiet button-small"
                      onClick={() => {
                        setConfirmRemove(null);
                      }}
                    >
                      Keep it
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="button button-quiet button-small"
                    onClick={() => {
                      setConfirmRemove(modelId);
                    }}
                  >
                    Remove…
                  </button>
                )}
              </div>
            ) : (
              <div className="settings-row">
                <select
                  className="settings-input"
                  value={chosenVariant}
                  disabled={saving || anyDownloading}
                  onChange={(event) => {
                    setVariants((current) => ({
                      ...current,
                      [modelId]: event.target.value as LocalModelVariant,
                    }));
                  }}
                >
                  {LOCAL_MODEL_VARIANTS.map((variant) => (
                    <option value={variant} key={variant}>
                      {variant === 'q8'
                        ? `Best quality · ${q8Label}`
                        : `Smaller · ${q4Label}`}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="button button-primary button-small"
                  disabled={saving || anyDownloading || !supported}
                  onClick={() => {
                    void install(modelId, chosenVariant);
                  }}
                >
                  Download
                </button>
              </div>
            )}

            <p className="settings-muted">
              <a href={model.license.url} target="_blank" rel="noreferrer">
                {model.license.name}
              </a>
            </p>
          </div>
        );
      })}

      {retired.length > 0 && (
        <div className="settings-field">
          <span>Other downloaded files</span>
          <p className="settings-muted">
            These LFM3 files are left over from an older install and are not used
            any more. Removing one deletes it from this computer.
          </p>
          <div className="settings-row">
            {retired.map((modelId) => {
              const label = RETIRED_MODEL_LABELS[modelId];
              return (
                <span className="settings-row" key={modelId}>
                  {confirmRemove === modelId ? (
                    <>
                      <button
                        type="button"
                        className="button button-primary button-small"
                        disabled={saving}
                        onClick={() => {
                          void removeRetired(modelId);
                        }}
                      >
                        Remove {label}
                      </button>
                      <button
                        type="button"
                        className="button button-quiet button-small"
                        onClick={() => {
                          setConfirmRemove(null);
                        }}
                      >
                        Keep it
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="button button-quiet button-small"
                      onClick={() => {
                        setConfirmRemove(modelId);
                      }}
                    >
                      Remove {label}…
                    </button>
                  )}
                </span>
              );
            })}
          </div>
        </div>
      )}

      {active?.detail !== undefined && (
        <p className="settings-problem">{active.detail}</p>
      )}
      {problem !== null && <p className="settings-problem">{problem}</p>}
    </SettingsSection>
  );
}
