import {readdir, readFile} from 'node:fs/promises';
import {join, relative} from 'node:path';

import {describe, expect, it} from 'vitest';

/**
 * The new core is allowed one door to ADK.
 *
 * The old host still imports ADK everywhere it needs to; it is being deleted.
 * The v2 modules are not allowed to grow a second door, because an ADK upgrade
 * that has to touch twenty files is an upgrade nobody can review.
 */
const ALLOWED = new Set(['src/engine/adk-driver.ts']);

async function sourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, {withFileTypes: true});
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await sourceFiles(path)));
    } else if (
      entry.name.endsWith('.ts') &&
      !entry.name.endsWith('.test.ts') &&
      !entry.name.endsWith('.d.ts')
    ) {
      files.push(path);
    }
  }
  return files;
}

describe('the v2 core boundary', () => {
  it('imports ADK only from the adapter', async () => {
    const root = process.cwd();
    const files = [
      ...(await sourceFiles(join(root, 'src', 'engine'))),
      ...(await sourceFiles(join(root, 'src', 'harness'))),
      ...(await sourceFiles(join(root, 'src', 'context'))),
    ];
    const offenders: string[] = [];
    for (const file of files) {
      const source = await readFile(file, 'utf8');
      if (source.includes("from '@google/adk'")) {
        const name = relative(root, file);
        if (!ALLOWED.has(name)) {
          offenders.push(name);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
