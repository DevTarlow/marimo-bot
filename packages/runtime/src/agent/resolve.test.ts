/**
 * Turning a profile and a running model into an agent configuration.
 *
 * This layer used to decide which provider answered and whether its key was
 * readable. The key is gone, the provider is `local`, and the address is handed
 * in by the process that started the engine. What is left is the shape the agent
 * receives, and the one refusal that is still its own: a profile with no folder
 * for its file tools to work in.
 *
 * The model and address are tested as *pass-through* rather than re-derived:
 * they exist only while an engine is running, and a copy of either stored here
 * would be an address pointing at a process that died a minute ago.
 */
import {describe, expect, it} from 'vitest';

import type {AgentModel, AgentProfile, Settings} from '@marimo/protocol';

import {defaultStoredSettings} from '../settings.js';
import {parseProfile, resolveAgentConfig} from './resolve.js';
import type {ResolveAgentOptions} from './resolve.js';

function profile(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
    id: 'p1',
    name: 'Marimo',
    identity: 'You are Marimo.',
    enabledTools: ['read_file'],
    enabledSkills: [],
    ...overrides,
  };
}

const MODEL: AgentModel = {provider: 'local', model: 'lfm3-1.7b'};

function resolve(
  overrides: Partial<ResolveAgentOptions> = {},
): ReturnType<typeof resolveAgentConfig> {
  return resolveAgentConfig({
    settings: defaultStoredSettings(),
    profile: profile(),
    model: MODEL,
    baseUrl: 'http://127.0.0.1:9137/v1',
    workspaceRoot: '/home/me/proj',
    ...overrides,
  });
}

describe('resolveAgentConfig', () => {
  it('carries the running model and its address through untouched', async () => {
    const result = await resolve();
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.config.baseUrl).toBe('http://127.0.0.1:9137/v1');
    expect(result.config.model).toBe('lfm3-1.7b');
    expect(result.config.provider).toBe('local');
    // The model runs on this machine and was started by this process. An empty
    // key means no `Authorization` header is sent at all.
    expect(result.config.apiKey).toBe('');
  });

  it('refuses a profile with no Space to work in', async () => {
    const result = await resolve({workspaceRoot: undefined});
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.problem).toMatch(/no space to work in/iu);
  });

  it('carries the Role, Persona and grants the turn will use', async () => {
    const result = await resolve({
      profile: profile({
        persona: 'Be brief.',
        enabledTools: ['read_file', 'write_file'],
        enabledSkills: ['release-notes'],
        mcpServerIds: ['mcp:notes'],
      }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.config.systemPrompt).toBe('You are Marimo.');
    expect(result.config.persona).toBe('Be brief.');
    expect(result.config.enabledTools).toEqual(['read_file', 'write_file']);
    expect(result.config.enabledSkills).toEqual(['release-notes']);
    expect(result.config.mcpServerIds).toEqual(['mcp:notes']);
    expect(result.config.workspaceRoot).toBe('/home/me/proj');
  });

  it('leaves a blank Persona absent rather than empty', async () => {
    const result = await resolve({profile: profile({persona: '   '})});
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.config.persona).toBeUndefined();
  });

  it('carries the output cap when the app has one', async () => {
    const settings: Settings = {
      ...defaultStoredSettings(),
      maxOutputTokens: 512,
    };
    const result = await resolve({settings});
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.config.maxOutputTokens).toBe(512);
  });

  it('turns the stored skills into the shape the prompt builder takes', async () => {
    const result = await resolve({
      skills: [
        {
          name: 'release-notes',
          description: 'How to write them.',
          instructions: 'Start with the date.',
        },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.config.userSkills).toEqual([
      {
        name: 'release-notes',
        description: 'How to write them.',
        instructions: 'Start with the date.',
      },
    ]);
  });
});

describe('parseProfile', () => {
  it('reads a stored profile and refuses a shape it cannot trust', () => {
    expect(parseProfile(profile())).toEqual(profile());
    expect(parseProfile({id: '', name: 'x'})).toBeUndefined();
    expect(parseProfile(null)).toBeUndefined();
  });
});
