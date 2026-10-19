/**
 * Where the workspace boundary actually is.
 *
 * The escape this file was written for is the one the resolver used to allow: a
 * symlink whose *target* does not exist. `realpath` reports ENOENT for that
 * exactly as it does for a name that was never there, so the leaf was
 * re-appended unchecked — `<root>/link -> /outside/missing` looked like an
 * ordinary new file inside the root. `write_file` followed the link and created
 * the file outside the workspace, and its own confirmation predicate returned
 * false because `stat` threw, so there was no approval card either.
 *
 * Every test that covered this path used `../`, which is why nothing caught it.
 */
import {mkdtemp, mkdir, rm, symlink, writeFile} from 'node:fs/promises';
import {join} from 'node:path';

import {afterEach, beforeEach, describe, expect, it} from 'vitest';

import {PathOutsideWorkspaceError, resolveInsideWorkspace} from './paths.js';

describe('resolveInsideWorkspace', () => {
  let base: string;
  let root: string;
  let outside: string;

  beforeEach(async () => {
    base = await mkdtemp(join(process.cwd(), '.marimo-paths-'));
    root = join(base, 'workspace');
    outside = join(base, 'outside');
    await mkdir(root);
    await mkdir(outside);
  });

  afterEach(async () => {
    await rm(base, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 20,
    });
  });

  it('resolves an ordinary file inside the root', async () => {
    const resolved = await resolveInsideWorkspace(root, 'notes.txt');
    expect(resolved).toBe(join(root, 'notes.txt'));
  });

  it('resolves a nested path that does not exist yet', async () => {
    const resolved = await resolveInsideWorkspace(root, 'a/b/c.txt');
    expect(resolved.startsWith(root)).toBe(true);
  });

  it('refuses a path that climbs out', async () => {
    await expect(
      resolveInsideWorkspace(root, '../outside/x'),
    ).rejects.toBeInstanceOf(PathOutsideWorkspaceError);
  });

  it('refuses an absolute path outside the root', async () => {
    await expect(
      resolveInsideWorkspace(root, join(outside, 'x')),
    ).rejects.toBeInstanceOf(PathOutsideWorkspaceError);
  });

  /*
   * The case that was missed. `realpath` says ENOENT for both "no such file" and
   * "a symlink whose target is missing", and treating the second as the first is
   * what let a write land outside the workspace with no approval.
   */
  it('refuses a symlink whose target does not exist', async () => {
    await symlink(join(outside, 'planted.txt'), join(root, 'link'));
    await expect(resolveInsideWorkspace(root, 'link')).rejects.toBeInstanceOf(
      PathOutsideWorkspaceError,
    );
  });

  it('refuses a symlink to a file that does exist outside', async () => {
    await writeFile(join(outside, 'real.txt'), 'secret');
    await symlink(join(outside, 'real.txt'), join(root, 'link'));
    await expect(resolveInsideWorkspace(root, 'link')).rejects.toBeInstanceOf(
      PathOutsideWorkspaceError,
    );
  });

  it('refuses a symlinked directory that points outside', async () => {
    await symlink(outside, join(root, 'escape'));
    await expect(
      resolveInsideWorkspace(root, 'escape/x.txt'),
    ).rejects.toBeInstanceOf(PathOutsideWorkspaceError);
  });

  /*
   * And the other direction, which matters as much: a legitimate link inside the
   * workspace has to keep working. A fix that refused every dangling symlink
   * would break a project that links its own files around.
   */
  it('allows a relative link that stays inside', async () => {
    await symlink('target.txt', join(root, 'internal'));
    const resolved = await resolveInsideWorkspace(root, 'internal');
    expect(resolved).toBe(join(root, 'target.txt'));
  });

  it('allows a link to a file that exists inside', async () => {
    await writeFile(join(root, 'real.txt'), 'hello');
    await symlink(join(root, 'real.txt'), join(root, 'link'));
    expect(await resolveInsideWorkspace(root, 'link')).toBe(
      join(root, 'real.txt'),
    );
  });

  it('resolves the root itself', async () => {
    expect(await resolveInsideWorkspace(root, '.')).toBe(root);
  });
});
