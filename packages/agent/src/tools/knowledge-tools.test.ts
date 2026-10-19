/**
 * Knowledge search tests.
 *
 * The walk's caps are the interesting part: the tool runs inside a chat turn, so
 * one badly chosen query must not read a whole repository or flood the context.
 */
import {mkdtemp, mkdir, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';

import type {BaseTool, Context} from '@google/adk';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';

import {
  createSearchKnowledgeBaseTool,
  searchWorkspace,
} from './knowledge-tools.js';

async function run(
  tool: BaseTool,
  args: Record<string, unknown>,
): Promise<string> {
  const result = await tool.runAsync({
    args,
    toolContext: undefined as unknown as Context,
  });
  return typeof result === 'string' ? result : JSON.stringify(result);
}

describe('search_knowledge_base', () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(process.cwd(), '.marimo-kb-'));
  });

  afterEach(async () => {
    await rm(workDir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 20,
    });
  });

  function tool(): BaseTool {
    return createSearchKnowledgeBaseTool({workspaceRoot: workDir});
  }

  it('finds a match and reports a relative path with the line number', async () => {
    await writeFile(
      join(workDir, 'src.txt'),
      'first line\nMARIMO_TOKEN\n',
      'utf8',
    );
    const output = await run(tool(), {query: 'marimo_token'});
    expect(output).toContain('src.txt:2: MARIMO_TOKEN');
    expect(output).toContain('1 match');
  });

  it('matches case-sensitively when asked', async () => {
    await writeFile(join(workDir, 'src.txt'), 'Marimo Bot\n', 'utf8');
    expect(
      await run(tool(), {query: 'Marimo Bot', caseSensitive: true}),
    ).toContain('1 match');
    expect(await run(tool(), {query: 'marimo', caseSensitive: true})).toContain(
      'No matches',
    );
  });

  it('says so when nothing matches', async () => {
    await writeFile(join(workDir, 'src.txt'), 'nothing here\n', 'utf8');
    const output = await run(tool(), {query: 'absent'});
    expect(output).toContain('No matches for "absent"');
    expect(output).toContain('1 file');
  });

  it('narrows the search to a subdirectory', async () => {
    await mkdir(join(workDir, 'a'));
    await mkdir(join(workDir, 'b'));
    await writeFile(join(workDir, 'a', 'one.txt'), 'target\n', 'utf8');
    await writeFile(join(workDir, 'b', 'two.txt'), 'target\n', 'utf8');
    const output = await run(tool(), {query: 'target', path: 'a'});
    expect(output).toContain('a/one.txt');
    expect(output).not.toContain('b/two.txt');
  });

  it('skips dependency, VCS, and agent folders', async () => {
    for (const directory of ['node_modules', '.git', '.marimo', 'dist']) {
      await mkdir(join(workDir, directory, 'nested'), {recursive: true});
      await writeFile(
        join(workDir, directory, 'nested', 'file.txt'),
        'target\n',
        'utf8',
      );
    }
    await writeFile(join(workDir, 'kept.txt'), 'target\n', 'utf8');
    const output = await run(tool(), {query: 'target'});
    expect(output).toContain('kept.txt');
    expect(output).not.toContain('node_modules');
    expect(output).not.toContain('.git');
    expect(output).not.toContain('.marimo');
    expect(output).not.toContain('dist/');
  });

  it('skips a binary file', async () => {
    await writeFile(join(workDir, 'blob.bin'), Buffer.from([0x74, 0x00, 0x61]));
    const output = await run(tool(), {query: 't'});
    expect(output).toContain('No matches');
  });

  it('caps the number of matches', async () => {
    await writeFile(
      join(workDir, 'many.txt'),
      Array.from({length: 30}, () => 'target').join('\n'),
      'utf8',
    );
    const output = await run(tool(), {query: 'target', maxResults: 5});
    expect(output).toContain('5+ matches');
    expect(
      output.split('\n').filter((line) => line.includes('many.txt')),
    ).toHaveLength(5);
    expect(output).toContain('result cap');
  });

  it('does not read a file over the size cap', async () => {
    await writeFile(join(workDir, 'huge.txt'), 'x'.repeat(300 * 1024), 'utf8');
    await writeFile(join(workDir, 'small.txt'), 'target\n', 'utf8');
    const outcome = await searchWorkspace(workDir, {query: 'target'});
    expect(outcome.matches.map((match) => match.file)).toEqual(['small.txt']);
    // The oversized file is counted nowhere; it is skipped, not read.
    expect(outcome.filesScanned).toBe(2);
  });

  it('refuses a path outside the workspace', async () => {
    const output = await run(tool(), {query: 'x', path: '../outside'});
    expect(output).toContain('outside the workspace');
  });

  it('reports the file count it actually scanned', async () => {
    await writeFile(join(workDir, 'one.txt'), 'a\n', 'utf8');
    await writeFile(join(workDir, 'two.txt'), 'b\n', 'utf8');
    const output = await run(tool(), {query: 'a'});
    expect(output).toContain('in 2 files');
  });
});
