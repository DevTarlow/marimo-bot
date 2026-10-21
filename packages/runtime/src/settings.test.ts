/**
 * Settings persistence, and the one thing it has to be lenient about.
 *
 * The file is hand-editable and has changed shape several times — most recently
 * when the app's bundled model became a provider the user chooses, which put a
 * block of five entries where one flat address and model used to be. A field this
 * build no longer knows must cost its own value and nothing else, because a
 * settings file that fails to parse is every preference the user has, reset at
 * once.
 */
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';

import {afterEach, beforeEach, describe, expect, it} from 'vitest';

import {
  defaultProviders,
  DEFAULT_MEMORY_SOFT_LIMIT_BYTES,
  MEMORY_SOFT_LIMIT_MAX_BYTES,
} from '@marimo/protocol';

import {MAX_MEMORY_BYTES} from '@marimo/agent';

import {chooseModel, readLegacyProfileSeed, SettingsStore} from './settings.js';

describe('readLegacyProfileSeed', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(process.cwd(), '.marimo-settings-'));
  });

  afterEach(async () => {
    await rm(dir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 20,
    });
  });

  it('keeps the workspace and prompt a pre-profile file held', async () => {
    const file = join(dir, 'settings.json');
    await writeFile(
      file,
      JSON.stringify({
        model: 'deepseek-flash',
        workspaceRoot: '/home/me/project',
        systemPrompt: 'You are the old prompt.',
      }),
      'utf8',
    );
    expect(await readLegacyProfileSeed(file)).toEqual({
      workspaceRoot: '/home/me/project',
      systemPrompt: 'You are the old prompt.',
    });
  });

  it('ignores a new-format file and a file that is not there', async () => {
    const file = join(dir, 'settings.json');
    await writeFile(file, JSON.stringify({model: 'deepseek-flash'}), 'utf8');
    expect(await readLegacyProfileSeed(file)).toEqual({});
    expect(await readLegacyProfileSeed(join(dir, 'missing.json'))).toEqual({});
  });

  it('ignores blank or wrong-typed values', async () => {
    const file = join(dir, 'settings.json');
    await writeFile(
      file,
      JSON.stringify({workspaceRoot: '   ', systemPrompt: 42}),
      'utf8',
    );
    // A blank prompt must not win over the default identity.
    expect(await readLegacyProfileSeed(file)).toEqual({});
  });
});

/**
 * The settings file, and the one nested object in it.
 *
 * Discord is a block inside a flat document, which is exactly the shape that
 * breaks an upgrade if it is read carelessly: a file written before the block
 * existed, or one a user edited by hand, must not cost them the model they
 * chose and the folders they sized.
 */
describe('SettingsStore', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(process.cwd(), '.marimo-settings-store-'));
  });

  afterEach(async () => {
    await rm(dir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 20,
    });
  });

  function store(): SettingsStore {
    return new SettingsStore(join(dir, 'settings.json'));
  }

  async function write(raw: unknown): Promise<void> {
    await writeFile(
      join(dir, 'settings.json'),
      JSON.stringify(raw, null, 2),
      'utf8',
    );
  }

  it('starts with Discord off and nothing configured', async () => {
    const settings = await store().load();
    expect(settings.discord).toEqual({
      enabled: false,
      channelId: '',
      channelName: '',
      guildName: '',
      autoReply: true,
      botUserId: '',
      botName: '',
    });
  });

  it('reads a file written before Discord existed', async () => {
    await write({notesWidth: 260, sidebarWidth: 320});
    const settings = await store().load();

    // The old settings survive, and the block arrives at its defaults.
    expect(settings.notesWidth).toBe(260);
    expect(settings.sidebarWidth).toBe(320);
    expect(settings.discord.enabled).toBe(false);
  });

  it('remembers the Documents drawer width with the rest of the layout', async () => {
    await store().patch({documentsWidth: 360});

    expect((await store().load()).documentsWidth).toBe(360);
  });

  /*
   * The split is a share rather than a height, so what comes back is the
   * fraction the drag settled on — not a measurement of one window that would
   * be the wrong size in the next.
   */
  it('remembers how much of the drawer the file list keeps', async () => {
    await store().patch({documentsLibraryShare: 0.5});

    expect((await store().load()).documentsLibraryShare).toBe(0.5);
  });

  it('falls back on a block that does not validate, keeping the rest', async () => {
    await write({
      notesWidth: 260,
      discord: {enabled: true, channelId: 42},
    });
    const settings = await store().load();

    expect(settings.notesWidth).toBe(260);
    expect(settings.discord.channelId).toBe('');
  });

  it('fills in a short block rather than discarding it', async () => {
    await write({discord: {enabled: true, channelId: '100'}});
    const settings = await store().load();

    expect(settings.discord.enabled).toBe(true);
    expect(settings.discord.channelId).toBe('100');
    // Fields the file never mentioned keep their defaults.
    expect(settings.discord.autoReply).toBe(true);
  });

  it('merges a partial Discord patch over what is stored', async () => {
    const settings = store();
    await settings.patch({
      discord: {
        channelId: '100',
        channelName: 'general',
        guildName: 'Marimo Bot HQ',
      },
    });
    const after = await settings.patch({discord: {enabled: true}});

    // Flipping one switch must not send the channel back, and must not lose it.
    expect(after.discord).toMatchObject({
      enabled: true,
      channelId: '100',
      channelName: 'general',
      guildName: 'Marimo Bot HQ',
    });
  });

  it('leaves Discord alone when a flat setting changes', async () => {
    const settings = store();
    await settings.patch({discord: {channelId: '100', enabled: true}});
    const after = await settings.patch({notesWidth: 260});

    expect(after.notesWidth).toBe(260);
    expect(after.discord.enabled).toBe(true);
    expect(after.discord.channelId).toBe('100');
  });
});

