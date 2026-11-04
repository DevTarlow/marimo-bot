import {mkdir, mkdtemp, readFile, rm, stat, writeFile} from 'node:fs/promises';
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
    expect(toolsFor(spec, {learning: true}).map((entry) => entry.name)).toEqual(
      ['request_tool', 'request_connector'],
    );
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
    expect(gateFor(spec, 'move_file')).toBe('on-overwrite');
    expect(gateFor(spec, 'delete_file')).toBe('always');
    expect(gateFor(spec, 'read_file')).toBe('never');
    // Renaming asks nothing, because it refuses a taken name rather than
    // replacing what is there: there is nothing for a card to warn about.
    expect(gateFor(spec, 'rename_file')).toBe('never');
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

  it('deletes one file', async () => {
    const dir = await workDir();
    await writeFile(join(dir, 'old.txt'), 'x', 'utf8');
    const result = await tool('delete_file').execute(
      {path: 'old.txt'},
      context(dir),
    );
    expect(result.ok).toBe(true);
    expect(String(result.result)).toContain('Deleted old.txt');
    await expect(stat(join(dir, 'old.txt'))).rejects.toThrow();
  });

  /*
   * One file per call, and never a folder. A recursive delete is the one
   * mistake in this tool that cannot be undone, so the shape of the call makes
   * it impossible rather than the prompt asking nicely.
   */
  it('refuses to delete a folder', async () => {
    const dir = await workDir();
    await mkdir(join(dir, 'notes'));
    const result = await tool('delete_file').execute(
      {path: 'notes'},
      context(dir),
    );
    expect(result.ok).toBe(false);
    expect(String(result.result)).toContain('folder');
    expect((await stat(join(dir, 'notes'))).isDirectory()).toBe(true);
  });

  it('refuses to delete a path that leaves the Space', async () => {
    const dir = await workDir();
    const result = await tool('delete_file').execute(
      {path: '../outside.txt'},
      context(dir),
    );
    expect(result.ok).toBe(false);
    expect(String(result.result)).toContain('outside the workspace');
  });

  it('refuses to delete a file that is not there', async () => {
    const dir = await workDir();
    const result = await tool('delete_file').execute(
      {path: 'missing.txt'},
      context(dir),
    );
    expect(result.ok).toBe(false);
    expect(String(result.result)).toContain('no such file');
  });

  it('renames a file and creates the folder it moves into', async () => {
    const dir = await workDir();
    await writeFile(join(dir, 'draft.md'), 'hello', 'utf8');
    const result = await tool('move_file').execute(
      {path: 'draft.md', to: 'archive/2026/draft.md'},
      context(dir),
    );
    expect(result.ok).toBe(true);
    expect(String(result.result)).toContain('Moved draft.md');
    expect(await readFile(join(dir, 'archive/2026/draft.md'), 'utf8')).toBe(
      'hello',
    );
    await expect(stat(join(dir, 'draft.md'))).rejects.toThrow();
  });

  it('replaces an existing destination', async () => {
    const dir = await workDir();
    await writeFile(join(dir, 'new.txt'), 'new', 'utf8');
    await writeFile(join(dir, 'old.txt'), 'old', 'utf8');
    const result = await tool('move_file').execute(
      {path: 'new.txt', to: 'old.txt'},
      context(dir),
    );
    expect(result.ok).toBe(true);
    expect(String(result.result)).toContain('Replaced new.txt → old.txt');
    expect(await readFile(join(dir, 'old.txt'), 'utf8')).toBe('new');
  });

  it('refuses to move a folder', async () => {
    const dir = await workDir();
    await mkdir(join(dir, 'notes'));
    const result = await tool('move_file').execute(
      {path: 'notes', to: 'archive'},
      context(dir),
    );
    expect(result.ok).toBe(false);
    expect(String(result.result)).toContain('folder');
  });

  it('refuses to move onto a folder', async () => {
    const dir = await workDir();
    await writeFile(join(dir, 'file.txt'), 'x', 'utf8');
    await mkdir(join(dir, 'notes'));
    const result = await tool('move_file').execute(
      {path: 'file.txt', to: 'notes'},
      context(dir),
    );
    expect(result.ok).toBe(false);
    expect(String(result.result)).toContain('folder');
  });

  it('refuses a move that leaves the Space', async () => {
    const dir = await workDir();
    await writeFile(join(dir, 'file.txt'), 'x', 'utf8');
    const result = await tool('move_file').execute(
      {path: 'file.txt', to: '../outside.txt'},
      context(dir),
    );
    expect(result.ok).toBe(false);
    expect(String(result.result)).toContain('outside the workspace');
  });

  it('refuses a move onto itself', async () => {
    const dir = await workDir();
    await writeFile(join(dir, 'file.txt'), 'x', 'utf8');
    const result = await tool('move_file').execute(
      {path: 'file.txt', to: './file.txt'},
      context(dir),
    );
    expect(result.ok).toBe(false);
    expect(String(result.result)).toContain('already at that path');
  });

  it('renames a file in the folder it is already in', async () => {
    const dir = await workDir();
    await mkdir(join(dir, 'notes'));
    await writeFile(join(dir, 'notes/draft.md'), 'hello', 'utf8');
    const result = await tool('rename_file').execute(
      {path: 'notes/draft.md', name: 'garden.md'},
      context(dir),
    );
    expect(result.ok).toBe(true);
    expect(String(result.result)).toContain(
      'Renamed notes/draft.md → garden.md',
    );
    expect(await readFile(join(dir, 'notes/garden.md'), 'utf8')).toBe('hello');
    await expect(stat(join(dir, 'notes/draft.md'))).rejects.toThrow();
    // The folder stays where it was: that is the whole difference from move_file.
    expect((await stat(join(dir, 'notes'))).isDirectory()).toBe(true);
  });

  it('refuses a name that is already taken instead of replacing it', async () => {
    const dir = await workDir();
    await writeFile(join(dir, 'draft.md'), 'draft', 'utf8');
    await writeFile(join(dir, 'final.md'), 'final', 'utf8');
    const result = await tool('rename_file').execute(
      {path: 'draft.md', name: 'final.md'},
      context(dir),
    );
    expect(result.ok).toBe(false);
    expect(String(result.result)).toContain('will not replace');
    // Both files survive with their own contents: a refusal writes nothing.
    expect(await readFile(join(dir, 'draft.md'), 'utf8')).toBe('draft');
    expect(await readFile(join(dir, 'final.md'), 'utf8')).toBe('final');
  });

  it('refuses a new name that is a path rather than a name', async () => {
    const dir = await workDir();
    await writeFile(join(dir, 'draft.md'), 'x', 'utf8');
    for (const name of ['archive/draft.md', '../draft.md', '..']) {
      const result = await tool('rename_file').execute(
        {path: 'draft.md', name},
        context(dir),
      );
      expect(result.ok).toBe(false);
      expect(String(result.result)).toContain('is a path, not a name');
    }
  });

  it('refuses to rename a folder', async () => {
    const dir = await workDir();
    await mkdir(join(dir, 'notes'));
    const result = await tool('rename_file').execute(
      {path: 'notes', name: 'archive'},
      context(dir),
    );
    expect(result.ok).toBe(false);
    expect(String(result.result)).toContain('folder');
  });

  it('refuses to rename a file that is not there', async () => {
    const dir = await workDir();
    const result = await tool('rename_file').execute(
      {path: 'missing.md', name: 'other.md'},
      context(dir),
    );
    expect(result.ok).toBe(false);
    expect(String(result.result)).toContain('no such file');
  });

  it('refuses a rename that leaves the Space', async () => {
    const dir = await workDir();
    const result = await tool('rename_file').execute(
      {path: '../outside.md', name: 'inside.md'},
      context(dir),
    );
    expect(result.ok).toBe(false);
    expect(String(result.result)).toContain('outside the workspace');
  });

  it('says when a file already has that name', async () => {
    const dir = await workDir();
    await writeFile(join(dir, 'draft.md'), 'x', 'utf8');
    const result = await tool('rename_file').execute(
      {path: 'draft.md', name: 'draft.md'},
      context(dir),
    );
    expect(result.ok).toBe(false);
    expect(String(result.result)).toContain('already named that');
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
