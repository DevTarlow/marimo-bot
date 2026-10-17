/**
 * The first step of the setup flow: what should answer.
 *
 * It moved to the front when the flow gained a guided bot builder. Marimo cannot
 * help make a bot before the app can answer, and a wizard that asks for a Space
 * and a bot before it has a model is asking somebody to describe work nothing
 * can do yet. So this is the one required step: the rest of the flow is offered
 * after it, and "Set this up later" closes the flow rather than continuing into
 * screens that cannot work.
 *
 * This is still the step the whole flow exists for, because it is the one thing
 * the app cannot do for itself. It carries no model, so a fresh install says
 * nothing until somebody points it at a service, and the choice is more than a
 * name: an address, a key, and which of that service's models to use.
 *
 * Three deliberate differences from the provider card in Settings, which is the
 * same setup for somebody who already knows the app:
 *
 * - **The providers are cards rather than a dropdown.** Each one's blurb is what
 *   makes the choice decidable ("nothing leaves your LAN" against "an account and
 *   a key"), and a select shows one blurb at a time, for whichever entry happens
 *   to be current.
 * - **The fields that do not apply are folded away.** A hosted service wants a
 *   key; a server on this machine wants an address. Drawing both for everybody is
 *   how a first run becomes a form.
 * - **It says whether the app can answer yet**, in the main process's own words
 *   when it cannot. That verdict is the difference between a step that is done
 *   and a step that looks done.
 *
 * What it does *not* do is hold its own copy of any provider fact: the labels,
 * blurbs, addresses, key help and placeholder models all come from `PROVIDERS`,
 * and the model list comes from what the endpoint last reported. A second list
 * here would be a second answer to "where does DeepSeek live".
 *
 * Every write lands as it is made — the provider on a click, the key on Save, the
 * model on a change — so a half-finished step is not a half-written settings
 * file, and closing the app in the middle of it loses nothing.
 */
import {useState} from 'react';

import {PROVIDERS, PROVIDER_IDS} from '@marimo/protocol';
import type {PublicSettings, SettingsPatch} from '@marimo/protocol';

import {describe} from '../describe.js';
import {modelChoicesFor, SEARCHABLE_MODEL_THRESHOLD} from '../model-search.js';
import {ModelPicker} from './ModelPicker.js';

