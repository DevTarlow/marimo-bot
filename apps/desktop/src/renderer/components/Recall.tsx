/**
 * Recall: the model that finds things by meaning, and what it has indexed.
 *
 * Off until somebody asks, and the button that asks names the size — a fresh
 * install downloading 310 MB because it felt like it is the failure Discord's
 * default exists to prevent. Everything below that switch is the answer to one of
 * two questions a user has: *is it working*, and *what has it read*.
 *
 * The card reads the status once when it opens and then subscribes to the four
 * recall events itself, rather than having the turn stream carry them up through
 * the app: this is the only thing in the window that draws them, and a download
 * that reported through the same channel as a conversation would be a progress bar
 * that appears in a chat.
 */
import {useCallback, useEffect, useState} from 'react';

import type {PublicSettings, RecallModelStatus, RecallPiece} from '@marimo/protocol';

import {formatBytes} from '../bytes.js';
import {describe} from '../describe.js';
import {SettingsSection} from './SettingsSection.js';

export function Recall({
  opened,
  onToggle,
}: {
  opened: ReadonlySet<string>;
  onToggle: (title: string, expanded: boolean) => void;
}): React.JSX.Element {
  const [status, setStatus] = useState<RecallModelStatus | null>(null);
  const [settings, setSettings] = useState<PublicSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    try {
      const [measured, loaded] = await Promise.all([
        window.marimo.call('recall.status', {}),
        window.marimo.call('settings.get', {}),
      ]);
      setStatus(measured);
      setSettings(loaded.settings);
      setProblem(null);
    } catch (failure) {
      setProblem(describe(failure));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /*
   * The events, subscribed here. A download is the one thing in this app somebody
   * watches, and the card has to move while they watch it — including when the
   * download was started from somewhere else, which is why this is a subscription
   * rather than a state the button sets.
   */
  useEffect(() => {
    return window.marimo.onEvent((event) => {
      if (
        event.type === 'recall.progress' ||
        event.type === 'recall.installed' ||
        event.type === 'recall.failed' ||
        event.type === 'recall.indexed'
      ) {
        if (event.type === 'recall.failed') {
          setProblem(event.message);
        }
        void load();
      }
    });
  }, [load]);

  const set = async (patch: {
    enabled?: boolean;
    memory?: boolean;
    workspace?: boolean;
    conversations?: boolean;
    media?: boolean;
    codeQueries?: boolean;
  }): Promise<void> => {
    setBusy(true);
    try {
      const {settings: saved} = await window.marimo.call('settings.set', {
        patch: {recall: patch},
      });
      setSettings(saved);
      await load();
    } catch (failure) {
      setProblem(describe(failure));
    } finally {
      setBusy(false);
    }
  };

  const download = async (piece: RecallPiece): Promise<void> => {
    setBusy(true);
    try {
      await window.marimo.call('recall.install', {piece});
    } catch (failure) {
      setProblem(describe(failure));
    } finally {
      setBusy(false);
    }
  };

  const enabled = settings?.recall.enabled ?? false;
  /*
   * Whether this profile may use it, read from the grant rather than assumed: the
   * tool is a capability like every other, and a card that said "on" while the
   * agent had not been allowed to look would be the switch that did nothing.
   */
  const granted =
    settings?.profiles
      .find((profile) => profile.id === settings.activeProfileId)
      ?.enabledTools.includes('recall') ?? false;
  const installed = status?.textPresent ?? false;
  const projectorPresent = status?.projectorPresent ?? false;
  const installing = status?.installing;
  const index = status?.index;

  return (
    <SettingsSection title="Recall" opened={opened} onToggle={onToggle}>
      <p className="settings-muted">
        Searches your space and the notes it keeps about you by what you mean.
        Ask why the upload keeps failing and it finds the code that retries,
        though retry is not in the question.
      </p>

      <label className="settings-check">
        <input
          type="checkbox"
          checked={enabled}
          disabled={busy}
          onChange={(event) => {
            void set({enabled: event.target.checked});
          }}
        />
        Remember and search by meaning
      </label>

      {problem !== null && <p className="settings-problem">{problem}</p>}

      {!enabled && (
        <p className="settings-muted">
          Off. Turning it on downloads{' '}
          {formatBytes(status?.sizeBytes.text ?? 0)} and runs it on your
          processor, next to the model that answers questions, so it does not
          take video memory from it.
        </p>
      )}

      {enabled && !installed && installing === undefined && (
        <>
          <p className="settings-muted">
            The model is not downloaded yet. It runs on the processor and needs
            about {formatBytes(status?.sizeBytes.text ?? 0)}.
          </p>
          <button
            type="button"
            className="button button-small"
            disabled={busy}
            onClick={() => {
              void download('text');
            }}
          >
            Download the recall model (
            {formatBytes(status?.sizeBytes.text ?? 0)})
          </button>
        </>
      )}

      {installing !== undefined && (
        <>
          <progress
            className="settings-progress"
            value={installing.receivedBytes}
            max={installing.totalBytes}
          />
          <p className="settings-muted">
            {installing.label}: {formatBytes(installing.receivedBytes)} of{' '}
            {formatBytes(installing.totalBytes)}
          </p>
          <button
            type="button"
            className="button button-small"
            onClick={() => {
              void window.marimo.call('recall.cancel', {});
            }}
          >
            Stop
          </button>
        </>
      )}

      {enabled && installed && (
        <>
          <label className="settings-check">
            <input
              type="checkbox"
              checked={settings?.recall.workspace ?? true}
              disabled={busy}
              onChange={(event) => {
                void set({workspace: event.target.checked});
              }}
            />
            Index the space this bot works in
          </label>
          <label className="settings-check">
            <input
              type="checkbox"
              checked={settings?.recall.memory ?? true}
              disabled={busy}
              onChange={(event) => {
                void set({memory: event.target.checked});
              }}
            />
            Index what it remembers about you
          </label>
          <label className="settings-check">
            <input
              type="checkbox"
              checked={settings?.recall.conversations ?? true}
              disabled={busy}
              onChange={(event) => {
                void set({conversations: event.target.checked});
              }}
            />
            Index your past conversations
          </label>
          <p className="settings-muted">
            Your messages and its answers, not the thinking in between and not the
            tool calls. This is the corpus that lets it find something you settled
            three weeks ago; it stays in the same index the space does, on this
            machine.
          </p>

          <label className="settings-check">
            <input
              type="checkbox"
              checked={settings?.recall.media ?? false}
              disabled={busy}
              onChange={(event) => {
                void set({media: event.target.checked});
              }}
            />
            Index pictures, sounds and video
          </label>
          {settings?.recall.media === true && !projectorPresent && (
            <>
              <p className="settings-muted">
                This needs a second download, about{' '}
                {formatBytes(status?.sizeBytes.media ?? 0)}: the image and audio
                encoder. Without it the engine has no way to read a picture at
                all.
              </p>
              {installing === undefined && (
                <button
                  type="button"
                  className="button button-small"
                  disabled={busy}
                  onClick={() => {
                    void download('media');
                  }}
                >
                  Download the image and audio encoder (
                  {formatBytes(status?.sizeBytes.media ?? 0)})
                </button>
              )}
            </>
          )}

          <label className="settings-check">
            <input
              type="checkbox"
              checked={settings?.recall.codeQueries ?? false}
              disabled={busy}
              onChange={(event) => {
                void set({codeQueries: event.target.checked});
              }}
            />
            This space is mostly code
          </label>
          <p className="settings-muted">
            The model has two ways of being asked a question, one for prose and one
            for code, and the code one finds code better. Nothing here can tell
            which a question wants, so this is your answer about the space rather
            than a guess made per search.
          </p>

          <p className="settings-muted">
            {index === undefined || index.records === 0
              ? 'Nothing is indexed in this space yet. It fills in as you work, and the first time you search.'
              : `${String(index.records)} ${index.records === 1 ? 'item' : 'items'} indexed: ${describeIndex(index)}.` +
                (index.changed > 0
                  ? ` ${String(index.changed)} ${index.changed === 1 ? 'file has' : 'files have'} changed since.`
                  : '')}
          </p>

          <div className="settings-row">
            <button
              type="button"
              className="button button-small"
              disabled={busy}
              onClick={() => {
                void window.marimo
                  .call('recall.reindex', {})
                  .then(() => load(), () => load());
              }}
            >
              Index now
            </button>
            <button
              type="button"
              className="button button-quiet button-small"
              disabled={busy}
              onClick={() => {
                void window.marimo
                  .call('recall.forget', {})
                  .then(() => load(), () => load());
              }}
            >
              Forget the index
            </button>
          </div>
          <p className="settings-muted">
            Forgetting deletes what it has read. Your files and its notes stay
            where they are.
          </p>
          {!granted && (
            <p className="settings-muted">
              The bot also has to be allowed to use it. Tick recall under
              “What this bot can do”; a tool it has not been granted is not
              offered to it.
            </p>
          )}
        </>
      )}

      {status !== null && (
        <details className="settings-detail">
          <summary>The engine</summary>
          <p className="settings-muted">
            {status.state}
            {status.detail === undefined ? '' : `: ${status.detail}`}
          </p>
          <p className="settings-muted settings-path">
            {status.command.join(' ')}
          </p>
          {status.log.length > 0 && (
            <pre className="settings-log">{status.log.slice(-6).join('\n')}</pre>
          )}
        </details>
      )}
    </SettingsSection>
  );
}

/**
 * What the index holds, as one clause.
 *
 * Only the corpora with something in them are named: "0 from conversations"
 * reads as a failure when it means the switch is off, and the counts are the one
 * place a user can see that their chats or their photographs were part of the
 * index at all.
 */
function describeIndex(index: RecallModelStatus['index']): string {
  const parts = [
    `${String(index.chunks)} from the space`,
    `${String(index.memory)} from memory`,
  ];
  if (index.conversations > 0) {
    parts.push(`${String(index.conversations)} from your conversations`);
  }
  if (index.media > 0) {
    parts.push(`${String(index.media)} from pictures and sound`);
  }
  return parts.join(', ');
}
