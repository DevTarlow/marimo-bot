/**
 * The review at the end of the first run.
 *
 * The summary deliberately reads the settings and the disk, not the goals. A
 * person who asked for pictures and then skipped the model download should see
 * "not downloaded", not a tick because they once said they wanted it; the goals
 * only decide which rows are worth showing. That is the same rule the Settings
 * cards follow — a claim about what is installed is a claim about a file.
 *
 * The one model the flow installs covers text and pictures, so the Pictures row
 * says that rather than naming a second download.
 *
 * Starting the app is the flow's existing close: App marks the first run as
 * seen, opens a new chat in the Space the person picked, and reloads. This
 * component only draws the review and calls that one path.
 */
import {useEffect, useState} from 'react';

import {LOCAL_MODELS} from '@marimo/protocol';
import type {
  AgentProfile,
  PublicSettings,
  ServiceStatus,
} from '@marimo/protocol';

import {goalEffects} from '../setup-goals.js';
import type {SetupDirection, SetupGoalId} from '../setup-goals.js';

export function SetupFinish({
  settings,
  direction,
  goals,
  bots,
  spaceName,
  accessLabel,
  onBack,
  onStart,
}: {
  settings: PublicSettings;
  direction: SetupDirection;
  goals: readonly SetupGoalId[];
  bots: readonly AgentProfile[];
  spaceName: string | undefined;
  /** The Standard/Power user label, or "your own mix". */
  accessLabel: string;
  onBack: () => void;
  onStart: () => void;
}): React.JSX.Element {
  const effects = goalEffects(goals);
  const [service, setService] = useState<ServiceStatus | null>(null);
  const wantsJobs = direction === 'power' && effects.jobs;

  useEffect(() => {
    if (!wantsJobs) {
      return;
    }
    let live = true;
    void window.marimo
      .call('service.status', {})
      .then((next) => {
        if (live) {
          setService(next);
        }
      })
      .catch(() => {
        // The row says it could not read the service rather than claiming on or
        // off; the Jobs rail is where the switch actually lives.
      });
    return () => {
      live = false;
    };
  }, [wantsJobs]);

  const chatModel = LOCAL_MODELS[settings.localModels.tasks.chat];
  const visionInstalled =
    settings.localModels.models[settings.localModels.tasks.vision].installed;
  const wantsPictures = effects.tasks.includes('vision');

  const jobsValue =
    service === null
      ? wantsJobs
        ? 'Could not read the service — see the Jobs rail.'
        : undefined
      : service.installed
        ? 'Runs while the window is closed.'
        : 'Only while the window is open — turn it on in the Jobs rail.';

  return (
    <div className="setup-body">
      <h2>You&rsquo;re ready</h2>
      <p className="onboarding-lead">
        Here is what this setup put in place. Everything below is in Settings
        and can be changed at any time; nothing here is a mode.
      </p>

      <dl className="setup-summary" data-setup-summary="">
        <div className="setup-summary-row">
          <dt>Access</dt>
          <dd>{accessLabel}</dd>
        </div>
        <div className="setup-summary-row">
          <dt>Model</dt>
          <dd>
            {chatModel.label}
            {settings.modelReady
              ? ' — ready for Chat and Images'
              : ` — not ready${settings.modelProblem === undefined ? '' : `: ${settings.modelProblem}`}`}
          </dd>
        </div>
        <div className="setup-summary-row">
          <dt>Space</dt>
          <dd>{spaceName ?? 'The folder the app started in.'}</dd>
        </div>
        <div className="setup-summary-row">
          <dt>Bots</dt>
          <dd>
            {bots.length === 0
              ? 'None yet — the + beside Bots makes one.'
              : bots.map((bot) => bot.name).join(', ')}
          </dd>
        </div>
        {wantsPictures && (
          <div className="setup-summary-row">
            <dt>Pictures</dt>
            <dd>
              {visionInstalled
                ? `Included in ${chatModel.label}.`
                : 'Not downloaded — the model row above has the download.'}
            </dd>
          </div>
        )}
        {wantsJobs && jobsValue !== undefined && (
          <div className="setup-summary-row">
            <dt>Jobs</dt>
            <dd>
              {jobsValue}
              {service !== null && !service.keysReadable
                ? " A connector's secret is encrypted, so the runner cannot read it — see Connectors."
                : ''}
            </dd>
          </div>
        )}
      </dl>

      {!settings.modelReady && (
        <p className="settings-problem">
          {settings.modelProblem ??
            'The app cannot answer yet. Go back to the model step to finish that download.'}
        </p>
      )}

      <p className="onboarding-note">
        Every switch is in Settings: the tools, the Models card, the companion,
        the connectors, and the background service in the Jobs rail.
      </p>

      <div className="onboarding-actions">
        <button
          type="button"
          className="button button-primary"
          disabled={!settings.modelReady}
          onClick={onStart}
        >
          Start chatting
        </button>
        <button type="button" className="button button-quiet" onClick={onBack}>
          Back
        </button>
      </div>
    </div>
  );
}
