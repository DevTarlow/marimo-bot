/**
 * Filesystem tool tests.
 *
 * The tools are exercised through `runAsync`, which is the same path ADK takes,
 * so argument validation and the confirmation predicate are covered rather than
 * bypassed.
 */
import {mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';

import type {BaseTool, Context} from '@google/adk';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {
  createCurrentTimeTool,
  createListDirTool,
  createReadFileTool,
  createWriteFileTool,
} from './fs-tools.js';

/** ADK only reaches for the context when a tool is gated. */
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

/**
 * The resume half of the approval round trip: ADK re-runs the call with the
 * user's confirmation attached. Anything else the context offers is unused by
 * these tools, so a confirmation flag is the whole context they need.
 */
async function runApproved(
  tool: BaseTool,
  args: Record<string, unknown>,
): Promise<string> {
  const result = await tool.runAsync({
    args,
    toolContext: {
      toolConfirmation: {confirmed: true},
    } as unknown as Context,
  });
  return typeof result === 'string' ? result : JSON.stringify(result);
}

async function gated(
  tool: BaseTool,
  args: Record<string, unknown>,
): Promise<boolean> {
  return await tool.checkRequireConfirmation(args);
}

describe('filesystem tools', () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(process.cwd(), '.marimo-fs-'));
  });

  afterEach(async () => {
    await rm(workDir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 20,
    });
  });

  describe('read_file', () => {
    it('returns the contents with a location header', async () => {
      await writeFile(join(workDir, 'notes.txt'), 'hello\n', 'utf8');
      const output = await run(createReadFileTool({workspaceRoot: workDir}), {
        path: 'notes.txt',
      });
      expect(output).toContain('hello');
      expect(output).toContain(join(workDir, 'notes.txt'));
    });

    it('truncates a large file and says how to continue', async () => {
      await writeFile(join(workDir, 'big.txt'), 'x'.repeat(70 * 1024), 'utf8');
      const output = await run(createReadFileTool({workspaceRoot: workDir}), {
        path: 'big.txt',
      });
      expect(output).toContain('[truncated: re-read with a larger offset');
    });

    it('points at list_dir for a directory', async () => {
      await mkdir(join(workDir, 'sub'));
      const output = await run(createReadFileTool({workspaceRoot: workDir}), {
        path: 'sub',
      });
      expect(output).toContain('is a directory');
    });

    it('refuses a path outside the workspace', async () => {
      const tool = createReadFileTool({workspaceRoot: workDir});
      await expect(run(tool, {path: '../secrets.txt'})).rejects.toThrow(
        /outside the workspace/,
      );
    });
  });

  describe('list_dir', () => {
    it('lists directories first, with sizes', async () => {
      await mkdir(join(workDir, 'sub'));
      await writeFile(join(workDir, 'a.txt'), 'abc', 'utf8');
      const output = await run(createListDirTool({workspaceRoot: workDir}), {
        path: '.',
      });
      const subIndex = output.indexOf('sub/');
      const fileIndex = output.indexOf('a.txt');
      expect(subIndex).toBeGreaterThan(-1);
      expect(fileIndex).toBeGreaterThan(subIndex);
      expect(output).toContain('(3 bytes)');
    });

    it('defaults to the workspace root when no path is given', async () => {
      await writeFile(join(workDir, 'a.txt'), 'abc', 'utf8');
      const output = await run(createListDirTool({workspaceRoot: workDir}), {});
      expect(output).toContain(workDir);
      expect(output).toContain('a.txt');
    });
  });

  describe('write_file', () => {
    it('creates a new file and its parent directories', async () => {
      const tool = createWriteFileTool({workspaceRoot: workDir});
      const output = await run(tool, {
        path: 'a/b/c.txt',
        content: 'hello',
      });
      expect(output).toContain('new file');
      expect(await readFile(join(workDir, 'a', 'b', 'c.txt'), 'utf8')).toBe(
        'hello',
      );
    });

    it('reports the size change when replacing a file', async () => {
      await writeFile(join(workDir, 'note.md'), 'old', 'utf8');
      const output = await runApproved(
        createWriteFileTool({workspaceRoot: workDir}),
        {path: 'note.md', content: 'brand new'},
      );
      expect(output).toContain('Replaced');
      expect(output).toContain('3 → 9 bytes');
    });

    it('refuses a directory target', async () => {
      await mkdir(join(workDir, 'sub'));
      const output = await run(createWriteFileTool({workspaceRoot: workDir}), {
        path: 'sub',
        content: 'nope',
      });
      expect(output).toContain('is a directory');
    });

    it('refuses a path outside the workspace without throwing', async () => {
      const output = await run(createWriteFileTool({workspaceRoot: workDir}), {
        path: '../escape.txt',
        content: 'nope',
      });
      expect(output).toContain('outside the workspace');
    });

    it('refuses contents over the size cap', async () => {
      const output = await run(createWriteFileTool({workspaceRoot: workDir}), {
        path: 'big.txt',
        content: 'x'.repeat(1024 * 1024 + 1),
      });
      expect(output).toContain('Refusing to write');
      await expect(
        readFile(join(workDir, 'big.txt'), 'utf8'),
      ).rejects.toThrow();
    });

    it('does not gate a brand-new file', async () => {
      const tool = createWriteFileTool({workspaceRoot: workDir});
      expect(await gated(tool, {path: 'fresh.txt', content: 'x'})).toBe(false);
    });

    it('gates an overwrite', async () => {
      await writeFile(join(workDir, 'existing.txt'), 'old', 'utf8');
      const tool = createWriteFileTool({workspaceRoot: workDir});
      expect(await gated(tool, {path: 'existing.txt', content: 'y'})).toBe(
        true,
      );
    });

    it('gates nothing when the path cannot be resolved', async () => {
      const tool = createWriteFileTool({workspaceRoot: workDir});
      expect(await gated(tool, {path: '../outside.txt', content: 'x'})).toBe(
        false,
      );
    });

    it('gates nothing when the target is a directory', async () => {
      await mkdir(join(workDir, 'sub'));
      const tool = createWriteFileTool({workspaceRoot: workDir});
      expect(await gated(tool, {path: 'sub', content: 'x'})).toBe(false);
    });
  });

  /*
   * The bug this pins down, from a real conversation: the output led with the ISO
   * instant, and the model answered a request for the time with that instant's
   * UTC reading — "6:37 PM" for 23:37 local — because a tool result is read from
   * the front.
   *
   * The expectations are computed from the frozen date's own local getters rather
   * than written as a literal, so this passes in every timezone and still fails
   * the moment the answer stops being the local wall clock.
   */
  describe('current_time', () => {
    it('leads with the local wall clock, keeping the instant as a footnote', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-10-09T06:37:50.589Z'));
      try {
        const text = await run(createCurrentTimeTool(), {});
        const now = new Date();
        const hour12 = ((now.getHours() + 11) % 12) + 1;
        const minute = String(now.getMinutes()).padStart(2, '0');
        const meridiem = now.getHours() < 12 ? 'AM' : 'PM';

        expect(text.startsWith(`${hour12}:${minute} ${meridiem}`)).toBe(true);
        // The old output's first token, and therefore the old answer.
        expect(text.startsWith(now.toISOString())).toBe(false);
        // The instant is still there, after the time that was asked for.
        expect(text).toContain(now.toISOString());
        expect(text.indexOf(now.toISOString())).toBeGreaterThan(
          text.indexOf(meridiem),
        );
        // Legible as a day as well as a clock, and labelled so neither reading
        // can be taken for the other.
        expect(text).toContain(
          now.toLocaleDateString('en-US', {weekday: 'long'}),
        );
        expect(text).toContain("the machine's local time");
        expect(text).toMatch(/UTC[+-]\d{2}:\d{2}/u);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
