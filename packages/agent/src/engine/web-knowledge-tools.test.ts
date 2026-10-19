import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';

import {afterEach, describe, expect, it} from 'vitest';

import {resolveHarness} from '../harness/resolve.js';
import type {HarnessAppDefaults, HarnessProfile} from '../harness/spec.js';
import {CORE_TOOLS, toolsFor} from './core-tools.js';
import type {WebSearchProvider} from '../tools/web-search-tool.js';

const app: HarnessAppDefaults = {
  model: {provider: 'deepseek', model: 'deepseek-chat'},
  allowPrivateNetworkFetch: false,
  learning: {mode: 'propose', retainTraces: false},
};

const profile: HarnessProfile = {
  id: 'writer',
  name: 'Writer',
  role: 'Write.',
  enabledTools: ['http_fetch', 'web_search', 'search_knowledge_base'],
  enabledSkills: [],
};

const roots: string[] = [];

async function workDir(): Promise<string> {
  const dir = await mkdtemp(join(process.cwd(), '.marimo-web-tools-'));
  roots.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((dir) =>
      rm(dir, {recursive: true, force: true, maxRetries: 5, retryDelay: 20}),
    ),
  );
});

function tool(name: string) {
  const found = CORE_TOOLS.find((candidate) => candidate.name === name);
  if (found === undefined) {
    throw new Error(`No tool ${name}`);
  }
  return found;
}

function harness() {
  return resolveHarness({profile, app, version: 1, workspaceRoot: '/tmp'});
}

describe('the web and knowledge tools', () => {
  it('offers web_search only with a provider and fetch without one', () => {
    expect(toolsFor(harness(), {webSearch: false}).map((entry) => entry.name)).toEqual([
      'http_fetch',
      'search_knowledge_base',
    ]);
    expect(toolsFor(harness(), {webSearch: true}).map((entry) => entry.name)).toContain(
      'web_search',
    );
  });

  it('refuses a loopback fetch when private network access is off', async () => {
    const result = await tool('http_fetch').execute(
      {url: 'http://127.0.0.1/admin'},
      {
        workspaceRoot: '/tmp',
        signal: new AbortController().signal,
        allowPrivateNetworkFetch: false,
      },
    );
    expect(result.ok).toBe(false);
    expect(String(result.result)).toContain('private or loopback');
  });

  it('formats web search results and citations', async () => {
    const provider: WebSearchProvider = {
      search: async () => [
        {
          title: 'Retries',
          url: 'https://example.com/retries',
          snippet: 'Back off and retry.',
        },
      ],
    };
    const result = await tool('web_search').execute(
      {query: 'retry strategy'},
      {
        workspaceRoot: '/tmp',
        signal: new AbortController().signal,
        webSearch: provider,
      },
    );
    expect(result.ok).toBe(true);
    expect(String(result.result)).toContain('https://example.com/retries');
    expect(String(result.result)).toContain('Retries');
  });

  it('finds a literal phrase in the Space', async () => {
    const dir = await workDir();
    await writeFile(join(dir, 'notes.md'), 'first line\nthe deploy runs at noon\n', 'utf8');
    const result = await tool('search_knowledge_base').execute(
      {query: 'deploy runs'},
      {workspaceRoot: dir, signal: new AbortController().signal},
    );
    expect(result.ok).toBe(true);
    expect(String(result.result)).toContain('notes.md:2');
    expect(String(result.result)).toContain('deploy runs at noon');
  });
});
