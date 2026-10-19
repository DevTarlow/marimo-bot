import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';

import {afterEach, describe, expect, it} from 'vitest';

import {resolveHarness} from '../harness/resolve.js';
import type {
  HarnessAppDefaults,
  HarnessProfile,
  HarnessSpec,
} from '../harness/spec.js';
import {CORE_TOOLS, gateFor, toolsFor} from './core-tools.js';
import type {ToolContext} from './tool-contract.js';

const app: HarnessAppDefaults = {
  model: {provider: 'deepseek', model: 'deepseek-chat'},
  allowPrivateNetworkFetch: false,
  learning: {mode: 'propose', retainTraces: false},
};

const profile: HarnessProfile = {
  id: 'writer',
  name: 'Writer',
  role: 'Write.',
  enabledTools: [
    'read_file',
    'list_dir',
    'write_file',
    'run_shell',
    'current_time',
  ],
  enabledSkills: [],
};

const roots: string[] = [];

async function workDir(): Promise<string> {
  const dir = await mkdtemp(join(process.cwd(), '.marimo-core-tools-'));
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

function harness(root?: string, grants?: string[]): HarnessSpec {
  return resolveHarness({
    profile:
      grants === undefined ? profile : {...profile, enabledTools: grants},
    app,
    version: 1,
    ...(root === undefined ? {} : {workspaceRoot: root}),
  });
}

function tool(name: string) {
  const found = CORE_TOOLS.find((candidate) => candidate.name === name);
  if (found === undefined) {
    throw new Error(`No tool ${name}`);
  }
  return found;
}

function context(root: string): ToolContext {
  return {workspaceRoot: root, signal: new AbortController().signal};
}

describe('toolsFor', () => {
  it('offers only the tools the profile granted', () => {
    expect(
      toolsFor(harness(undefined, ['current_time'])).map((tool) => tool.name),
    ).toEqual(['current_time']);
  });

  it('does not offer a workspace tool when there is no Space', () => {
    const names = toolsFor(
      harness(undefined, ['current_time', 'read_file']),
    ).map((tool) => tool.name);
    expect(names).toEqual(['current_time']);
  });

  /*
   * The request tools are the one pair whose availability is about the runtime
   * rather than the Space. A turn with no inbox cannot record a proposal, and a
   * tool that answers "cannot ask" is a capability the model would narrate.
   */
  it('offers a request tool only when there is an inbox to record into', () => {
    const spec = harness('/tmp/space', ['request_tool', 'request_connector']);
    expect(toolsFor(spec, {}).map((entry) => entry.name)).toEqual([]);
    expect(
      toolsFor(spec, {learning: true}).map((entry) => entry.name),
    ).toEqual(['request_tool', 'request_connector']);
  });

  it('offers a workspace tool when there is a Space', () => {
    expect(
      toolsFor(harness('/tmp/space', ['current_time', 'read_file'])).map(
        (tool) => tool.name,
      ),
    ).toEqual(['current_time', 'read_file']);
  });
});

describe('gateFor', () => {
  it('gates the shell always and an overwrite on the arguments', () => {
    const spec = harness('/tmp/space');
    expect(gateFor(spec, 'run_shell')).toBe('always');
    expect(gateFor(spec, 'write_file')).toBe('on-overwrite');
    expect(gateFor(spec, 'read_file')).toBe('never');
  });
});

describe('the core tools', () => {
  it('answers the time without a Space', async () => {
    const result = await tool('current_time').execute(
      {},
      {
        workspaceRoot: '',
        signal: new AbortController().signal,
      },
    );
    expect(result.ok).toBe(true);
    expect(String(result.ok ? result.result : '')).toMatch(/^20\d\d-/);
  });

  it('creates parent folders and writes a file', async () => {
    const dir = await workDir();
    const result = await tool('write_file').execute(
      {path: 'notes/today.md', content: 'hello'},
      context(dir),
    );
    expect(result.ok).toBe(true);
    expect(await readFile(join(dir, 'notes/today.md'), 'utf8')).toBe('hello');
  });

  it('refuses a path that leaves the Space', async () => {
    const dir = await workDir();
    const result = await tool('read_file').execute(
      {path: '../outside.txt'},
      context(dir),
    );
    expect(result.ok).toBe(false);
    expect(String(result.result)).toContain('outside the workspace');
  });

  it('truncates a large read and says so', async () => {
    const dir = await workDir();
    await writeFile(
      join(dir, 'large.txt'),
      'x'.repeat(1024 * 1024 + 10),
      'utf8',
    );
    const result = await tool('read_file').execute(
      {path: 'large.txt'},
      context(dir),
    );
    expect(result.ok).toBe(true);
    expect(String(result.result)).toContain('[truncated:');
  });

  it('lists a folder and marks a directory', async () => {
    const dir = await workDir();
    await writeFile(join(dir, 'file.txt'), 'x', 'utf8');
    const result = await tool('list_dir').execute({path: '.'}, context(dir));
    expect(result.ok).toBe(true);
    expect(String(result.result)).toContain('file file.txt');
    expect(String(result.result)).toContain('entry');
  });
});
