/**
 * The voice-input model, pinned by repository revision and by the sha256 of
 * every file the app downloads.
 *
 * The pins are code rather than a manifest the app goes and finds, for the
 * reason recall's and the voice model's are: the window and the headless runner
 * resolve the same directory, and a file read at run time is one more way for
 * the two to disagree. A module has no path to disagree about.
 *
 * The revision is the asset mirror's commit when this build was written. It is
 * not `main`: a repository that moves under a shipped app turns a verified
 * download into a file nobody tested.
 *
 * **Why the dated snapshot.** The mirror's newer `quantized_26_11_07` frontend
 * is split into `frontend.model.ort` + `frontend.weights.ort`, and the model
 * graph exposes the weight tensors as additional graph inputs. `onnxruntime-node`
 * has no public API for attaching those initializers, so that set cannot be
 * loaded as one graph. `quantized_26_07_30` carries a self-contained
 * `frontend.ort`, which is the graph this build loads.
 *
 * **The decoder is one graph.** The five assets are the official runtime's
 * merged-decoder layout: `decoder_kv.ort` handles the first step with an empty
 * cache and every later step with the cache it returned. There is no second
 * decoder copy, so the 82 MB of decoder weights is held once.
 *
 * The English speech-to-text models in this repository are MIT-licensed, as the
 * repository's licensing section says. The mirror also carries non-MIT language
 * and TTS assets; only these seven English files are pinned.
 */
import type {ListenFile} from './types.js';

/** The repository revision every file is fetched at. */
export const LISTEN_REVISION = 'e318117203f245fda2ca0142db6b8c057d86671c';

const BASE =
  'https://huggingface.co/moonshine-ai/moonshine-voice-assets/resolve';

/** The dated snapshot the self-contained frontend belongs to. */
const SNAPSHOT = 'model/small-streaming-en/quantized_26_07_30';

/**
 * The seven files this build needs.
 *
 * The order is the order they download in: the frontend and encoder first, then
 * the decoder, then the three small files that make the result usable. The
 * marker is written after all of them.
 */
export const LISTEN_FILES: readonly ListenFile[] = [
  {
    name: 'frontend.ort',
    path: `${SNAPSHOT}/frontend.ort`,
    label: 'The speech front end',
    bytes: 30_984_520,
    sha256: 'd1be8145bc9ef3e8625bb7bcb7a5b2930eeb828c91d6c1897bc215d7de6f2b93',
  },
  {
    name: 'encoder.ort',
    path: `${SNAPSHOT}/encoder.ort`,
    label: 'The speech encoder',
    bytes: 44_148_576,
    sha256: '2d4d973e91e8aca08c51e7e7efa28a46ab265b63d809d5294d18b86bcd85b993',
  },
  {
    name: 'decoder_kv.ort',
    path: `${SNAPSHOT}/decoder_kv.ort`,
    label: 'The speech decoder',
    bytes: 81_878_600,
    sha256: '1a05465b1dd955858dfcbee039c0020fb5dd982b0f5094c34e61735d518d771b',
  },
  {
    name: 'adapter.ort',
    path: `${SNAPSHOT}/adapter.ort`,
    label: 'The speech adapter',
    bytes: 2_870_368,
    sha256: 'c665f742364febad597cc9ac1e0b341ffbee0e24a1466e2f3bde95e6e4771762',
  },
  {
    name: 'cross_kv.ort',
    path: `${SNAPSHOT}/cross_kv.ort`,
    label: 'The speech cross-attention cache',
    bytes: 5_356_536,
    sha256: 'e2d3417144e9514055ebfefe8dcc4c0a55a55adcb8530435844c75c53e352bf6',
  },
  {
    name: 'tokenizer.bin',
    path: `${SNAPSHOT}/tokenizer.bin`,
    label: 'The speech tokenizer',
    bytes: 249_974,
    sha256: '6884b35fd6377d4c4d32336a0bc152f36b64d1e45b6503683cdc238250a8472d',
  },
  {
    name: 'streaming_config.json',
    path: `${SNAPSHOT}/streaming_config.json`,
    label: 'The speech settings',
    bytes: 512,
    sha256: '26f02b6afb22d60871a5efd85c3d38e569cc0ddb6c5eb6e93d3260152ae8a47a',
  },
];

/** The bytes a fresh install downloads, for the card's sentence. */
export const LISTEN_TOTAL_BYTES = LISTEN_FILES.reduce(
  (total, file) => total + file.bytes,
  0,
);

/** Where one file is fetched from, at the pinned revision. */
export function listenFileUrl(file: ListenFile): string {
  return `${BASE}/${LISTEN_REVISION}/${file.path}`;
}

/*
 * A pin that is not a digest is a check that hashes nothing and passes
 * everything. Caught here, at import, so a truncated paste is a loud failure at
 * startup rather than a first download that fails on somebody's machine.
 */
for (const file of LISTEN_FILES) {
  if (!/^[0-9a-f]{64}$/u.test(file.sha256)) {
    throw new Error(
      `The voice-input pin for ${file.name} is not a sha256 digest.`,
    );
  }
  if (!Number.isSafeInteger(file.bytes) || file.bytes <= 0) {
    throw new Error(`The voice-input pin for ${file.name} has no size.`);
  }
}
