/**
 * Every on-disk location the app owns, resolved from a user-data directory that
 * is handed in rather than read from Electron.
 *
 * This module is deliberately Electron-free, and that is load-bearing rather
 * than tidy. Two very different processes resolve these same paths: the Electron
 * main process, which knows its directory because `app.getPath('userData')`
 * told it, and the headless job runner, which is the same binary running as
 * plain Node and has no `app` at all. Taking the directory as an argument is
 * what lets both share one definition instead of drifting into two layouts that
 * disagree about where a conversation lives.
 */
import {homedir} from 'node:os';
import {join} from 'node:path';

import {providerIdSchema} from '@marimo/protocol';
import type {ProviderId} from '@marimo/protocol';

export interface AppPaths {
  /** The directory everything below lives under. */
  userData: string;
  /** One JSONL file per conversation, plus the index the sidebar reads. */
  sessions: string;
  /**
   * The v2 canonical logs, one JSONL file per conversation.
   *
   * A directory of its own rather than reusing `sessions`: the v1 files are ADK
   * event streams with a different shape, and mixing the two in one folder would
   * make a format change look like a corrupt conversation.
   */
  harnessSessions: string;
  /** One frozen harness spec per distinct hash, for audit and rollback. */
  harnessVersions: string;
  /** Window geometry, rail widths, theme, and the plain preferences. */
  settings: string;
  /**
   * Secrets, one file each.
   *
   * A directory rather than a single file, because a secret that cannot be
   * cleared without touching another one is a secret nobody dares rotate. Each
   * file records in its own prefix whether it is encrypted or readable on disk,
   * so the choice stays visible to anyone who looks.
   */
  secretsDir: string;
  /**
   * One file per provider, named by its id.
   *
   * A record rather than a function, because the set is the catalogue: a provider
   * this build knows has a path here whether or not a key was ever saved for it,
   * so nothing has to invent a file name at the moment a secret is written.
   */
  providerSecrets: Record<ProviderId, string>;
  /** Agent profiles: identities and the capabilities they carry. */
  profiles: string;
  /**
   * The images the user uploaded for their bots.
   *
   * A directory of its own rather than a field on the profile, because a picture
   * is bytes and the profile document is a small JSON file read on every launch.
   * One PNG per profile, named by the profile id through {@link avatarFileName};
   * the profile carries only the marker that says which icon and which version.
   */
  avatars: string;
  /**
   * The folders every agent can work in, and which one is current.
   *
   * Its own document rather than a field on each profile: a folder is a place on
   * the machine, not a fact about which agent is talking.
   */
  workspaces: string;
  /** Scheduled jobs: what to do, when, and which conversation they report into. */
  jobs: string;
  /**
   * The agent's memory suggestions, waiting for the user to agree.
   *
   * A file of its own rather than part of settings: it is neither a preference
   * nor a secret, it is written by a background review rather than by a person,
   * and a document the user never edits should not share a write path with the
   * one holding their API-key configuration.
   */
  memoryProposals: string;
  /**
   * The half of memory that is about the person rather than the project.
   *
   * One folder per profile under here, each holding a `memory.md`, mirroring the
   * workspace layout exactly — so a `.bak` beside either file means the same
   * thing and a user who has learned to read one can read the other. Under user
   * data rather than inside a folder, which is the whole point: a fact about the
   * person has to outlive whichever project happened to be open when they said
   * it. The workspace half still travels with the folder.
   */
  personMemoryDir: string;
  /**
   * What the user told the app about its own answers.
   *
   * "That was wrong" has nowhere else to go: a memory proposal's refusal is a
   * judgement about a *suggestion*, and it deliberately does not silence the
   * agent's own `update_memory`. This is the record of the answers themselves,
   * which is what the next review reads so it stops heading the same way.
   */
  feedback: string;
  /**
   * Where a running app says so.
   *
   * The headless runner reads it to answer one question: is the app already
   * running the jobs? It is not what makes a job run once — the store's own
   * claim does that — but it is what stops the runner building an agent, dialling
   * every MCP server and ticking, once a minute, beside an app doing the same.
   */
  appLock: string;
  /**
   * The user's skills: one folder per skill, each holding a `SKILL.md`.
   *
   * A directory rather than a file, unlike the documents beside it, because a
   * skill is a procedure the user may write by hand and copy between machines.
   * The agent's own instructions are advertised from here and loaded on demand.
   */
  skills: string;
  /**
   * Where skills lived before they were folders.
   *
   * Read once, imported into `skills/`, and renamed to `skills.json.imported`.
   * Kept as a path so the upgrade lives in one place and the runtime does not
   * spell out a filename the store could get wrong.
   */
  legacySkills: string;
  /**
   * The discovery trees: one document per conversation, holding the turns'
   * parent-child records of what the agent tried.
   *
   * A directory rather than a file, unlike almost everything else here, because
   * the unit a reader wants is one conversation — the replay asks "what would
   * these settings have done to this work" — and a single document would be
   * rewritten in full on every recorded step. One file per conversation keeps
   * each write small and makes deleting a conversation's record a rename.
   *
   * Only ever written when the user turns Dream-RSI on; an install that never
   * does never creates the directory.
   */
  dreamDir: string;
  /**
   * Where a brand-new profile may work.
   *
   * A folder of the app's own inside the person's home directory, created on the
   * first run. It used to be the home directory itself, and that was the wrong
   * default rather than a neutral one: an agent's file tools are confined to the
   * folder a Space points at, so starting on home confined it to everything —
   * photographs, tax returns, other people's projects — and showed the home path
   * as if it were a project. A short folder the person did not have to choose is
   * contained and easy to find; picking another Space, or loading home itself, is
   * still one click away.
   *
   * Outside `userData` on purpose: reset erases that directory, and a Space holds
   * documents that are the person's, not the app's.
   */
  defaultWorkspace: string;
  /**
   * Where that starting folder pointed before this build had one of its own.
   *
   * The home directory, and read by exactly one thing: the `workspaces.json`
   * upgrade that moves the folder an older install was seeded with. It exists as
   * a value here rather than as a second `homedir()` call at the upgrade site so
   * the two defaults cannot be resolved from different homes.
   */
  formerDefaultWorkspace: string;
}

