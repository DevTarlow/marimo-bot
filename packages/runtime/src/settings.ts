/**
 * Settings persistence.
 *
 * Settings are non-secret, so they live in a plain JSON file that a user can
 * read and edit. Reads are forgiving: an unknown or malformed field falls back
 * to its default instead of discarding every other setting.
 *
 * Two kinds of value live here and only one of them is patchable. The
 * preferences are what the user chose; the model list each provider reported is a
 * *fact*, kept beside them in the same document and written only by the call that
 * fetched it — see `setAvailableModels`.
 */
import {mkdir, readFile, rename, writeFile} from 'node:fs/promises';
import {dirname} from 'node:path';

import {
  assertWritable,
  DocumentTooNewError,
  readVersionedDocument,
} from '@marimo/agent';

import {
  appearanceSchema,
  companionSettingsSchema,
  defaultAppearance,
  defaultProviders,
  defaultRecallSettings,
  defaultCompanionSettings,
  DEFAULT_MEMORY_REVIEW_EVENTS,
  DEFAULT_MEMORY_SOFT_LIMIT_BYTES,
  defaultWindowState,
  defaultDiscordSettings,
  discordSettingsSchema,
  providerIdSchema,
  recallSettingsSchema,
  settingsPatchSchema,
  settingsSchema,
  windowStateSchema,
} from '@marimo/protocol';
import type {
  AvailableModels,
  ProviderConfig,
  ProviderId,
  Providers,
  ProvidersPatch,
  SettingsPatch,
  StoredSettings,
} from '@marimo/protocol';

export function defaultStoredSettings(): StoredSettings {
  return {
    /*
     * Which service answers, and what each one was last set to.
     *
     * A real provider rather than a placeholder: the app runs no backend of its
     * own, so a default that answered nothing would be a fresh install unable to
     * reply until somebody found the right screen. DeepSeek is the entry a first
     * run can explain in one sentence, and every other provider is one pick away.
     */
    providers: defaultProviders(),
    /*
     * Nothing fetched yet, and that is the honest state of a file that has never
     * been pointed at an endpoint. Filling it in with the catalogue's names was
     * tried and is worse than it looks: the window could not then tell a list an
     * endpoint reported from one this build guessed, so it could neither say
     * "these are placeholders" nor offer to go and ask. The names themselves are
     * `fallbackModelsFor`, and the renderer's `modelChoicesFor` is what reaches
     * for them where a picker is drawn.
     */
    availableModels: {},
    appearance: defaultAppearance(),
    allowPrivateNetworkFetch: false,
    mcpServers: [],
    // Discord is off until the user pastes a bot token, so a fresh install makes
    // no network calls it was not asked to make.
    discord: defaultDiscordSettings(),
    // How the moss ball answers and behaves. Defaults here rather than in the
    // window that draws it, because two of the four change what the agent is
    // told and a default the renderer owned would be a default the agent could
    // not see.
    companion: defaultCompanionSettings(),
    // Match the design tokens, so the first launch looks like the stylesheet says
    // it should, and a later drag starts from wherever the user left it.
    sidebarWidth: 272,
    todosWidth: 288,
    jobsWidth: 288,
    notesWidth: 288,
    filesWidth: 320,
    // The drawer's default, and the width the stylesheet uses before the stored
    // preference has loaded. Wide enough for a markdown preview, narrow enough
    // to leave the conversation most of a 1180px window.
    documentsWidth: 420,
    // How much of the drawer the file list keeps when a file is open, matching
    // the stylesheet's first paint. The library is for finding a file; the
    // editor is where the time goes, so the split starts in the editor's favour
    // and the divider is what changes it.
    documentsLibraryShare: 0.34,
    // The file tree opens folded, like the notes: the to-do list is the rail a
    // fresh install starts with, and it should not have to share the column.
    filesOpen: false,
    // Nothing opened: every section of the dialog starts folded, so a fresh
    // install opens on the list of headings rather than on eight cards.
    expandedSections: [],
    // Nothing switched off. A command that exists is offered, and one the user
    // turns off stays off — which is why the stored list is the *disabled* half.
    disabledCommands: [],
    // The size the window opened at before it remembered one, placed by the OS.
    window: defaultWindowState(),
    // Where the agent starts being told that memory.md is getting full. Well
    // under the hard cap, so the warning arrives while there is room to prune.
    memorySoftLimitBytes: DEFAULT_MEMORY_SOFT_LIMIT_BYTES,
    // How much unreviewed conversation a session may hold before the memory look
    // stops waiting for it to go quiet. The default reads a long conversation
    // back in stretches rather than only after it ends, which is what stops a
    // fact mentioned early from going unremembered for as long as somebody keeps
    // typing.
    memoryReviewEvents: DEFAULT_MEMORY_REVIEW_EVENTS,
    // Recall off: it downloads a model and starts an engine, and neither is
    // something a fresh install should do without being asked.
    recall: defaultRecallSettings(),
    /*
     * The setup flow has not run: a file that says nothing is either a fresh
     * install or one from a build before the flow existed, and both want to be
     * asked once. What this must not be is a claim about readiness — a user who
     * declined is `setupSeen: true` and still unable to answer.
     */
    setupSeen: false,
  };
}

