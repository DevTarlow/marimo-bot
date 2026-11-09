/**
 * The pins, as code rather than as a file the app has to go and find.
 *
 * This lived in `apps/desktop/local-model.json` and was read by a fetch script at
 * package time. It has to be read at *run* time now, because the app downloads the
 * model when somebody turns recall on — and a run-time read of a file is exactly the
 * problem this file's history is about: the window would find it through
 * Electron's `process.resourcesPath`, the headless runner would derive the path
 * from its own executable, and when the two disagreed nothing would error.
 *
 * A module has no path to disagree about. Both processes import it, the pins
 * travel with the code they describe, and there is nothing to copy into the
 * installer.
 *
 * The values are validated on import, so a truncated paste or a placeholder digest
 * is a loud failure at startup rather than a first-run download that fails on
 * somebody else's machine.
 */
import {parseEmbeddingManifest} from './manifest.js';
import type {EmbeddingManifest} from './manifest.js';

/**
 * The engine the recall model runs on, pinned by release tag and by the sha256 of
 * each platform's archive.
 *
 * The tag is a nightly rather than the stable cut, and that is forced rather than
 * preferred — it was learned by running the pinned build against the pinned
 * weights, not by reading about either:
 *
 *   $ llama-server -m embeddinggemma-2-Q8_0.gguf --embeddings --pooling mean
 *   E llama_model_load: error loading model: unknown model architecture:
 *     'gemma-embedding2'
 *
 * `gemma-embedding2` appears in llama.cpp's architecture list after b11429, so the
 * build that was current when this model was published cannot load it at all.
 * b11557 was verified here: it loads the model, returns 768 finite unit-length
 * vectors, and embeds an image, a two-second WAV and a ten-second MP4 into that
 * same space. A later tag is a change to the one binary this feature depends on
 * and to the flags in `args.ts`, which were verified against this one.
 *
 * Every asset is a GPU build — Vulkan on Linux and Windows, Metal on macOS — and
 * there is no CPU-only archive pinned beside them. That looks backwards for an
 * engine started with no GPU offload (see `args.ts`), and it is deliberate: these
 * builds contain llama.cpp's CPU backend like every other, so one asset per
 * platform serves this model and the graphics backend simply goes unused.
 */
const RECALL_ENGINE = {
  tag: 'b11557',
  baseUrl: 'https://github.com/ggml-org/llama.cpp/releases/download',
  assets: {
    'linux-x64': {
      file: 'llama-b11557-bin-ubuntu-vulkan-x64.tar.gz',
      sha256: 'c05ccb11f6de7c907c9ca861a0bb921bc3a52a94912cd0f1d47d53cea0c3dc08',
    },
    'linux-arm64': {
      file: 'llama-b11557-bin-ubuntu-vulkan-arm64.tar.gz',
      sha256: '7c9a2e6de70f005c597de301a53874b2413b3f0b7a25183f6737130248d6786b',
    },
    'darwin-arm64': {
      file: 'llama-b11557-bin-macos-arm64.tar.gz',
      sha256: '83cd5827293f7fa33403627436da2606413e48978bcedfe7aa3e587f62742f5c',
    },
    'darwin-x64': {
      file: 'llama-b11557-bin-macos-x64.tar.gz',
      sha256: 'c6cb1d85c6528bf02202d59ff67b4aa16feec8f442c41dce91dbdbe6a3d6ec93',
    },
    'win32-x64': {
      file: 'llama-b11557-bin-win-vulkan-x64.zip',
      sha256: '6db23c5cf69e51f3dc2bf7f68277f4a791217bab853bd5b93afac1898d450b83',
    },
  },
};

/**
 * The recall model: one repository, two downloads.
 *
 * `text` is the 270M backbone and is what an index of words, code and
 * conversations needs. `media` is the vision and audio projector — 555 MB, and
 * without it in the process there is no image encoder at all, so a picture is
 * not a slower answer, it is one the engine cannot give.
 *
 * Q8_0 rather than the smallest quant: it is 310 MB against 176 MB, and the
 * measurements that matter here are a dozen tokens per bullet of memory and a
 * few hundred per image, where the better quantization is the cheaper half of a
 * download measured in seconds either way. It is also not the F16 file in the
 * same repository, which is deliberate: the model card warns that this model's
 * activations exceed float16's range and return NaN in it, and the first thing
 * `client.ts` does with a vector is check that every value is finite.
 */
const EMBEDDING_WEIGHTS = {
  repo: 'unsloth/embeddinggemma-2-GGUF',
  revision: '031f0d4b35536f69ab3509d4893c923264fcf253',
  license: 'Apache-2.0',
  dims: 768,
  contextSize: 8192,
  pooling: 'mean',
  pieces: {
    text: {
      name: 'text',
      label: 'The recall model',
      file: 'embeddinggemma-2-Q8_0.gguf',
      sha256: '6f1bd4ac6c5df7444f9cca7ca36cafe6cfa34cd6f49fefb1e0b4be8143aed8bc',
      bytes: 309_855_520,
    },
    media: {
      name: 'media',
      label: 'The image and audio encoder',
      file: 'mmproj-Q8_0.gguf',
      sha256: '90e7b0238009e2954f856f2081dcf7f35af026b64c765e98f4777053e1754460',
      bytes: 554_821_120,
    },
  },
} as const;

/**
 * The pins, parsed.
 *
 * Parsed here rather than at the call site because the parse is what turns a
 * hand-edited value into a sentence naming the field that is wrong — and a caller
 * that forgot to parse would be reading a document nothing had checked.
 */
export const EMBEDDING_PINS: EmbeddingManifest = parseEmbeddingManifest({
  engine: RECALL_ENGINE,
  weights: EMBEDDING_WEIGHTS,
});
