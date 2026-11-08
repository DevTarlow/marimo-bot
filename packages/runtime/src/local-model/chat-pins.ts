/**
 * The chat weights and the llama.cpp engine that runs them, pinned.
 *
 * The app carries no weights. A first run downloads them, which is why this is
 * code rather than a file the app has to find: both the window and the headless
 * runner import it, the pins travel with the code they describe, and there is no
 * second copy to drift.
 *
 * Two facts are worth knowing before editing anything here.
 *
 * **The revisions are commits, not `main`.** A repository can be revised between
 * a release and a user's first run, and "whatever `main` says today" is not a
 * pin. The sha256 values are the LFS object ids the repositories hold at those
 * commits.
 *
 * **The engine is a GPU-capable build.** The default archives are Vulkan on
 * Linux and Windows and Metal on macOS, and each one contains the CPU backend.
 * Asking for every layer therefore puts the model on a card when there is one and
 * on the processor when there is not. The CUDA variant is opt-in: it is faster on
 * NVIDIA, but the engine and the runtime the release publishes beside it are
 * about 776 MB on Linux, and it only runs on an NVIDIA driver new enough for the
 * pinned CUDA version.
 *
 * The eight-byte counts below are the same numbers the protocol's catalogue
 * shows on a download button. A runtime test holds the two equal: a card that
 * promises 1.9GB and a download that asks for 2.4GB is a lie the user finds out
 * about at 80 percent.
 */
import type {
  LocalModelId,
  LocalModelVariant,
} from '@marimo/protocol';
import {
  LOCAL_MODEL_IDS,
  LOCAL_MODEL_VARIANTS,
  LOCAL_MODELS,
} from '@marimo/protocol';

import {parseChatModelManifest} from './manifest.js';
import type {ChatModelManifest} from './manifest.js';

/**
 * llama.cpp b11960, the build the LFM3 GGUF cards require.
 *
 * These are the graphics builds where the platform has one: Vulkan on Linux and
 * Windows, Metal in the macOS archives. Each also contains the CPU backend, so
 * `localModelArgs` can ask for every layer: a machine with a card offloads the
 * model, and one without a usable device falls back to the processor rather than
 * refusing to start.
 *
 * The CUDA bundle is the opt-in NVIDIA path. It is two archives — the engine and
 * the CUDA runtime it links against — and the installer unpacks both into the
 * same directory. The Linux build is CUDA 12.8 and the Windows build is 12.4, so
 * each pins the oldest NVIDIA driver it can run on. The release tag is the
 * nightly name, which is what the URL uses; it is pinned rather than "latest" so
 * a model/engine pair that worked on one
 * machine keeps working on the next.
 */
const CHAT_ENGINE = {
  tag: 'b11960',
  baseUrl: 'https://github.com/ggml-org/llama.cpp/releases/download',
  assets: {
    'linux-x64': {
      file: 'llama-b11960-bin-ubuntu-vulkan-x64.tar.gz',
      sha256: '164199e978304bb32a8a6c24b8efa015528ddf286821596eab676c90b375feac',
    },
    'linux-arm64': {
      file: 'llama-b11960-bin-ubuntu-vulkan-arm64.tar.gz',
      sha256: '22d1f852055a95a5c969b90326a2b68b4618eca6c54638bae27b4ee603031d53',
    },
    'darwin-arm64': {
      file: 'llama-b11960-bin-macos-arm64.tar.gz',
      sha256: '58e5a5e1d7c2bf66cedd9c29e0323f3e570660a70a1e2156d32eed08f4cc1e3c',
    },
    'darwin-x64': {
      file: 'llama-b11960-bin-macos-x64.tar.gz',
      sha256: 'd1e6c9ddcaed9a3b1bb8f3d946bdb3481c7b919357a4029dcb747762397f1da5',
    },
    'win32-x64': {
      file: 'llama-b11960-bin-win-vulkan-x64.zip',
      sha256: 'bac6914b5e83523eb008c6789eaa12669f93fbc196c3b9e8237b6672323b33e9',
    },
    'win32-arm64': {
      file: 'llama-b11960-bin-win-vulkan-arm64.zip',
      sha256: 'cd375e330452496aadf8a872cde6d48c92e51d598088e5575a32a0d43bc0c9f0',
    },
  },
  /**
   * The opt-in NVIDIA bundle: the engine first, then the runtime it links
   * against. Both are unpacked into the same directory. The Linux runtime is
   * CUDA 12.8 and the Windows runtime is 12.4; the host only offers the variant
   * when `nvidia-smi` reports a driver new enough for the pinned version.
   */
  cuda: {
    'linux-x64': [
      {
        file: 'llama-b11960-bin-ubuntu-cuda-12.8-x64.tar.gz',
        sha256: '64d57beb9abb637c177c6afb313760a0c0782224cac71e74869eed5b8f9a1ea4',
        bytes: 182_524_002,
      },
      {
        file: 'cudart-llama-b11960-bin-ubuntu-cuda-12.8-x64.tar.gz',
        sha256: '7c4d5974bd39649df649649e5d71950688a70e37aaae00bf11afbb656ea2cc56',
        bytes: 594_371_478,
      },
    ],
    'win32-x64': [
      {
        file: 'llama-b11960-bin-win-cuda-12.4-x64.zip',
        sha256: '8d9d819261de10cc2f03921b8b79c779c5c458e21edb60c170ee30a7d462d684',
        bytes: 279_763_224,
      },
      {
        file: 'cudart-llama-bin-win-cuda-12.4-x64.zip',
        sha256: '8c79a9b226de4b3cacfd1f83d24f962d0773be79f1e7b75c6af4ded7e32ae1d6',
        bytes: 391_443_627,
      },
    ],
  },
} as const;