/**
 * The app's own folder for a fresh install, inside the person's home directory.
 *
 * A constant rather than a path spelled twice, because a test, the README and the
 * code that creates it all have to name the same folder.
 */
export const DEFAULT_SPACE_FOLDER = 'Marimo';

/**
 * Resolves every location from the one directory the caller owns.
 *
 * `userData` is Electron's own name for it and is kept here so a bug report and
 * a Settings screen call the same place the same thing. In the runner the same
 * value arrives from `MARIMO_USER_DATA_DIR` or the platform default.
 *
 * `home` is an override for the starting folder and the former seed, and exists
 * for tests: a test that let this function derive the tester's home would create
 * the real `~/Marimo` on the machine running it. Production callers leave it
 * out.
 */
export function resolveAppPaths(
  userData: string,
  options: {home?: string} = {},
): AppPaths {
  const home = options.home ?? homedir();
  const secretsDir = join(userData, 'secrets');

  return {
    userData,
    sessions: join(userData, 'sessions'),
    harnessSessions: join(userData, 'harness', 'sessions'),
    harnessVersions: join(userData, 'harness', 'versions'),
    settings: join(userData, 'settings.json'),
    secretsDir,
    /*
     * One file per provider, named by its id, and derived from the catalogue so
     * a provider added to it has a key path the moment it exists. The name is
     * sanitised like any other secret name, which for these ids is a no-op —
     * they are lowercase with at most an underscore.
     */
    providerSecrets: Object.fromEntries(
      providerIdSchema.options.map((id) => [id, secretFileIn(secretsDir, id)]),
    ) as Record<ProviderId, string>,
    profiles: join(userData, 'profiles.json'),
    avatars: join(userData, 'avatars'),
    workspaces: join(userData, 'workspaces.json'),
    jobs: join(userData, 'jobs.json'),
    memoryProposals: join(userData, 'memory-proposals.json'),
    personMemoryDir: join(userData, 'memory'),
    feedback: join(userData, 'feedback.json'),
    appLock: join(userData, 'app.lock'),
    skills: join(userData, 'skills'),
    legacySkills: join(userData, 'skills.json'),
    dreamDir: join(userData, 'trees'),
    defaultWorkspace: join(home, DEFAULT_SPACE_FOLDER),
    formerDefaultWorkspace: home,
  };
}