export function SetupProvider({
  settings,
  onSettings,
  onBack,
  onNext,
  onLater,
}: {
  settings: PublicSettings;
  /** The write's own answer, so this step and the window cannot disagree. */
  onSettings: (next: PublicSettings) => void;
  onBack: () => void;
  /** Continues to the Space and bot steps, only when the app can answer. */
  onNext: () => void;
  /** Closes the flow without making a bot, for somebody setting the rest up later. */
  onLater: () => void;
}): React.JSX.Element {
  const [saving, setSaving] = useState(false);
  const [fetching, setFetching] = useState(false);
  const [apiKey, setApiKey] = useState('');
  /** The address while it is being typed; `null` means "show what is stored". */
  const [baseUrlDraft, setBaseUrlDraft] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  /*
   * The two fields that do not apply to every provider, revealed on request.
   * Held here rather than in settings: "I was looking at the address box" is not
   * a preference, and a stored one would open the flow on a form again.
   */
  const [showAddress, setShowAddress] = useState(false);
  const [showKey, setShowKey] = useState(false);

  const active = settings.providers.active;
  const descriptor = PROVIDERS[active];
  const config = settings.providers.configs[active];
  const choices = modelChoicesFor(
    settings.availableModels,
    active,
    config.model,
  );
  const models = choices.models;
  const keyStored = settings.providerKeys[active] === true;
  const baseUrl = baseUrlDraft ?? config.baseUrl;
  const busy = saving || fetching;

  /** Runs one write and redraws from its answer. */
  const write = async (work: () => Promise<PublicSettings>): Promise<void> => {
    setSaving(true);
    setProblem(null);
    setNote(null);
    try {
      onSettings(await work());
      setBaseUrlDraft(null);
    } catch (failure) {
      setProblem(describe(failure));
      // Put the box back rather than leaving a refused address in it.
      setBaseUrlDraft(null);
    } finally {
      setSaving(false);
    }
  };

  const save = (patch: SettingsPatch): void => {
    void write(
      async () => (await window.marimo.call('settings.set', {patch})).settings,
    );
  };

  /** Writes the key and forgets it here: the window is never told one back. */
  const saveKey = async (): Promise<void> => {
    const value = apiKey;
    setSaving(true);
    setProblem(null);
    setNote(null);
    try {
      const {settings: next} = await window.marimo.call('settings.setApiKey', {
        apiKey: value,
        provider: active,
      });
      setApiKey('');
      onSettings(next);
    } catch (failure) {
      setProblem(describe(failure));
    } finally {
      setSaving(false);
    }
  };

  /**
   * Asks the endpoint what it serves.
   *
   * It is also the only honest check that the address and the key work: a key
   * that is stored is a key nobody has used yet, and the first turn is a bad
   * place to find out. An address still sitting in the box is committed first,
   * or the button asks the one the user just replaced.
   */
  const fetchModels = async (): Promise<void> => {
    setFetching(true);
    setProblem(null);
    setNote(null);
    try {
      const draft = baseUrlDraft?.trim() ?? '';
      if (draft.length > 0 && draft !== config.baseUrl) {
        await window.marimo.call('settings.set', {
          patch: {providers: {configs: {[active]: {baseUrl: draft}}}},
        });
        setBaseUrlDraft(null);
      }
      const {settings: next} = await window.marimo.call('providers.fetch', {
        provider: active,
      });
      setNote(
        `${descriptor.label} returned ` +
          `${String(next.availableModels[active]?.length ?? 0)} model(s).`,
      );
      onSettings(next);
    } catch (failure) {
      setProblem(describe(failure));
    } finally {
      setFetching(false);
    }
  };

  const ready = settings.modelReady;
  const canFetch = !busy && (!descriptor.requiresApiKey || keyStored);
  const drawKey = descriptor.requiresApiKey || showKey;
  const drawAddress = !descriptor.requiresApiKey || showAddress;

  return (
    <div className="setup-body">
      <h2>Where should answers come from?</h2>
      <p className="onboarding-lead">
        Pick a service. Marimo Bot sends it your messages and shows you the
        reply.
      </p>
      <p className="onboarding-note">
        Each service keeps its own address, model, and key. Trying one and
        switching back costs nothing.
      </p>

      <div className="capability-cards">
        {PROVIDER_IDS.map((id) => (
          <button
            key={id}
            type="button"
            className="capability-card"
            aria-pressed={id === active}
            disabled={busy}
            onClick={() => {
              // Nothing to write when it is already the choice, and a write
              // would clear the note that says what it just did.
              if (id === active) {
                return;
              }
              setShowAddress(false);
              setShowKey(false);
              save({providers: {active: id}});
            }}
          >
            <span className="capability-label">{PROVIDERS[id].label}</span>
            <em className="capability-blurb">{PROVIDERS[id].blurb}</em>
          </button>
        ))}
      </div>

      {/*
        The fold-away half of each field, offered as a sentence rather than as a
        greyed-out box: a disabled control says "you are not allowed", and this
        is simply not the usual case. Each one sits where the field it reveals
        would be, so the form does not reorder itself when it is pressed.
      */}
      {!drawKey && (
        <button
          type="button"
          className="button button-quiet button-small"
          disabled={busy}
          onClick={() => {
            setShowKey(true);
          }}
        >
          My server needs a key
        </button>
      )}

      {drawKey && (
        <div className="settings-field">
          <span>API key</span>
          <p className="settings-muted">
            {keyStored
              ? `A ${descriptor.label} key is saved. It stays on this machine and is never sent back to this window.`
              : descriptor.requiresApiKey
                ? `No ${descriptor.label} key yet. Add one to fetch its models.`
                : `${descriptor.label} needs no key. Anything you put here is sent as one, which matters only if your server asks for it.`}
          </p>
          {/*
            Said before the field rather than after a refused save: the storage
            is about to refuse an encrypted key, and a secret typed into a box
            whose Save cannot work is a secret spent for nothing.
          */}
          {!settings.encryptionAvailable && (
            <p className="settings-muted">
              This machine has no keychain, so the key can only be stored
              readable. Tick the box below, then save it.
            </p>
          )}
          <div className="settings-row">
            <input
              className="settings-input"
              type="password"
              value={apiKey}
              placeholder={descriptor.keyPlaceholder}
              aria-label={`${descriptor.label} API key`}
              autoComplete="off"
              disabled={busy}
              onChange={(event) => {
                setApiKey(event.target.value);
              }}
            />
            <button
              type="button"
              className="button button-primary"
              disabled={busy || apiKey.trim().length === 0}
              onClick={() => {
                void saveKey();
              }}
            >
              Save key
            </button>
          </div>
          <p className="settings-muted">{descriptor.keyHelp}</p>

          {/*
            The consent that decides whether a scheduled job can reach a hosted
            provider at all: the runner has no keychain, so a key it must decrypt
            is a key it cannot use. Off unless the user says otherwise, and said
            in full rather than as a euphemism — the key really does sit readable.
          */}
          <label className="settings-check">
            <input
              type="checkbox"
              checked={config.keyStorage === 'plaintext'}
              disabled={busy}
              onChange={(event) => {
                save({
                  providers: {
                    configs: {
                      [active]: {
                        keyStorage: event.target.checked
                          ? 'plaintext'
                          : 'keychain',
                      },
                    },
                  },
                });
              }}
            />
            <span>
              Let scheduled jobs use this key while the app is closed
              <em className="settings-why">
                {settings.encryptionAvailable
                  ? 'A job runs without a window, so it cannot unlock the keychain. With this on, the key is stored readable instead of encrypted, so anything that can open the file can read it. Save the key again after changing this.'
                  : 'The key can only be stored readable here, because there is no keychain to encrypt it with.'}
              </em>
            </span>
          </label>
        </div>
      )}

      {!drawAddress && (
        <button
          type="button"
          className="button button-quiet button-small"
          disabled={busy}
          onClick={() => {
            setShowAddress(true);
          }}
        >
          Use a different address
        </button>
      )}

      {drawAddress && (
        <label className="settings-field">
          <span>Address</span>
          <em className="settings-why">
            Where requests for {descriptor.label} go. The usual address is{' '}
            <code>{descriptor.defaultBaseUrl}</code>.
          </em>
          <input
            className="settings-input"
            type="text"
            value={baseUrl}
            placeholder={descriptor.defaultBaseUrl}
            disabled={busy}
            spellCheck={false}
            onChange={(event) => {
              setBaseUrlDraft(event.target.value);
            }}
            onBlur={() => {
              const next = baseUrl.trim();
              // An empty box is not an address: put back what is stored rather
              // than writing a value the schema refuses and nobody can see.
              if (next.length === 0 || next === config.baseUrl) {
                setBaseUrlDraft(null);
                return;
              }
              save({providers: {configs: {[active]: {baseUrl: next}}}});
            }}
          />
        </label>
      )}

      <div className="settings-field">
        <span>Model</span>
        <em className="settings-why">
          What {descriptor.label} answers with. A cheaper model is fine for
          reading and summarising. Harder questions want a bigger one.
        </em>
        <div className="settings-row">
          {models.length > SEARCHABLE_MODEL_THRESHOLD ? (
            <ModelPicker
              models={models}
              value={config.model}
              disabled={busy}
              onChange={(model) => {
                save({providers: {configs: {[active]: {model}}}});
              }}
            />
          ) : (
            <select
              className="settings-input"
              aria-label="Model"
              value={config.model}
              disabled={busy}
              onChange={(event) => {
                save({
                  providers: {configs: {[active]: {model: event.target.value}}},
                });
              }}
            >
              {models.map((model) => (
                <option key={model} value={model}>
                  {model}
                </option>
              ))}
            </select>
          )}
          <button
            type="button"
            className="button button-quiet"
            disabled={!canFetch}
            title={
              descriptor.requiresApiKey && !keyStored
                ? `Save a ${descriptor.label} key first`
                : undefined
            }
            onClick={() => {
              void fetchModels();
            }}
          >
            {fetching ? 'Fetching…' : 'Fetch models'}
          </button>
        </div>
        {note !== null && <p className="settings-muted">{note}</p>}
        {/*
          The half that stops a placeholder from reading as an answer: these are
          the names this build ships with until somebody asks, and a field that
          showed them silently is one nobody has a reason to refresh.
        */}
        {!choices.fetched && (
          <p className="settings-muted">
            {descriptor.label} has not been asked what it serves yet. These are
            the names this build ships with. Fetching them also checks that the
            key works.
          </p>
        )}
      </div>

      {problem !== null && <p className="settings-problem">{problem}</p>}

      {/*
        The verdict, in the main process's words when it is a refusal: no key, a
        key this process cannot decrypt, and a service this build does not know
        are three different fixes, and a screen that said "not ready" for all of
        them would be a dead end for each.
      */}
      <p className={ready ? 'settings-muted' : 'settings-problem'}>
        {ready
          ? `Answers will come from ${descriptor.label} using ${config.model}.`
          : (settings.modelProblem ??
            'The app cannot answer yet. Pick a service above.')}
      </p>

      <div className="onboarding-actions">
        <button
          type="button"
          className="button button-primary"
          disabled={busy || !ready}
          onClick={onNext}
        >
          Continue
        </button>
        <button
          type="button"
          className="button button-quiet"
          disabled={busy}
          onClick={onBack}
        >
          Back
        </button>
        <button
          type="button"
          className="button button-quiet"
          disabled={busy}
          onClick={onLater}
        >
          Set this up later
        </button>
      </div>
    </div>
  );
}
