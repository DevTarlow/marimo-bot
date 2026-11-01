/**
 * The first-run model step.
 *
 * This is the one step the app cannot do for the person: it downloads the text
 * model that answers. Everything else in the flow is a choice; this is a wait,
 * and the screen has to say how long, how big, and what happens if it fails.
 *
 * Pictures and voice are deliberately *not* here. They are a separate, optional
 * step (`SetupExtras`) that exists only when the person's goals asked for them,
 * because a first run should not spend another two gigabytes on a camera
 * somebody never opens. This step stays the one required download, and the one
 * place the flow refuses to continue past a download that has not finished.
 *
 * Two principles are unchanged from the version that owned the card directly:
 *
 * - **It ends on a verification.** The install is not "done" when the files are
 *   on disk; the person can start the engine once and watch it load, because a
 *   first chat that dies on a machine the app cannot run would be a worse first
 *   impression than a slower download.
 * - **The card is shared.** `ModelSetupCard` is the same download UI the
 *   optional extras step uses, so the two steps cannot disagree about a copy,
 *   a size, a failure sentence or a progress bar.
 */
import {useState} from 'react';

import {LOCAL_MODELS} from '@marimo/protocol';
import type {LocalModelId, PublicSettings} from '@marimo/protocol';

import {ModelSetupCard} from './ModelSetupCard.js';

export function SetupModel({
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
  const modelId = settings.localModels.tasks.chat;
  const status = settings.localModels.models[modelId];
  const ready = status.installed && settings.modelReady;
  /*
   * The card owns the download state, but this step owns the buttons that leave
   * it. The card reports busy rather than exposing the hook, so Back and "set
   * this up later" cannot walk away from a download that is still running.
   */
  const [cardBusy, setCardBusy] = useState(false);

  return (
    <div className="setup-body">
      <h2>Give {LOCAL_MODELS[modelId].shortLabel} a local brain</h2>
      <p className="onboarding-lead">
        One download, and then the app answers on this computer. No account, no
        API key, and nothing you type is sent to a model service.
      </p>

      <ModelSetupCard
        modelId={modelId}
        settings={settings}
        onSettings={onSettings}
        ready={ready}
        check
        downloadLabel="Download and continue"
        extraProblem={ready ? undefined : settings.modelProblem}
        onInstallingChange={setCardBusy}
      />

      <div className="onboarding-actions">
        <button
          type="button"
          className="button button-primary"
          disabled={!ready || cardBusy}
          onClick={onNext}
        >
          Continue
        </button>
        <button
          type="button"
          className="button button-quiet"
          disabled={cardBusy}
          onClick={onBack}
        >
          Back
        </button>
        <button
          type="button"
          className="button button-quiet"
          disabled={cardBusy}
          onClick={onLater}
        >
          Set this up later
        </button>
      </div>
    </div>
  );
}

/** Kept for the compiler: the id is a union, and a typo must not compile. */
export function isLocalModelId(value: string): value is LocalModelId {
  return value in LOCAL_MODELS;
}
