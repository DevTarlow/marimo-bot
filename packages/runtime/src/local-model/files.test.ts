/**
 * Where the recall engine and its weights are found.
 *
 * The failure this file has always pinned is the quiet one, and it has changed
 * shape: the model used to be bundled, so the window asked Electron for
 * `process.resourcesPath` while the headless runner derived the directory from its
 * own executable, and when the two disagreed nothing errored — the window answered
 * questions while a scheduled job reported the model as not installed.
 *
 * The model is downloaded now, so it lives in the user-data directory both
 * processes already resolve the same way. What is left to get wrong is smaller and
 * still worth pinning: the override has to win, the projector has to be resolved
 * only when the user has asked for media, and "installed" has to mean the right
 * bytes are there rather than that a file with the right name exists.
 */
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';

import {afterEach, beforeEach, describe, expect, it} from 'vitest';

import {parseEmbeddingManifest} from './manifest.js';
import {
  engineDir,
  MODEL_DIR_ENV,
  MODEL_DIR_NAME,
  modelDir,
  recallDir,
  recallPiecesInstalled,
  recallSpec,
  resolveRecallFiles,
} from './files.js';

describe('modelDir', () => {
  it('lives under the user-data directory both processes already agree on', () => {
    expect(modelDir({userData: '/home/sam/.config/Marimo Bot', env: {}})).toBe(
      join('/home/sam/.config/Marimo Bot', MODEL_DIR_NAME),
    );
  });

  /*
   * The override wins rather than the other way round: a development checkout and
   * the smoke check both point at a directory of their own, and a default a
   * checkout cannot outrank is one that does not work.
   */
  it('lets the environment point somewhere else', () => {
    expect(
      modelDir({
        userData: '/home/sam/.config/Marimo Bot',
        env: {[MODEL_DIR_ENV]: '/opt/weights'},
      }),
    ).toBe('/opt/weights');
  });

  it('ignores an empty override rather than resolving to nothing', () => {
    expect(
      modelDir({
        userData: '/data',
        env: {[MODEL_DIR_ENV]: ''},
      }),
    ).toBe(join('/data', MODEL_DIR_NAME));
  });
});

/**
 * Where the recall model is, and the one thing that makes it different.
 *
 * It lives in a subdirectory of the same model directory, which is what lets the
 * engine helpers be reused rather than re-derived — the engine directory and the
 * binary's name. What is genuinely new is the projector: it is optional, and "not
 * asked for" has to be distinguishable from "asked for and not downloaded",
 * because the first is a setting and the second is a button the user has not
 * pressed.
 */
function embeddingManifest() {
  return parseEmbeddingManifest({
    engine: {
      tag: 'b2',
      baseUrl: 'https://example.test/dl',
      assets: {'linux-x64': {file: 'e.tar.gz', sha256: 'a'.repeat(64)}},
    },
    weights: {
      repo: 'unsloth/embeddinggemma-2-GGUF',
      revision: 'deadbeef',
      license: 'Apache-2.0',
      dims: 768,
      contextSize: 8192,
      pooling: 'mean',
      pieces: {
        text: {
          label: 't',
          file: 'text.gguf',
          sha256: 'b'.repeat(64),
          bytes: 10,
        },
        media: {
          label: 'm',
          file: 'mmproj.gguf',
          sha256: 'c'.repeat(64),
          bytes: 20,
        },
      },
    },
  });
}

describe('the recall model’s files', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(process.cwd(), '.marimo-recallfiles-'));
  });

  afterEach(async () => {
    await rm(home, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 20,
    });
  });

  it('keeps them in their own directory inside the model directory', () => {
    expect(recallDir({userData: '/data', env: {}})).toBe(
      join('/data', MODEL_DIR_NAME, 'recall'),
    );
  });

  it('follows the same override the model directory does', () => {
    expect(
      recallDir({userData: '/data', env: {[MODEL_DIR_ENV]: '/elsewhere'}}),
    ).toBe(join('/elsewhere', 'recall'));
  });

  it('reuses the engine layout for the recall engine', async () => {
    const root = recallDir({userData: home, env: {}});
    await mkdir(engineDir(root), {recursive: true});
    await writeFile(join(engineDir(root), 'llama-server'), 'binary', 'utf8');

    const files = resolveRecallFiles({
      dir: root,
      manifest: embeddingManifest(),
      media: false,
      platform: 'linux',
    });

    // The pinned build of the same binary, in the same layout — which is why
    // this is a subdirectory rather than a second idea about where files live.
    expect(files.engine).toBe(join(engineDir(root), 'llama-server'));
    expect(files.libraryDir).toBe(engineDir(root));
    expect(files.enginePresent).toBe(true);
    expect(files.model).toBe(join(root, 'text.gguf'));
  });

  it('resolves no projector at all when media is off', () => {
    const files = resolveRecallFiles({
      dir: home,
      manifest: embeddingManifest(),
      media: false,
    });

    expect(files.projector).toBe('');
    expect(files.projectorPresent).toBe(false);
  });

  it('resolves the projector and reports whether it is really there', async () => {
    const root = recallDir({userData: home, env: {}});
    const manifest = embeddingManifest();

    const missing = resolveRecallFiles({dir: root, manifest, media: true});
    expect(missing.projector).toBe(join(root, 'mmproj.gguf'));
    expect(missing.projectorPresent).toBe(false);

    await mkdir(root, {recursive: true});
    await writeFile(join(root, 'mmproj.gguf'), 'x'.repeat(20), 'utf8');
    const present = resolveRecallFiles({dir: root, manifest, media: true});
    expect(present.projectorPresent).toBe(true);
  });

  /*
   * Size, not existence, and for the reason the manifest pins exact sizes at all:
   * a download that was interrupted leaves a file with the right name and the
   * wrong length, and counting that as installed means an engine that fails to
   * load a model the card says is there.
   */
  it('counts a piece as installed only at the pinned size', async () => {
    const root = recallDir({userData: home, env: {}});
    const manifest = embeddingManifest();
    await mkdir(root, {recursive: true});

    expect(recallPiecesInstalled({dir: root, manifest})).toEqual([]);

    await writeFile(join(root, 'text.gguf'), 'x'.repeat(9), 'utf8');
    expect(recallPiecesInstalled({dir: root, manifest})).toEqual([]);

    await writeFile(join(root, 'mmproj.gguf'), 'x'.repeat(20), 'utf8');
    await writeFile(join(root, 'text.gguf'), 'x'.repeat(10), 'utf8');
    expect(recallPiecesInstalled({dir: root, manifest}).sort()).toEqual([
      'media',
      'text',
    ]);
  });

  it('carries the two numbers an index depends on into the spec', () => {
    const spec = recallSpec({
      dir: '/model/recall',
      manifest: embeddingManifest(),
      media: true,
    });

    expect(spec.contextSize).toBe(8192);
    expect(spec.pooling).toBe('mean');
    expect(spec.media).toBe(true);
  });
});