const QWEN_VL_REVISION = '68bb8bc4b7df5289c143aaec0ab477a7d4051aab';

function weights(
  file: string,
  bytes: number,
  sha256: string,
): {file: string; bytes: number; sha256: string} {
  return {file, bytes, sha256};
}

/**
 * One model, both quantized copies, and the encoder both share.
 *
 * The projector is the same F16 file for either copy. Qwen publishes no smaller
 * encoder for this family, and a variant without it is not a text model with
 * fewer features — it is an engine with no image encoder in it at all, so a
 * picture would be a request the process cannot serve. The Q4 copy is the one a
 * first run downloads; the Q8 copy is the larger answer.
 */
const CHAT_MODELS = {
  'qwen2.5-vl-7b': {
    modelId: 'qwen2.5-vl-7b' as const,
    repo: 'unsloth/Qwen2.5-VL-7B-Instruct-GGUF',
    revision: QWEN_VL_REVISION,
    license: 'Apache-2.0',
    variants: {
      q8: {
        weights: weights(
          'Qwen2.5-VL-7B-Instruct-Q8_0.gguf',
          8_098_524_032,
          'ee770c700d7429cc6f0c74d6c7ab3c063bf521312fc36e80776d1d79bc9fa4ad',
        ),
        projector: weights(
          'mmproj-F16.gguf',
          1_354_163_040,
          '987dd0733033fb5dd9b124d1ca926ae865572e432384eee7618b2eec3e735e17',
        ),
      },
      q4: {
        weights: weights(
          'Qwen2.5-VL-7B-Instruct-Q4_K_M.gguf',
          4_683_072_384,
          'd16776dcd9a28d42758c2958ed3a752aabf20a305252cd64ff2be72b4a78c503',
        ),
        projector: weights(
          'mmproj-F16.gguf',
          1_354_163_040,
          '987dd0733033fb5dd9b124d1ca926ae865572e432384eee7618b2eec3e735e17',
        ),
      },
    },
  },
} satisfies Record<LocalModelId, unknown>;

/**
 * The pins, parsed.
 *
 * Parsed here rather than at the call site because the parse is what turns a
 * hand-edited value into a sentence naming the field that is wrong — and a
 * caller that forgot to parse would be reading a document nothing had checked.
 */
export const CHAT_PINS: ChatModelManifest = parseChatModelManifest({
  engine: CHAT_ENGINE,
  models: CHAT_MODELS,
});

/**
 * The default variant for a model.
 *
 * Read from the descriptor rather than repeated here: the card's default and
 * the installer's default have to be one answer, and a second table is how they
 * stop being one.
 */
export function defaultVariantFor(model: LocalModelId): LocalModelVariant {
  return LOCAL_MODELS[model].defaultVariant;
}

/** Every id and variant, for a test that walks the pins. */
export const CHAT_PIN_KEYS = LOCAL_MODEL_IDS.flatMap((modelId) =>
  LOCAL_MODEL_VARIANTS.map((variant) => ({modelId, variant})),
);
