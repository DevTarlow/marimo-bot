/**
 * The pinned recall model, as data.
 *
 * `pins.ts` beside this file holds them, and this is the reader that decides
 * whether they are usable. It exists because the app carries no weights and no
 * engine: the file names, the digests, the sizes and the URLs travel with the
 * build, and they are the thing that decides what to *download* when somebody
 * turns recall on.
 *
 * That is the inversion worth understanding. The pins used to be read only at
 * package time, and a mistake in them was a broken release build — loud, and
 * caught before anybody saw it. Now a mistake is a first-run download that fails
 * on a user's machine, so the parse is strict and names the field that is
 * wrong.
 */
export interface EngineAsset {
  /** The release asset's file name, which is also its name in the cache. */
  file: string;
  sha256: string;
  /** The download size, when the release publishes one. */
  bytes?: number;
}

/**
 * One pinned llama.cpp release, by tag and by the digest of each platform's
 * archive.
 *
 * `assets` is one archive per platform — Vulkan on Linux and Windows, Metal on
 * macOS. There is no CUDA variant: the chat engine that offered one is gone, and
 * recall deliberately runs on the processor.
 *
 * A named shape rather than an inline one because the downloader takes this
 * rather than a whole manifest: `installEngine` fetches a build from a document
 * whose `weights` it never reads, and the type is what says so.
 */
export interface EngineManifest {
  tag: string;
  baseUrl: string;
  assets: Record<string, EngineAsset>;
}

/**
 * The pieces of the recall model, which is one repository and two downloads.
 *
 * `text` is the backbone and is required for the feature to work at all. `media`
 * is the vision and audio projector, which is 555 MB and only means anything when
 * the user has asked for images, audio or video to be searchable. Keeping them
 * apart is what lets the cheap half gate the expensive one: the download button
 * for a picture is a decision, and the backbone is not.
 *
 * They are not tiers of one thing: without the projector there is no image
 * encoder in the process at all, so a media request is not a slower answer, it is
 * a request the engine cannot serve.
 */
export const EMBEDDING_PIECES = ['text', 'media'] as const;
export type EmbeddingPieceName = (typeof EMBEDDING_PIECES)[number];

export interface EmbeddingPiece {
  name: EmbeddingPieceName;
  /** What a download card calls it. */
  label: string;
  file: string;
  sha256: string;
  bytes: number;
}

/** How token vectors are combined into the one vector an index stores. */
export const EMBEDDING_POOLINGS = ['mean', 'cls', 'last'] as const;
export type EmbeddingPooling = (typeof EMBEDDING_POOLINGS)[number];

/**
 * The recall model, pinned.
 *
 * `weights` carries the two facts an index depends on — `dims`, which is written
 * into every vector file, and `contextSize`, which is how long a single input may
 * be — so neither is a number a caller improvises. It has no chat template and no
 * KV cache worth quantizing: it is served by `--embeddings` on an engine of its
 * own.
 */
export interface EmbeddingManifest {
  engine: EngineManifest;
  weights: {
    repo: string;
    revision: string;
    license: string;
    /**
     * The width of every vector this model returns.
     *
     * Read from the model rather than assumed: it is stored in each index, and a
     * query vector of the wrong width scores against nothing rather than
     * failing. The model supports Matryoshka truncation to 128, 256 and 512, and
     * this app deliberately does not use it — a truncated vector must be
     * re-normalized or ranking degrades silently, which is a failure mode that
     * looks like a bad model.
     */
    dims: number;
    /** The window one input is tokenized into, in tokens. */
    contextSize: number;
    pooling: EmbeddingPooling;
    pieces: Record<EmbeddingPieceName, EmbeddingPiece>;
  };
}

/** Raised when the shipped manifest is not a document this build understands. */
export class ManifestError extends Error {
  constructor(message: string) {
    super(`The model manifest is not usable: ${message}`);
    this.name = 'ManifestError';
  }
}

/**
 * The platform key the manifest uses.
 *
 * Node's own pair with a dash, so `linux-x64` and `win32-x64` — the same keys the
 * fetch script has always used, and the same ones a human reads in the JSON.
 */
export function platformKey(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  return `${platform}-${arch}`;
}

/**
 * The engine asset for a platform, or `undefined` when this build has none.
 *
 * `undefined` is a real answer and not an error: a platform the app does not ship
 * an engine for is one where it cannot run its model, and the sentence that says
 * so is written by the caller that knows what the user was trying to do.
 */
export function engineAssetFor(
  manifest: {engine: EngineManifest},
  options: {platform?: NodeJS.Platform; arch?: string} = {},
): {key: string; asset: EngineAsset} | undefined {
  const key = platformKey(options.platform, options.arch);
  const asset = manifest.engine.assets[key];
  return asset === undefined ? undefined : {key, asset};
}

/**
 * The one archive an engine install needs, or `undefined` when this build has no
 * archive for the platform.
 *
 * One rather than a list: recall ships one engine per platform, and the chat
 * engine that needed a second CUDA runtime archive is gone.
 */
export function engineFilesFor(
  manifest: {engine: EngineManifest},
  options: {platform?: NodeJS.Platform; arch?: string} = {},
): readonly EngineAsset[] | undefined {
  const asset = manifest.engine.assets[platformKey(options.platform, options.arch)];
  return asset === undefined ? undefined : [asset];
}

