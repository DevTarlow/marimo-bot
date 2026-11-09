/**
 * The shipped manifest, as a document this build can trust.
 *
 * The stakes changed when the app stopped carrying weights: a field that is wrong
 * here is no longer a broken build on a maintainer's machine, it is a first-run
 * download that fails on a user's. So the parse is strict, and these tests are
 * about the refusals as much as the happy path — each one names the field a
 * reader would have to go and fix.
 */
import {describe, expect, it} from 'vitest';

import {
  embeddingUrl,
  engineAssetFor,
  engineUrl,
  ManifestError,
  parseEmbeddingManifest,
  platformKey,
} from './manifest.js';
import {EMBEDDING_PINS} from './pins.js';

/** The smallest document that is a valid recall manifest. */
function fixture(): Record<string, unknown> {
  return {
    engine: {
      tag: 'b2',
      baseUrl: 'https://example.test/dl',
      assets: {'linux-x64': {file: 'engine.tar.gz', sha256: 'a'.repeat(64)}},
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
          label: 'The recall model',
          file: 'text.gguf',
          sha256: 'b'.repeat(64),
          bytes: 10,
        },
        media: {
          label: 'The encoder',
          file: 'mmproj.gguf',
          sha256: 'c'.repeat(64),
          bytes: 20,
        },
      },
    },
  };
}

/** The fixture with one path deleted, for the refusal cases. */
function without(path: string): Record<string, unknown> {
  const copy = structuredClone(fixture());
  const parts = path.split('.');
  let node = copy as Record<string, unknown>;
  for (const part of parts.slice(0, -1)) {
    node = node[part] as Record<string, unknown>;
  }
  delete node[parts[parts.length - 1]!];
  return copy;
}

/** The fixture with one path set to something the parser should refuse. */
function withValue(path: string, value: unknown): Record<string, unknown> {
  const copy = structuredClone(fixture());
  const parts = path.split('.');
  let node = copy as Record<string, unknown>;
  for (const part of parts.slice(0, -1)) {
    node = node[part] as Record<string, unknown>;
  }
  node[parts[parts.length - 1]!] = value;
  return copy;
}

describe('parseEmbeddingManifest', () => {
  it('reads the document and names each piece', () => {
    const manifest = parseEmbeddingManifest(fixture());

    expect(manifest.weights.dims).toBe(768);
    expect(manifest.weights.contextSize).toBe(8192);
    expect(manifest.weights.pooling).toBe('mean');
    expect(manifest.weights.pieces.text.name).toBe('text');
    expect(manifest.weights.pieces.media.file).toBe('mmproj.gguf');
    expect(manifest.engine.tag).toBe('b2');
  });

  it('refuses a document that is not an object at all', () => {
    expect(() => parseEmbeddingManifest(null)).toThrow(ManifestError);
    expect(() => parseEmbeddingManifest([])).toThrow(/not an object/u);
    expect(() => parseEmbeddingManifest('nope')).toThrow(/not an object/u);
  });

  it('refuses an empty asset list, which would fetch nothing', () => {
    expect(() => parseEmbeddingManifest(withValue('engine.assets', {}))).toThrow(
      /engine\.assets is empty/u,
    );
  });

  /*
   * A digest that is a placeholder or a truncated paste is the mistake that
   * reaches a user as "the download is corrupt", so it is caught at the door.
   */
  it('refuses a digest that is not a sha256', () => {
    for (const bad of ['', 'abc', 'A'.repeat(64), `${'a'.repeat(63)}z`]) {
      expect(() =>
        parseEmbeddingManifest(withValue('engine.assets.linux-x64.sha256', bad)),
      ).toThrow(/sha256/u);
    }
    expect(() =>
      parseEmbeddingManifest(withValue('weights.pieces.text.sha256', 'nope')),
    ).toThrow(/weights\.pieces\.text\.sha256 is not a sha256/u);
  });

  /*
   * A pooling the engine does not have is a start that fails with a usage
   * message, so it is caught here where the message can name the field.
   */
  it('refuses a pooling this build does not know', () => {
    expect(() =>
      parseEmbeddingManifest(withValue('weights.pooling', 'average')),
    ).toThrow(/weights\.pooling/u);
  });

  it('refuses a size that is not a positive whole number', () => {
    expect(() =>
      parseEmbeddingManifest(withValue('weights.pieces.text.bytes', 0)),
    ).toThrow(/bytes is not a positive whole number/u);
    expect(() =>
      parseEmbeddingManifest(withValue('weights.pieces.text.bytes', 1.5)),
    ).toThrow(/bytes is not a positive whole number/u);
    expect(() =>
      parseEmbeddingManifest(withValue('weights.contextSize', -1)),
    ).toThrow(/contextSize is not a positive whole number/u);
  });

  it('refuses a piece the build expects but the file does not carry', () => {
    expect(() => parseEmbeddingManifest(without('weights.pieces.media'))).toThrow(
      /weights\.pieces\.media is not an object/u,
    );
  });

  it('refuses a missing field rather than defaulting it', () => {
    expect(() => parseEmbeddingManifest(without('engine.tag'))).toThrow(
      /engine\.tag is missing or empty/u,
    );
    expect(() => parseEmbeddingManifest(without('weights.repo'))).toThrow(
      /weights\.repo is missing or empty/u,
    );
    expect(() => parseEmbeddingManifest(without('weights.dims'))).toThrow(
      /weights\.dims/u,
    );
  });

  /*
   * The width is written into every vector file, and a vector of the wrong width
   * does not throw anywhere — it quietly scores against nothing, which reads as a
   * search that finds nothing. So it is required rather than defaulted.
   */
  it('refuses a width that is not a positive whole number', () => {
    expect(() => parseEmbeddingManifest(withValue('weights.dims', 0))).toThrow(
      /weights\.dims/u,
    );
  });

  /*
   * The revision is in the URL rather than the branch name, which is what stops
   * a re-uploaded file changing what the app ships.
   */
  it('pins each piece to a revision, not a branch', () => {
    const manifest = parseEmbeddingManifest(fixture());

    expect(embeddingUrl(manifest, manifest.weights.pieces.media)).toBe(
      'https://huggingface.co/unsloth/embeddinggemma-2-GGUF/resolve/deadbeef/mmproj.gguf',
    );
  });
});

