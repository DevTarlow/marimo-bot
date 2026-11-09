/**
 * Settings persistence, and the parts that have to be lenient.
 *
 * The file is hand-editable and has changed shape several times — most recently
 * when the provider catalogue left and four local models arrived. A field this
 * build no longer knows must cost its own value and nothing else, because a
 * settings file that fails to parse is every preference the user has, reset at
 * once.
 */
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';

import {afterEach, beforeEach, describe, expect, it} from 'vitest';

import {
  DEFAULT_MODEL_SERVER_URL,
  defaultModelServerSettings,
} from '@marimo/protocol';

import {
  mergeModelServer,
  readLegacyProfileSeed,
  SettingsStore,
} from './settings.js';

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

describe('SettingsStore', () => {
  let dir: string;
  let store: SettingsStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(process.cwd(), '.marimo-settings-store-'));
    store = new SettingsStore(join(dir, 'settings.json'));
  });

  afterEach(async () => {
    await rm(dir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 20,
    });
  });

  it('starts a fresh install on the local server and no provider block', async () => {
    const settings = await store.load();
    expect(settings.modelServer).toEqual(defaultModelServerSettings());
    expect(settings.modelServer.url).toBe(DEFAULT_MODEL_SERVER_URL);
    expect('providers' in settings).toBe(false);
    expect('availableModels' in settings).toBe(false);
  });

  /*
   * The upgrade that matters: a file written by the provider build has a block
   * this schema does not know. It is stripped, and the local model choices fill
   * from the defaults — the preferences beside it survive.
   */
  it('reads a provider-era file and fills the model server', async () => {
    await writeFile(
      join(dir, 'settings.json'),
      JSON.stringify({
        version: 1,
        setupSeen: true,
        sidebarWidth: 331,
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
      }),
      'utf8',
    );

    const settings = await store.load();
    expect(settings.sidebarWidth).toBe(331);
    expect(settings.setupSeen).toBe(true);
    expect(settings.modelServer).toEqual(defaultModelServerSettings());
    expect('providers' in settings).toBe(false);
  });

  it('moves a version 1 install through every model era to the server, once', async () => {
    await writeFile(
      join(dir, 'settings.json'),
      JSON.stringify({
        version: 1,
        setupSeen: true,
        localModels: {
          tasks: {
            chat: 'lfm3-1.7b',
            vision: 'lfm3-vl-2b',
            voice: 'lfm3-audio-2b',
          },
          idleMinutes: 5,
        },
      }),
      'utf8',
    );

    const settings = await store.load();
    // The old block is gone, and the address is llama.cpp's default: the
    // assignments named models no server is running.
    expect(settings.modelServer).toEqual(defaultModelServerSettings());
    expect(settings.setupSeen).toBe(true);
    const raw = JSON.parse(
      await readFile(join(dir, 'settings.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(raw['version']).toBe(4);
    expect(raw['localModels']).toBeUndefined();
    expect(raw['modelServer']).toBeDefined();
  });

  it('merges a model-server patch one field at a time', async () => {
    await store.load();
    await store.patch({modelServer: {model: 'qwen3-8b'}});
    await store.patch({modelServer: {url: 'http://localhost:9000/'}});

    const settings = await store.load();
    expect(settings.modelServer.model).toBe('qwen3-8b');
    // The address is normalised on the way in, not stored as it was typed.
    expect(settings.modelServer.url).toBe('http://localhost:9000/v1');
    // And the window the first patch did not mention is still the default.
    expect(settings.modelServer.contextTokens).toBe(32_768);
  });

  it('merges a model server over one that is stored', () => {
    expect(
      mergeModelServer(
        {...defaultModelServerSettings(), model: 'old'},
        {contextTokens: 8192},
      ),
    ).toEqual({
      url: DEFAULT_MODEL_SERVER_URL,
      model: 'old',
      contextTokens: 8192,
    });
  });

  it('stores a preference and keeps every other one', async () => {
    await store.load();
    await store.patch({modelServer: {contextTokens: 8192}, sidebarWidth: 300});
    const settings = await store.load();
    expect(settings.modelServer.contextTokens).toBe(8192);
    expect(settings.sidebarWidth).toBe(300);
  });

  /*
   * A block that does not validate costs the block, not the document. This is
   * the hand-edited case that matters most: an address off the machine is the
   * one thing the app's privacy promise depends on, so it falls back to the
   * loopback default rather than being dialled.
   */
  it('falls back on a model server that is not on this computer', async () => {
    await writeFile(
      join(dir, 'settings.json'),
      JSON.stringify({
        version: 4,
        sidebarWidth: 333,
        modelServer: {
          url: 'https://api.example.com/v1',
          model: 'something-hosted',
        },
      }),
      'utf8',
    );

    const settings = await store.load();
    expect(settings.sidebarWidth).toBe(333);
    expect(settings.modelServer).toEqual(defaultModelServerSettings());
  });

  it('reads a version 3 file and leaves the old model block behind', async () => {
    await writeFile(
      join(dir, 'settings.json'),
      JSON.stringify({
        version: 3,
        sidebarWidth: 334,
        localModels: {
          tasks: {chat: 'qwen2.5-vl-7b', vision: 'qwen2.5-vl-7b'},
          idleMinutes: 10,
        },
      }),
      'utf8',
    );

    const settings = await store.load();
    expect(settings.sidebarWidth).toBe(334);
    expect(settings.modelServer).toEqual(defaultModelServerSettings());
  });

  it('writes a current document, with no provider block', async () => {
    await store.load();
    await store.patch({setupSeen: true});
    const raw = JSON.parse(
      await readFile(join(dir, 'settings.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(raw['version']).toBe(4);
    expect(raw['setupSeen']).toBe(true);
    expect(raw['providers']).toBeUndefined();
    expect(raw['availableModels']).toBeUndefined();
    expect(raw['localModels']).toBeUndefined();
    expect(raw['modelServer']).toBeDefined();
  });

  it('keeps the companion block of an old file, without the speech keys', async () => {
    await writeFile(
      join(dir, 'settings.json'),
      JSON.stringify({
        version: 1,
        companion: {
          answerLength: 'detailed',
          visibleMessages: 6,
          alwaysOnTop: true,
          clickThrough: true,
          speakReplies: true,
          speechVoice: 'male',
          speechLanguage: 'en-gb',
        },
      }),
      'utf8',
    );
    const settings = await store.load();
    expect(settings.companion.answerLength).toBe('detailed');
    expect(settings.companion).not.toHaveProperty('speakReplies');
    expect(settings.companion).not.toHaveProperty('speechVoice');
  });
});
