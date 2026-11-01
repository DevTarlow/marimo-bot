/**
 * Settings persistence.
 *
 * Settings are non-secret, so they live in a plain JSON file that a user can
 * read and edit. Reads are forgiving: an unknown or malformed field falls back
 * to its default instead of discarding every other setting.
 *
 * Every value here is now a preference: the local model tasks, the idle
 * timeout, the companion's speech settings, the layout and the escape hatches.
 * What is installed and which quantization it is are facts about the disk and
 * live beside the weights; a settings file that claimed them would be a card
 * offering a model nobody downloaded.
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
  defaultLocalModelsSettings,
  defaultRecallSettings,
  defaultCompanionSettings,
  DEFAULT_MEMORY_REVIEW_EVENTS,
  DEFAULT_MEMORY_SOFT_LIMIT_BYTES,
  defaultWindowState,
  defaultDiscordSettings,
  discordSettingsSchema,
  localModelsSettingsSchema,
  recallSettingsSchema,
  settingsPatchSchema,
  settingsSchema,
  windowStateSchema,
} from '@marimo/protocol';
import type {
  LocalModelsPatch,
  LocalModelsSettings,
  SettingsPatch,
  StoredSettings,
} from '@marimo/protocol';

export function defaultStoredSettings(): StoredSettings {
  return {
    /*
     * Which local model does Chat, Images and Voice, and how long it stays
     * warm. The defaults are the dedicated models rather than the all-in-one:
     * a first run should get the best text answer this family offers, and the
     * "one model for everything" preset is a choice somebody makes once they
     * know the machine.
     */
    localModels: defaultLocalModelsSettings(),
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
        await this.write(upgraded.data);
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
           * The local model block, filled over its defaults the same way. A
           * hand-edited task assignment that names a model this build does not
           * ship costs the block, not the rest of the document, and a file from
           * the provider build has no block at all, so it gets the defaults.
           */
          localModels: fillBlock(
            localModelsSettingsSchema,
            defaults.localModels,
            rawObject['localModels'],
          ),
        }
      : raw;

    const partial = settingsPatchSchema.safeParse(filled ?? {});
    const candidate: Record<string, unknown> = partial.success
      ? {...defaults, ...definedOnly(partial.data)}
      : {...defaults};

    const result = settingsSchema.safeParse(candidate);
    this.cache = result.success ? result.data : defaults;
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
       * The local model block is merged one task at a time, not one block at a
       * time. Moving Chat must not send the other two assignments back from a
       * window whose copy predates a change made in another one.
       */
      const localModels = defined.localModels
        ? mergeLocalModels(current.localModels, defined.localModels)
        : current.localModels;
      const merged = settingsSchema.parse({
        ...current,
        ...defined,
        discord,
        companion,
        appearance,
        recall,
        localModels,
      });
      await this.write(merged);
      this.cache = merged;
      return merged;
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

/**
 * Applies a local-model patch over what is stored.
 *
 * The three task assignments are merged one at a time, so moving Chat leaves
 * Vision and Voice exactly as another window last wrote them. `idleMinutes` is a
 * single number and is simply replaced when present. The capability validation
 * happens on the merged block in `settingsSchema.parse`, not here: a patch naming
 * one task is not asked to prove the other two.
 */
export function mergeLocalModels(
  current: LocalModelsSettings,
  patch: LocalModelsPatch,
): LocalModelsSettings {
  return {
    tasks: {
      ...current.tasks,
      ...(patch.tasks === undefined ? {} : definedOnly(patch.tasks)),
    },
    idleMinutes: patch.idleMinutes ?? current.idleMinutes,
  };
}
