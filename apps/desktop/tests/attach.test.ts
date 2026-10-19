/**
 * Which picked files a conversation may attach.
 *
 * Every rule here is one that fails *quietly* if it is wrong. A file outside the
 * folder looks attached and is refused by the agent a turn later, in an answer
 * about a missing path; a binary file looks attached and comes back as "that
 * looks like a binary file", which reads as the agent's mistake rather than the
 * app's. Neither is visible from the window, so both are pinned here.
 *
 * The symlink case is invariant 6 in miniature: a link that sits inside the
 * folder and points out of it is the one way a path that looks confined is not.
 */
import {mkdir, mkdtemp, rm, symlink, writeFile} from 'node:fs/promises';
import {join} from 'node:path';

import {afterEach, beforeEach, describe, expect, it} from 'vitest';

import {attachableFiles} from '../src/main/attach.js';

let dir: string;
let root: string;

beforeEach(async () => {
  // Under the working directory rather than /tmp: a sandbox that only permits
  // writes inside the repository still runs these.
  dir = await mkdtemp(join(process.cwd(), '.marimo-attach-'));
  root = join(dir, 'project');
  await mkdir(join(root, 'src'), {recursive: true});
  await mkdir(join(dir, 'elsewhere'), {recursive: true});
});

afterEach(async () => {
  await rm(dir, {recursive: true, force: true, maxRetries: 5, retryDelay: 20});
});

describe('attaching files to a message', () => {
  it('accepts a text file, named relative to the folder', async () => {
    await writeFile(join(root, 'src', 'index.ts'), 'export const one = 1;\n');

    const {files, skipped} = await attachableFiles(root, [
      join(root, 'src', 'index.ts'),
    ]);

    expect(skipped).toEqual([]);
    expect(files).toEqual([
      {
        path: join(root, 'src', 'index.ts'),
        name: 'index.ts',
        relative: join('src', 'index.ts'),
      },
    ]);
  });

  it('refuses a file outside the space, and says which space', async () => {
    await writeFile(join(dir, 'elsewhere', 'notes.md'), 'private\n');

    const {files, skipped} = await attachableFiles(root, [
      join(dir, 'elsewhere', 'notes.md'),
    ]);

    expect(files).toEqual([]);
    expect(skipped).toHaveLength(1);
    /*
     * The reason names the space rather than saying "outside". The user chose
     * the file in a dialog that let them go anywhere; the sentence that helps is
     * the one that says what the boundary was.
     */
    expect(skipped[0]?.reason).toContain(root);
    expect(skipped[0]?.name).toBe('notes.md');
  });

  it('refuses a link that points out of the space', async () => {
    await writeFile(join(dir, 'elsewhere', 'secret.txt'), 'not yours\n');
    await symlink(join(dir, 'elsewhere', 'secret.txt'), join(root, 'link.txt'));

    const {files, skipped} = await attachableFiles(root, [
      join(root, 'link.txt'),
    ]);

    expect(files).toEqual([]);
    expect(skipped[0]?.reason).toContain('Outside the space');
  });

  it('refuses a file that is not text', async () => {
    // A NUL byte in the first block: the same test `read_file` makes.
    await writeFile(
      join(root, 'shot.png'),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]),
    );

    const {files, skipped} = await attachableFiles(root, [
      join(root, 'shot.png'),
    ]);

    expect(files).toEqual([]);
    expect(skipped[0]?.reason).toContain('not text');
  });

  it('refuses a folder and a path that does not exist', async () => {
    const {files, skipped} = await attachableFiles(root, [
      join(root, 'src'),
      join(root, 'ghost.txt'),
    ]);

    expect(files).toEqual([]);
    expect(skipped.map((entry) => entry.reason)).toEqual([
      'Not a regular file.',
      'That file could not be read.',
    ]);
  });

  it('keeps the accepted files when one of the picks is refused', async () => {
    await writeFile(join(root, 'keep.md'), '# keep\n');
    await writeFile(join(dir, 'elsewhere', 'drop.md'), '# drop\n');

    const {files, skipped} = await attachableFiles(root, [
      join(root, 'keep.md'),
      join(dir, 'elsewhere', 'drop.md'),
    ]);

    // One bad pick must not take the good ones down with it: the user multi-
    // selected, and a refusal is a note beside the message, not a failed action.
    expect(files.map((file) => file.name)).toEqual(['keep.md']);
    expect(skipped.map((entry) => entry.name)).toEqual(['drop.md']);
  });
});
