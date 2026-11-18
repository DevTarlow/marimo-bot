/**
 * Spoken replies: the switch, the download, the voice and the audition.
 *
 * The card is one block because the four answers are one question — what the
 * app should sound like — and because a switch that only worked after a 92 MB
 * download nobody could see would be a switch that did nothing. The download is
 * a button rather than a consequence of the switch: a fresh install must make no
 * network call it was not asked to make, and 92 MB is a size a person deserves
 * to see before they spend it.
 *
 * The status is a read beside the settings, not a field in them. Whether the
 * model is on disk and whether a session is loaded are facts about this machine;
 * a settings file that claimed them would be a card describing a download that
 * never happened.
 */
import {useCallback, useEffect, useRef, useState} from 'react';

import type {
  PublicSettings,
  SettingsPatch,
  SpeechStatus,
  SpeechVoice,
} from '@marimo/protocol';
import {COMPANION_ANSWER_LENGTHS, SPEECH_MODEL_LABEL} from '@marimo/protocol';

import {ANSWER_LENGTH_LABELS} from '../answer-length.js';
import {formatBytes} from '../bytes.js';
import {describe} from '../describe.js';
import {SettingsSection} from './SettingsSection.js';

export function Speech({
  opened,
  onToggle,
  settings,
  saving,
  onPatch,
}: {
  opened: ReadonlySet<string>;
  onToggle: (title: string, expanded: boolean) => void;
  settings: PublicSettings;
  saving: boolean;
  /** Writes one patch through the parent's reloading `change`. */
  onPatch: (patch: SettingsPatch) => Promise<boolean>;
}): React.JSX.Element {
  const [status, setStatus] = useState<SpeechStatus | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sampleBusy, setSampleBusy] = useState(false);
  const audio = useRef<HTMLAudioElement | undefined>(undefined);

  const load = useCallback(async (): Promise<void> => {
    try {
      setStatus(await window.marimo.call('speech.status', {}));
    } catch (failure) {
      setProblem(describe(failure));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /*
   * A download is the one thing here somebody watches. The events are the
   * progress bar; `installed` and `failed` are the two answers it can end on.
   */
  useEffect(() => {
    return window.marimo.onEvent((event) => {
      if (event.type === 'speech.progress') {
        setStatus((current) =>
          current === null
            ? current
            : {
                ...current,
                downloading: {
                  label: event.label,
                  receivedBytes: event.receivedBytes,
                  totalBytes: event.totalBytes,
                  ...(event.percent === undefined
                    ? {}
                    : {percent: event.percent}),
                },
              },
        );
      } else if (event.type === 'speech.failed') {
        setProblem(event.message);
        void load();
      } else if (event.type === 'speech.installed') {
        setProblem(null);
        void load();
      }
    });
  }, [load]);

  useEffect(() => {
    return () => {
      audio.current?.pause();
      audio.current = undefined;
    };
  }, []);

  const installed = status?.installed ?? false;
  const modelProblem = status?.error;
  const voices: SpeechVoice[] = status?.voices ?? [];
  const downloading = status?.downloading;
  const selected =
    voices.find((voice) => voice.key === settings.speech.voice)?.key ??
    voices[0]?.key ??
    settings.speech.voice;

  const set = async (patch: SettingsPatch): Promise<void> => {
    setProblem(null);
    const ok = await onPatch(patch);
    if (!ok) {
      setProblem('That change could not be saved.');
    }
  };

  const download = async (): Promise<void> => {
    setBusy(true);
    setProblem(null);
    try {
      await window.marimo.call('speech.install', {});
    } catch (failure) {
      setProblem(describe(failure));
    } finally {
      setBusy(false);
    }
  };

  const cancel = async (): Promise<void> => {
    try {
      await window.marimo.call('speech.cancel', {});
      await load();
    } catch (failure) {
      setProblem(describe(failure));
    }
  };

  const sample = async (): Promise<void> => {
    setSampleBusy(true);
    setProblem(null);
    audio.current?.pause();
    audio.current = undefined;
    try {
      const spoken = await window.marimo.call('speech.sample', {
        voice: selected,
      });
      const element = new Audio(`data:audio/wav;base64,${spoken.wavBase64}`);
      audio.current = element;
      element.onended = () => {
        if (audio.current === element) {
          audio.current = undefined;
        }
      };
      await element.play();
    } catch (failure) {
      setProblem(describe(failure));
    } finally {
      setSampleBusy(false);
    }
  };

  const shown = problem ?? status?.error;

  return (
    <SettingsSection title="Spoken replies" opened={opened} onToggle={onToggle}>
      <p className="settings-muted">
        Read answers aloud in the main window and at the moss. The voice model
        is downloaded once and runs on this computer; nothing about a reply is
        sent anywhere.
      </p>

      <label className="settings-check">
        <input
          type="checkbox"
          checked={settings.speech.enabled}
          disabled={saving}
          onChange={(event) => {
            void set({speech: {enabled: event.target.checked}});
          }}
        />
        <span>
          Read answers aloud
          <em className="settings-why">
            A spoken answer is read in the window that asked. With it off, the
            app answers in text and the voice model is not loaded.
          </em>
        </span>
      </label>

      {!installed || modelProblem !== undefined ? (
        <div className="settings-field">
          <span>
            Voice model
            <em className="settings-why">
              {SPEECH_MODEL_LABEL}, downloaded once. It is checked against its
              fingerprint before it is used.
            </em>
          </span>
          {downloading === undefined ? (
            <button
              type="button"
              className="button"
              disabled={busy || saving}
              onClick={() => {
                void download();
              }}
            >
              {installed ? 'Repair voice model' : 'Download voice model'}
            </button>
          ) : (
            <div className="settings-progress">
              <span>
                {downloading.label}: {formatBytes(downloading.receivedBytes)} of{' '}
                {formatBytes(downloading.totalBytes)}
              </span>
              <div
                className="settings-progress-bar"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={downloading.percent}
              >
                <span style={{width: `${downloading.percent ?? 0}%`}} />
              </div>
              <button
                type="button"
                className="button button-quiet"
                onClick={() => {
                  void cancel();
                }}
              >
                Cancel
              </button>
            </div>
          )}
        </div>
      ) : (
        <>
          <label className="settings-field">
            <span>
              Voice
              <em className="settings-why">
                {voices.find((voice) => voice.key === selected)?.description ??
                  'The model’s English voices.'}
              </em>
            </span>
            <select
              className="settings-input"
              value={selected}
              disabled={saving}
              aria-label="Voice"
              onChange={(event) => {
                void set({speech: {voice: event.target.value}});
              }}
            >
              {voices.map((voice) => (
                <option key={voice.key} value={voice.key}>
                  {voice.name} — {voice.description}
                </option>
              ))}
            </select>
          </label>

          <div className="settings-actions">
            <button
              type="button"
              className="button button-quiet"
              disabled={sampleBusy || saving || voices.length === 0}
              onClick={() => {
                void sample();
              }}
            >
              {sampleBusy ? 'Preparing…' : 'Play sample'}
            </button>
            <em className="settings-why">
              Hears the selected voice say one sentence. The first one waits for
              the model to load; later ones do not.
            </em>
          </div>

          <label className="settings-field">
            <span>
              How long spoken answers are
              <em className="settings-why">
                This applies to answers read aloud in either window. The
                companion&rsquo;s own length still applies when speech is off.
              </em>
            </span>
            <select
              className="settings-input"
              value={settings.speech.answerLength}
              disabled={saving}
              aria-label="Spoken answer length"
              onChange={(event) => {
                void set({
                  speech: {
                    answerLength: event.target
                      .value as (typeof COMPANION_ANSWER_LENGTHS)[number],
                  },
                });
              }}
            >
              {COMPANION_ANSWER_LENGTHS.map((length) => (
                <option key={length} value={length}>
                  {ANSWER_LENGTH_LABELS[length]}
                </option>
              ))}
            </select>
          </label>
        </>
      )}

      {shown !== undefined && <p className="settings-problem">{shown}</p>}
    </SettingsSection>
  );
}
