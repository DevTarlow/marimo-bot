/**
 * The jobs step of a Power setup.
 *
 * It exists only for the automation goal, because that is the only goal whose
 * work has to happen while the window is closed — and because the job tools are
 * part of the Power grant, a Regular setup has neither the tools nor a reason
 * to install an OS service.
 *
 * The switch is `KeepRunning`, the same component the Jobs rail draws, so there
 * is one behaviour and one set of failure messages rather than a first-run
 * version that can drift. The two facts the step adds are the ones a first run
 * knows and the rail assumes: a job that hits an approval stays paused, and the
 * runner can only read a connector secret that was stored for it.
 */
import {KeepRunning} from './KeepRunning.js';

export function SetupJobs({
  onBack,
  onNext,
}: {
  onBack: () => void;
  onNext: () => void;
}): React.JSX.Element {
  return (
    <div className="setup-body">
      <h2>Keep jobs running</h2>
      <p className="onboarding-lead">
        A job is a prompt on a schedule. With this on, the background runner
        wakes up and runs it while the window is closed, using the same
        conversations and files.
      </p>
      <p className="onboarding-note">
        A job that hits an approval stays paused. Unattended means unapproved
        stays unapproved — the runner never answers its own gate.
      </p>

      <KeepRunning showUnavailable />

      <p className="onboarding-note">
        You can turn this on later from the Jobs rail. Turning it on installs an
        OS timer for this app; turning it off removes it.
      </p>

      <div className="onboarding-actions">
        <button
          type="button"
          className="button button-primary"
          onClick={onNext}
        >
          Continue
        </button>
        <button type="button" className="button button-quiet" onClick={onBack}>
          Back
        </button>
      </div>
    </div>
  );
}