/**
 * Values a pre-profile settings file may still hold.
 *
 * `workspaceRoot` and `systemPrompt` moved into the agent profile, so they are
 * no longer part of the settings schema — which means the parser strips them on
 * read. This looks at the raw file once, before anything rewrites it, so an
 * upgrade keeps the folder and the prompt the user already had.
 */
export async function readLegacyProfileSeed(file: string): Promise<{
  workspaceRoot?: string;
  systemPrompt?: string;
}> {
  try {
    const raw = JSON.parse(await readFile(file, 'utf8')) as Record<
      string,
      unknown
    >;
    const workspaceRoot = raw['workspaceRoot'];
    const systemPrompt = raw['systemPrompt'];
    return {
      // Trimmed only for the emptiness test: a real folder name may contain
      // spaces, but a blank one must not win over the app's default.
      ...(typeof workspaceRoot === 'string' && workspaceRoot.trim().length > 0
        ? {workspaceRoot}
        : {}),
      ...(typeof systemPrompt === 'string' && systemPrompt.trim().length > 0
        ? {systemPrompt}
        : {}),
    };
  } catch {
    return {};
  }
}

export class SettingsStore {
  private cache: StoredSettings | undefined;

  constructor(private readonly file: string) {}

  async load(): Promise<StoredSettings> {
    if (this.cache) {
      return this.cache;
    }

    /*
     * Versioned like every other document, and refused when it is newer.
     *
     * The leniency below is deliberate — a hand-edited block falls back on its
     * own rather than resetting everything — but leniency plus a write is how a
     * user's data disappears, and a settings file from a future build is exactly
     * the case where the read has to guess. Throwing here stops the guess from
     * becoming a write.
     */
    const read = await readVersionedDocument(this.file, {
      label: 'The settings file',
      /*
       * This document has never carried a version — `settingsSchema` has no such
       * field — so every settings file in existence is version-less, and treating
       * that as "not mine" would reset every user's connectors and preferences the
       * first time they upgraded. Naming the version they are is the migration.
       *
       * A *newer* file is still refused, which is the half that matters: a future
       * build that adds a version number will have its settings left alone.
       */
      missingVersion: 1,
    });
    if (read.state === 'too-new') {
      throw new DocumentTooNewError(
        'The settings file',
        read.found,
        read.supported,
      );
    }
    const raw: unknown =
      read.state === 'current' || read.state === 'migrated'
        ? read.document
        : undefined;

    if (read.state === 'migrated') {
      // Written back once, so the upgrade is not repeated on every launch.
      const upgraded = settingsSchema.safeParse({
        ...defaultStoredSettings(),
        ...(raw as Record<string, unknown>),
      });
      if (upgraded.success) {
        await this.write({
          ...upgraded.data,
          // Derived from the raw file, exactly as the read path below does it:
          // the parse cannot see it, and writing the defaults over what a
          // previous build fetched would throw away every model list.
          availableModels: readAvailableModels(
            (raw as {availableModels?: unknown} | undefined)?.availableModels,
          ),
        });
      }
    }

    const defaults = defaultStoredSettings();
    /*
     * The nested blocks are filled in before the file is parsed as a whole.
     *
     * Each is a sub-object inside an otherwise flat document, and each is what a
     * hand-edited file or a file written by an older build gets slightly wrong —
     * which, without this, would fail the settings schema and reset *every*
     * setting. Filling them block by block means a bad block falls back on its
     * own and the model, the folder widths and the API-key choice survive.
     */
    const rawObject =
      raw !== null && typeof raw === 'object'
        ? (raw as Record<string, unknown>)
        : undefined;
    const filled = rawObject
      ? {
          ...rawObject,
          // A block that does not validate is replaced whole rather than
          // field-by-field: half of a hand-edited block is a second, quieter
          // schema, and the defaults are at least a state the app can describe.
          discord: fillBlock(
            discordSettingsSchema,
            defaults.discord,
            rawObject['discord'],
          ),
          companion: fillBlock(
            companionSettingsSchema,
            defaults.companion,
            rawObject['companion'],
          ),
          appearance: fillBlock(
            appearanceSchema,
            defaults.appearance,
            rawObject['appearance'],
          ),
          /*
           * The window block, filled the same way, for the same reason: a
           * hand-edited bounds value must cost the user the position, not every
           * other setting they have. It is also what a file written before the
           * app remembered its window gets.
           */
          window: fillBlock(
            windowStateSchema,
            defaults.window,
            rawObject['window'],
          ),
          /*
           * And recall, which has the same problem as the rest: it is a block, and
           * a hand-edited switch inside it must cost that block rather than every
           * other setting the user has. It is also what a file written before the
           * feature existed gets, which is the off state.
           */
          recall: fillBlock(
            recallSettingsSchema,
            defaults.recall,
            rawObject['recall'],
          ),
          /*
           * The provider block, filled one provider at a time rather than whole.
           *
           * Deeper than `fillBlock` because the block holds a sub-object per
           * provider: a typo in the Gemini address must not cost the user the
           * provider they were actually using, nor the address they typed for
           * their own server. It is also the one filler that has to read fields
           * outside its own block — see `fillProviders`.
           */
          providers: fillProviders(rawObject),
        }
      : raw;

    const partial = settingsPatchSchema.safeParse(filled ?? {});
    const candidate: Record<string, unknown> = partial.success
      ? {...defaults, ...definedOnly(partial.data)}
      : {...defaults};

    const result = settingsSchema.safeParse(candidate);
    /*
     * The fetched lists are attached after the parse rather than inside it.
     *
     * They are derived from the raw file and never from a patch, so a malformed
     * one falls back to the catalogue's placeholder instead of failing a document
     * that holds every preference the user has.
     */
    this.cache = result.success
      ? {
          ...result.data,
          availableModels: readAvailableModels(
            (raw as {availableModels?: unknown} | undefined)?.availableModels,
          ),
        }
      : defaults;
    return this.cache;
  }

