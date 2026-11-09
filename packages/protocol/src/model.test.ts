/**
 * The settings blocks that decide what answers, and the one that decides how.
 *
 * The store that reads and writes a settings file is tested in `@marimo/runtime`;
 * what is asserted here is the shape a window and a first run agree about: the
 * model server block, the companion block, and the recall block that was already
 * here. A fixture built by hand would be a second copy of the schema and would
 * break every time a field was added somewhere else, so each block is tested on
 * its own over the defaults the app ships.
 */
import {describe, expect, it} from 'vitest';

import {
  DEFAULT_MEMORY_REVIEW_EVENTS,
  DEFAULT_MEMORY_SOFT_LIMIT_BYTES,
  defaultAppearance,
  defaultCompanionSettings,
  defaultDiscordSettings,
  DEFAULT_MODEL_SERVER_URL,
  defaultModelServerSettings,
  defaultRecallSettings,
  defaultWindowState,
  recallSettingsSchema,
  settingsPatchSchema,
  settingsSchema,
} from './index.js';

/**
 * The model server block, and the rule that makes a hand-edited file safe.
 *
 * The address is the one place a conversation is sent, so the schema refuses
 * anything that is not loopback. The URL rules themselves are tested in
 * `model-server.test.ts`; what is asserted here is that the block is part of the
 * settings document and that a patch can move one field without the others.
 */
describe('the model server in a settings file', () => {
  it('is a block of the settings document, not a separate store', () => {
    expect(settingsSchema.shape.modelServer).toBeDefined();
  });

  it('starts a fresh install on llama.cpp’s own address', () => {
    const parsed = settingsSchema.safeParse(settingsShape());
    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      return;
    }
    expect(parsed.data.modelServer).toEqual(defaultModelServerSettings());
    expect(parsed.data.modelServer.url).toBe(DEFAULT_MODEL_SERVER_URL);
    // Blank means "the model the server reports", not a name the app invented.
    expect(parsed.data.modelServer.model).toBe('');
    expect(parsed.data.modelServer.contextTokens).toBe(32_768);
  });

  it('accepts a patch that sets the address and leaves the model out', () => {
    const parsed = settingsPatchSchema.safeParse({
      modelServer: {url: 'http://localhost:8080/v1'},
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.modelServer).toEqual({
      url: 'http://localhost:8080/v1',
    });
  });

  it('refuses a patch that points off this computer', () => {
    expect(
      settingsPatchSchema.safeParse({
        modelServer: {url: 'https://api.example.com/v1'},
      }).success,
    ).toBe(false);
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
  it('ignores a provider block and fills the model server', () => {
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
    expect(parsed.data.modelServer).toEqual(defaultModelServerSettings());
  });
});

function settingsShape(): Record<string, unknown> {
  return {
    appearance: defaultAppearance(),
    modelServer: defaultModelServerSettings(),
    allowPrivateNetworkFetch: false,
    mcpServers: [],
    discord: defaultDiscordSettings(),
    companion: defaultCompanionSettings(),
    sidebarWidth: 272,
    todosWidth: 288,
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