/**
 * A settings file written by a build from the provider era.
 *
 * It holds a `providers` block naming a service this build has never heard of —
 * the engine the app used to bundle, which was a provider for one release — and
 * it may hold a top-level `model` and `baseUrl` from before even that, which were
 * DeepSeek's because DeepSeek was the only provider then.
 *
 * That file is the common upgrade case rather than an exotic one, so the block is
 * *adopted*: the flat pair fills DeepSeek's entry, an id this build does not know
 * is dropped as an entry rather than as the block, and every other preference in
 * the same document comes through untouched. A read that failed on a field it did
 * not recognise would reset all of them at once, and the user would have no idea
 * which line did it.
 */
describe('SettingsStore, on a file from the provider era', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(process.cwd(), '.marimo-provider-era-'));
  });

  afterEach(async () => {
    await rm(dir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 20,
    });
  });

  function store(): SettingsStore {
    return new SettingsStore(join(dir, 'settings.json'));
  }

  async function write(raw: unknown): Promise<void> {
    await writeFile(
      join(dir, 'settings.json'),
      JSON.stringify(raw, null, 2),
      'utf8',
    );
  }

  /** What such a file looked like: the bundled engine, DeepSeek, and the knobs. */
  function providerEraFile(): Record<string, unknown> {
    return {
      version: 1,
      providers: {
        // The app's own model, which was a provider for exactly one build.
        active: 'builtin',
        configs: {
          builtin: {baseUrl: 'http://127.0.0.1:8137/v1', model: 'qwen3-1.7b'},
          deepseek: {
            baseUrl: 'https://api.deepseek.com',
            model: 'deepseek-v4-pro',
          },
        },
      },
      availableModels: {
        builtin: ['qwen3-1.7b'],
        deepseek: ['deepseek-flash', 'deepseek-v4-pro'],
      },
      localModel: {
        ggufPath: '/home/sam/other.gguf',
        contextSize: 32768,
        thinking: true,
      },
      allowPlaintextApiKey: true,
      notesWidth: 260,
      sidebarWidth: 320,
      disabledCommands: ['compact'],
    };
  }

  it('adopts the block, dropping only the provider it does not know', async () => {
    await write(providerEraFile());
    const settings = await store().load();

    /*
     * The pick was the engine, which no longer exists, so it falls to the
     * catalogue's default — a provider this build can actually reach rather than
     * a name it would have to refuse.
     */
    expect(settings.providers.active).toBe('deepseek');
    expect(settings.providers.configs.deepseek).toEqual({
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-v4-pro',
      // The file predates the field. Keychain is the answer that keeps a key
      // already stored encrypted, and a machine without one refuses rather than
      // writing it readable.
      keyStorage: 'keychain',
    });
    // The id is dropped as an entry, and the block it sits in comes through.
    expect(settings.providers.configs).not.toHaveProperty('builtin');
    expect(settings.providers.configs.gemini).toEqual(
      defaultProviders().configs.gemini,
    );

    // The fetched list travels the same way: DeepSeek's is what the file stored,
    // the list belonging to the engine is gone, and every provider the file never
    // mentioned is *absent* rather than filled in with the catalogue's names —
    // see `readAvailableModels`, and the picker that supplies those names where
    // it can also say nobody has asked.
    expect(settings.availableModels.deepseek).toEqual([
      'deepseek-flash',
      'deepseek-v4-pro',
    ]);
    expect(Object.keys(settings.availableModels)).toEqual(['deepseek']);

    // The engine's own knobs have no reader now — the tier plan and the global
    // plaintext opt-in went with the engine — and they are the only part that is
    // dropped outright.
    expect(settings).not.toHaveProperty('localModel');
    expect(settings).not.toHaveProperty('allowPlaintextApiKey');

    expect(settings.notesWidth).toBe(260);
    expect(settings.sidebarWidth).toBe(320);
    expect(settings.disabledCommands).toEqual(['compact']);
  });

  it('writes the adopted block back rather than the fields it replaced', async () => {
    await write(providerEraFile());
    const settings = store();
    await settings.load();
    await settings.patch({notesWidth: 260});

    const written = JSON.parse(
      await readFile(join(dir, 'settings.json'), 'utf8'),
    ) as Record<string, unknown>;
    const providers = written['providers'] as {
      active: string;
      configs: Record<string, unknown>;
    };

    expect(written['notesWidth']).toBe(260);
    expect(providers.active).toBe('deepseek');
    expect(providers.configs['deepseek']).toMatchObject({
      model: 'deepseek-v4-pro',
    });
    // Neither the engine's knobs nor the id it was reached by come back.
    expect(written).not.toHaveProperty('localModel');
    expect(written).not.toHaveProperty('allowPlaintextApiKey');
    expect(providers.configs['builtin']).toBeUndefined();
  });

  /*
   * The two flat fields predate the picker, and they were DeepSeek's: it was the
   * only provider when they were written. Their presence is also what says the
   * file was *pointed* at DeepSeek — so an upgrade keeps the address and the
   * model the user had, rather than landing on the catalogue's default for a
   * config nothing selects.
   */
  it('adopts the flat model and base URL into DeepSeek', async () => {
    await write({
      model: 'deepseek-v4-pro',
      baseUrl: 'https://api.deepseek.com/v2',
      notesWidth: 260,
    });
    const settings = await store().load();

    expect(settings.providers.active).toBe('deepseek');
    expect(settings.providers.configs.deepseek).toEqual({
      baseUrl: 'https://api.deepseek.com/v2',
      model: 'deepseek-v4-pro',
      keyStorage: 'keychain',
    });
    // And nothing else moved with them: a flat field could only ever have been
    // DeepSeek's, so the other entries keep the catalogue's addresses.
    expect(settings.providers.configs.gemini).toEqual(
      defaultProviders().configs.gemini,
    );
    expect(settings).not.toHaveProperty('model');
    expect(settings).not.toHaveProperty('baseUrl');
    expect(settings.notesWidth).toBe(260);
  });
});

