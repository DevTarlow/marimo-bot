/**
 * The strip that explains why a message will not be answered.
 *
 * The app no longer blocks on a missing model: the server is a process the
 * person starts and stops outside the window, so a launch with it off is an
 * ordinary state rather than a first run. What it must not be is silent — a
 * composer that takes a message and fails a second later is worse than a
 * sentence naming the address and the fix.
 *
 * It sits here rather than in the transcript because it is about the whole
 * window, and it has a button of its own because the server can be started
 * while the window is open. `models.test` is the immediate look; the watcher
 * would find it within twenty seconds anyway.
 */
import type {PublicSettings} from '@marimo/protocol';

export function ModelServerNotice({
  settings,
  onRetry,
  onOpenSettings,
}: {
  settings: PublicSettings;
  onRetry: () => void | Promise<void>;
  onOpenSettings: () => void;
}): React.JSX.Element | null {
  if (settings.modelReady) {
    return null;
  }
  return (
    <div className="warning" role="status">
      <span>
        {settings.modelProblem ??
          'The model server is not answering. Start it, then try again.'}
      </span>
      <button
        type="button"
        className="button button-quiet button-small"
        onClick={() => {
          void (async () => {
            try {
              await onRetry();
            } catch {
              // The notice is the explanation; a failed retry leaves it up rather
              // than replacing it with a second error.
            }
          })();
        }}
      >
        Try again
      </button>
      <button
        type="button"
        className="button button-quiet button-small"
        onClick={onOpenSettings}
      >
        Open Settings
      </button>
    </div>
  );
}
