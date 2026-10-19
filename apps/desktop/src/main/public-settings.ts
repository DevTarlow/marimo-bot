/**
 * The settings a window may see, assembled in one place.
 *
 * Split out of `ipc.ts` for the reason that file cannot answer a question about
 * itself: it imports Electron to register its handlers, so nothing in it can be
 * called from a test without mocking a browser. What crosses to the renderer is
 * the one boundary the app has a rule about — no credential ever goes over it —
 * and a rule that can only be checked by reading the code that obeys it is a
 * rule that holds until somebody adds a field.
 *
 * So the gathering stays in `ipc.ts` and the *shape* is built here, from values
 * a caller can hand in: `tests/settings-payload.test.ts` walks what this returns
 * rather than a copy of what it thinks this returns.
 */
import type {
  AgentProfile,
  ProviderId,
  PublicSettings,
  StoredSettings,
} from '@marimo/protocol';

/** The facts only the main process has, gathered by the caller. */
export interface SettingsFacts {
  /** The stored document, fetched lists included. */
  settings: StoredSettings;
  /** Whether a question could be answered right now, and why not. */
  readiness: {ok: boolean; problem?: string};
  /** Which providers have a key stored. Never the key. */
  providerKeys: Partial<Record<ProviderId, boolean>>;
  /** Whether this machine can encrypt a key at rest. */
  encryptionAvailable: boolean;
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
    providerKeys: facts.providerKeys,
    encryptionAvailable: facts.encryptionAvailable,
    /*
     * Every provider's list rather than the active one's.
     *
     * The active provider's was what `providers.fetch` happened to fill last,
     * and a model is a pair: an agent or a conversation pinned elsewhere is
     * offered that endpoint's models, so a payload carrying one list left every
     * control but the app's own with nothing to show. A provider absent from the
     * record has never been asked, which the window is told rather than
     * papered over — see `AvailableModels`.
     */
    availableModels: facts.settings.availableModels,
    profiles: facts.profiles,
    activeProfileId: facts.activeProfileId,
  };
}
