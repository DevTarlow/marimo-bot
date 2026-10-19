/**
 * How a scheduled job becomes a turn.
 *
 * Shared by both processes, and that is the point: the app runs jobs while it is
 * open and the headless runner runs them while it is closed, and a job must
 * behave the same either way. Anything that differed — which agent answers, what
 * happens when the conversation has been deleted, whether the events reach a
 * window — is decided here, once.
 *
 * Two details are worth reading closely.
 *
 * **A job outlives its conversation.** A job's `sessionId` can point at a
 * conversation the user has since deleted from the sidebar. A schedule is not a
 * conversation, so the job starts a fresh one named after itself and is
 * re-pointed at it, rather than failing because something it referenced is gone.
 *
 * **Events go two ways.** The scheduler drains them to work out how the run
 * ended, and the window is told as well when there is one. Without that second
 * copy a job running in the conversation you are looking at would sit silent and
 * then appear all at once when it finished.
 */
import type {AgentUiEvent} from '@marimo/protocol';

import type {AgentRuntime} from './runtime.js';
import type {HarnessRuntime} from './harness-runtime.js';
import type {JobStore} from '../jobs.js';
import type {JobRunner} from '../scheduler.js';

export interface JobRunnerOptions {
  runtime: AgentRuntime;
  /** The v2 path, when the job's conversation has a v2 log. */
  harness?: HarnessRuntime;
  jobs: JobStore;
  /**
   * Told about every event as it passes, when anything is listening.
   *
   * Absent in the headless runner, which has no window, and that is not a
   * degraded mode: the events are still drained, which is what records the
   * outcome.
   */
  onEvent?: (event: AgentUiEvent) => void;
}

export function createJobRunner(options: JobRunnerOptions): JobRunner {
  const {runtime, jobs} = options;

  return {
    isBusy: () => runtime.isBusy(),
    run: async ({jobId, profileId, sessionId, onSession, prompt, title}) => {
      let id = sessionId;
      if (id !== null && !(await hasSession(runtime, profileId, id))) {
        id = null;
      }
      if (id === null) {
        const created = await runtime.createSession(profileId, title);
        if (created === undefined) {
          throw new Error(`There is no bot called "${profileId}".`);
        }
        id = created.id;
        // Written back before the turn starts, so a run that is interrupted
        // still leaves the job pointing at the conversation it began in.
        await jobs.setSession(jobId, id);
        onSession(id);
      }

      if (options.harness !== undefined && (await options.harness.hasLog(id))) {
        return {
          sessionId: id,
          events: forward(
            options.harness.run(profileId, id, prompt),
            options.onEvent,
          ),
        };
      }

      return {
        sessionId: id,
        events: forward(runtime.run(profileId, id, prompt), options.onEvent),
      };
    },
  };
}

/** Whether a conversation still exists for this agent. */
async function hasSession(
  runtime: AgentRuntime,
  profileId: string,
  sessionId: string,
): Promise<boolean> {
  const sessions = await runtime.listSessions(profileId);
  return sessions.some((session) => session.id === sessionId);
}

/** Yields every event onward, and to a listener when there is one. */
async function* forward(
  stream: AsyncGenerator<AgentUiEvent>,
  listener: ((event: AgentUiEvent) => void) | undefined,
): AsyncGenerator<AgentUiEvent> {
  for await (const event of stream) {
    listener?.(event);
    yield event;
  }
}
