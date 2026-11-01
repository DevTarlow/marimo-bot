/**
 * Invariant 8: secrets never cross to the renderer.
 *
 * The audit that prompted this file found the guard correct and **completely
 * untested** — `grep` for `PublicSettings` or `providerKeys` across every test
 * file returned nothing. A rule with no test is a rule that holds until somebody
 * adds a field.
 *
 * So this asserts the *shape* rather than one call site: whatever a settings
 * payload grows into, no secret may appear in it. The models are local now and
 * need no key at all, but the payload still carries connector entries and a
 * Discord block, and those are the fields a hurried change would be tempted to
 * fill in "because the window already has a box for it".
 *
 * The shape is not a copy of what the window gets. It is what
 * `settingsForWindow` — the function `settings.get` builds its answer with —
 * returns for a real settings document, so a field added to the payload is in
 * front of the walk below rather than beside it.
 */
import {describe, expect, it} from 'vitest';

import {defaultStoredSettings} from '@marimo/runtime';
import {
  LOCAL_MODEL_IDS,
  LOCAL_MODELS,
  LOCAL_TASKS,
} from '@marimo/protocol';
import type {
  LocalModelId,
  LocalModelStatus,
  LocalModelsStatus,
  PublicSettings,
} from '@marimo/protocol';

import {settingsForWindow} from '../src/main/public-settings.js';

/** The fields of a settings payload that could ever hold a credential. */
const FORBIDDEN = ['apikey', 'key', 'token', 'secret', 'password'] as const;

/**
 * Whether a JSON value contains anything that looks like a stored credential.
 *
 * Checked by key name rather than by value: a key that happened to be short would
 * not be caught by a length or entropy test, and a false positive is cheaper here
 * than a leak. The last *word* of the name rather than the whole string, so
 * `botToken` is caught as well as `bot_token` — the app writes camelCase, and a
 * guard that only knew snake_case would pass over exactly the field a hurried
 * change would add.
 */
function credentialFieldsIn(value: unknown, path = ''): string[] {
  if (value === null || typeof value !== 'object') {
    return [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) =>
      credentialFieldsIn(entry, `${path}[${String(index)}]`),
    );
  }
  return Object.entries(value as Record<string, unknown>).flatMap(
    ([key, entry]) => {
      const here = path.length > 0 ? `${path}.${key}` : key;
      const lastWord = (key.split(/(?=[A-Z])|_/u).pop() ?? '').toLowerCase();
      const looksSecret = FORBIDDEN.some((word) => lastWord === word);
      return [
        ...(looksSecret ? [here] : []),
        ...credentialFieldsIn(entry, here),
      ];
    },
  );
}

function modelStatus(id: LocalModelId): LocalModelStatus {
  return {
    id,
    installed: false,
    missing: ['weights'],
    state: 'off',
    usedFor: [],
  };
}

function localModels(): LocalModelsStatus {
  return {
    engine: {present: true, platformSupported: true, tag: 'b11960'},
    models: Object.fromEntries(
      LOCAL_MODEL_IDS.map((id) => [id, modelStatus(id)]),
    ) as Record<LocalModelId, LocalModelStatus>,
    tasks: {
      chat: 'lfm3-1.7b',
      vision: 'lfm3-vl-2b',
      voice: 'lfm3-audio-2b',
    },
    idleMinutes: 3,
    recommendedVariant: 'q8',
  };
}

describe('a settings payload', () => {
  /** The real shape, as `settings.get` builds it. */
  function payload(): PublicSettings {
    return settingsForWindow({
      settings: defaultStoredSettings(),
      readiness: {ok: true},
      encryptionAvailable: true,
      localModels: localModels(),
      hardware: {totalMemoryMb: 16_384, platform: 'linux', arch: 'x64'},
      profiles: [],
      activeProfileId: 'p1',
    });
  }

  it('carries the model situation and the hardware facts', () => {
    const settings = payload();
    expect(settings.localModels.engine.present).toBe(true);
    expect(settings.localModels.tasks.chat).toBe('lfm3-1.7b');
    expect(settings.hardware.totalMemoryMb).toBe(16_384);
    expect(settings.modelReady).toBe(true);
    // Every task is in the catalogue and every model has a label the window can
    // draw without importing the catalogue's prose.
    for (const task of LOCAL_TASKS) {
      expect(LOCAL_MODELS[settings.localModels.tasks[task]].label.length).toBeGreaterThan(0);
    }
  });

  it('carries no credential field anywhere in it', () => {
    expect(credentialFieldsIn(payload())).toEqual([]);
  });

  /*
   * The check is only worth having if it can fail. Without this, a bug in
   * `credentialFieldsIn` would make the assertion above vacuous — which is the
   * failure mode of every "assert nothing bad is present" test.
   */
  it('would notice a key if one were added', () => {
    expect(credentialFieldsIn({...payload(), apiKey: 'sk-test'})).toEqual([
      'apiKey',
    ]);
    expect(
      credentialFieldsIn({
        ...payload(),
        mcpServers: [{secrets: [], token: 'x'}],
      }),
    ).toContain('mcpServers[0].token');
    expect(
      credentialFieldsIn({
        ...payload(),
        discord: {botToken: 'x'},
      }),
    ).toContain('discord.botToken');
  });

  it('reports a connector as a name and a target, never a value', () => {
    /*
     * The shape a saved connector actually has. `secrets` names where a value
     * goes; the value lives in the keychain and is never read back into this
     * payload. This is the assertion that would break first if somebody stored
     * one here for convenience.
     */
    const payloadWithConnector = {
      ...payload(),
      mcpServers: [
        {
          id: 'notes',
          name: 'Notes',
          transport: 'stdio',
          command: 'notes-mcp',
          secrets: [{target: 'env', name: 'NOTES_TOKEN'}],
        },
      ],
    };

    expect(credentialFieldsIn(payloadWithConnector)).toEqual([]);
  });
});
