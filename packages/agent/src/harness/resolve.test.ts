import {describe, expect, it} from 'vitest';

import {DEFAULT_HARNESS} from './defaults.js';
import {resolveHarness} from './resolve.js';
import type {HarnessAppDefaults, HarnessProfile} from './spec.js';

const app: HarnessAppDefaults = {
  model: {provider: 'deepseek', model: 'deepseek-chat'},
  allowPrivateNetworkFetch: false,
  learning: {mode: 'propose', retainTraces: false},
};

function profile(overrides: Partial<HarnessProfile> = {}): HarnessProfile {
  return {
    id: 'writer',
    name: 'Writer',
    role: 'Write for the person.',
    persona: 'Dry and direct.',
    enabledTools: ['read_file', 'write_file'],
    enabledSkills: ['style'],
    ...overrides,
  };
}

describe('resolveHarness', () => {
  it('freezes the identity, the contract and the version for the turn', () => {
    const spec = resolveHarness({profile: profile(), app, version: 3});
    expect(spec.id).toBe('writer');
    expect(spec.version).toBe(3);
    expect(spec.identity).toEqual({
      name: 'Writer',
      role: 'Write for the person.',
      persona: 'Dry and direct.',
    });
    expect(spec.contract).toEqual(DEFAULT_HARNESS.contract);
  });

  it('freezes the spec deeply so a recorded hash stays true', () => {
    const spec = resolveHarness({profile: profile(), app, version: 1});
    expect(Object.isFrozen(spec)).toBe(true);
    expect(Object.isFrozen(spec.tools.grants)).toBe(true);
    expect(Object.isFrozen(spec.contract)).toBe(true);
    expect(() => {
      (spec.tools.grants as string[]).push('run_shell');
    }).toThrow();
    expect(() => {
      (spec.contract as string[]).push('invented');
    }).toThrow();
  });

  it('drops a persona that is only whitespace', () => {
    const spec = resolveHarness({
      profile: profile({persona: '   '}),
      app,
      version: 1,
    });
    expect(spec.identity).not.toHaveProperty('persona');
  });

  it('takes the conversation model as a whole pair, then the profile, then the app', () => {
    const conversation = resolveHarness({
      profile: profile({model: {provider: 'gemini', model: 'gemini-flash'}}),
      app,
      version: 1,
      conversation: {
        model: {provider: 'openrouter', model: 'openrouter/auto'},
      },
    });
    expect(conversation.model).toEqual({
      provider: 'openrouter',
      model: 'openrouter/auto',
    });

    const own = resolveHarness({
      profile: profile({model: {provider: 'gemini', model: 'gemini-flash'}}),
      app,
      version: 1,
    });
    expect(own.model).toEqual({
      provider: 'gemini',
      model: 'gemini-flash',
    });

    const inherited = resolveHarness({profile: profile(), app, version: 1});
    expect(inherited.model).toEqual(app.model);
  });

  it('answers with no guidance when the profile has no tools', () => {
    const spec = resolveHarness({
      profile: profile({enabledTools: []}),
      app,
      version: 1,
    });
    expect(spec.tools.grants).toEqual([]);
    expect(spec.tools.guidance).toEqual([]);
  });

  it('keeps the person half of memory and adds the Space half only with a Space', () => {
    const noSpace = resolveHarness({profile: profile(), app, version: 1});
    expect(noSpace.context.memory.scopes).toEqual(['person']);
    expect(noSpace.context.spaceContext).toBe(false);

    const withSpace = resolveHarness({
      profile: profile(),
      app,
      version: 1,
      hasSpace: true,
    });
    expect(withSpace.context.memory.scopes).toEqual(['person', 'space']);
    expect(withSpace.context.spaceContext).toBe(true);

    const rooted = resolveHarness({
      profile: profile(),
      app,
      version: 1,
      workspaceRoot: '/tmp/space',
    });
    expect(rooted.workspaceRoot).toBe('/tmp/space');
    expect(rooted.context.memory.scopes).toEqual(['person', 'space']);
    expect(rooted.context.spaceContext).toBe(true);
    expect(noSpace.workspaceRoot).toBeUndefined();
  });

  it('lets a profile narrow private-network access but never widen it', () => {
    const off = resolveHarness({
      profile: profile({
        harness: {tools: {policy: {network: 'private'}}},
      }),
      app,
      version: 1,
    });
    expect(off.tools.policy.network).toBe('default');

    const on = resolveHarness({
      profile: profile(),
      app: {...app, allowPrivateNetworkFetch: true},
      version: 1,
    });
    expect(on.tools.policy.network).toBe('private');

    const narrowed = resolveHarness({
      profile: profile({
        harness: {tools: {policy: {network: 'default'}}},
      }),
      app: {...app, allowPrivateNetworkFetch: true},
      version: 1,
    });
    expect(narrowed.tools.policy.network).toBe('default');
  });

  it('never lets a profile weaken the shell or overwrite gate', () => {
    const spec = resolveHarness({
      profile: profile({
        harness: {
          tools: {
            policy: {
              gates: {run_shell: 'never', write_file: 'never'},
            },
          },
        },
      }),
      app,
      version: 1,
    });
    expect(spec.tools.policy.gates.run_shell).toBe('always');
    expect(spec.tools.policy.gates.write_file).toBe('on-overwrite');
  });

  it('lets a profile strengthen a gate', () => {
    const spec = resolveHarness({
      profile: profile({
        harness: {
          tools: {policy: {gates: {write_file: 'always'}}},
        },
      }),
      app,
      version: 1,
    });
    expect(spec.tools.policy.gates.write_file).toBe('always');
  });

  it('merges budgets over the defaults without dropping the rest', () => {
    const spec = resolveHarness({
      profile: profile({
        harness: {tools: {budgets: {maxSteps: 4}}},
      }),
      app,
      version: 1,
    });
    expect(spec.tools.budgets).toMatchObject({
      ...DEFAULT_HARNESS.tools.budgets,
      maxSteps: 4,
    });
  });

  it('treats an absent connector grant as every connector and an empty one as none', () => {
    const all = resolveHarness({
      profile: profile(),
      app,
      version: 1,
      hasConnectors: true,
    });
    expect(all.tools.mcpServerIds).toBe('all');
    expect(all.tools.guidance).toContain('connectors');

    const none = resolveHarness({
      profile: profile({mcpServerIds: []}),
      app,
      version: 1,
      hasConnectors: true,
    });
    expect(none.tools.mcpServerIds).toEqual([]);
    expect(none.tools.guidance).not.toContain('connectors');
  });

  it('records trace only when learning is on and retention was asked for', () => {
    const off = resolveHarness({profile: profile(), app, version: 1});
    expect(off.plugins).not.toContain('trace');
    expect(off.plugins).toEqual(
      expect.arrayContaining(['redaction', 'loop-guard']),
    );

    const on = resolveHarness({
      profile: profile(),
      app: {
        ...app,
        learning: {mode: 'propose', retainTraces: true},
      },
      version: 1,
    });
    expect(on.plugins).toContain('trace');
  });

  it('does not record when learning itself is off', () => {
    const spec = resolveHarness({
      profile: profile(),
      app: {
        ...app,
        learning: {mode: 'off', retainTraces: true},
      },
      version: 1,
    });
    expect(spec.plugins).not.toContain('trace');
    expect(spec.learning).toEqual({mode: 'off', retainTraces: true});
  });

  it('applies a conversation memory policy without touching the tool grant', () => {
    const spec = resolveHarness({
      profile: profile(),
      app,
      version: 1,
      hasSpace: true,
      conversation: {
        harness: {
          context: {
            memory: {policy: 'all', scopes: ['person', 'space']},
            compaction: {maxContextTokens: 128_000},
          },
        },
      },
    });
    expect(spec.context.memory.policy).toBe('all');
    expect(spec.context.compaction.maxContextTokens).toBe(128_000);
    expect(spec.tools.grants).toEqual(['read_file', 'write_file']);
  });
});