/** Where the engine archive for a platform is fetched from. */
export function engineUrl(
  manifest: {engine: EngineManifest},
  asset: EngineAsset,
): string {
  return `${manifest.engine.baseUrl}/${manifest.engine.tag}/${asset.file}`;
}

/** Where one piece of the recall model is fetched from. */
export function embeddingUrl(
  manifest: EmbeddingManifest,
  piece: EmbeddingPiece,
): string {
  return (
    `https://huggingface.co/${manifest.weights.repo}/resolve/` +
    `${manifest.weights.revision}/${piece.file}`
  );
}

/**
 * Reads the recall model's pins, or refuses with the field that is wrong.
 *
 * Hand-written rather than a schema library, because this is the only document
 * `@marimo/runtime` validates and a validator dependency for one file would be
 * the larger cost. Every message names the path a reader would search for.
 *
 * The check worth naming is `dims`: it is written into every vector file, and a
 * vector of the wrong width does not throw anywhere — it quietly scores against
 * nothing, which reads as a search that finds nothing rather than as a
 * mismatched model.
 */
export function parseEmbeddingManifest(raw: unknown): EmbeddingManifest {
  const root = asRecord(raw, 'the document');
  const engine = parseEngine(root['engine']);

  const weights = asRecord(root['weights'], 'weights');
  const pooling = requireString(weights['pooling'], 'weights.pooling');
  if (!EMBEDDING_POOLINGS.includes(pooling as EmbeddingPooling)) {
    throw new ManifestError(
      `weights.pooling is "${pooling}", and this build only knows ` +
        `${EMBEDDING_POOLINGS.join(', ')}.`,
    );
  }

  const rawPieces = asRecord(weights['pieces'], 'weights.pieces');
  const pieces = {} as Record<EmbeddingPieceName, EmbeddingPiece>;
  for (const name of EMBEDDING_PIECES) {
    const piece = asRecord(rawPieces[name], `weights.pieces.${name}`);
    pieces[name] = {
      name,
      label: requireString(piece['label'], `weights.pieces.${name}.label`),
      file: requireString(piece['file'], `weights.pieces.${name}.file`),
      sha256: requireDigest(piece['sha256'], `weights.pieces.${name}.sha256`),
      bytes: requirePositiveInt(piece['bytes'], `weights.pieces.${name}.bytes`),
    };
  }

  return {
    engine,
    weights: {
      repo: requireString(weights['repo'], 'weights.repo'),
      revision: requireString(weights['revision'], 'weights.revision'),
      license: requireString(weights['license'], 'weights.license'),
      dims: requirePositiveInt(weights['dims'], 'weights.dims'),
      contextSize: requirePositiveInt(
        weights['contextSize'],
        'weights.contextSize',
      ),
      pooling: pooling as EmbeddingPooling,
      pieces,
    },
  };
}

/**
 * The engine half of a manifest.
 *
 * Every path in the messages below has been `engine.` since the file was
 * written, and it still is: the prefix is a path into the document a reader is
 * looking at, not into the object this function was handed.
 */
function parseEngine(raw: unknown): EngineManifest {
  const engine = asRecord(raw, 'engine');
  const tag = requireString(engine['tag'], 'engine.tag');
  const baseUrl = requireString(engine['baseUrl'], 'engine.baseUrl');

  const rawAssets = asRecord(engine['assets'], 'engine.assets');
  const assets: Record<string, EngineAsset> = {};
  for (const [key, value] of Object.entries(rawAssets)) {
    assets[key] = parseEngineAsset(value, `engine.assets.${key}`);
  }
  if (Object.keys(assets).length === 0) {
    throw new ManifestError('engine.assets is empty, so nothing can be fetched.');
  }

  return {tag, baseUrl, assets};
}

function parseEngineAsset(raw: unknown, path: string): EngineAsset {
  const asset = asRecord(raw, path);
  const bytes = asset['bytes'];
  if (
    bytes !== undefined &&
    (typeof bytes !== 'number' || !Number.isInteger(bytes) || bytes <= 0)
  ) {
    throw new ManifestError(`${path}.bytes is not a positive whole number.`);
  }
  return {
    file: requireString(asset['file'], `${path}.file`),
    sha256: requireDigest(asset['sha256'], `${path}.sha256`),
    ...(bytes === undefined ? {} : {bytes}),
  };
}

function asRecord(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ManifestError(`${path} is not an object.`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ManifestError(`${path} is missing or empty.`);
  }
  return value;
}

function requirePositiveInt(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new ManifestError(`${path} is not a positive whole number.`);
  }
  return value;
}

/**
 * A sha256, checked for shape rather than for content.
 *
 * Shape only, because the digest is *verified against the download* — this check
 * catches a truncated paste or a placeholder left in the file, which is the
 * mistake that would otherwise reach a user as "the download is corrupt".
 */
function requireDigest(value: unknown, path: string): string {
  const text = requireString(value, path);
  if (!/^[0-9a-f]{64}$/u.test(text)) {
    throw new ManifestError(`${path} is not a sha256 digest.`);
  }
  return text;
}

/* -------------------------------------------------------------------------- */
/* The chat models                                                             */
/* -------------------------------------------------------------------------- */
