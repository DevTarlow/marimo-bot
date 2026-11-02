/**
 * What the person wants to do, as a multi-select.
 *
 * These are not capabilities. A goal chooses which steps the flow shows, which
 * starter role it suggests, and whether the voice preference is offered. It
 * grants no tool: the direction above already answered
 * that question, and a goal that quietly wrote a grant would be a second,
 * quieter access screen.
 *
 * The one goal the current direction cannot offer is scheduling. It is drawn
 * and disabled rather than hidden, so the difference between Regular and Power
 * is visible, and the switch below is the honest way to choose it.
 */
import {SETUP_GOALS, goalAvailableIn} from '../setup-goals.js';
import type {SetupDirection, SetupGoalId} from '../setup-goals.js';

export function SetupGoals({
  direction,
  goals,
  busy,
  powerAvailable,
  onToggle,
  onSwitchToPower,
  onContinue,
  onBack,
}: {
  direction: SetupDirection;
  goals: readonly SetupGoalId[];
  busy: boolean;
  /** Whether this build's catalogue actually offers the Power preset. */
  powerAvailable: boolean;
  onToggle: (id: SetupGoalId) => void;
  onSwitchToPower: () => void;
  onContinue: () => void;
  onBack: () => void;
}): React.JSX.Element {
  return (
    <div className="setup-body">
      <h2>What do you want to get done?</h2>
      <p className="onboarding-lead">
        Pick any that apply. These choose the steps you see and the bot we
        suggest; they do not give Marimo Bot any new tools. Every setup already
        answers questions and remembers what you tell it.
      </p>

      <div className="setup-goal-grid">
        {SETUP_GOALS.map((goal) => {
          const available = goalAvailableIn(goal, direction);
          const selected = goals.includes(goal.id);
          return (
            <button
              key={goal.id}
              type="button"
              className="capability-card"
              data-setup-goal={goal.id}
              aria-pressed={selected}
              disabled={busy || !available}
              onClick={() => {
                onToggle(goal.id);
              }}
            >
              <span className="capability-label">
                {goal.label}
                {!available && <em className="capability-tag">Power setup</em>}
              </span>
              <em className="capability-blurb">{goal.blurb}</em>
            </button>
          );
        })}
      </div>

      <p className="onboarding-note">
        Marimo Bot itself follows the access you chose above. A Writer or Coder
        bot has its own tools, so it can save files while Marimo Bot is on
        Standard; Power setup turns those same tools on for Marimo Bot itself. A
        goal that needs a bot adds a bot step, and you can always add one later
        with the + beside Bots.
      </p>

      {direction === 'regular' && (
        <div className="settings-field">
          {powerAvailable ? (
            <>
              <p className="settings-muted">
                Scheduling jobs is part of Power setup, which also gives Marimo
                Bot every tool, including running commands. The command gate is
                unchanged: it still asks before it runs one.
              </p>
              <div className="settings-row">
                <button
                  type="button"
                  className="button button-quiet"
                  disabled={busy}
                  onClick={onSwitchToPower}
                >
                  Switch to Power setup
                </button>
              </div>
            </>
          ) : (
            <p className="settings-muted">
              Scheduling jobs needs Power setup, which this build cannot offer.
            </p>
          )}
        </div>
      )}

      <div className="onboarding-actions">
        <button
          type="button"
          className="button button-primary"
          disabled={busy}
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
