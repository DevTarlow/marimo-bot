import {readFile} from 'node:fs/promises';
import {join} from 'node:path';

import {describe, expect, it} from 'vitest';

/**
 * The v2 facade must not reach back into the host it is replacing.
 *
 * The engine has its own boundary test for ADK. This is the layer above it: the
 * runtime that owns the canonical log, the ledger and the review may import the
 * agent package's stores, but not `AgentHost` or its host modules. A dependency
 * here would be invisible until somebody tried to delete the old turn path.
 */
const FILES = [
  'agent/harness-runtime.ts',
  'agent/harness-projection.ts',
  'harness-versions.ts',
];

describe('the v2 runtime boundary', () => {
  it('does not import the old host', async () => {
    const root = join(process.cwd(), 'src');
    const offenders: string[] = [];
    for (const name of FILES) {
      const source = await readFile(join(root, name), 'utf8');
      if (
        /\bAgentHost\b/u.test(source) ||
        /from\s+['"][^'"]*\/host\//u.test(source)
      ) {
        offenders.push(name);
      }
    }
    expect(offenders).toEqual([]);
  });
});
