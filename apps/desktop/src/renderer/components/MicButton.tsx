/**
 * The microphone control, shared by the composer, the moss bar and the Settings
 * test.
 *
 * One button changes meaning with the phase: a dimmed microphone when voice
 * input is not set up, a live one when it is, a stop square while recording, a
 * spinner while the CPU works. The cancel `×` is deliberately separate from the
 * stop square: stop keeps what was said, cancel throws it away, and the two are
 * one mis-click apart.
 */
import type {ListenSurface} from '@marimo/protocol';

import type {VoiceInputPhase} from '../hooks/useVoiceInput.js';

export function MicButton({
  phase,
  level = 0,
  elapsedMs = 0,
  remoteSurface = null,
  compact = false,
  disabled = false,
  onStart,
  onStop,
  onCancel,
  onSetup,
  startLabel = 'Start voice input',
  stopLabel = 'Stop and transcribe',
}: {
  phase: VoiceInputPhase;
  /** 0–1, for the live meter. */
  level?: number;
  elapsedMs?: number;
  remoteSurface?: ListenSurface | null;
  compact?: boolean;
  disabled?: boolean;
  onStart?: () => void;
  onStop?: () => void;
  onCancel?: () => void;
  onSetup?: () => void;
  /** The ready-state name, for the Settings test. */
  startLabel?: string;
  /** The recording-state name, for the Settings test. */
  stopLabel?: string;
}): React.JSX.Element {
  const state = disabled ? 'disabled' : phase;
  const className = [
    'mic-button',
    compact ? 'pet-mic is-compact' : 'composer-mic',
    `is-${state}`,
  ]
    .filter(Boolean)
    .join(' ');
  const title = titleFor(state, remoteSurface, startLabel, stopLabel);
  const busy = state === 'starting' || state === 'transcribing';

  if (state === 'recording') {
    return (
      <span className={`mic-cluster ${compact ? 'is-compact' : ''}`}>
        <button
          type="button"
          className={`${className} is-recording`}
          aria-label={stopLabel}
          title={stopLabel}
          onClick={onStop}
        >
          <span aria-hidden="true">■</span>
        </button>
        <span
          className="mic-level"
          role="meter"
          aria-label="Microphone level"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(level * 100)}
        >
          <span style={{width: `${Math.round(level * 100)}%`}} />
        </span>
        <button
          type="button"
          className="mic-cancel"
          aria-label="Cancel recording"
          title="Cancel recording"
          onClick={onCancel}
        >
          ×
        </button>
        {!compact && (
          <span className="mic-elapsed" aria-hidden="true">
            {clock(elapsedMs)}
          </span>
        )}
      </span>
    );
  }

  if (busy) {
    return (
      <span className={`mic-cluster ${compact ? 'is-compact' : ''}`}>
        <button
          type="button"
          className={`${className} is-busy`}
          aria-label={
            state === 'starting' ? 'Opening the microphone' : 'Transcribing'
          }
          title={title}
          disabled
        >
          <span className="mic-spinner" aria-hidden="true" />
        </button>
        {state === 'transcribing' && onCancel !== undefined && (
          <button
            type="button"
            className="mic-cancel"
            aria-label="Cancel transcription"
            title="Cancel transcription"
            onClick={onCancel}
          >
            ×
          </button>
        )}
      </span>
    );
  }

  return (
    <button
      type="button"
      className={className}
      aria-label={title}
      title={title}
      disabled={state === 'disabled' || state === 'remote'}
      onClick={state === 'setup' ? onSetup : onStart}
    >
      <MicIcon />
    </button>
  );
}

function MicIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
      <path
        d="M12 15a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v6a3 3 0 0 0 3 3Z"
        fill="currentColor"
      />
      <path
        d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

function titleFor(
  state:
    | 'setup'
    | 'starting'
    | 'recording'
    | 'transcribing'
    | 'remote'
    | 'ready'
    | 'disabled',
  remoteSurface: ListenSurface | null,
  startLabel: string,
  stopLabel: string,
): string {
  switch (state) {
    case 'setup':
      return 'Set up voice input in Settings → Voice input';
    case 'starting':
      return 'Opening the microphone…';
    case 'recording':
      return stopLabel;
    case 'transcribing':
      return 'Transcribing on this computer…';
    case 'remote':
      return `The ${surfaceName(remoteSurface)} is using the microphone`;
    case 'disabled':
      return 'Voice input is not available here';
    case 'ready':
      return startLabel;
  }
}

function surfaceName(surface: ListenSurface | null): string {
  switch (surface) {
    case 'pet':
      return 'moss';
    case 'settings':
      return 'Settings test';
    case 'window':
    default:
      return 'main window';
  }
}

function clock(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(seconds / 60))}:${String(seconds % 60).padStart(2, '0')}`;
}
