/**
 * The settings a window may see, assembled in one place.
 *
 * Split out of `ipc.ts` for the reason that file cannot answer a question about
 * itself: it imports Electron to register its handlers, so nothing in it can be
 * called from a test without mocking a browser. What crosses to the renderer is
 * the one boundary the app has a rule about — a secret never goes over it — and
 * a rule that can only be checked by reading the code that obeys it is a rule
 * that holds until somebody adds a field.
 *
 * So the gathering stays in `ipc.ts` and the *shape* is built here, from values
 * a caller can hand in: `tests/settings-payload.test.ts` walks what this returns
 * rather than a copy of what it thinks this returns.
 *
 * Readiness is derived from the one probe result rather than passed beside it.
 * There used to be a second function deciding whether a file was on disk; a
 * server either answered or it did not, and a boolean computed from the same
 * status is one fewer thing that can disagree with the card.
 */
import type {
  AgentProfile,
  ModelServerStatus,
  PublicSettings,
  StoredSettings,
} from '@marimo/protocol';

/** The facts only the main process has, gathered by the caller. */
export interface SettingsFacts {
  /** The stored document. */
  settings: StoredSettings;
  /** Whether this machine can encrypt a connector's secret at rest. */
  encryptionAvailable: boolean;
  /** The live model server, as the probe found it. */
  modelServer: ModelServerStatus;
  profiles: AgentProfile[];
  activeProfileId: string;
}

export function settingsForWindow(facts: SettingsFacts): PublicSettings {
  const ready = facts.modelServer.state === 'ready';
  return {
    ...facts.settings,
    modelReady: ready,
    ...(ready
      ? {}
      : {
          modelProblem:
            facts.modelServer.detail ??
            'The model server is not answering. Open Settings → Model server.',
        }),
    encryptionAvailable: facts.encryptionAvailable,
    modelServerStatus: facts.modelServer,
    profiles: facts.profiles,
    activeProfileId: facts.activeProfileId,
  };
}
