/**
 * Models: what answers, what it costs, and what is running.
 *
 * This card replaces the old provider card. There is no address and no key to
 * type; the four models are the app's own, and the two decisions are which task
 * each one does and how long one stays warm between turns.
 *
 * The design is deliberately two levels. The **task rows** answer "what should
 * handle Chat / Images / Voice", which is the question a person actually has.
 * The **model cards** answer "what is downloaded, which copy, and is it running",
 * which is the question the disk asks. A model can be installed without being
 * used for a task, and a task can point at one that is not downloaded; both are
 * shown rather than hidden, because the fix is a button either way.
 *
 * A download is not a modal. It starts, the row grows a progress bar, and the
 * rest of Settings stays usable — the one long operation in this app should not
 * hold the screen hostage.
 */
import {useEffect, useState} from 'react';

import {
  LOCAL_MODELS,
  LOCAL_MODEL_IDS,
  LOCAL_TASKS,
  LOCAL_MODEL_VARIANTS,
  modelsForTask,
  TASK_LABELS,
  variantBytes,
} from '@marimo/protocol';
import type {
  LocalModelId,
  LocalModelVariant,
  PublicSettings,
  SettingsPatch,
} from '@marimo/protocol';

import {describe} from '../describe.js';
import {SettingsSection} from './SettingsSection.js';

export const MODELS_SECTION = 'Models';

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
  const [confirmRemove, setConfirmRemove] = useState<LocalModelId | null>(null);

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

  return (
    <SettingsSection
      title={MODELS_SECTION}
      opened={opened}
      onToggle={onToggle}
    >
      <p className="settings-muted">
        Four small models from Liquid AI run on this computer. Nothing you type
        is sent to a model service. One model is in memory at a time; switching
        task switches the model, and after a quiet spell it stops.
      </p>
      {!supported && (
        <p className="settings-problem">
          This build has no model engine for this computer, so a download here
          would fail. The engine ships for 64-bit Linux, macOS and Windows; this
          looks like a platform the pinned engine does not publish a build for.
        </p>
      )}

      <div className="model-tasks">
        {LOCAL_TASKS.map((task) => {
          const chosen = settings.localModels.tasks[task];
          const status = settings.localModels.models[chosen];
          return (
            <label className="settings-field" key={task}>
              <span>{TASK_LABELS[task]}</span>
              <div className="settings-row">
                <select
                  className="settings-input"
                  value={chosen}
                  disabled={saving}
                  onChange={(event) => {
                    const modelId = event.target.value as LocalModelId;
                    void save({
                      localModels: {tasks: {[task]: modelId}},
                    });
                  }}
                >
                  {modelsForTask(task).map((id) => (
                    <option key={id} value={id}>
                      {LOCAL_MODELS[id].label}
                      {settings.localModels.models[id].installed
                        ? ''
                        : ' — needs download'}
                    </option>
                  ))}
                </select>
                <span className="settings-muted">
                  {status?.installed
                    ? `${status.installedVariant === 'q4' ? '4-bit' : '8-bit'} · ${
                        status.state === 'ready'
                          ? 'awake'
                          : status.state === 'starting'
                            ? 'waking'
                            : 'resting'
                      }`
                    : 'Not downloaded'}
                </span>
              </div>
            </label>
          );
        })}
      </div>

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

      <div className="settings-row">
        <button
          type="button"
          className="button button-quiet"
          disabled={saving}
          onClick={() => {
            void save({
              localModels: {
                tasks: {
                  chat: 'lfm3-omni-2b',
                  vision: 'lfm3-omni-2b',
                  voice: 'lfm3-omni-2b',
                },
              },
            });
          }}
        >
          Use one model for everything (Omni)
        </button>
        {active !== undefined && (
          <button
            type="button"
            className="button button-quiet"
            onClick={() => {
              void sleep();
            }}
          >
            Put {LOCAL_MODELS[active.id].shortLabel} to sleep
          </button>
        )}
      </div>

      {LOCAL_MODEL_IDS.map((modelId) => {
        const model = LOCAL_MODELS[modelId];
        const status = settings.localModels.models[modelId];
        const chosenVariant =
          variants[modelId] ?? status.installedVariant ?? model.defaultVariant;
        const progress = downloading[modelId];
        const usedFor = status.usedFor
          .map((task) => TASK_LABELS[task])
          .join(', ');
        const q8 = variantBytes(modelId, 'q8');
        const q4 = variantBytes(modelId, 'q4');
        const q8Label = `${(q8 / (1024 * 1024 * 1024)).toFixed(1)} GB`;
        const q4Label = `${(q4 / (1024 * 1024 * 1024)).toFixed(1)} GB`;

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
              {usedFor.length > 0 ? `Used for ${usedFor}.` : 'Not used by a task.'}{' '}
              {status.installed
                ? `Installed: ${status.installedVariant === 'q4' ? '4-bit' : '8-bit'}.`
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

      {active?.detail !== undefined && (
        <p className="settings-problem">{active.detail}</p>
      )}
      {problem !== null && <p className="settings-problem">{problem}</p>}
    </SettingsSection>
  );
}
