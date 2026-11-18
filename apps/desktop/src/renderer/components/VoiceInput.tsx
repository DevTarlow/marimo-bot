/**
 * Settings → Voice input.
 *
 * One card because the four answers are one question — may this app listen, to
 * which microphone, and what should it do with the words — and because a
 * download nobody can see would be a switch that appears to do nothing. The
 * model is a button rather than a consequence of the switch: a fresh install
 * must make no 158 MB request it was not asked to make.
 *
 * The microphone test is deliberately independent of the model. Somebody should
 * be able to see whether their microphone works before spending the download; the
 * meter runs on the same capture path the composer uses, and the test clip is
 * transcribed only when the model is installed.
 */
import {useCallback, useEffect, useRef, useState} from 'react';

import type {
  ListenStatus,
  PublicSettings,
  SettingsPatch,
} from '@marimo/protocol';
import {
  LISTEN_MAX_SECONDS,
  LISTEN_MODEL_BYTES,
  LISTEN_MODEL_LABEL,
} from '@marimo/protocol';

import {formatBytes} from '../bytes.js';
import {describe} from '../describe.js';
import {useVoiceCapture} from '../hooks/useVoiceCapture.js';
import type {CapturedClip} from '../hooks/useVoiceCapture.js';
import {audioInputs, resolveSavedDevice} from '../voice-devices.js';
import type {AudioInput} from '../voice-devices.js';
import {TranscriptGate} from '../voice-insert.js';
import {MicButton} from './MicButton.js';
import {SettingsSection} from './SettingsSection.js';

/** The card's title, and the name Settings opens when the mic sends it here. */
export const VOICE_INPUT_SECTION = 'Voice input';

