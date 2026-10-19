import {mkdtemp, rm} from 'node:fs/promises';
import {join} from 'node:path';

import {afterEach, describe, expect, it} from 'vitest';

import {MemoryStore} from '../memory/memory-store.js';
import {resolveHarness} from '../harness/resolve.js';
import type {HarnessAppDefaults, HarnessProfile} from '../harness/spec.js';
import {composeHarnessInstruction} from '../context/instruction.js';
import {CORE_TOOLS, toolsFor} from './core-tools.js';
import type {SkillToolService, ToolContext} from './tool-contract.js';
import type {RecallLookup} from '../tools/recall-tools.js';
import type {JobService} from '../tools/job-tools.js';

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

  it('asks another bot only when delegation is available', async () => {
    const spec = resolveHarness({
      profile: {...profile(), enabledTools: ['ask_agent']},
      app,
      version: 1,
    });
    expect(toolsFor(spec, {delegate: false})).toEqual([]);
    expect(toolsFor(spec, {delegate: true}).map((entry) => entry.name)).toEqual(
      ['ask_agent'],
    );
    const result = await tool('ask_agent').execute(
      {agent: 'Reader', task: 'What do you think?'},
      {
        workspaceRoot: '/tmp',
        signal: new AbortController().signal,
        delegate: async ({agent, task}) => ({
          ok: true,
          result: `${agent}: ${task}`,
        }),
      },
    );
    expect(result).toMatchObject({ok: true});
    expect(String(result.result)).toContain('Reader: What do you think?');
  });

  it('searches recall only when an index is available', async () => {
    const spec = resolveHarness({
      profile: {...profile(), enabledTools: ['recall']},
      app,
      version: 1,
    });
    expect(toolsFor(spec, {recall: false})).toEqual([]);
    const recall: RecallLookup = {
      scopes: () => ['folder'],
      search: async () => ({
        hits: [
          {
            kind: 'text',
            path: 'notes.md',
            startLine: 4,
            preview: 'the retry loop',
            score: 0.8,
            text: 'The retry loop backs off.',
            stale: false,
          },
        ],
        searched: ['folder'],
        notes: [],
      }),
    };
    expect(toolsFor(spec, {recall: true}).map((entry) => entry.name)).toEqual([
      'recall',
    ]);
    const result = await tool('recall').execute(
      {query: 'how retries work'},
      {
        workspaceRoot: '/tmp',
        signal: new AbortController().signal,
        recall,
      },
    );
    expect(result).toMatchObject({ok: true});
    expect(String(result.result)).toContain('notes.md:4');
    expect(String(result.result)).toContain('backs off');
  });

  it('schedules a job only when a job service is present', async () => {
    const spec = resolveHarness({
      profile: {
        ...profile(),
        enabledTools: ['list_jobs', 'create_job', 'update_job', 'delete_job'],
      },
      app,
      version: 1,
    });
    expect(toolsFor(spec, {jobs: false})).toEqual([]);
    const made: Array<Record<string, unknown>> = [];
    const jobs: JobService = {
      list: async () => [],
      create: async (input) => {
        made.push(input);
        return {
          id: 'job-1',
          name: input.name,
          description: input.description,
          schedules: input.schedules ?? ['0 9 * * *'],
          enabled: true,
          profileId: input.profileId,
          sessionId: input.sessionId,
          createdAt: '2026-01-01T00:00:00.000Z',
        };
      },
      update: async () => null,
      remove: async () => false,
    };
    const context = {
      workspaceRoot: '/tmp',
      signal: new AbortController().signal,
      jobs,
      profileId: 'writer',
      sessionId: 's1',
    };
    expect(toolsFor(spec, {jobs: true}).map((entry) => entry.name)).toEqual([
      'list_jobs',
      'create_job',
      'update_job',
      'delete_job',
    ]);
    const created = await tool('create_job').execute(
      {
        name: 'Morning digest',
        description: 'Summarise the inbox.',
        schedules: ['0 9 * * *'],
      },
      context,
    );
    expect(created).toMatchObject({ok: true});
    expect(made[0]).toMatchObject({
      name: 'Morning digest',
      profileId: 'writer',
      sessionId: 's1',
    });
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