/**
 * The provider block: which service answers, and what each one was last set to.
 *
 * It is the block an upgrade is most likely to get wrong. A file written before
 * the catalogue existed has no `providers` at all, and one hand-edited since can
 * have a typo in exactly one of its five entries — and either has to cost its own
 * value rather than the document, because the document beside it holds every
 * other preference the user has.
 */
describe('SettingsStore providers', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(process.cwd(), '.marimo-providers-'));
  });

  afterEach(async () => {
    await rm(dir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 20,
    });
  });

  function store(): SettingsStore {
    return new SettingsStore(join(dir, 'settings.json'));
  }

  async function write(raw: unknown): Promise<void> {
    await writeFile(
      join(dir, 'settings.json'),
      JSON.stringify(raw, null, 2),
      'utf8',
    );
  }

  /*
   * Every provider has to be reachable and describable before anything has been
   * fetched or typed, or the first thing a fresh install shows is an empty
   * picker — which reads as "the app has no models" rather than as an unset
   * field.
   *
   * What it does *not* have is a model list: an endpoint nobody has asked has
   * said nothing, and the catalogue's names are a placeholder the renderer draws
   * where it can also say so. A store that filled them in here could not tell the
   * window which of the two it was handing back.
   */
  it('points a fresh install at the catalogue defaults, with nothing fetched', async () => {
    const settings = await store().load();

    expect(settings.providers).toEqual(defaultProviders());
    expect(settings.availableModels).toEqual({});
  });

  /*
   * The merge is per provider, not per block, and that is the whole point of the
   * block's patch shape: a window holding a copy of the other four addresses from
   * before somebody's edit must not send them back, or the user's own server
   * address quietly reverts to the catalogue's.
   */
  it('merges a patch into the provider it names and leaves the others alone', async () => {
    const settings = store();
    const before = await settings.load();

    const after = await settings.patch({
      providers: {
        configs: {gemini: {baseUrl: 'https://gemini.example.test/v1'}},
      },
    });

    expect(after.providers.configs.gemini.baseUrl).toBe(
      'https://gemini.example.test/v1',
    );
    // The fields the patch did not mention keep their values, and so does every
    // provider it did not name — including the active pick.
    expect(after.providers.configs.gemini.model).toBe(
      before.providers.configs.gemini.model,
    );
    expect(after.providers.configs.gemini.keyStorage).toBe(
      before.providers.configs.gemini.keyStorage,
    );
    expect(after.providers.configs.deepseek).toEqual(
      before.providers.configs.deepseek,
    );
    expect(after.providers.active).toBe(before.providers.active);
  });

  /*
   * One bad entry, and the entry is all it costs. The block is filled a provider
   * at a time rather than whole, so a mistyped Gemini address cannot take the
   * provider the user was actually using, the active pick, or the layout beside
   * them — which is what a single failed parse would have done.
   */
  it('costs one hand-edited provider rather than the document', async () => {
    await write({
      providers: {
        active: 'gemini',
        configs: {
          deepseek: {
            baseUrl: 'https://mine.example.test/v1',
            model: 'deepseek-v4-pro',
            keyStorage: 'plaintext',
          },
          // The address is a number and the storage word is not one this build
          // knows, so this entry is not half-usable: it is replaced whole.
          gemini: {baseUrl: 42, model: '', keyStorage: 'clear'},
        },
      },
      sidebarWidth: 320,
    });
    const settings = await store().load();

    expect(settings.providers.configs.gemini).toEqual(
      defaultProviders().configs.gemini,
    );
    expect(settings.providers.configs.deepseek).toEqual({
      baseUrl: 'https://mine.example.test/v1',
      model: 'deepseek-v4-pro',
      keyStorage: 'plaintext',
    });
    expect(settings.providers.active).toBe('gemini');
    expect(settings.sidebarWidth).toBe(320);
  });

  /*
   * A list a provider reported is a *fact*, kept beside the preferences and
   * written only by the call that fetched it. The provider's own default has to
   * move with it: a model the endpoint has retired would fail the next turn for a
   * reason nobody could see.
   */
  it('replaces a provider’s list and moves its default off a retired name', async () => {
    const settings = store();
    const before = await settings.load();
    expect(before.providers.configs.deepseek.model).toBe('deepseek-flash');

    const after = await settings.setAvailableModels('deepseek', [
      'deepseek-v4-pro',
      'deepseek-v4-pro',
      '',
    ]);

    expect(after.availableModels.deepseek).toEqual(['deepseek-v4-pro']);
    expect(after.providers.configs.deepseek.model).toBe('deepseek-v4-pro');
    /*
     * And nothing else moved. Each list is an answer about one endpoint, so a
     * store that rewrote its neighbours would be inventing answers about services
     * it never asked.
     */
    expect(after.availableModels.gemini).toBeUndefined();
    expect(after.providers.configs.gemini).toEqual(
      before.providers.configs.gemini,
    );
  });

  /*
   * The lists are per provider, and one fetch must not cost another's.
   *
   * The window used to be handed the active provider's list alone, so this is
   * the half that has to hold for every *other* provider to have anything to
   * show: an agent pinned to Gemini keeps Gemini's names when the app goes and
   * re-asks DeepSeek, and neither fetch touches the third provider nobody has
   * asked at all.
   */
  it('keeps the other providers’ lists when one of them is fetched again', async () => {
    const settings = store();
    await settings.setAvailableModels('gemini', ['gemini-3.6-flash']);
    await settings.setAvailableModels('deepseek', ['deepseek-v4-pro']);

    const after = await settings.setAvailableModels('deepseek', [
      'deepseek-v4-pro',
      'deepseek-v5',
    ]);

    expect(after.availableModels.deepseek).toEqual([
      'deepseek-v4-pro',
      'deepseek-v5',
    ]);
    expect(after.availableModels.gemini).toEqual(['gemini-3.6-flash']);
    expect(after.providers.configs.gemini.model).toBe('gemini-3.6-flash');
    // Never asked, so never answered: the window tells the two apart, and a
    // placeholder written here would erase the difference.
    expect(after.availableModels.llamacpp).toBeUndefined();
  });

  /*
   * An empty answer is not an answer. `providers.fetch` refuses to store one —
   * there is nothing to choose from in it — and a file that somehow holds one
   * reads as "never asked" rather than as a provider with no models, which is a
   * list a picker could not draw anything from.
   */
  it('reads an empty stored list as one nobody has filled in', async () => {
    await write({
      availableModels: {deepseek: [], gemini: ['gemini-3.6-flash']},
    });
    const settings = await store().load();

    expect(settings.availableModels.deepseek).toBeUndefined();
    expect(settings.availableModels.gemini).toEqual(['gemini-3.6-flash']);
  });
});

