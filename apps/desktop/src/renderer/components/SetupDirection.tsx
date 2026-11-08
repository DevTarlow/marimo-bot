/**
 * The setup style, as two path cards.
 *
 * This replaces the control card that used to open the flow, and it asks a
 * slightly larger question: *how do you want to set this up?* Regular is the
 * Standard grant and a shorter path; Power is every tool, the full path, and
 * the scheduled-jobs step. The grant itself comes from `controlPresets` — this
 * component never spells out a tool name, and the lit card is derived from the
 * profile rather than stored here, exactly as the Settings control cards are.
 *
 * It is deliberately not the same component as `ControlChoice`. Settings asks
 * "how much should this bot be able to do" and shows one card over each grant;
 * the first run asks which setup to take, and the answer also decides which
 * steps exist. They share the catalogue, not the question.
 */
import type {CapabilityPreset} from '@marimo/protocol';

import {SETUP_DIRECTIONS, presetIdForDirection} from '../setup-goals.js';
import type {SetupDirection as SetupDirectionId} from '../setup-goals.js';

export function SetupDirection({
  presets,
  chosenId,
  busy,
  catalogLoading,
  problem,
  onChoose,
  onContinue,
  onBack,
  onRetry,
}: {
  presets: readonly CapabilityPreset[];
  /** The preset the current grant matches, or `undefined` for a custom mix. */
  chosenId: string | undefined;
  busy: boolean;
  /** The catalogue read is still in flight. */
  catalogLoading: boolean;
  /** Why the catalogue could not be read, when it could not. */
  problem: string | null;
  onChoose: (direction: SetupDirectionId, preset: CapabilityPreset) => void;
  onContinue: () => void;
  onBack: () => void;
  onRetry: () => void;
}): React.JSX.Element {
  const cards = SETUP_DIRECTIONS.flatMap((direction) => {
    const preset = presets.find(
      (entry) => entry.id === presetIdForDirection(direction.id),
    );
    return preset === undefined ? [] : [{direction, preset}];
  });
  /*
   * A custom mix is not a direction. The person has to choose one, because the
   * answer writes a whole grant and the flow's depth depends on it; continuing
   * with nothing chosen would pretend the question had been answered.
   */
  const custom = !catalogLoading && cards.length > 0 && chosenId === undefined;
  const canContinue = !busy && !catalogLoading && chosenId !== undefined;

  return (
    <div className="setup-body">
      <h2>How do you want to set this up?</h2>
      <p className="onboarding-lead">
        <strong>Regular</strong> gives Marimo Bot the Standard tools and keeps
        the path short. <strong>Power</strong> gives it every tool this app has
        and opens the extra steps; scheduled jobs are part of that path when you
        choose them. Both end in the same app, and every switch stays in
        Settings.
      </p>

      {catalogLoading ? (
        <p className="settings-muted">Reading what this install can do…</p>
      ) : cards.length === 0 ? (
        <div className="settings-field">
          <p className="settings-problem">
            {problem === null
              ? 'This build offers no Standard or Power setup to choose from.'
              : 'Could not read what this install can do.'}
          </p>
          <div className="settings-row">
            <button
              type="button"
              className="button button-quiet"
              disabled={busy}
              onClick={onRetry}
            >
              Try again
            </button>
          </div>
        </div>
      ) : (
        <div className="capability-cards" data-setup-directions="">
          {cards.map(({direction, preset}) => (
            <button
              key={direction.id}
              type="button"
              className="capability-card"
              data-control-preset={preset.id}
              data-setup-direction={direction.id}
              aria-pressed={chosenId === preset.id}
              disabled={busy}
              onClick={() => {
                onChoose(direction.id, preset);
              }}
            >
              <span className="capability-label">
                {direction.label}
                <em className="capability-tag">{preset.label}</em>
              </span>
              <em className="capability-blurb">{preset.blurb}</em>
              <em className="capability-blurb">
                {direction.id === 'regular'
                  ? 'A shorter setup: the model, a Space, and the bots you ask for. It already sees pictures.'
                  : 'Every tool, plus the extra steps — scheduled jobs included when you pick them.'}
              </em>
            </button>
          ))}
        </div>
      )}

      {custom && (
        <p className="settings-muted">
          This bot currently has its own mix of tools. Choosing one replaces it.
        </p>
      )}

      <p className="onboarding-note">
        This is about access, not looks: it sets which tools Marimo Bot may use.
        A bot you make has its own tools, so a Writer bot can save files even
        when Marimo Bot itself is on Standard.
      </p>

      <div className="onboarding-actions">
        <button
          type="button"
          className="button button-primary"
          disabled={!canContinue}
          onClick={onContinue}
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
      </div>
    </div>
  );
}
