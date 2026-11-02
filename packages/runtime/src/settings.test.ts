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

import {defaultLocalModelsSettings} from '@marimo/protocol';

import {
  mergeLocalModels,
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

  it('starts a fresh install with local models and no provider block', async () => {
    const settings = await store.load();
    expect(settings.localModels).toEqual(defaultLocalModelsSettings());
    expect('providers' in settings).toBe(false);
    expect('availableModels' in settings).toBe(false);
  });

  /*
   * The upgrade that matters: a file written by the provider build has a block
   * this schema does not know. It is stripped, and the local model choices fill
   * from the defaults — the preferences beside it survive.
   */
  it('reads a provider-era file and fills the local models', async () => {
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
    expect(settings.localModels).toEqual(defaultLocalModelsSettings());
    expect('providers' in settings).toBe(false);
  });

  it('merges a task patch one task at a time', async () => {
    await store.load();
    await store.patch({localModels: {tasks: {chat: 'lfm3-vl-2b'}}});

    const settings = await store.load();
    expect(settings.localModels.tasks.chat).toBe('lfm3-vl-2b');
    // The other two are still the defaults, not whatever a stale window sent.
    expect(settings.localModels.tasks.vision).toBe('lfm3-vl-2b');
    expect(settings.localModels.tasks.voice).toBe('lfm3-audio-2b');
  });

  it('stores the idle timeout and keeps every other preference', async () => {
    await store.load();
    await store.patch({
      localModels: {idleMinutes: 10},
      sidebarWidth: 300,
    });
    const settings = await store.load();
    expect(settings.localModels.idleMinutes).toBe(10);
    expect(settings.sidebarWidth).toBe(300);
  });

  /*
   * A block that does not validate costs the block, not the document. This is
   * the hand-edited case: Chat pointed at the audio model cannot answer, and the
   * safe answer is the defaults rather than a turn whose prompt is wrong for the
   * weights.
   */
  it('falls back on a local models block that cannot do its tasks', async () => {
    await writeFile(
      join(dir, 'settings.json'),
      JSON.stringify({
        version: 1,
        sidebarWidth: 333,
        localModels: {
          tasks: {
            chat: 'lfm3-1.7b',
            vision: 'lfm3-1.7b',
            voice: 'lfm3-audio-2b',
          },
          idleMinutes: 3,
        },
      }),
      'utf8',
    );

    const settings = await store.load();
    expect(settings.sidebarWidth).toBe(333);
    expect(settings.localModels).toEqual(defaultLocalModelsSettings());
  });

  it('writes a current document, with no provider block', async () => {
    await store.load();
    await store.patch({setupSeen: true});
    const raw = JSON.parse(
      await readFile(join(dir, 'settings.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(raw['version']).toBe(1);
    expect(raw['setupSeen']).toBe(true);
    expect(raw['providers']).toBeUndefined();
    expect(raw['availableModels']).toBeUndefined();
    expect(raw['localModels']).toBeDefined();
  });

  it('keeps the default companion speech settings in an old file', async () => {
    await writeFile(
      join(dir, 'settings.json'),
      JSON.stringify({
        version: 1,
        companion: {
          answerLength: 'brief',
          visibleMessages: 6,
          alwaysOnTop: true,
          clickThrough: true,
        },
      }),
      'utf8',
    );
    const settings = await store.load();
    expect(settings.companion.speakReplies).toBe(false);
    expect(settings.companion.speechVoice).toBe('female');
    expect(settings.companion.speechLanguage).toBe('en');
  });
});

describe('mergeLocalModels', () => {
  it('keeps every task a patch does not name', () => {
    const current = defaultLocalModelsSettings();
    expect(mergeLocalModels(current, {tasks: {voice: 'lfm3-omni-2b'}})).toEqual({
      tasks: {
        chat: 'lfm3-1.7b',
        vision: 'lfm3-vl-2b',
        voice: 'lfm3-omni-2b',
      },
      idleMinutes: 3,
      engineBackend: 'vulkan',
    });
  });

  it('moves the engine backend without touching the tasks', () => {
    const current = defaultLocalModelsSettings();
    const patched = mergeLocalModels(current, {engineBackend: 'cuda'});
    expect(patched.engineBackend).toBe('cuda');
    expect(patched.tasks).toEqual(current.tasks);

    const kept = mergeLocalModels({...current, engineBackend: 'cuda'}, {});
    expect(kept.engineBackend).toBe('cuda');
  });
});