/*
 * What a provider's default model becomes when the endpoint stops serving the
 * stored name, which is the one decision `setAvailableModels` delegates.
 *
 * The cheap tier is the least surprising landing place: a provider that dropped
 * its flagship must not silently move somebody onto its most expensive model, and
 * a list with nothing that reads as small still has to answer with something.
 */
describe('chooseModel', () => {
  it('keeps a model that still exists', () => {
    expect(
      chooseModel(['deepseek-flash', 'deepseek-v4-pro'], 'deepseek-v4-pro'),
    ).toBe('deepseek-v4-pro');
  });

  it('picks a fast tier when the stored name has gone', () => {
    expect(
      chooseModel(['deepseek-v4-pro', 'deepseek-flash'], 'deepseek-v3'),
    ).toBe('deepseek-flash');
    // Nothing in the list reads as fast, and the first entry is a better answer
    // than an empty picker.
    expect(chooseModel(['deepseek-v4-pro'], 'deepseek-v3')).toBe(
      'deepseek-v4-pro',
    );
  });
});

/**
 * The memory soft limit, which the Settings dialog draws as a slider.
 *
 * The schema is a client of it too — the renderer's slider can only produce
 * values the schema accepts — so the bounds are what stops a hand-edited file
 * from setting a limit that makes the agent's warning nonsense.
 */
