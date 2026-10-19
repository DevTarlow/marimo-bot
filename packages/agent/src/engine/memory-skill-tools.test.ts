import {mkdtemp, rm} from 'node:fs/promises';
import {join} from 'node:path';

import {afterEach, describe, expect, it} from 'vitest';

import {MemoryStore} from '../memory/memory-store.js';
import {resolveHarness} from '../harness/resolve.js';
import type {HarnessAppDefaults, HarnessProfile} from '../harness/spec.js';
import {composeHarnessInstruction} from '../context/instruction.js';
import {CORE_TOOLS, toolsFor} from './core-tools.js';
import type {SkillToolService, ToolContext} from './tool-contract.js';

const app: HarnessAppDefaults = {
  model: {provider: 'deepseek', model: 'deepseek-chat'},
  allowPrivateNetworkFetch: false,
  learning: {mode: 'propose', retainTraces: false},
};

const roots: string[] = [];

async function workDir(): Promise<string> {
  const dir = await mkdtemp(join(process.cwd(), '.marimo-memory-tools-'));
  roots.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((dir) =>
        rm(dir, {recursive: true, force: true, maxRetries: 5, retryDelay: 20}),
      ),
  );
});

function profile(): HarnessProfile {
  return {
    id: 'writer',
    name: 'Writer',
    role: 'Write.',
    enabledTools: [
      'read_memory',
      'update_memory',
      'prune_memory',
      'load_skill',
      'save_skill',
    ],
    enabledSkills: ['triage'],
  };
}

function tool(name: string) {
  const found = CORE_TOOLS.find((candidate) => candidate.name === name);
  if (found === undefined) {
    throw new Error(`No tool ${name}`);
  }
  return found;
}

describe('memory and skill tools', () => {
  it('offers them only when their service is present', () => {
    const spec = resolveHarness({profile: profile(), app, version: 1});
    expect(
      toolsFor(spec, {memory: true, skills: true}).map((entry) => entry.name),
    ).toEqual([
      'read_memory',
      'update_memory',
      'prune_memory',
      'load_skill',
      'save_skill',
    ]);
    expect(toolsFor(spec, {memory: false, skills: false})).toEqual([]);
    expect(
      toolsFor(spec, {memory: true, skills: false}).map((entry) => entry.name),
    ).toEqual(['read_memory', 'update_memory', 'prune_memory']);
  });

  it('reads, writes and prunes a real memory file', async () => {
    const dir = await workDir();
    const memory = new MemoryStore({
      workspaceRoot: dir,
      personMemoryRoot: join(dir, 'person'),
      profileId: 'writer',
    });
    const context: ToolContext = {
      workspaceRoot: dir,
      signal: new AbortController().signal,
      memory,
    };

    expect(
      String((await tool('read_memory').execute({}, context)).result),
    ).toContain('Memory is empty');
    const written = await tool('update_memory').execute(
      {content: '- prefers tabs', section: 'Preferences and tone'},
      context,
    );
    expect(written.ok).toBe(true);
    expect(String(written.result)).toContain('Updated memory');
    expect(await memory.read()).toContain('prefers tabs');

    const pruned = await tool('prune_memory').execute(
      {content: '## Preferences and tone\n- prefers tabs', reason: 'dedupe'},
      context,
    );
    expect(pruned.ok).toBe(true);
    expect(String(pruned.result)).toContain('Pruned memory');
  });

  it('loads a granted skill and refuses one it does not carry', async () => {
    const skills: SkillToolService = {
      load: async (name) => ({
        ...(name === 'triage'
          ? {
              skill: {
                name: 'triage',
                description: 'Sort an inbox.',
                instructions: 'Do the steps.',
              },
            }
          : {}),
        names: ['triage'],
      }),
      save: async (input) => ({name: input.name, updated: false}),
    };
    const context: ToolContext = {
      workspaceRoot: '/tmp',
      signal: new AbortController().signal,
      skills,
    };
    const hit = await tool('load_skill').execute({name: 'triage'}, context);
    expect(hit).toMatchObject({ok: true});
    expect(String(hit.result)).toContain('Do the steps.');

    const miss = await tool('load_skill').execute({name: 'other'}, context);
    expect(miss.ok).toBe(false);
    expect(String(miss.result)).toContain('triage');

    const saved = await tool('save_skill').execute(
      {
        name: 'weekly',
        description: 'Weekly review.',
        instructions: 'Do the review.',
      },
      context,
    );
    expect(saved).toMatchObject({ok: true});
  });

  it('puts memory and the skill index in the prompt, not the skill body', () => {
    const spec = resolveHarness({profile: profile(), app, version: 1});
    const prompt = composeHarnessInstruction(spec, {
      memory: '## Notes\n- prefers tabs',
      skills: [{name: 'triage', description: 'Sort an inbox.'}],
    });
    expect(prompt).toContain('prefers tabs');
    expect(prompt).toContain('triage — Sort an inbox.');
    expect(prompt).not.toContain('Do the steps.');
  });
});
