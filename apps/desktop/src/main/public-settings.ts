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
 */
import type {
  AgentProfile,
  HostHardware,
  LocalModelsStatus,
  PublicSettings,
  StoredSettings,
} from '@marimo/protocol';

/** The facts only the main process has, gathered by the caller. */
export interface SettingsFacts {
  /** The stored document. */
  settings: StoredSettings;
  /** Whether a turn could start right now, and why not. */
  readiness: {ok: boolean; problem?: string};
  /** Whether this machine can encrypt a connector's secret at rest. */
  encryptionAvailable: boolean;
  /** Every model's files and process state. */
  localModels: LocalModelsStatus;
  /** Memory and platform, for a first run's copy recommendation. */
  hardware: HostHardware;
  profiles: AgentProfile[];
  activeProfileId: string;
}

export function settingsForWindow(facts: SettingsFacts): PublicSettings {
  return {
    ...facts.settings,
    modelReady: facts.readiness.ok,
    ...(facts.readiness.problem === undefined
      ? {}
      : {modelProblem: facts.readiness.problem}),
    encryptionAvailable: facts.encryptionAvailable,
    localModels: facts.localModels,
    hardware: facts.hardware,
    profiles: facts.profiles,
    activeProfileId: facts.activeProfileId,
  };
}