describe('SettingsStore memorySoftLimitBytes', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(process.cwd(), '.marimo-memlimit-'));
  });

  afterEach(async () => {
    await rm(dir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 20,
    });
  });

  function store(): SettingsStore {
    return new SettingsStore(join(dir, 'settings.json'));
  }

  async function write(raw: unknown): Promise<void> {
    await writeFile(
      join(dir, 'settings.json'),
      JSON.stringify(raw, null, 2),
      'utf8',
    );
  }

  it('defaults to the limit the agent warns at', async () => {
    expect((await store().load()).memorySoftLimitBytes).toBe(
      DEFAULT_MEMORY_SOFT_LIMIT_BYTES,
    );
  });

  it('keeps a value the user chose', async () => {
    const settings = store();
    await settings.patch({memorySoftLimitBytes: 16 * 1024});
    await settings.patch({notesWidth: 260});
    expect((await settings.load()).memorySoftLimitBytes).toBe(16 * 1024);
  });

  /*
   * A file holding a limit the agent cannot act on falls back rather than
   * failing the whole document: losing every provider because somebody typed a
   * bad number into one field would be the worse outcome.
   */
  it('falls back when the stored value is out of range', async () => {
    await write({memorySoftLimitBytes: 1});
    expect((await store().load()).memorySoftLimitBytes).toBe(
      DEFAULT_MEMORY_SOFT_LIMIT_BYTES,
    );
  });

  it('refuses a value that is not a whole KiB', async () => {
    await write({memorySoftLimitBytes: 8 * 1024 + 1});
    expect((await store().load()).memorySoftLimitBytes).toBe(
      DEFAULT_MEMORY_SOFT_LIMIT_BYTES,
    );
  });

  it('keeps the limit strictly under the hard cap it warns about', async () => {
    // The ceiling the schema allows is half the hard cap, so a memory the user
    // has told the agent to let grow still crosses the warning before writes
    // start failing.
    expect(MEMORY_SOFT_LIMIT_MAX_BYTES).toBeLessThan(MAX_MEMORY_BYTES);
  });
});

describe('SettingsStore expandedSections', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(process.cwd(), '.marimo-expanded-'));
  });

  afterEach(async () => {
    await rm(dir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 20,
    });
  });

  function store(): SettingsStore {
    return new SettingsStore(join(dir, 'settings.json'));
  }

  async function write(raw: unknown): Promise<void> {
    await writeFile(
      join(dir, 'settings.json'),
      JSON.stringify(raw, null, 2),
      'utf8',
    );
  }

  it('starts with every section folded', async () => {
    const settings = await store().load();
    expect(settings.expandedSections).toEqual([]);
  });

  it('keeps the opened sections through another settings write', async () => {
    const settings = store();
    await settings.patch({expandedSections: ['Limits', 'Discord']});
    const after = await settings.patch({notesWidth: 260});

    expect(after.expandedSections).toEqual(['Limits', 'Discord']);
    expect(after.notesWidth).toBe(260);
  });

  it('gives a file written before the field existed an empty list', async () => {
    /*
     * Empty is "every section folded", which is where the dialog starts anyway:
     * an older file opens on the same page a fresh install does, rather than on
     * the eight cards the field replaced.
     */
    await write({sidebarWidth: 300});
    const settings = await store().load();

    expect(settings.expandedSections).toEqual([]);
    expect(settings.sidebarWidth).toBe(300);
  });

  it('discards a value that is not a list instead of losing the rest', async () => {
    /*
     * This is why the field carries a `.catch`. It is a flat setting, and a flat
     * setting that fails the schema takes the *whole file* down with it — the
     * user would lose their model, their folders and their Discord setup over a
     * hand-edited list of section names. Falling back to "nothing opened" is the
     * only sane reading of a value that is not a list of names anyway, and it
     * folds the dialog rather than opening all of it.
     */
    await write({expandedSections: 42, sidebarWidth: 300});
    const settings = await store().load();

    expect(settings.expandedSections).toEqual([]);
    expect(settings.sidebarWidth).toBe(300);
  });

  it('drops names it does not recognise rather than refusing the file', async () => {
    // A section that was renamed leaves a stale name behind, which has to be
    // harmless: the renderer opens by title and simply never matches it.
    await write({
      expandedSections: ['Limits', 'A section from an older build'],
    });
    const settings = await store().load();

    expect(settings.expandedSections).toEqual([
      'Limits',
      'A section from an older build',
    ]);
  });
});

/**
 * The commands the user has switched off.
 *
 * Stored as the *disabled* half so that a command added in a later build is
 * available without anybody touching this setting — and carrying a `.catch`,
 * because a command renamed or removed later must cost its own row rather than
 * fail the whole settings schema.
 */
