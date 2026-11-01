/**
 * "Keep jobs running when the app is closed."
 *
 * The one switch that makes the background service real for a user, and the one
 * with a prerequisite worth stating plainly: the runner has no keychain, so an
 * encrypted key is one it cannot read. A service switched on over an encrypted
 * key does not fail loudly — it runs every minute, refuses for want of a key,
 * records that against the job, and does it again, with nobody watching. So the
 * reason is shown *before* the switch, not as an error afterwards.
 *
 * The failures are shown verbatim. Installing a timer is the one thing this app
 * does that reaches outside its own files, and when a step is refused the message
 * from `systemctl` or `launchctl` is the only thing that says which — along with
 * the command, so it can be finished by hand.
 */
import {useEffect, useState} from 'react';

import type {ServiceStatus} from '@marimo/protocol';

interface Change {
  installed: boolean;
  notes: string[];
  failures: Array<{what: string; detail: string}>;
}

export function KeepRunning({
  showUnavailable = false,
}: {
  /**
   * Whether a failed status read is worth a sentence.
   *
   * The rail stays silent: it is one line under a list of conversations, and a
   * service read that failed there is not what the person came for. The setup
   * step sets this because its whole purpose is the switch, and an empty step
   * would look like a feature this build does not have.
   */
  showUnavailable?: boolean;
} = {}): React.JSX.Element | null {
  const [status, setStatus] = useState<ServiceStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Change | null>(null);

  const load = async (): Promise<void> => {
    try {
      setStatus(await window.marimo.call('service.status', {}));
    } catch {
      // The window is still usable without this row; a failed status read is not
      // worth an error banner over the conversation.
      setStatus(null);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  if (status === null) {
    return showUnavailable ? (
      <p className="settings-muted">
        Could not read the background service. You can turn it on in the Jobs
        rail later.
      </p>
    ) : null;
  }

  const change = async (enable: boolean): Promise<void> => {
    setBusy(true);
    setProblem(null);
    try {
      const result = await window.marimo.call(
        enable ? 'service.enable' : 'service.disable',
        {},
      );
      setProblem(result);
      await load();
    } catch (failure) {
      setProblem({
        installed: status.installed,
        notes: [],
        failures: [
          {
            what: enable ? 'turn it on' : 'turn it off',
            detail: failure instanceof Error ? failure.message : String(failure),
          },
        ],
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="keep-running">
      <label className="keep-head">
        <input
          type="checkbox"
          checked={status.installed}
          disabled={busy}
          onChange={(event) => {
            void change(event.target.checked);
          }}
        />
        <span>Keep jobs running when the app is closed</span>
      </label>

      {status.installed && status.definitionPath.length > 0 && (
        <p className="keep-note">
          Set up at <code>{status.definitionPath}</code>
        </p>
      )}

      {/*
        The runner has no keychain, so an encrypted connector secret is one it
        cannot read. Saying so before the switch is the difference between a
        job that refuses on the night it was needed and a person who knows to
        let the runner read it. The status API already answers for every
        enabled connector together.
      */}
      {!status.keysReadable && (
        <p className="keep-note keep-error">
          A connector&rsquo;s secret is encrypted, so the background runner
          cannot read it. A job that uses that connector will refuse until you
          let the runner read it in Connectors.
        </p>
      )}

      {problem?.failures.map((failure) => (
        <p className="keep-note keep-error" key={failure.what}>
          {failure.what}: {failure.detail}
        </p>
      ))}

      {problem !== null && problem.failures.length === 0 && problem.notes.length > 0 && (
        <p className="keep-note">
          {problem.installed ? 'On' : 'Off'} — with a caveat: {problem.notes[0]}
        </p>
      )}
    </div>
  );
}