/**
 * Where Electron would put this app's user data, worked out rather than asked.
 *
 * The app does not need this — it has `app.getPath('userData')`. The headless
 * job runner does, and it is the same binary running as plain Node with no
 * `app` object at all, so it has to derive the path from the platform's own
 * rules. Getting this wrong is one of the quieter possible bugs: the runner
 * would read a *different* `jobs.json` from the one the window writes, find
 * nothing due, and exit 0 — a background service that looks healthy and never
 * does anything.
 *
 * Electron's rule, which this mirrors, is the platform's application-data
 * directory with the app's name appended:
 *
 * - Linux — `$XDG_CONFIG_HOME` or `~/.config`
 * - macOS — `~/Library/Application Support`
 * - Windows — `%APPDATA%`, which is the roaming profile
 *
 * The `MARIMO_USER_DATA_DIR` override is applied by the caller rather than here,
 * because Electron has to apply it before its single-instance lock is taken and
 * this function has no opinion about when it runs.
 */
export function defaultUserDataDir(options: {
  /**
   * The directory to append, which is `USER_DATA_NAME` in the app: the folder's
   * name, deliberately not the product name.
   */
  appName: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  home?: string;
}): string {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();

  if (platform === 'darwin') {
    return join(home, 'Library', 'Application Support', options.appName);
  }

  if (platform === 'win32') {
    const appData = env['APPDATA'];
    // A Windows process without APPDATA is unusual but possible in a service
    // context; falling back to the profile directory beats returning a relative
    // path that would resolve against whatever the working directory happens to
    // be.
    return join(appData && appData.length > 0 ? appData : home, options.appName);
  }

  const configHome = env['XDG_CONFIG_HOME'];
  const base =
    configHome && configHome.length > 0 ? configHome : join(home, '.config');
  return join(base, options.appName);
}

/**
 * The file holding one secret, named by the caller.
 *
 * A function rather than a pre-computed map because the names are user-supplied
 * (`mcp:notes`, `discord`), so the set is not knowable at startup. The one thing
 * it is *not* used for any more is a model API key: the app holds none.
 */
export function secretFile(paths: AppPaths, name: string): string {
  return secretFileIn(paths.secretsDir, name);
}

/**
 * A secret name turned into a file name that cannot leave the secrets directory.
 *
 * Connector names reach this from a Settings field, which makes them the one
 * piece of this path a user types. Everything outside `[a-z0-9._-]` becomes `-`,
 * which folds `/`, `\` and a leading `..` into a name that stays put; the result
 * can only be a single path segment, so `secretFile(paths, '../../etc/passwd')`
 * lands inside `secretsDir` like any other name.
 *
 * Empty after sanitising (a name made entirely of slashes, say) falls back to
 * `secret`, so a malformed name still yields a real file instead of a directory.
 */
export function secretFileName(name: string): string {
  const safe = name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, '-')
    .replace(/^[.-]+/u, '')
    .slice(0, 80);
  return `${safe.length > 0 ? safe : 'secret'}.bin`;
}

function secretFileIn(directory: string, name: string): string {
  return join(directory, secretFileName(name));
}

/**
 * The file holding one bot's uploaded icon.
 *
 * The same one-safe-segment rule as a secret name, for a different reason: a
 * profile id is app-generated, but a hand-edited file or an older test fixture
 * can contain anything, and the name is used both to write and to serve. It has
 * to be impossible for one helper to answer a path outside the directory the
 * other one is allowed to read.
 */
export function avatarFileName(profileId: string): string {
  const safe = profileId
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, '-')
    .replace(/^[.-]+/u, '')
    .slice(0, 80);
  return `${safe.length > 0 ? safe : 'bot'}.png`;
}

export function avatarFile(paths: AppPaths, profileId: string): string {
  return join(paths.avatars, avatarFileName(profileId));
}