describe('SettingsStore disabledCommands', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(process.cwd(), '.marimo-commands-'));
  });

  afterEach(async () => {
    await rm(dir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 20,
    });
  });

  function store(): SettingsStore {
    return new SettingsStore(join(dir, 'settings.json'));
  }

  it('offers every command on a fresh install', async () => {
    expect((await store().load()).disabledCommands).toEqual([]);
  });

  it('remembers what was switched off, and only that', async () => {
    const settings = store();
    const off = await settings.patch({disabledCommands: ['compact']});
    expect(off.disabledCommands).toEqual(['compact']);

    // A later write of something else must not bring it back.
    const after = await settings.patch({notesWidth: 260});
    expect(after.disabledCommands).toEqual(['compact']);
    expect(after.notesWidth).toBe(260);
  });

  it('gives a file written before the field existed nothing switched off', async () => {
    await writeFile(
      join(dir, 'settings.json'),
      JSON.stringify({sidebarWidth: 300}, null, 2),
      'utf8',
    );
    const settings = await store().load();

    expect(settings.disabledCommands).toEqual([]);
    expect(settings.sidebarWidth).toBe(300);
  });

  it('ignores a command this build does not know, rather than the file', async () => {
    /*
     * The failure this prevents is the one `.catch` is for: a name from a newer
     * build — or a typo — inside a flat field would otherwise fail the whole
     * settings schema, and the user would lose their model, their folders and
     * their key setup over one string.
     */
    await writeFile(
      join(dir, 'settings.json'),
      JSON.stringify(
        {
          disabledCommands: ['compact', 'a-command-from-a-newer-build'],
          sidebarWidth: 300,
        },
        null,
        2,
      ),
      'utf8',
    );
    const settings = await store().load();

    expect(settings.disabledCommands).toEqual([]);
    expect(settings.sidebarWidth).toBe(300);
  });
});

/**
 * Whether the setup flow has had its turn.
 *
 * The flag exists so the flow is a first run rather than a screen that returns
 * whenever the app cannot answer. The cases that matter are therefore the three
 * states a launch can be in: never seen, seen and declined, and a file written
 * before the field existed — which is a person who has been using the app and
 * wants to be left alone.
 */
describe('SettingsStore setupSeen', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(process.cwd(), '.marimo-setup-'));
  });

  afterEach(async () => {
    await rm(dir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 20,
    });
  });

  function store(): SettingsStore {
    return new SettingsStore(join(dir, 'settings.json'));
  }

  it('offers the flow to a fresh install', async () => {
    expect((await store().load()).setupSeen).toBe(false);
  });

  it('remembers that it ran, through a restart and a later write', async () => {
    const settings = store();
    await settings.patch({setupSeen: true});
    await settings.patch({notesWidth: 260});

    // A window opened later reads the file rather than the default.
    expect((await store().load()).setupSeen).toBe(true);
  });

  it('gives a file written before the field existed the flow once more', async () => {
    /*
     * False, which is the cheap direction: an existing install is asked once
     * after an upgrade and never again. True would be worse than chatty — a
     * user whose key stopped being readable would be sent to the short card
     * with no way to be walked through it.
     */
    await writeFile(
      join(dir, 'settings.json'),
      JSON.stringify({sidebarWidth: 300}, null, 2),
      'utf8',
    );
    const settings = await store().load();

    expect(settings.setupSeen).toBe(false);
    expect(settings.sidebarWidth).toBe(300);
  });

  it('costs the flag its own value rather than every other setting', async () => {
    // The reason it carries a `.catch`: flat fields fail the whole document.
    await writeFile(
      join(dir, 'settings.json'),
      JSON.stringify({setupSeen: 'yes', sidebarWidth: 300}, null, 2),
      'utf8',
    );
    const settings = await store().load();

    expect(settings.setupSeen).toBe(false);
    expect(settings.sidebarWidth).toBe(300);
  });
});

/**
 * One screen, and an old file that still says otherwise.
 *
 * The mode field is gone; what matters is that its absence cannot cost the rest
 * of the document. A settings file is flat, and a field this build no longer
 * knows is stripped like any other unknown key — so an install that upgrades is
 * left with its widths, theme and providers rather than a reset.
 */
describe('SettingsStore with no experience mode', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(process.cwd(), '.marimo-mode-'));
  });

  afterEach(async () => {
    await rm(dir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 20,
    });
  });

  function store(): SettingsStore {
    return new SettingsStore(join(dir, 'settings.json'));
  }

  it('reads a file that still carries the old field and keeps everything else', async () => {
    await writeFile(
      join(dir, 'settings.json'),
      JSON.stringify({experienceMode: 'power', sidebarWidth: 300}, null, 2),
      'utf8',
    );
    const settings = await store().load();

    expect(settings.sidebarWidth).toBe(300);
    expect('experienceMode' in settings).toBe(false);
  });
});

/**
 * The appearance block: a choice with three fields, none of which may take the
 * others down with it.
 */
describe('SettingsStore appearance', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(process.cwd(), '.marimo-appearance-'));
  });

  afterEach(async () => {
    await rm(dir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 20,
    });
  });

  function store(): SettingsStore {
    return new SettingsStore(join(dir, 'settings.json'));
  }

  it('starts by following the machine', async () => {
    const settings = await store().load();
    expect(settings.appearance).toEqual({theme: 'system'});
  });

  /*
   * The merge behaviour the block was always about: flipping one thing must not
   * clear another, which is why the patch schema accepts a subset.
   */
  it('merges a change without clearing the rest of the block', async () => {
    const settings = store();
    await settings.patch({appearance: {theme: 'dark'}});
    const after = await settings.patch({appearance: {}});

    expect(after.appearance.theme).toBe('dark');
  });

  it('keeps a choice through an unrelated write', async () => {
    const settings = store();
    await settings.patch({appearance: {theme: 'light'}});
    const after = await settings.patch({notesWidth: 260});

    expect(after.appearance.theme).toBe('light');
  });

  it('refuses a theme that is not one of the three', async () => {
    const settings = store();
    await expect(
      settings.patch({appearance: {theme: 'sepia' as never}}),
    ).rejects.toThrow();
    // And the block is untouched rather than half-written.
    expect((await settings.load()).appearance.theme).toBe('system');
  });
});

