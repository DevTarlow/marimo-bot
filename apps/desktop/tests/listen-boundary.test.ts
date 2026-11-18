/**
 * The runner must never load ONNX.
 *
 * The app and the headless job runner are the same binary, and the runner is
 * the process that starts before a display server exists. `onnxruntime-node` is
 * a native module with a large model behind it; if it appears on the runtime's
 * import graph, every scheduled job pays for it. The split is therefore a
 * source-level boundary: the pure listen package contains no ORT import, and
 * the runner imports neither the host nor its loader.
 */
import {readFile, readdir} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

import {describe, expect, it} from 'vitest';

const appRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const repoRoot = dirname(dirname(appRoot));

describe('the voice-input boundary', () => {
  it('keeps onnxruntime-node out of the pure runtime package', async () => {
    const dir = join(repoRoot, 'packages', 'runtime', 'src', 'listen');
    const files = await readdir(dir);
    for (const file of files.filter((name) => name.endsWith('.ts'))) {
      const source = await readFile(join(dir, file), 'utf8');
      expect(source, file).not.toMatch(
        /(?:^|\n)\s*(?:import|export)[^\n]*onnxruntime|require\(\s*['"]onnxruntime/u,
      );
    }
  });

  it('keeps the host and loader out of the headless runner', async () => {
    const source = await readFile(
      join(appRoot, 'src', 'runner', 'run-due.ts'),
      'utf8',
    );
    expect(source).not.toMatch(/listen-host|listen-ort/u);
  });

  it('does load the host in the app process', async () => {
    const source = await readFile(
      join(appRoot, 'src', 'main', 'agent.ts'),
      'utf8',
    );
    expect(source).toContain("from './listen-host.js'");
  });
});
