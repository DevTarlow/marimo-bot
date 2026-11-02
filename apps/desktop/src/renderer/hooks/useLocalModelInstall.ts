/**
 * One local model's download, as a hook.
 *
 * The required model step is the first run's one model download; this hook owns
 * the event subscription, progress, cancel and refresh so the card stays a
 * view rather than a second copy of the installer's event handling.
 *
 * The subscription exists only while this model is installing, exactly as the
 * first-run step always did: a download started in Settings is Settings' to
 * draw, and a card that listened all the time would show another window's
 * progress under its own button.
 */
import {useCallback, useEffect, useState} from 'react';

import type {
  LocalModelId,
  LocalModelVariant,
  PublicSettings,
} from '@marimo/protocol';

import {describe} from '../describe.js';

export interface ModelInstallProgress {
  label: string;
  receivedBytes: number;
  totalBytes: number;
  percent?: number;
}

export interface LocalModelInstall {
  installing: boolean;
  warming: boolean;
  progress: ModelInstallProgress | null;
  problem: string | null;
  install: (variant: LocalModelVariant) => Promise<void>;
  /** Answers when the installer has stopped, so a caller can unblock a sibling. */
  cancel: () => Promise<void>;
  warm: () => Promise<void>;
}

export function useLocalModelInstall({
  modelId,
  onSettings,
}: {
  modelId: LocalModelId;
  /** The write's own answer, so the card and the window cannot disagree. */
  onSettings: (next: PublicSettings) => void;
}): LocalModelInstall {
  const [installing, setInstalling] = useState(false);
  const [warming, setWarming] = useState(false);
  const [progress, setProgress] = useState<ModelInstallProgress | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const {settings: next} = await window.marimo.call('settings.get', {});
      onSettings(next);
    } catch (failure) {
      setProblem(describe(failure));
    }
  }, [onSettings]);

  useEffect(() => {
    if (!installing) {
      return;
    }
    const off = window.marimo.onEvent((event) => {
      if (event.type === 'model.progress' && event.modelId === modelId) {
        setProgress({
          label: event.label,
          receivedBytes: event.receivedBytes,
          totalBytes: event.totalBytes,
          ...(event.percent === undefined ? {} : {percent: event.percent}),
        });
      } else if (
        event.type === 'model.installed' &&
        event.modelId === modelId
      ) {
        setInstalling(false);
        setProgress(null);
        void refresh();
      } else if (event.type === 'model.failed' && event.modelId === modelId) {
        setInstalling(false);
        setProblem(event.message);
      }
    });
    return off;
  }, [installing, modelId, refresh]);

  const install = useCallback(
    async (variant: LocalModelVariant): Promise<void> => {
      setInstalling(true);
      setProblem(null);
      try {
        const {started} = await window.marimo.call('models.install', {
          modelId,
          variant,
        });
        if (!started) {
          setInstalling(false);
          setProblem(
            'Another download is already running. Let it finish first.',
          );
        }
      } catch (failure) {
        setInstalling(false);
        setProblem(describe(failure));
      }
    },
    [modelId],
  );

  const cancel = useCallback(async (): Promise<void> => {
    try {
      await window.marimo.call('models.cancel', {});
      setInstalling(false);
      setProgress(null);
    } catch (failure) {
      setProblem(describe(failure));
    }
  }, []);

  const warm = useCallback(async (): Promise<void> => {
    setWarming(true);
    setProblem(null);
    try {
      const result = await window.marimo.call('models.warm', {modelId});
      if (!result.ok) {
        setProblem(result.problem ?? 'The model did not start.');
      } else {
        await refresh();
      }
    } catch (failure) {
      setProblem(describe(failure));
    } finally {
      setWarming(false);
    }
  }, [modelId, refresh]);

  return {installing, warming, progress, problem, install, cancel, warm};
}
