/**
 * The model server's fields, shared by Settings and the first run.
 *
 * One component for the two places that configure the same server, because the
 * two screens asking slightly different questions — pressing Test in Settings
 * and pressing Continue in the first run — is exactly how a second validation
 * rule gets invented. The hook owns the write and the probe; this owns the
 * labels, the status line and the help.
 *
 * The address is a plain text input rather than a picker: the server is a
 * process the person chose and started, and the app cannot discover a port it
 * was not told about. The default is llama.cpp's.
 */
import {useEffect, useRef} from 'react';

import type {PublicSettings} from '@marimo/protocol';

import {useModelServer} from '../hooks/useModelServer.js';
import {cannotCallTools, TOOLS_OFF_CARD} from '../model-copy.js';

/**
 * The llama.cpp invocation the guide is built and tested against.
 *
 * An array rather than one long line so the breaks are explicit: the card
 * preserves them, and a command wrapped by the source's indentation would not
 * paste back into a shell.
 */
const TESTED_SERVER_COMMAND = [
  'llama-server \\',
  '  -m gemma-4-12B-it-qat-UD-Q4_K_XL.gguf \\',
  '  --mmproj mmproj-F16.gguf \\',
  '  -c 16384 -fa on -ngl 99 \\',
  '  --parallel 1 -ub 1120 \\',
  '  -ctk q8_0 -ctv q8_0 \\',
  '  --jinja --host 127.0.0.1 --port 8080',
].join('\n');

export function ModelServerForm({
  settings,
  onSettings,
  onStatusChange,
}: {
  settings: PublicSettings;
  /** The write's own answer, so this form and the window cannot disagree. */
  onSettings: (next: PublicSettings) => void;
  /**
   * Reports whether the form is saved, reachable and busy.
   *
   * The first run's Continue button reads this rather than keeping a second
   * copy of the same three facts; the Settings card does not need it.
   */
  onStatusChange?: (state: {
    dirty: boolean;
    ready: boolean;
    testing: boolean;
  }) => void;
}): React.JSX.Element {
  const editor = useModelServer(settings, onSettings);
  const status = settings.modelServerStatus;
  const autoTested = useRef(false);
  const ready = status.state === 'ready' && !editor.dirty;

  useEffect(() => {
    onStatusChange?.({
      dirty: editor.dirty,
      ready,
      testing: editor.testing,
    });
  }, [editor.dirty, editor.testing, ready, onStatusChange]);

  /*
   * The status in the payload was read at launch. A person who opened this step
   * and then started llama.cpp should not have to press Test to find out it
   * worked, so the first render probes once. Later renders do not: the watcher
   * and the button are the ways to look again.
   */
  useEffect(() => {
    if (autoTested.current) {
      return;
    }
    autoTested.current = true;
    void editor.test();
  }, [editor]);

  const summary =
    status.state === 'ready'
      ? `Connected. ${status.model === undefined ? 'The server named no model.' : `The model is ${status.model}.`}`
      : (status.detail ??
        'The model server is not answering. Start it, then test again.');

  return (
    <div className="model-server-form" data-model-server-form="">
      <div className="settings-field">
        <span>Address</span>
        <div className="settings-row">
          <input
            className="settings-input"
            type="text"
            value={editor.url}
            spellCheck={false}
            aria-label="Model server address"
            placeholder="http://127.0.0.1:8080/v1"
            onChange={(event) => {
              editor.setUrl(event.target.value);
            }}
            onBlur={() => {
              void editor.save();
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.currentTarget.blur();
              }
            }}
          />
          <button
            type="button"
            className="button button-primary button-small"
            disabled={editor.testing}
            onClick={() => {
              void editor.test();
            }}
          >
            {editor.testing ? 'Checking…' : 'Test connection'}
          </button>
        </div>
        <em className="settings-why">
          An OpenAI-compatible server on this computer. Only localhost,
          127.0.0.1 and ::1 are accepted. The default is llama.cpp’s port 8080.
        </em>
      </div>

      <div className="settings-field">
        <span>Model</span>
        <input
          className="settings-input"
          type="text"
          list="model-server-models"
          value={editor.model}
          spellCheck={false}
          aria-label="Model name"
          placeholder="The model the server reports"
          onChange={(event) => {
            editor.setModel(event.target.value);
          }}
          onBlur={() => {
            void editor.save();
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.currentTarget.blur();
            }
          }}
        />
        <datalist id="model-server-models">
          {status.models.map((model) => (
            <option value={model} key={model} />
          ))}
        </datalist>
        <em className="settings-why">
          Leave this blank to use the first model the server reports. A server
          that lists several models can be pointed at one by name.
        </em>
      </div>

      <div className="settings-field">
        <span>Context window</span>
        <input
          className="settings-input"
          type="number"
          min={2048}
          max={1_048_576}
          step={1024}
          value={editor.context}
          aria-label="Context window in tokens"
          onChange={(event) => {
            editor.setContext(event.target.value);
          }}
          onBlur={() => {
            void editor.save();
          }}
        />
        <em className="settings-why">
          Used only when the server does not report its own. The harness keeps a
          quarter of it back for the reply and the tool schemas.
          {status.contextTokens === undefined
            ? ''
            : ` This turn would get ${String(status.contextTokens)} tokens${
                status.contextSource === 'server'
                  ? ' from the server'
                  : ' from this setting'
              }.`}
        </em>
      </div>

      <div
        className={`model-server-status is-${status.state}`}
        data-model-server-state={status.state}
      >
        <span className="model-server-dot" aria-hidden="true" />
        <span>{summary}</span>
      </div>

      {status.models.length > 1 && (
        <p className="settings-muted">
          The server reports {status.models.length} models: {status.models.join(', ')}.
        </p>
      )}

      {cannotCallTools(status) && (
        <p className="settings-problem">{TOOLS_OFF_CARD}</p>
      )}

      {status.vision === false && (
        <p className="settings-problem">
          This server does not report vision, so an attached picture may be
          refused. In llama.cpp, start it with <code>--mmproj</code> and a
          vision model.
        </p>
      )}

      {editor.problem !== null && (
        <p className="settings-problem">{editor.problem}</p>
      )}

      <p className="settings-muted">
        Pictures reach the server only if it was started with an image projector;
        in llama.cpp that is <code>--mmproj</code>. Without one, an attached
        picture gets the server’s own complaint rather than an answer.
      </p>

      <p className="settings-muted">
        The configuration this build is tested against, with Gemma 4 12B and its
        projector (about 10 GB of memory):
      </p>

      <pre className="model-server-command">
        <code>{TESTED_SERVER_COMMAND}</code>
      </pre>
    </div>
  );
}
