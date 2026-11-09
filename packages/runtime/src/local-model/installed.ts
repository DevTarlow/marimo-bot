/**
 * What is actually on disk for recall's engine.
 *
 * The installer writes a marker only after a verified unpack, and the engine
 * checks it before running the binary. That is the whole safety story for the
 * one download this app still owns: an app update that moves to a new llama.cpp
 * tag leaves the old binary at the same path, and without the marker it would
 * look installed and go on running the engine this build no longer pins.
 *
 * The chat model used to have a second marker beside its weights. It is gone
 * with the download; the chat model is a server the person runs, so there are no
 * files here to verify.
 */
import {readFile, stat, writeFile} from 'node:fs/promises';
import {join} from 'node:path';

import {engineBinaryName, engineDir} from './files.js';
import type {EngineAsset} from './manifest.js';

/** The file that records which asset the unpacked engine came from. */
const ENGINE_MARKER = '.pinned';

/**
 * Whether the unpacked engine is the one this build pinned.
 *
 * A marker rather than a size check, because the engine binary has no pinned
 * size: without this, an app update that moved to a new llama.cpp tag — or from
 * one platform archive to another — would go on running the old engine, and
 * nothing would say so. The installer writes it only after a verified unpack.
 *
 * The marker names a list of archives. A marker written before that shape
 * existed has one `file`/`sha256` pair and still matches the single archive this
 * build ships.
 */
export async function engineIsPinned(
  root: string,
  asset: EngineAsset | readonly EngineAsset[],
  platform?: NodeJS.Platform,
): Promise<boolean> {
  if ((await sizeOf(join(engineDir(root), engineBinaryName(platform)))) < 0) {
    return false;
  }
  const expected = assetsOf(asset);
  try {
    const raw = await readFile(join(engineDir(root), ENGINE_MARKER), 'utf8');
    const parsed = JSON.parse(raw) as {
      files?: unknown;
      file?: unknown;
      sha256?: unknown;
    };
    const actual: EngineAsset[] = [];
    if (Array.isArray(parsed.files)) {
      for (const entry of parsed.files) {
        if (
          entry !== null &&
          typeof entry === 'object' &&
          typeof (entry as {file?: unknown}).file === 'string' &&
          typeof (entry as {sha256?: unknown}).sha256 === 'string'
        ) {
          actual.push({
            file: (entry as {file: string}).file,
            sha256: (entry as {sha256: string}).sha256,
          });
        }
      }
    } else if (
      typeof parsed.file === 'string' &&
      typeof parsed.sha256 === 'string'
    ) {
      actual.push({file: parsed.file, sha256: parsed.sha256});
    }
    return (
      actual.length === expected.length &&
      expected.every((want) =>
        actual.some(
          (have) => have.file === want.file && have.sha256 === want.sha256,
        ),
      )
    );
  } catch {
    return false;
  }
}

/** Records the archives an unpacked engine came from, after a verified unpack. */
export async function writeEngineMarker(
  root: string,
  asset: EngineAsset | readonly EngineAsset[],
): Promise<void> {
  const files = assetsOf(asset).map(({file, sha256}) => ({file, sha256}));
  await writeFile(
    join(engineDir(root), ENGINE_MARKER),
    `${JSON.stringify({files}, null, 2)}\n`,
    'utf8',
  );
}

function assetsOf(
  asset: EngineAsset | readonly EngineAsset[],
): readonly EngineAsset[] {
  return Array.isArray(asset) ? asset : [asset as EngineAsset];
}

async function sizeOf(file: string): Promise<number> {
  try {
    return (await stat(file)).size;
  } catch {
    return -1;
  }
}
