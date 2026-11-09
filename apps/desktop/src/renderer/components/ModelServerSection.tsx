/**
 * Settings → Model server.
 *
 * The app no longer downloads a chat model, so this card is not a download
 * manager. It is the address of the server the person runs, the model that
 * server serves, and the one question a turn needs answered before it can send
 * anything. The form is shared with the first run; the card adds the cleanup
 * list for the files an earlier install left behind.
 */
import {useState} from 'react';

import {LEFT_OVER_MODEL_LABELS} from '@marimo/protocol';
import type {LeftOverModelId, PublicSettings} from '@marimo/protocol';

import {describe} from '../describe.js';
import {ModelServerForm} from './ModelServerForm.js';
import {SettingsSection} from './SettingsSection.js';

export const MODEL_SERVER_SECTION = 'Model server';

export function ModelServerSection({
  settings,
  opened,
  onToggle,
  onSettings,
  onSaved,
}: {
  settings: PublicSettings;
  opened: ReadonlySet<string>;
  onToggle: (title: string, expanded: boolean) => void;
  /** The form's own answer, so the card and the write cannot disagree. */
  onSettings: (next: PublicSettings) => void;
  onSaved: () => void | Promise<void>;
}): React.JSX.Element {
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const remove = async (id: LeftOverModelId): Promise<void> => {
    setProblem(null);
    try {
      await window.marimo.call('modelServer.removeLeftOver', {id});
      setConfirmRemove(null);
      await onSaved();
    } catch (failure) {
      setProblem(describe(failure));
    }
  };

  const status = settings.modelServerStatus;

  return (
    <SettingsSection
      title={MODEL_SERVER_SECTION}
      opened={opened}
      onToggle={onToggle}
    >
      <p className="settings-muted">
        Marimo Bot does not download a model. It talks to an OpenAI-compatible
        server you run on this computer — llama.cpp, LM Studio, Ollama, or
        anything else that speaks the same API. Nothing you type is sent to a
        model service.
      </p>

      <ModelServerForm settings={settings} onSettings={onSettings} />

      {status.leftOver.length > 0 && (
        <div className="settings-field">
          <span>Files from an older version</span>
          <p className="settings-muted">
            These downloads were used before the app talked to a server. They are
            not used any more, and removing one deletes it from this computer.
          </p>
          <div className="settings-row">
            {status.leftOver.map((id) => {
              const label = LEFT_OVER_MODEL_LABELS[id];
              return confirmRemove === id ? (
                <span className="settings-row" key={id}>
                  <button
                    type="button"
                    className="button button-primary button-small"
                    onClick={() => {
                      void remove(id);
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
                </span>
              ) : (
                <button
                  type="button"
                  className="button button-quiet button-small"
                  key={id}
                  onClick={() => {
                    setConfirmRemove(id);
                  }}
                >
                  Remove {label}…
                </button>
              );
            })}
          </div>
        </div>
      )}

      {problem !== null && <p className="settings-problem">{problem}</p>}
    </SettingsSection>
  );
}