/**
 * The window block: where the app was when it last closed.
 *
 * The failure this guards is not a crash but an app that is running with nothing
 * to click, so the block has to be one a hand-edited file can lose on its own and
 * one an older file simply gets a default for.
 */
describe('SettingsStore window', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(process.cwd(), '.marimo-window-'));
  });

  afterEach(async () => {
    await rm(dir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 20,
    });
  });

  function store(): SettingsStore {
    return new SettingsStore(join(dir, 'settings.json'));
  }

  async function write(raw: unknown): Promise<void> {
    await writeFile(
      join(dir, 'settings.json'),
      JSON.stringify(raw, null, 2),
      'utf8',
    );
  }

  it('starts with a size and no position, so the OS places the first window', async () => {
    const settings = await store().load();
    expect(settings.window).toEqual({
      width: 1180,
      height: 780,
      x: null,
      y: null,
    });
  });

  it('keeps the remembered bounds through another settings write', async () => {
    const settings = store();
    await settings.patch({window: {width: 1024, height: 640, x: 10, y: 20}});
    const after = await settings.patch({notesWidth: 260});

    expect(after.window).toEqual({width: 1024, height: 640, x: 10, y: 20});
    expect(after.notesWidth).toBe(260);
  });

  it('gives a file written before the block existed the default window', async () => {
    await write({sidebarWidth: 300});
    const settings = await store().load();

    expect(settings.window.width).toBe(1180);
    expect(settings.window.x).toBeNull();
    // And the rest of the file still loads, which is the point of filling the
    // block rather than parsing the document whole.
    expect(settings.sidebarWidth).toBe(300);
  });

  it('falls back on the block alone when it is nonsense', async () => {
    await write({window: {width: 'wide'}, sidebarWidth: 300});
    const settings = await store().load();

    expect(settings.window.width).toBe(1180);
    expect(settings.sidebarWidth).toBe(300);
  });

  it('keeps a position that is negative, because a second monitor is', async () => {
    // Coordinates left of and above the primary display are ordinary on a
    // multi-monitor desk, and refusing them would silently centre the window
    // every launch for the people most likely to move it.
    await write({window: {width: 1024, height: 640, x: -1600, y: -200}});
    const settings = await store().load();

    expect(settings.window).toEqual({
      width: 1024,
      height: 640,
      x: -1600,
      y: -200,
    });
  });
});

/*
 * Invariant 12 for the settings document, and the subtlety that makes it
 * different from every other one.
 *
 * The settings file has never carried a version — `storedSettingsSchema` has no
 * such field — so *every* settings file in existence is version-less, and
 * treating that as "not mine" would reset every user's providers, connectors and
 * preferences the first time they upgraded. A version-less file is version 1, and
 * that is the migration.
 *
 * A file from a future build is still refused, which is the half that matters.
 */
describe('settings from another build', () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(process.cwd(), '.marimo-settings-version-'));
    file = join(dir, 'settings.json');
  });

  afterEach(async () => {
    await rm(dir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 20,
    });
  });

  function store(): SettingsStore {
    return new SettingsStore(file);
  }

  it('opens a version-less file, which is every settings file there is', async () => {
    // The shape a real install has on disk right now.
    await writeFile(
      file,
      JSON.stringify({notesWidth: 260, sidebarWidth: 321}),
      'utf8',
    );

    const settings = await store().load();

    expect(settings.notesWidth).toBe(260);
    expect(settings.sidebarWidth).toBe(321);
  });

  it('stamps a version when it writes, so this is only needed once', async () => {
    await writeFile(file, JSON.stringify({notesWidth: 260}), 'utf8');
    const settings = store();
    await settings.load();
    await settings.patch({notesWidth: 300});

    const written = JSON.parse(await readFile(file, 'utf8')) as {
      version: number;
    };
    expect(written.version).toBe(1);
  });

  it('refuses a file from a newer build, and leaves it alone', async () => {
    const future = JSON.stringify({version: 99, notesWidth: 260});
    await writeFile(file, future, 'utf8');

    await expect(store().load()).rejects.toThrow(/newer version/u);
    expect(await readFile(file, 'utf8')).toBe(future);
  });

  it('refuses to write over a file from a newer build', async () => {
    const future = JSON.stringify({version: 99, notesWidth: 260});
    await writeFile(file, future, 'utf8');

    await expect(store().patch({notesWidth: 210})).rejects.toThrow(
      /newer version/u,
    );
    expect(await readFile(file, 'utf8')).toBe(future);
  });
});

/**
 * The companion block: how the moss ball answers and how it behaves.
 *
 * Two of the four are prompt text and two are the window's own behaviour, which
 * is why the block is one thing rather than a setting on the profile: the pet
 * shares the conversation with the window, and none of it belongs to a
 * conversation.
 */
