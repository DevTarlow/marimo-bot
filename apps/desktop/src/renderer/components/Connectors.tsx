/**
 * Connectors: the MCP servers this install can reach.
 *
 * The panel is shaped around what somebody actually does — paste the line from a
 * server's README — rather than around the schema. Command and arguments are one
 * box, quoted the way every shell they have used quotes, and the parser beside
 * this file turns it back into the pair the document stores.
 *
 * **Trust is the decision the panel exists for.** An MCP server is software
 * somebody else wrote, offering tools to a model that will use them. Until it is
 * trusted, every one of its calls asks first; trusting it means they stop asking.
 * So the switch says exactly that, and the default is untrusted.
 *
 * **The second decision is where its secret is kept**, and it is the provider
 * card's key-storage question again: a connector's token is encrypted by default,
 * and the headless runner has no keychain, so a job that has to dial this server
 * needs the user to say the secret may sit on disk readable. The two are phrased
 * alike on purpose — it is one trade, made per credential.
 *
 * Nothing is saved until it is tested or saved deliberately. A connector typed
 * wrongly and saved is a connector that "does not work", and the user has no way
 * to tell a typo from a broken server.
 */
import {useState} from 'react';

import type {McpServer, McpStatus, SecretStorage} from '@marimo/protocol';

import {
  formatCommandLine,
  formatSecret,
  parseCommandLine,
  parseSecret,
} from '../command-line.js';
import {SettingsSection} from './SettingsSection.js';

/** A connector being written, before it is a valid `McpServer`. */
interface Draft {
  id: string;
  name: string;
  transport: 'stdio' | 'http';
  /** One line, as pasted. Split on save. */
  line: string;
  url: string;
  trusted: boolean;
  /** Where its secrets are written: encrypted unless the user said otherwise. */
  secretStorage: SecretStorage;
  /**
   * Secrets this connector needs, as `target:name`.
   *
   * The *names* only — a value is written once and never read back, because it
   * is a credential and the window has no business holding one. Which is also
   * why the editor is a list of names with a "set" mark rather than a form of
   * filled-in fields.
   */
  secrets: string[];
}

function emptyDraft(): Draft {
  return {
    id: '',
    name: '',
    transport: 'stdio',
    line: '',
    url: '',
    trusted: false,
    secretStorage: 'keychain',
    secrets: [],
  };
}

function draftOf(server: McpServer): Draft {
  return {
    id: server.id,
    name: server.name,
    transport: server.transport,
    line: formatCommandLine(server.command, server.args),
    url: server.url ?? '',
    trusted: server.trusted,
    secretStorage: server.secretStorage,
    secrets: (server.secrets ?? []).map(
      (secret) => `${secret.target}:${secret.name}`,
    ),
  };
}

/** A name the server can be identified by, derived from what was typed. */
function idFor(draft: Draft): string {
  const base = draft.name.trim().toLowerCase().replaceAll(/[^a-z0-9_]/gu, '_');
  return `mcp:${base.length > 0 ? base : 'server'}`;
}

/** Turns a draft into the document, or explains what is missing. */
function toServer(draft: Draft): {server: McpServer} | {problem: string} {
  const name = draft.name.trim().toLowerCase();
  if (name.length === 0) {
    return {problem: 'Give the connector a name so you can tell it apart later.'};
  }

  const base = {
    id: draft.id.length > 0 ? draft.id : idFor(draft),
    name,
    transport: draft.transport,
    enabled: true,
    trusted: draft.trusted,
    secretStorage: draft.secretStorage,
    // Parsed back into the pair the document stores. A malformed entry is
    // dropped rather than saved as a name nobody can fill in.
    ...(draft.secrets.length === 0
      ? {}
      : {
          secrets: draft.secrets
            .map(parseSecret)
            .filter((entry): entry is {target: 'env' | 'header'; name: string} =>
              entry !== undefined,
            ),
        }),
  };

  if (draft.transport === 'http') {
    const url = draft.url.trim();
    if (url.length === 0) {
      return {problem: 'An address is needed for a connector reached over HTTP.'};
    }
    return {server: {...base, url}};
  }

  try {
    const {command, args} = parseCommandLine(draft.line);
    return {server: {...base, command, ...(args.length > 0 ? {args} : {})}};
  } catch (error) {
    return {
      problem: error instanceof Error ? error.message : String(error),
    };
  }
}

