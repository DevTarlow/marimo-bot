/**
 * The model server as a form: address, model, window, and a test.
 *
 * The app does not own this process any more, so there is no download to watch
 * and no engine to sleep. What is left is three preferences and one question —
 * is it answering? — and the question is answered by the main process's probe
 * rather than by anything here. This hook owns the edit, the write and the
 * test; the card and the first-run step draw the same state.
 *
 * **A test saves first.** The address field loses focus when the button is
 * pressed, and a probe of the *stored* address beside a field showing a new one
 * would be a button that tested something nobody could see. The URL is
 * normalised and validated here with the protocol's own reader, so the sentence
 * about a public address arrives before a settings write does.
 */
import {useCallback, useEffect, useState} from 'react';

import {readModelServerUrl} from '@marimo/protocol';
import type {ModelServerStatus, PublicSettings} from '@marimo/protocol';

import {describe} from '../describe.js';

export interface ModelServerEditor {
  url: string;
  setUrl: (value: string) => void;
  model: string;
  setModel: (value: string) => void;
  context: string;
  setContext: (value: string) => void;
  /** Whether the fields differ from what is stored. */
  dirty: boolean;
  /** A probe is in flight. */
  testing: boolean;
  /** A refused address or a failed probe, in words. */
  problem: string | null;
  /** Writes the fields, answering whether they are now stored. */
  save: () => Promise<boolean>;
  /** Saves when needed, then probes, answering whether the server is ready. */
  test: () => Promise<boolean>;
}

const CONTEXT_MIN = 2048;
const CONTEXT_MAX = 1_048_576;

export function useModelServer(
  settings: PublicSettings,
  onSettings: (next: PublicSettings) => void,
): ModelServerEditor {
  const [url, setUrl] = useState(settings.modelServer.url);
  const [model, setModel] = useState(settings.modelServer.model);
  const [context, setContext] = useState(
    String(settings.modelServer.contextTokens),
  );
  const [testing, setTesting] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  /*
   * A write from this form, or from another window, replaces the fields. Keyed
   * by the stored values rather than by the whole payload: a status event
   * arrives through the same `onSettings` and must not pull the text out from
   * under somebody halfway through typing an address.
   */
  useEffect(() => {
    setUrl(settings.modelServer.url);
    setModel(settings.modelServer.model);
    setContext(String(settings.modelServer.contextTokens));
  }, [
    settings.modelServer.url,
    settings.modelServer.model,
    settings.modelServer.contextTokens,
  ]);

  const dirty =
    url !== settings.modelServer.url ||
    model !== settings.modelServer.model ||
    context !== String(settings.modelServer.contextTokens);

  /** The fields as a patch, or the sentence that refuses them. */
  const read = useCallback(():
    | {ok: true; patch: {url: string; model: string; contextTokens: number}}
    | {ok: false; problem: string} => {
    const address = readModelServerUrl(url);
    if (!address.ok) {
      return {ok: false, problem: address.problem};
    }
    const contextTokens = Number(context);
    if (
      !Number.isInteger(contextTokens) ||
      contextTokens < CONTEXT_MIN ||
      contextTokens > CONTEXT_MAX
    ) {
      return {
        ok: false,
        problem:
          'The context window has to be a whole number between 2,048 and ' +
          '1,048,576 tokens.',
      };
    }
    return {
      ok: true,
      patch: {url: address.url, model: model.trim(), contextTokens},
    };
  }, [url, model, context]);

  const save = useCallback(async (): Promise<boolean> => {
    if (!dirty) {
      return true;
    }
    const fields = read();
    if (!fields.ok) {
      setProblem(fields.problem);
      return false;
    }
    setProblem(null);
    try {
      const {settings: saved} = await window.marimo.call('settings.set', {
        patch: {modelServer: fields.patch},
      });
      onSettings(saved);
      return true;
    } catch (failure) {
      setProblem(describe(failure));
      return false;
    }
  }, [dirty, onSettings, read]);

  const test = useCallback(async (): Promise<boolean> => {
    setTesting(true);
    setProblem(null);
    try {
      let current = settings;
      if (dirty) {
        const fields = read();
        if (!fields.ok) {
          setProblem(fields.problem);
          return false;
        }
        const {settings: saved} = await window.marimo.call('settings.set', {
          patch: {modelServer: fields.patch},
        });
        current = saved;
        onSettings(saved);
      }
      const status = await window.marimo.call('modelServer.test', {});
      onSettings(withStatus(current, status));
      if (status.state !== 'ready') {
        setProblem(status.detail ?? 'The model server did not answer.');
        return false;
      }
      return true;
    } catch (failure) {
      setProblem(describe(failure));
      return false;
    } finally {
      setTesting(false);
    }
  }, [dirty, onSettings, read, settings]);

  return {
    url,
    setUrl,
    model,
    setModel,
    context,
    setContext,
    dirty,
    testing,
    problem,
    save,
    test,
  };
}

/**
 * The settings payload with one new probe result.
 *
 * `modelReady` and `modelProblem` are derived from the status in the main
 * process too; this is the same derivation for the window, so a test result
 * takes effect without a second `settings.get`.
 */
function withStatus(
  settings: PublicSettings,
  status: ModelServerStatus,
): PublicSettings {
  const ready = status.state === 'ready';
  const next: PublicSettings = {
    ...settings,
    modelServerStatus: status,
    modelReady: ready,
  };
  if (ready) {
    delete next.modelProblem;
  } else {
    next.modelProblem =
      status.detail ??
      'The model server is not answering. Open Settings → Model server.';
  }
  return next;
}