  async patch(patch: SettingsPatch): Promise<StoredSettings> {
    return await this.enqueue(async () => {
      const current = await this.load();
      const defined = definedOnly(patch);
      /*
       * The nested blocks are merged rather than replaced.
       *
       * Their patch schemas accept any subset — that is the point, so flipping one
       * switch does not mean sending the channel name and the bot's name back —
       * but a shallow spread would then store the partial block and throw away
       * the fields the window did not mention.
       */
      const discord = defined.discord
        ? {...current.discord, ...definedOnly(defined.discord)}
        : current.discord;
      const companion = defined.companion
        ? {...current.companion, ...definedOnly(defined.companion)}
        : current.companion;
      const appearance = defined.appearance
        ? {...current.appearance, ...definedOnly(defined.appearance)}
        : current.appearance;
      const recall = defined.recall
        ? {...current.recall, ...definedOnly(defined.recall)}
        : current.recall;
      /*
       * The provider block is merged per provider, not per block.
       *
       * Setting one base URL must not mean sending the other four addresses back:
       * a window holding a copy from before another provider's edit would win, and
       * the user's own server address would quietly revert to the catalogue's.
       */
      const providers = defined.providers
        ? mergeProviders(current.providers, defined.providers)
        : current.providers;
      const merged = settingsSchema.parse({
        ...current,
        ...defined,
        discord,
        companion,
        appearance,
        recall,
        providers,
      });
      const stored: StoredSettings = {
        ...merged,
        // Carried through, never patched: see `setAvailableModels`.
        availableModels: current.availableModels,
      };
      await this.write(stored);
      this.cache = stored;
      return stored;
    });
  }