describe('SettingsStore companion', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(process.cwd(), '.marimo-companion-'));
  });

  afterEach(async () => {
    await rm(dir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 20,
    });
  });

  function store(): SettingsStore {
    return new SettingsStore(join(dir, 'settings.json'));
  }

  async function write(raw: unknown): Promise<void> {
    await writeFile(
      join(dir, 'settings.json'),
      JSON.stringify(raw, null, 2),
      'utf8',
    );
  }

  it('starts brief, floating, and showing six messages', async () => {
    const settings = await store().load();
    expect(settings.companion).toEqual({
      answerLength: 'brief',
      visibleMessages: 6,
      alwaysOnTop: true,
      clickThrough: true,
    });
  });

  it('gives a file written before the block existed the defaults', async () => {
    await write({notesWidth: 260, sidebarWidth: 300});
    const settings = await store().load();

    expect(settings.companion.answerLength).toBe('brief');
    // And the rest of the file is untouched.
    expect(settings.notesWidth).toBe(260);
  });

  it('fills in a short block rather than discarding it', async () => {
    await write({companion: {answerLength: 'detailed'}});
    const settings = await store().load();

    expect(settings.companion.answerLength).toBe('detailed');
    expect(settings.companion.visibleMessages).toBe(6);
  });

  it('merges a change without clearing the rest of the block', async () => {
    const settings = store();
    await settings.patch({companion: {visibleMessages: 12}});
    const after = await settings.patch({companion: {alwaysOnTop: false}});

    expect(after.companion.visibleMessages).toBe(12);
    expect(after.companion.alwaysOnTop).toBe(false);
    expect(after.companion.answerLength).toBe('brief');
  });

  it('keeps a choice through an unrelated write', async () => {
    const settings = store();
    await settings.patch({companion: {answerLength: 'balanced'}});
    const after = await settings.patch({notesWidth: 260});

    expect(after.companion.answerLength).toBe('balanced');
  });

  it('refuses a length that is not one of the three', async () => {
    const settings = store();
    await expect(
      settings.patch({companion: {answerLength: 'terse' as never}}),
    ).rejects.toThrow();
    expect((await settings.load()).companion.answerLength).toBe('brief');
  });

  it('refuses a bubble count that is not a usable number', async () => {
    const settings = store();
    await expect(
      settings.patch({companion: {visibleMessages: 0}}),
    ).rejects.toThrow();
    await expect(
      settings.patch({companion: {visibleMessages: 2.5}}),
    ).rejects.toThrow();
    expect((await settings.load()).companion.visibleMessages).toBe(6);
  });
});

/**
 * The recall block, in the settings store.
 *
 * It is a nested block, which means it is read the way the window block and the
 * Discord block are: validated whole against its defaults, so a hand-edited value
 * inside it costs that block rather than every other preference the user has —
 * and so a settings file written before recall existed loads as "off" rather than
 * failing.
 */
describe('the recall block', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(process.cwd(), '.marimo-settings-recall-'));
  });

  afterEach(async () => {
    await rm(dir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 20,
    });
  });

  it('defaults to off, on an install with no settings file at all', async () => {
    const store = new SettingsStore(join(dir, 'settings.json'));

    expect((await store.load()).recall).toEqual({
      enabled: false,
      memory: true,
      workspace: true,
      conversations: true,
      media: false,
      codeQueries: false,
      introSeen: false,
    });
  });

  it('reads a file that predates the feature as off', async () => {
    const file = join(dir, 'settings.json');
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        notesWidth: 260,
        memorySoftLimitBytes: 8192,
      }),
      'utf8',
    );

    const settings = await new SettingsStore(file).load();

    expect(settings.recall.enabled).toBe(false);
    // And the setting beside it survives, which is the whole point of filling the
    // block in rather than resetting the document.
    expect(settings.notesWidth).toBe(260);
  });

  /*
   * The leniency, tested at the one place it can go wrong: a block that does not
   * validate is replaced whole, and everything *around* it is kept. A parse that
   * took the document down with the block would lose the user's width and theme
   * because of one typo in a switch.
   */
  it('costs the block, not the document, when a switch is hand-edited wrong', async () => {
    const file = join(dir, 'settings.json');
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        notesWidth: 260,
        sidebarWidth: 300,
        recall: {enabled: 'yes', memory: true, workspace: true},
      }),
      'utf8',
    );

    const settings = await new SettingsStore(file).load();

    expect(settings.recall.enabled).toBe(false);
    expect(settings.notesWidth).toBe(260);
    expect(settings.sidebarWidth).toBe(300);
  });

  /* A patch touching one switch leaves the others as they were. */
  it('merges a partial block over what is stored', async () => {
    const store = new SettingsStore(join(dir, 'settings.json'));
    await store.patch({recall: {enabled: true}});
    const merged = await store.patch({recall: {workspace: false}});

    expect(merged.recall).toEqual({
      enabled: true,
      memory: true,
      workspace: false,
      conversations: true,
      media: false,
      codeQueries: false,
      introSeen: false,
    });
  });
});