export function Connectors({
  servers,
  statuses,
  encryptionAvailable,
  opened,
  onToggle,
  onChange,
}: {
  servers: McpServer[];
  statuses: Record<string, McpStatus>;
  /**
   * Whether this machine has a keychain at all.
   *
   * The storage consent's copy turns on it, exactly as the provider card's does:
   * without one, a connector's secret cannot be encrypted here either, and a
   * switch offering encryption the machine cannot do would be a lie.
   */
  encryptionAvailable: boolean;
  opened: ReadonlySet<string>;
  onToggle: (title: string, expanded: boolean) => void;
  onChange: () => void;
}): React.JSX.Element {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [tested, setTested] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (work: () => Promise<unknown>): Promise<void> => {
    setBusy(true);
    setProblem(null);
    try {
      await work();
      onChange();
    } catch (failure) {
      setProblem(describe(failure));
    } finally {
      setBusy(false);
    }
  };

  /** The server this draft describes, or a complaint. */
  const resolve = (): McpServer | null => {
    if (draft === null) {
      return null;
    }
    const result = toServer(draft);
    if ('problem' in result) {
      setProblem(result.problem);
      return null;
    }
    return result.server;
  };

  return (
    <SettingsSection title="Connectors" opened={opened} onToggle={onToggle}>
      <p className="settings-muted">
        A connector is an MCP server — software somebody else wrote, offering
        extra tools to a model, which is why nothing from it runs unasked. Until
        you trust one, every tool it offers asks your permission before it runs.
      </p>

      {servers.length === 0 && draft === null && (
        <p className="settings-muted">No connectors yet.</p>
      )}

      {servers.map((server) => {
        const status = statuses[server.id];
        return (
          <div className="connector" key={server.id}>
            <div className="connector-head">
              <span
                className="connector-dot"
                data-state={status?.state ?? 'off'}
                aria-hidden="true"
              />
              <strong className="connector-name">{server.name}</strong>
              <span className="connector-transport">{server.transport}</span>
              <button
                type="button"
                className="button button-quiet button-small"
                disabled={busy}
                onClick={() => {
                  setTested(null);
                  setDraft(draftOf(server));
                }}
              >
                Edit
              </button>
              <button
                type="button"
                className="button button-quiet button-small"
                disabled={busy}
                onClick={() => {
                  void run(async () => {
                    await window.marimo.call('mcp.remove', {serverId: server.id});
                  });
                }}
              >
                Remove
              </button>
            </div>
            {/*
              The detail alone. It already *is* the message — for a connected
              server it reads "5 tools." — and appending the count again gave
              "5 tools. (5 tools)".
            */}
            <p className="connector-detail">
              {status === undefined ? 'Not connected.' : status.detail}
            </p>
            <label className="settings-check">
              <input
                type="checkbox"
                checked={server.trusted}
                disabled={busy}
                onChange={(event) => {
                  const trusted = event.target.checked;
                  void run(async () => {
                    await window.marimo.call('mcp.set', {
                      server: {...server, trusted},
                    });
                  });
                }}
              />
              <span>
                Trust this connector
                <em className="settings-why">
                  {server.trusted
                    ? 'Its tools run without asking. Only do this for a server you would let act on your computer.'
                    : 'Its tools ask before every call. Leave this off unless you wrote the server or trust whoever did.'}
                </em>
              </span>
            </label>
          </div>
        );
      })}

      {draft === null ? (
        <button
          type="button"
          className="button button-quiet"
          disabled={busy}
          onClick={() => {
            setProblem(null);
            setTested(null);
            setDraft(emptyDraft());
          }}
        >
          + Add a connector
        </button>
      ) : (
        <div className="connector connector-editing">
          <label className="settings-field">
            <span>Name</span>
            <input
              className="settings-input"
              value={draft.name}
              placeholder="files"
              disabled={busy}
              onChange={(event) => {
                setDraft({...draft, name: event.target.value});
              }}
            />
          </label>

          <label className="settings-field">
            <span>How it connects</span>
            <select
              className="settings-input"
              value={draft.transport}
              disabled={busy}
              onChange={(event) => {
                setDraft({
                  ...draft,
                  transport: event.target.value === 'http' ? 'http' : 'stdio',
                });
              }}
            >
              <option value="stdio">A command on this computer</option>
              <option value="http">A web address</option>
            </select>
          </label>

          {draft.transport === 'stdio' ? (
            <label className="settings-field">
              <span>Command</span>
              <em className="settings-why">
                Paste the line from the server&rsquo;s instructions. Put quotes
                around anything with a space in it.
              </em>
              <input
                className="settings-input"
                value={draft.line}
                placeholder="npx -y @modelcontextprotocol/server-filesystem /home/you"
                disabled={busy}
                onChange={(event) => {
                  setDraft({...draft, line: event.target.value});
                }}
              />
            </label>
          ) : (
            <label className="settings-field">
              <span>Address</span>
              <input
                className="settings-input"
                value={draft.url}
                placeholder="https://example.com/mcp"
                disabled={busy}
                onChange={(event) => {
                  setDraft({...draft, url: event.target.value});
                }}
              />
            </label>
          )}

          <SecretEditor
            draft={draft}
            busy={busy}
            encryptionAvailable={encryptionAvailable}
            onChange={(secrets) => {
              setDraft({...draft, secrets});
            }}
            onSecretStorage={(secretStorage) => {
              setDraft({...draft, secretStorage});
            }}
            onSaved={() => {
              setTested('Saved.');
              onChange();
            }}
            onProblem={setProblem}
          />

          <label className="settings-check">
            <input
              type="checkbox"
              checked={draft.trusted}
              disabled={busy}
              onChange={(event) => {
                setDraft({...draft, trusted: event.target.checked});
              }}
            />
            <span>
              Trust it now
              <em className="settings-why">
                Its tools will run without asking. Leaving this off is the safer
                start — you can turn it on once you have seen what it offers.
              </em>
            </span>
          </label>

          <div className="connector-actions">
            <button
              type="button"
              className="button button-quiet"
              disabled={busy}
              onClick={() => {
                const server = resolve();
                if (server === null) {
                  return;
                }
                void (async () => {
                  setBusy(true);
                  setProblem(null);
                  setTested(null);
                  try {
                    const result = await window.marimo.call('mcp.test', {server});
                    setTested(
                      result.ok
                        ? `Connected. ${result.detail}`
                        : `Could not connect: ${result.detail}`,
                    );
                  } catch (failure) {
                    setProblem(describe(failure));
                  } finally {
                    setBusy(false);
                  }
                })();
              }}
            >
              Test
            </button>
            <button
              type="button"
              className="button button-primary"
              disabled={busy}
              onClick={() => {
                const server = resolve();
                if (server === null) {
                  return;
                }
                void run(async () => {
                  await window.marimo.call('mcp.set', {server});
                  setDraft(null);
                  setTested(null);
                });
              }}
            >
              Save
            </button>
            <button
              type="button"
              className="button button-quiet"
              disabled={busy}
              onClick={() => {
                setDraft(null);
                setProblem(null);
                setTested(null);
              }}
            >
              Cancel
            </button>
          </div>

          {tested !== null && <p className="connector-detail">{tested}</p>}
        </div>
      )}

      {problem !== null && (
        <p className="connector-detail connector-error">{problem}</p>
      )}
    </SettingsSection>
  );
}