  /**
   * Records what one provider says it serves.
   *
   * A model the user had selected there may no longer exist, so that provider's
   * default is moved to something the endpoint actually offers rather than left
   * pointing at a retired name — which would fail the next turn for a reason
   * nobody could see. A conversation's own choice is left alone: it was made on
   * purpose, and the refusal it earns is a sentence about that model.
   *
   * No other provider is touched. The lists are answers about one endpoint each,
   * and a store that rewrote its neighbours would be inventing answers.
   */
  async setAvailableModels(
    provider: ProviderId,
    models: string[],
  ): Promise<StoredSettings> {
    const unique = [...new Set(models.filter((id) => id.length > 0))];
    if (unique.length === 0) {
      return await this.load();
    }

    return await this.enqueue(async () => {
      const current = await this.load();
      const config = current.providers.configs[provider];
      const stored: StoredSettings = {
        ...current,
        providers: {
          ...current.providers,
          configs: {
            ...current.providers.configs,
            [provider]: {
              ...config,
              model: chooseModel(unique, config.model),
            },
          },
        },
        availableModels: {...current.availableModels, [provider]: unique},
      };
      await this.write(stored);
      this.cache = stored;
      return stored;
    });
  }

  /**
   * The tail of the write queue.
   *
   * Every mutation here is a read-modify-write, and two of them can arrive in the
   * same tick: the settings dialog saves a text box when it loses focus and the
   * menu that took the focus in the same gesture, which is two `settings.set`
   * calls from one click. Both would read the state from before either wrote, and
   * the second write would drop the first edit — silently, because both writes
   * succeed and neither caller is told.
   */
  private writes: Promise<unknown> = Promise.resolve();

  /** Runs one mutation after every mutation queued before it, in that order. */
  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const queued = this.writes.then(work);
    /*
     * The queue keeps moving after a failed write: one refused patch must not
     * wedge every save after it. The caller still sees its own rejection, because
     * this is the chain's tail rather than the promise handed back.
     */
    this.writes = queued.catch(() => undefined);
    return queued;
  }

  private async write(settings: StoredSettings): Promise<void> {
    // Refused before anything is written: a lenient read plus a write is how a
    // user's settings disappear.
    await assertWritable(this.file, {label: 'The settings file'});
    await mkdir(dirname(this.file), {recursive: true});
    const temporary = `${this.file}.tmp`;
    await writeFile(
      temporary,
      // Stamped from here on, so the next build can tell an old file from one
      // written before versioning existed — which is what `missingVersion` was
      // for, and what stops it being needed twice.
      `${JSON.stringify({version: 1, ...settings}, null, 2)}\n`,
      'utf8',
    );
    await rename(temporary, this.file);
  }
}

function definedOnly<T extends object>(value: T): Partial<T> {
  const output: Partial<T> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) {
      output[key as keyof T] = entry as T[keyof T];
    }
  }
  return output;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Fills one nested block over its defaults, or falls back to them whole.
 *
 * The rule the Discord block always used, generalised: a block that does not
 * validate is replaced rather than merged field-by-field, because half of a
 * hand-edited block is a second, quieter schema.
 */
function fillBlock<T extends object>(
  schema: {
    safeParse: (value: unknown) => {success: boolean; data?: T};
  },
  defaults: T,
  raw: unknown,
): T {
  const parsed = schema.safeParse({...defaults, ...asRecord(raw)});
  return parsed.success && parsed.data ? parsed.data : defaults;
}

/** Keep the current model when it still exists; otherwise pick a fresh one. */
export function chooseModel(available: string[], current: string): string {
  if (available.includes(current)) {
    return current;
  }
  /*
   * Prefer a fast tier when the previous default has been retired: the cheap
   * model is the least surprising thing to land on, and a provider that has
   * dropped its flagship should not silently move somebody onto its most
   * expensive one.
   */
  return (
    available.find((id) => /flash|mini|lite|small|fast/i.test(id)) ??
    available[0]!
  );
}

/**
 * The provider block, filled one provider at a time.
 *
 * Deeper than a single `fillBlock` because the block holds one sub-object per
 * provider: a typo in the Gemini address must not cost the user the provider they
 * were actually using, or the address they typed for their own server.
 *
 * This is also the one filler that reads fields outside its own block, and that
 * is the whole reason it is a function rather than a `fillBlock` call. A settings
 * file written by the build that had a provider catalogue holds a top-level
 * `model` and `baseUrl` — the schema this build ships no longer declares them, so
 * a lenient read would drop both — and those fields were DeepSeek's, because it
 * was the only provider then. They fill DeepSeek's entry here, and their presence
 * is what says such a file is *pointed* at DeepSeek rather than at this build's
 * default. Without that second half, an upgrade would keep the user's address in
 * a config nothing selects.
 */
