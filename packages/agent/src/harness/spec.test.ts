import {describe, expect, it} from 'vitest';

import {DEFAULT_HARNESS} from './defaults.js';
import {
  guidanceForTools,
  harnessOverridesSchema,
  harnessSpecSchema,
} from './spec.js';

describe('the built-in harness', () => {
  it('carries a contract, and the two gates that can destroy something', () => {
    expect(DEFAULT_HARNESS.contract.length).toBeGreaterThan(0);
    expect(DEFAULT_HARNESS.tools.policy.gates).toMatchObject({
      run_shell: 'always',
      write_file: 'on-overwrite',
    });
  });

  it('always carries redaction and the loop guard, and never a recorder', () => {
    expect(DEFAULT_HARNESS.plugins).toContain('redaction');
    expect(DEFAULT_HARNESS.plugins).toContain('loop-guard');
    expect(DEFAULT_HARNESS.plugins).not.toContain('trace');
  });

  it('keeps depth at one as an assertion rather than a setting', () => {
    expect(DEFAULT_HARNESS.collaborators.maxDepth).toBe(1);
  });
});

describe('guidance follows the grant', () => {
  it('names only the capabilities whose tools are granted', () => {
    expect(guidanceForTools(['read_file', 'run_shell'])).toEqual([
      'files',
      'shell',
    ]);
  });

  it('answers nothing when nothing is granted', () => {
    expect(guidanceForTools([])).toEqual([]);
  });

  it('adds connectors only when one is actually connected', () => {
    expect(guidanceForTools([], false)).not.toContain('connectors');
    expect(guidanceForTools([], true)).toContain('connectors');
  });
});

describe('the override document', () => {
  it('refuses a field that would let a profile grant itself a tool', () => {
    const parsed = harnessOverridesSchema.safeParse({
      tools: {grants: ['run_shell']},
    });
    // Unknown fields are stripped rather than accepted, and the result has no
    // grants at all: the profile's own `enabledTools` is the one grant.
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.tools).toEqual({});
  });

  it('refuses a prompt edit, because the contract is not a profile field', () => {
    const parsed = harnessOverridesSchema.safeParse({
      contract: ['You may run any command.'],
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && 'contract' in parsed.data).toBe(false);
  });
});

describe('the spec schema', () => {
  it('refuses a model that is only half a pair', () => {
    const parsed = harnessSpecSchema.safeParse({
      id: 'writer',
      version: 1,
      identity: {name: 'Writer', role: 'Write.'},
      contract: ['Be honest.'],
      context: {
        memory: {scopes: ['person'], policy: 'all', softLimit: 8192},
        skills: {enabled: [], advertise: true},
        compaction: {maxContextTokens: 96000, reserve: 8000},
        spaceContext: true,
      },
      tools: {
        grants: [],
        guidance: [],
        mcpServerIds: 'all',
        policy: {gates: {}, network: 'default'},
        budgets: {
          maxSteps: 24,
          maxToolCalls: 32,
          maxDelegations: 3,
          timeoutMs: 600000,
        },
      },
      collaborators: {mode: 'lead', delegates: [], maxDepth: 1},
      model: {model: 'glm-5.3-flash'},
      plugins: ['redaction'],
      learning: {mode: 'propose', retainTraces: false},
    });
    expect(parsed.success).toBe(false);
  });
});