/** Electron wraps a rejected `invoke` in its own prefix, which is noise here. */
function describe(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/^Error invoking remote method '[^']*':\s*/u, '');
}

/**
 * The connector's own credentials, and where they are kept.
 *
 * A list of *names* with a write-only field each, rather than a form of
 * filled-in boxes. A value is a credential, so it is written once and never read
 * back — which means the panel cannot show it, only whether there is one. The
 * alternative, holding decrypted keys in the renderer to redisplay them, is the
 * thing invariant 8 exists to prevent.
 *
 * The storage consent sits inside this block rather than beside the Save button
 * because it is a fact about these values, and its wording is the provider
 * card's: one trade, made per credential, so it should not read as two.
 */
function SecretEditor({
  draft,
  busy,
  encryptionAvailable,
  onChange,
  onSecretStorage,
  onSaved,
  onProblem,
}: {
  draft: Draft;
  busy: boolean;
  encryptionAvailable: boolean;
  onChange: (secrets: string[]) => void;
  onSecretStorage: (secretStorage: SecretStorage) => void;
  onSaved: () => void;
  onProblem: (problem: string | null) => void;
}): React.JSX.Element {
  const [adding, setAdding] = useState('');
  const [values, setValues] = useState<Record<string, string>>({});

  const add = (): void => {
    const parsed = parseSecret(adding);
    if (parsed === undefined) {
      return;
    }
    const entry = formatSecret(parsed);
    if (!draft.secrets.includes(entry)) {
      onChange([...draft.secrets, entry]);
    }
    setAdding('');
  };

  const save = (key: string): void => {
    const value = values[key] ?? '';
    if (value.length === 0 || draft.id.length === 0) {
      return;
    }
    const parsed = parseSecret(key);
    if (parsed === undefined) {
      return;
    }
    void (async () => {
      try {
        await window.marimo.call('mcp.setSecret', {
          serverId: draft.id,
          target: parsed.target,
          name: parsed.name,
          value,
          /*
           * The consent travels with the value rather than being read back off
           * the saved connector. They are two fields of one form, and a user who
           * ticks "let the background runner read this" and then saves the secret
           * without saving the connector must get the file they just asked for —
           * the other order writes yesterday's answer while the screen shows
           * today's, and that is the direction that leaks.
           */
          secretStorage: draft.secretStorage,
        });
        setValues((current) => ({...current, [key]: ''}));
        onSaved();
      } catch (failure) {
        onProblem(failure instanceof Error ? failure.message : String(failure));
      }
    })();
  };

  return (
    <div className="settings-field">
      <span>Secrets</span>
      <em className="settings-why">
        Values the connector needs — an API key in an environment variable, or a
        token in a header. A value is never shown again once it is saved, and the
        switch below decides whether it is encrypted or readable.
        {draft.id.length === 0 &&
          ' Save the connector first, then come back to add these.'}
      </em>

      {/*
        Whether a scheduled job may dial this server is decided by where the
        secret lives: the runner has no keychain to unlock an encrypted one.
      */}
      <label className="settings-check">
        <input
          type="checkbox"
          checked={draft.secretStorage === 'plaintext'}
          disabled={busy}
          onChange={(event) => {
            onSecretStorage(event.target.checked ? 'plaintext' : 'keychain');
          }}
        />
        <span>
          Let the background runner read this key
          <em className="settings-why">
            {encryptionAvailable
              ? 'On, the secret is stored readable instead of encrypted — which is what a scheduled job needs, because the runner has no keychain to unlock it. Anything that can read the file can then read the secret, so leave it off unless jobs have to dial this connector while the app is closed. Save the secret again after changing this.'
              : 'The secret can only be stored readable here, because there is no keychain to encrypt it with. It is readable by anything that can open the file.'}
          </em>
        </span>
      </label>

      {draft.secrets.map((key) => (
        <div className="secret-row" key={key}>
          <code className="secret-name">{key}</code>
          <input
            className="settings-input"
            type="password"
            placeholder={draft.id.length === 0 ? 'save first' : 'value'}
            aria-label={`Value for ${key}`}
            disabled={busy || draft.id.length === 0}
            value={values[key] ?? ''}
            onChange={(event) => {
              setValues((current) => ({...current, [key]: event.target.value}));
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                save(key);
              }
            }}
          />
          <button
            type="button"
            className="button button-quiet button-small"
            disabled={busy || (values[key] ?? '').length === 0}
            onClick={() => {
              save(key);
            }}
          >
            Save
          </button>
          <button
            type="button"
            className="button button-quiet button-small"
            disabled={busy}
            onClick={() => {
              onChange(draft.secrets.filter((entry) => entry !== key));
            }}
          >
            Remove
          </button>
        </div>
      ))}

      <div className="secret-row">
        <input
          className="settings-input"
          value={adding}
          placeholder="env:API_KEY or header:Authorization"
          aria-label="Add a secret name"
          disabled={busy}
          onChange={(event) => {
            setAdding(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && adding.trim().length > 0) {
              const entry = adding.trim().replace(/^header:/u, 'header:');
              const normalised = entry.startsWith('header:')
                ? entry
                : `env:${entry.replace(/^env:/u, '')}`;
              if (!draft.secrets.includes(normalised)) {
                onChange([...draft.secrets, normalised]);
              }
              setAdding('');
            }
          }}
        />
        <button
          type="button"
          className="button button-quiet button-small"
          disabled={busy || parseSecret(adding) === undefined}
          onClick={add}
        >
          Add
        </button>
      </div>
    </div>
  );
}