describe('looking an engine up', () => {
  const manifest = parseEmbeddingManifest(fixture());

  it('finds the asset for a platform it was pinned for', () => {
    const found = engineAssetFor(manifest, {platform: 'linux', arch: 'x64'});
    expect(found?.key).toBe('linux-x64');
    expect(found?.asset.file).toBe('engine.tar.gz');
  });

  /*
   * `undefined` is a real answer: a platform with no engine is one where this
   * feature cannot run, and the caller writes the sentence for that.
   */
  it('answers undefined for a platform this build does not ship', () => {
    expect(
      engineAssetFor(manifest, {platform: 'freebsd', arch: 'x64'}),
    ).toBeUndefined();
  });

  it('keys platforms the way a human reads them in the JSON', () => {
    expect(platformKey('win32', 'x64')).toBe('win32-x64');
    expect(platformKey('darwin', 'arm64')).toBe('darwin-arm64');
  });

});

describe('the URLs a download uses', () => {
  const manifest = parseEmbeddingManifest(fixture());

  it('puts the tag between the base URL and the file', () => {
    const found = engineAssetFor(manifest, {platform: 'linux', arch: 'x64'})!;
    expect(engineUrl(manifest, found.asset)).toBe(
      'https://example.test/dl/b2/engine.tar.gz',
    );
  });
});

/**
 * The pins that actually ship, checked as a document.
 *
 * `parseEmbeddingManifest` runs at import, so a malformed paste is already a
 * failure — but only of a shape the parser knows about. What is asserted here is
 * the arithmetic the index depends on and the one thing that has already been
 * wrong once in this repository's history: the engine tag.
 */
describe('EMBEDDING_PINS', () => {
  it('is a document this build can read', () => {
    expect(EMBEDDING_PINS.weights.dims).toBe(768);
    expect(EMBEDDING_PINS.weights.pieces.text.bytes).toBe(309_855_520);
    expect(EMBEDDING_PINS.weights.pieces.media.bytes).toBe(554_821_120);
  });

  /*
   * The model is `gemma-embedding2`, which llama.cpp only learned to load after
   * the stable build that was current when the model was published — that build
   * answers "unknown model architecture" and exits. Bumping the tag is therefore a
   * change to the binary the whole feature runs on, and the flags in `args.ts`
   * were verified against this one.
   */
  it('pins the engine tag the model was verified against', () => {
    expect(EMBEDDING_PINS.engine.tag).toBe('b11557');
  });
});