function fillProviders(raw: Record<string, unknown>): Providers {
  const defaults = defaultProviders();
  const source = asRecord(raw['providers']);
  const rawConfigs = asRecord(source['configs']);
  const legacy: Partial<ProviderConfig> = {};
  const legacyBaseUrl = raw['baseUrl'];
  const legacyModel = raw['model'];
  if (typeof legacyBaseUrl === 'string' && legacyBaseUrl.length > 0) {
    legacy.baseUrl = legacyBaseUrl;
  }
  if (typeof legacyModel === 'string' && legacyModel.length > 0) {
    legacy.model = legacyModel;
  }

  const active = providerIdSchema.safeParse(source['active']);
  const configs = {} as Record<ProviderId, ProviderConfig>;
  for (const id of providerIdSchema.options) {
    configs[id] = fillProviderConfig(
      defaults.configs[id],
      rawConfigs[id],
      id === 'deepseek' ? legacy : {},
    );
  }
  return {
    active: active.success
      ? active.data
      : Object.keys(legacy).length > 0
        ? 'deepseek'
        : defaults.active,
    configs,
  };
}

function fillProviderConfig(
  defaults: ProviderConfig,
  raw: unknown,
  legacy: Partial<ProviderConfig> = {},
): ProviderConfig {
  const source = asRecord(raw);
  return {
    // The block's own value wins; a legacy top-level field only fills a gap.
    baseUrl: firstNonEmpty([
      source['baseUrl'],
      legacy.baseUrl,
      defaults.baseUrl,
    ]),
    model: firstNonEmpty([source['model'], legacy.model, defaults.model]),
    /*
     * A file from before this field existed has no answer, and the safe one is
     * the keychain: a key that was encrypted stays encrypted, and a machine
     * without one still refuses rather than writing a secret readable.
     */
    keyStorage: providerKeyStorageOrDefault(source['keyStorage'], defaults),
  };
}

function providerKeyStorageOrDefault(
  raw: unknown,
  defaults: ProviderConfig,
): ProviderConfig['keyStorage'] {
  return raw === 'plaintext' || raw === 'keychain'
    ? raw
    : defaults.keyStorage;
}

function firstNonEmpty(candidates: unknown[]): string {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0) {
      return candidate;
    }
  }
  return '';
}

/**
 * What each provider last reported, and only that.
 *
 * A provider this file does not mention — or one whose value is not a list of
 * names — comes back *absent* rather than filled with the catalogue's
 * placeholders. That fallback used to live here, and it was the wrong side of
 * the line: a placeholder is a guess about an endpoint nobody asked, and a
 * reader that cannot tell it from an answer can only show it as one. The picker
 * that has to show something before the first fetch reaches for the same names
 * through `modelChoicesFor`, where it can say which of the two it is showing.
 *
 * A list stored before the catalogue was keyed by provider was a flat array, and
 * it was DeepSeek's.
 */
function readAvailableModels(raw: unknown): AvailableModels {
  const byProvider = asRecord(raw);
  const legacyDeepSeek = Array.isArray(raw) ? raw : undefined;
  const stored: AvailableModels = {};
  for (const id of providerIdSchema.options) {
    const list = storedModelList(
      byProvider[id] ?? (id === 'deepseek' ? legacyDeepSeek : undefined),
    );
    if (list !== undefined) {
      stored[id] = list;
    }
  }
  return stored;
}

/** The names a stored value holds, or `undefined` when it holds no answer. */
function storedModelList(value: unknown): string[] | undefined {
  const list = Array.isArray(value)
    ? value.filter(
        (entry): entry is string =>
          typeof entry === 'string' && entry.length > 0,
      )
    : [];
  return list.length > 0 ? list : undefined;
}

/**
 * Applies a provider patch over what is stored.
 *
 * Each named provider is merged into its own config, so a patch that changes only
 * the active provider leaves the other addresses exactly as they were.
 */
export function mergeProviders(
  current: Providers,
  patch: ProvidersPatch,
): Providers {
  const configs = {...current.configs};
  for (const id of providerIdSchema.options) {
    const next = patch.configs?.[id];
    if (next) {
      configs[id] = {...configs[id], ...definedOnly(next)};
    }
  }
  return {active: patch.active ?? current.active, configs};
}
