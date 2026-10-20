/**
 * The tier vocabulary, and the two rules that matter about it.
 *
 * `auto` is a real answer rather than a placeholder: it means the app probes the
 * graphics card and picks. That distinction is the whole reason the type has three
 * members instead of two, and it is the thing a later change is most likely to
 * flatten — a `low`/`high` pair with a nullable default would lose the difference
 * between "the user chose the small one" and "the app decided the small one was all
 * this machine could take", which are different sentences to show somebody.
 *
 * The field is tested on its own rather than through a whole settings document.
 * A fixture built by hand would be a second copy of the schema, and it would fail
 * every time a field was added somewhere else — which is a test that reports the
 * wrong thing.
 */
import {describe, expect, it} from 'vitest';

import {
  DEFAULT_MEMORY_SOFT_LIMIT_BYTES,
  DEFAULT_MEMORY_REVIEW_EVENTS,
  defaultAppearance,
  defaultCompanionSettings,
  defaultDiscordSettings,
  defaultProviders,
  defaultRecallSettings,
  defaultWindowState,
  PROVIDER_IDS,
  recallSettingsSchema,
  settingsPatchSchema,
  settingsSchema,
} from './index.js';

/**
 * The provider block, and the two facts about it that a settings file can get
 * wrong.
 *
 * Which service answers is a preference, so it lives in the settings document
 * with the other preferences — and it is a *block* rather than a field, because
 * every provider keeps its own address and model so that switching away and back
 * does not cost the user what they typed.
 *
 * Asserted here rather than through a whole settings fixture, for the reason the
 * recall block is: a fixture built by hand is a second copy of the schema, and it
 * breaks every time a field is added somewhere else.
 */
describe('the providers in a settings file', () => {
  it('is a block of the settings document, not a separate store', () => {
    expect(settingsSchema.shape.providers).toBeDefined();
  });

  /*
   * The default is a real provider rather than a placeholder: the app runs no
   * backend of its own any more, so a fresh install has to be pointed at
   * something, and DeepSeek is the one whose catalogue entry a first run explains
   * in a sentence. The alternative — a default that refused the first question —
   * would be the app asking a stranger to configure it before it said anything.
   */
  it('points a fresh install at one provider that can actually answer', () => {
    const parsed = settingsSchema.safeParse(settingsShape());
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.providers.active).toBe('deepseek');
  });

  it('keeps an address and a model for every provider it knows', () => {
    const parsed = settingsSchema.safeParse(settingsShape());
    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      return;
    }
    // Every id the enum names, so switching provider is never an unset field.
    expect(Object.keys(parsed.data.providers.configs).sort()).toEqual(
      [...PROVIDER_IDS].sort(),
    );
    for (const id of PROVIDER_IDS) {
      expect(parsed.data.providers.configs[id].baseUrl.length).toBeGreaterThan(0);
      expect(parsed.data.providers.configs[id].model.length).toBeGreaterThan(0);
    }
  });

  /*
   * A block whose one entry is malformed costs the block, not the document —
   * which is the settings store's job rather than this schema's, and is asserted
   * where that store is tested. What this pins is the shape the store fills.
   */
  it('refuses a provider this build has never heard of', () => {
    const providers = defaultProviders();
    const parsed = settingsSchema.safeParse({
      ...settingsShape(),
      providers: {...providers, active: 'someones_own_server'},
    });
    expect(parsed.success).toBe(false);
  });

  it('accepts a patch that names one provider and leaves the rest out', () => {
    const parsed = settingsPatchSchema.safeParse({
      providers: {configs: {deepseek: {model: 'deepseek-v4-pro'}}},
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.providers?.configs).toEqual({
      deepseek: {model: 'deepseek-v4-pro'},
    });
  });

  it('refuses a patch that invents a provider', () => {
    expect(
      settingsPatchSchema.safeParse({providers: {active: 'someone_elses'}}).success,
    ).toBe(false);
  });
});

/**
 * The recall block, and the default that downloads nothing.
 *
 * Recall is off until somebody asks for it: turning it on fetches 310 MB and
 * starts a second engine process, and a fresh install that did that unasked would
 * be the same failure Discord's default exists to prevent. So the default is
 * asserted rather than left to a `false` in whichever file builds it first.
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
    expect(settingsSchema.safeParse({...settingsShape(), recall: undefined}).success).toBe(
      false,
    );
  });

  /*
   * A window that moved one switch must not have to send the other two back: a
   * stale copy of them is exactly what must not win, which is why this is a
   * partial block merged over what is stored.
   */
  it('accepts a patch touching one switch of the block', () => {
    const parsed = settingsPatchSchema.safeParse({recall: {enabled: true}});

    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.recall).toEqual({enabled: true});
  });

  it('refuses a block whose switches are not switches', () => {
    expect(
      recallSettingsSchema.safeParse({enabled: 'yes', memory: true, workspace: true})
        .success,
    ).toBe(false);
  });
});

function settingsShape(): Record<string, unknown> {
  return {
    appearance: defaultAppearance(),
    providers: defaultProviders(),
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
    filesOpen: false,
    expandedSections: [],
    disabledCommands: [],
    window: defaultWindowState(),
    memorySoftLimitBytes: DEFAULT_MEMORY_SOFT_LIMIT_BYTES,
    memoryReviewEvents: DEFAULT_MEMORY_REVIEW_EVENTS,
    recall: defaultRecallSettings(),
  };
}