export function VoiceInput({
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
  const [status, setStatus] = useState<ListenStatus | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [devices, setDevices] = useState<AudioInput[]>([]);
  const [testText, setTestText] = useState<string | null>(null);
  const [transcribing, setTranscribing] = useState(false);
  const [remoteCapture, setRemoteCapture] = useState<
    'window' | 'pet' | 'settings' | null
  >(null);
  const installedRef = useRef(false);
  installedRef.current = status?.installed ?? false;
  const testGate = useRef(new TranscriptGate());
  const testId = useRef(0);
  const testToken = useRef<string | undefined>(undefined);

  const loadStatus = useCallback(async (): Promise<void> => {
    try {
      setStatus(await window.marimo.call('listen.status', {}));
    } catch (failure) {
      setProblem(describe(failure));
    }
  }, []);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  useEffect(() => {
    return window.marimo.onEvent((event) => {
      if (event.type === 'listen.progress') {
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
      } else if (event.type === 'listen.failed') {
        setProblem(event.message);
        void loadStatus();
      } else if (event.type === 'listen.installed') {
        setProblem(null);
        void loadStatus();
      } else if (event.type === 'listen.capture') {
        setRemoteCapture((current) => {
          if (event.active) {
            return event.surface === 'settings' ? null : event.surface;
          }
          return current === event.surface ? null : current;
        });
      }
    });
  }, [loadStatus]);

  const refreshDevices = useCallback(async (): Promise<void> => {
    if (navigator.mediaDevices?.enumerateDevices === undefined) {
      setProblem('This window cannot reach a microphone.');
      return;
    }
    try {
      setDevices(audioInputs(await navigator.mediaDevices.enumerateDevices()));
    } catch (failure) {
      setProblem(describe(failure));
    }
  }, []);

  useEffect(() => {
    void refreshDevices();
    const media = navigator.mediaDevices;
    if (media === undefined || media.addEventListener === undefined) {
      return;
    }
    const changed = (): void => {
      void refreshDevices();
    };
    media.addEventListener('devicechange', changed);
    return () => {
      media.removeEventListener('devicechange', changed);
    };
  }, [refreshDevices]);

  const handleCaptured = useCallback(
    async (captured: CapturedClip): Promise<void> => {
      const id = testId.current;
      if (!testGate.current.accepts(id)) {
        void window.marimo
          .call('listen.cancel', {token: captured.token})
          .catch(() => undefined);
        return;
      }
      if (!installedRef.current) {
        void window.marimo
          .call('listen.cancel', {token: captured.token})
          .catch(() => undefined);
        setTestText(
          'The microphone is working. Download the model to transcribe the test.',
        );
        return;
      }
      testToken.current = captured.token;
      setTranscribing(true);
      try {
        const result = await window.marimo.call('listen.transcribe', {
          token: captured.token,
          pcm: captured.pcmBase64,
          sampleRate: 16_000,
          clipId: String(id),
        });
        if (!testGate.current.accepts(id) || result.cancelled) {
          return;
        }
        setTestText(
          result.text.trim().length === 0
            ? 'I didn’t catch that. Try again a little closer to the mic.'
            : result.text,
        );
      } catch (failure) {
        if (testGate.current.accepts(id)) {
          setProblem(describe(failure));
        }
      } finally {
        if (testToken.current === captured.token) {
          testToken.current = undefined;
        }
        setTranscribing(false);
      }
    },
    [],
  );

  const capture = useVoiceCapture({
    surface: 'settings',
    deviceId: settings.listen.deviceId,
    deviceLabel: settings.listen.deviceLabel,
    autoStopOnSilence: false,
    // A test clip is short; the app-wide cap is for dictation.
    maxSeconds: 10,
    onNotice: (message) => {
      setProblem(message);
    },
    onCaptured: handleCaptured,
  });

  const resolved = resolveSavedDevice(devices, settings.listen.deviceId);
  const installed = status?.installed ?? false;
  const modelProblem = status?.error;
  const downloading = status?.downloading;
  const captureBusy = capture.recording || capture.starting || transcribing;
  const canRemove =
    !settings.listen.enabled &&
    !captureBusy &&
    remoteCapture === null &&
    downloading === undefined &&
    !saving;

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
      await window.marimo.call('listen.install', {});
    } catch (failure) {
      setProblem(describe(failure));
    } finally {
      setBusy(false);
    }
  };

  const cancelDownload = async (): Promise<void> => {
    try {
      await window.marimo.call('listen.installCancel', {});
      await loadStatus();
    } catch (failure) {
      setProblem(describe(failure));
    }
  };

  const remove = async (): Promise<void> => {
    setBusy(true);
    setProblem(null);
    try {
      await window.marimo.call('listen.remove', {});
      setConfirmRemove(false);
      await loadStatus();
    } catch (failure) {
      setProblem(describe(failure));
    } finally {
      setBusy(false);
    }
  };

  const startTest = (): void => {
    if (captureBusy || remoteCapture !== null) {
      return;
    }
    testId.current = testGate.current.begin();
    setTestText(null);
    setProblem(null);
    void capture.start();
  };

  const stopTest = (): void => {
    void capture.stop();
  };

  const cancelTest = (): void => {
    testGate.current.cancel();
    const token = testToken.current;
    testToken.current = undefined;
    if (token !== undefined) {
      void window.marimo.call('listen.cancel', {token}).catch(() => undefined);
    }
    capture.cancel();
    setTranscribing(false);
    setTestText(null);
  };

  const testPhase = capture.recording
    ? 'recording'
    : capture.starting
      ? 'starting'
      : transcribing
        ? 'transcribing'
        : remoteCapture !== null
          ? 'remote'
          : 'ready';

  const engineLabel =
    status?.engine === 'ready'
      ? 'loaded on the CPU'
      : status?.engine === 'loading'
        ? 'loading'
        : 'not loaded until a recording';

  return (
    <SettingsSection
      title={VOICE_INPUT_SECTION}
      opened={opened}
      onToggle={onToggle}
    >
      <p className="settings-muted">
        Speak instead of typing. The speech-to-text model runs on this
        computer’s CPU with no GPU memory, and the audio never leaves the
        machine. English only in this build.
      </p>

      <label className="settings-check">
        <input
          type="checkbox"
          checked={settings.listen.enabled}
          disabled={saving}
          onChange={(event) => {
            void set({listen: {enabled: event.target.checked}});
          }}
        />
        <span>
          Use voice input
          <em className="settings-why">
            Adds a microphone to the message box and the moss bar. With it off,
            the model is not loaded and the microphone is never opened.
          </em>
        </span>
      </label>

      {!installed || modelProblem !== undefined ? (
        <div className="settings-field">
          <span>
            Voice input model
            <em className="settings-why">
              Moonshine Streaming Small (English), {LISTEN_MODEL_LABEL} (
              {formatBytes(LISTEN_MODEL_BYTES)};{' '}
              {LISTEN_MODEL_BYTES.toLocaleString()} bytes), downloaded once. It
              is checked against its fingerprint before it is used.
            </em>
          </span>
          {downloading === undefined ? (
            <button
              type="button"
              className="button"
              disabled={busy || saving || captureBusy || remoteCapture !== null}
              onClick={() => {
                void download();
              }}
            >
              {installed
                ? 'Repair voice input model'
                : 'Download voice input model'}
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
                  void cancelDownload();
                }}
              >
                Cancel
              </button>
            </div>
          )}
        </div>
      ) : (
        <>
          <p className="settings-muted">
            Installed — {engineLabel}. {LISTEN_MODEL_LABEL} (
            {formatBytes(LISTEN_MODEL_BYTES)}).
          </p>
          <div className="settings-actions">
            <button
              type="button"
              className="button button-quiet"
              disabled={busy || saving || captureBusy || remoteCapture !== null}
              onClick={() => {
                void download();
              }}
            >
              {busy ? 'Checking…' : 'Verify model'}
            </button>
            <em className="settings-why">
              Re-checks every file against its fingerprint and fetches only what
              is damaged.
            </em>
          </div>
        </>
      )}

      <label className="settings-field">
        <span>
          Microphone
          <em className="settings-why">
            The default follows whatever your system calls the default,
            including when a headset is plugged in. A chosen microphone is
            remembered by id; if it disappears, the default is used and this
            card says so.
          </em>
        </span>
        <select
          className="settings-input"
          value={resolved.selected ?? ''}
          disabled={saving || captureBusy}
          aria-label="Microphone"
          onChange={(event) => {
            const id =
              event.target.value.length === 0 ? null : event.target.value;
            const label =
              id === null
                ? null
                : (devices.find((device) => device.deviceId === id)?.label ??
                  null);
            void set({listen: {deviceId: id, deviceLabel: label}});
          }}
        >
          <option value="">System default</option>
          {devices.map((device) => (
            <option key={device.deviceId} value={device.deviceId}>
              {device.label}
            </option>
          ))}
        </select>
      </label>

      {resolved.missing && (
        <p className="settings-problem">
          {settings.listen.deviceLabel ?? 'Your saved microphone'} is not
          connected. The system default will be used until it comes back, or
          choose another microphone above.
        </p>
      )}

      <div className="settings-actions">
        <button
          type="button"
          className="button button-quiet"
          disabled={saving}
          onClick={() => {
            void refreshDevices();
          }}
        >
          Refresh microphones
        </button>
        {devices.length === 0 && (
          <em className="settings-why">
            No microphone found yet. Connect one, then press Refresh.
          </em>
        )}
      </div>

      <h4 className="settings-group">Test microphone</h4>
      <p className="settings-muted">
        The meter works before the model is downloaded. Speak a sentence, then
        press Stop; with the model installed, the test clip is transcribed here
        so you can check the whole path.
      </p>
      <div className="settings-actions settings-mic-test">
        <MicButton
          phase={testPhase}
          level={capture.level}
          elapsedMs={capture.elapsedMs}
          remoteSurface={remoteCapture}
          onStart={startTest}
          onStop={stopTest}
          onCancel={cancelTest}
          startLabel="Test microphone"
          stopLabel="Stop test"
        />
        <em className="settings-why">
          {capture.recording
            ? 'Listening… press the square to stop and transcribe.'
            : transcribing
              ? 'Transcribing the test clip on the CPU…'
              : 'Records for up to ten seconds.'}
        </em>
      </div>
      {testText !== null && <p className="settings-note">{testText}</p>}

      <h4 className="settings-group">Behaviour</h4>
      <label className="settings-check">
        <input
          type="checkbox"
          checked={settings.listen.autoSend}
          disabled={saving}
          onChange={(event) => {
            void set({listen: {autoSend: event.target.checked}});
          }}
        />
        <span>
          Send the transcript immediately
          <em className="settings-why">
            Off puts the words in the message box so you can read and edit them.
            On sends the turn as soon as the transcription finishes.
          </em>
        </span>
      </label>

      <label className="settings-check">
        <input
          type="checkbox"
          checked={settings.listen.autoStopOnSilence}
          disabled={saving}
          onChange={(event) => {
            void set({listen: {autoStopOnSilence: event.target.checked}});
          }}
        />
        <span>
          Stop after silence
          <em className="settings-why">
            Ends the recording after about 1.5 seconds of quiet, once you have
            started speaking. A noisy room may never count as quiet; the square
            is always there.
          </em>
        </span>
      </label>

      {installed && !settings.listen.enabled && (
        <div className="settings-actions">
          {confirmRemove ? (
            <>
              <button
                type="button"
                className="button button-quiet"
                disabled={busy || !canRemove}
                onClick={() => {
                  void remove();
                }}
              >
                Remove {LISTEN_MODEL_LABEL}
              </button>
              <button
                type="button"
                className="button button-quiet"
                onClick={() => {
                  setConfirmRemove(false);
                }}
              >
                Keep
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className="button button-quiet"
                disabled={busy || !canRemove}
                onClick={() => {
                  setConfirmRemove(true);
                }}
              >
                Remove voice input model…
              </button>
              <em className="settings-why">
                Deletes the downloaded files. It cannot be removed while a
                recording or transcription is running.
              </em>
            </>
          )}
        </div>
      )}

      <p className="settings-muted">
        A clip stops at {String(LISTEN_MAX_SECONDS)} seconds, so a microphone
        left open cannot exhaust memory. The model unloads after five quiet
        minutes.
      </p>

      {(problem ?? modelProblem) !== undefined && (
        <p className="settings-problem">{problem ?? modelProblem}</p>
      )}
    </SettingsSection>
  );
}
