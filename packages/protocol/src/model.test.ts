/**
 * The settings blocks that decide what answers, and the one that decides how.
 *
 * The store that reads and writes a settings file is tested in `@marimo/runtime`;
 * what is asserted here is the shape a window and a first run agree about: a
 * local model assignment per task, the companion block, and the recall block
 * that was already here. A fixture built by hand would be a
 * second copy of the schema and would break every time a field was added
 * somewhere else, so each block is tested on its own over the defaults the app
 * ships.
 */
import {describe, expect, it} from 'vitest';

import {
  DEFAULT_MEMORY_REVIEW_EVENTS,
  DEFAULT_MEMORY_SOFT_LIMIT_BYTES,
  defaultAppearance,
  defaultCompanionSettings,
  defaultDiscordSettings,
  defaultLocalModelsSettings,
  defaultRecallSettings,
  defaultWindowState,
  LOCAL_TASKS,
  localModelsSettingsSchema,
  recallSettingsSchema,
  settingsPatchSchema,
  settingsSchema,
} from './index.js';

/**
 * The local models block, and the rule that makes a hand-edited file safe.
 *
 * A task is a capability, not a name. The refinement is what refuses a file that
 * names the audio model for Chat at the door, rather than producing a turn whose
 * prompt is wrong for the weights — a failure that would otherwise arrive as a
 * bad answer, which is much harder to explain.
 */
describe('the local models in a settings file', () => {
  it('is a block of the settings document, not a separate store', () => {
    expect(settingsSchema.shape.localModels).toBeDefined();
  });

  it('starts a fresh install on the vision model for both tasks', () => {
    const parsed = settingsSchema.safeParse(settingsShape());
    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      return;
    }
    expect(parsed.data.localModels).toEqual(defaultLocalModelsSettings());
    expect(parsed.data.localModels.tasks).toEqual({
      chat: 'qwen2.5-vl-7b',
      vision: 'qwen2.5-vl-7b',
    });
    expect(parsed.data.localModels.idleMinutes).toBe(3);
  });

  it('refuses a model that cannot do the task it was assigned', () => {
    const parsed = localModelsSettingsSchema.safeParse({
      tasks: {
        chat: 'lfm3-1.7b',
        vision: 'lfm3-1.7b',
      },
      idleMinutes: 3,
    });
    expect(parsed.success).toBe(false);
  });

  it('accepts the vision model for both tasks it can do', () => {
    const parsed = localModelsSettingsSchema.safeParse({
      tasks: {
        chat: 'qwen2.5-vl-7b',
        vision: 'qwen2.5-vl-7b',
      },
      idleMinutes: 10,
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts a patch that moves one task and leaves the other out', () => {
    const parsed = settingsPatchSchema.safeParse({
      localModels: {tasks: {chat: 'qwen2.5-vl-7b'}},
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.localModels).toEqual({
      tasks: {chat: 'qwen2.5-vl-7b'},
    });
  });

  it('refuses a patch that names a model this build does not ship', () => {
    expect(
      settingsPatchSchema.safeParse({
        localModels: {tasks: {chat: 'lfm3-9b'}},
      }).success,
    ).toBe(false);
  });

  it('covers every task the app can route', () => {
    const defaults = defaultLocalModelsSettings();
    expect(Object.keys(defaults.tasks).sort()).toEqual([...LOCAL_TASKS].sort());
  });
});

/**
 * The companion keeps its answer length and layout; speech is not part of this
 * build, so an old key is stripped rather than refused.
 */
describe('the companion settings', () => {
  it('have no speech fields any more', () => {
    const companion = defaultCompanionSettings();
    expect(companion.answerLength).toBe('brief');
    expect(companion).not.toHaveProperty('speakReplies');
    expect(companion).not.toHaveProperty('speechVoice');
  });

  it('accept a patch touching one field', () => {
    const parsed = settingsPatchSchema.safeParse({
      companion: {answerLength: 'detailed'},
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.companion).toEqual({
      answerLength: 'detailed',
    });
  });

  it('refuse an answer length the schema does not know', () => {
    expect(
      settingsPatchSchema.safeParse({
        companion: {answerLength: 'essay'},
      }).success,
    ).toBe(false);
  });
});

/**
 * The recall block, and the default that downloads nothing.
 *
 * Unchanged by the local-model change except for the settings document it lives
 * in; the tests stay because the default is the promise that a fresh install
 * makes no download it was not asked for.
 */
describe('the recall settings', () => {
  it('is off, with both corpora ready for when it is on', () => {
    expect(defaultRecallSettings()).toEqual({
      enabled: false,
      memory: true,
      workspace: true,
      conversations: true,
      media: false,
      codeQueries: false,
      introSeen: false,
    });
  });

  it('is part of the settings document', () => {
    expect(settingsSchema.shape.recall).toBeDefined();
    expect(
      settingsSchema.safeParse({...settingsShape(), recall: undefined}).success,
    ).toBe(false);
  });

  it('accepts a patch touching one switch of the block', () => {
    const parsed = settingsPatchSchema.safeParse({recall: {enabled: true}});

    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.recall).toEqual({enabled: true});
  });

  it('refuses a block whose switches are not switches', () => {
    expect(
      recallSettingsSchema.safeParse({
        enabled: 'yes',
        memory: true,
        workspace: true,
      }).success,
    ).toBe(false);
  });
});

/**
 * What a settings file from the provider build looks like after this one reads
 * it: the provider block is gone, and the model choices have defaults.
 *
 * The runtime store is what actually drops the old fields on the next write; the
 * schema test is here because the schema is the half a window sees.
 */
describe('a settings file from the old build', () => {
  it('ignores a provider block and fills the local models', () => {
    const parsed = settingsSchema.safeParse({
      ...settingsShape(),
      providers: {
        active: 'deepseek',
        configs: {
          deepseek: {
            baseUrl: 'https://api.deepseek.com',
            model: 'deepseek-flash',
            keyStorage: 'keychain',
          },
        },
      },
      availableModels: {deepseek: ['deepseek-flash']},
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      return;
    }
    expect('providers' in parsed.data).toBe(false);
    expect(parsed.data.localModels).toEqual(defaultLocalModelsSettings());
  });
});

function settingsShape(): Record<string, unknown> {
  return {
    appearance: defaultAppearance(),
    localModels: defaultLocalModelsSettings(),
    allowPrivateNetworkFetch: false,
    mcpServers: [],
    discord: defaultDiscordSettings(),
    companion: defaultCompanionSettings(),
    sidebarWidth: 272,
    todosWidth: 288,
    jobsWidth: 288,
    notesWidth: 288,
    filesWidth: 320,
    documentsWidth: 420,
    documentsLibraryShare: 0.34,
    filesOpen: false,
    expandedSections: [],
    disabledCommands: [],
    window: defaultWindowState(),
    memorySoftLimitBytes: DEFAULT_MEMORY_SOFT_LIMIT_BYTES,
    memoryReviewEvents: DEFAULT_MEMORY_REVIEW_EVENTS,
    recall: defaultRecallSettings(),
  };
}
