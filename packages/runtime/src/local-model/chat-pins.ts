/**
 * The LFM3 weights and the llama.cpp engine that runs them, pinned.
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
 * **The engine is a GPU-capable build.** The archives are Vulkan on Linux and
 * Windows and Metal on macOS, and each one contains the CPU backend. Asking for
 * every layer therefore puts the model on a card when there is one and on the
 * processor when there is not. A CUDA archive would add hundreds of megabytes of
 * runtime for a gain these small models do not need on a 12 GB card.
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
import {LOCAL_MODEL_IDS, LOCAL_MODEL_VARIANTS} from '@marimo/protocol';

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
 * CUDA is not pinned. Its archive and the CUDA runtime together are hundreds of
 * megabytes against 35 MB for Vulkan, and this model family fits a 12 GB card
 * without it. The release tag is the nightly name, which is what the URL uses;
 * it is pinned rather than "latest" so a model/engine pair that worked on one
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
} as const;

const TEXT_REVISION = 'bad5729bba61d076fff20d2548e62526665af215';
const VL_REVISION = 'b36554cfd35854b06429900131730cd80f092cdb';
const AUDIO_REVISION = '02355c1a141e464a064f2ab2c276638dbcb7f38a';
const OMNI_REVISION = '3d29af2ad166f8299c2d820937e47dc0add20ffc';

function weights(
  file: string,
  bytes: number,
  sha256: string,
): {file: string; bytes: number; sha256: string} {
  return {file, bytes, sha256};
}

/**
 * One model, both quantized copies.
 *
 * The 4-bit choice is not "the same model, worse": the text model ships a QAD
 * checkpoint trained to recover the accuracy Q4_0 loses, and that is the file
 * used. The others use their Q4_K_M cut. A variant's projector is included
 * because the encoder is part of the download; a vision model without its
 * projector is an engine that cannot see at all, not a slightly worse one.
 */
const CHAT_MODELS = {
  'lfm3-1.7b': {
    modelId: 'lfm3-1.7b' as const,
    repo: 'LiquidAI/LFM3-1.7B-GGUF',
    revision: TEXT_REVISION,
    license: 'LFM Open License v1.0',
    variants: {
      q8: {
        weights: weights(
          'LFM3-1.7B-Q8_0.gguf',
          1_846_238_496,
          '8f6b24182258205e9e01e21f1f24a1f208c1e8115578825d202ce39976af20b6',
        ),
      },
      q4: {
        weights: weights(
          'LFM3-1.7B-QAD-Q4_0.gguf',
          1_049_615_680,
          '43a7d09a0e9cba91b63eb7052488b9564569bddfd65754d2e426465e572a7452',
        ),
      },
    },
  },
  'lfm3-vl-2b': {
    modelId: 'lfm3-vl-2b' as const,
    repo: 'LiquidAI/LFM3-VL-2B-GGUF',
    revision: VL_REVISION,
    license: 'LFM Open License v1.0',
    variants: {
      q8: {
        weights: weights(
          'LFM3-VL-2B-Q8_0.gguf',
          1_846_238_496,
          'e138e54189a751d90ea8c0b236360490613ecd465d28d68fa6094d3db7fa6727',
        ),
        projector: weights(
          'mmproj-LFM3-VL-2B-Q8_0.gguf',
          203_031_872,
          'c5c5b58d544a18da919172d2d0368090ea1a4a351b6feb7f8a326a264a5918ab',
        ),
      },
      q4: {
        weights: weights(
          'LFM3-VL-2B-QAD-Q4_0.gguf',
          1_049_615_648,
          '621c455376cb96a20891697deb9975c6fb47dd5ea98ed3ad1f3b7e8f24f0b1e6',
        ),
        /*
         * There is no Q4 projector in the repository. The Q8 encoder is 203MB
         * against 1.05GB of weights; inventing a smaller file would mean a
         * download that does not exist, and leaving it out would mean a vision
         * model that cannot see.
         */
        projector: weights(
          'mmproj-LFM3-VL-2B-Q8_0.gguf',
          203_031_872,
          'c5c5b58d544a18da919172d2d0368090ea1a4a351b6feb7f8a326a264a5918ab',
        ),
      },
    },
  },
  'lfm3-audio-2b': {
    modelId: 'lfm3-audio-2b' as const,
    repo: 'LiquidAI/LFM3-Audio-2B-GGUF',
    revision: AUDIO_REVISION,
    license: 'LFM Open License v1.0',
    variants: {
      q8: {
        weights: weights(
          'LFM3-Audio-2B-Q8_0.gguf',
          1_846_236_704,
          'd4e36902ba8f0ee7b333596030a59d650f88ac76660b4d9ba5ff77c3c2258fc0',
        ),
        projector: weights(
          'mmproj-LFM3-Audio-2B-Q8_0.gguf',
          303_811_840,
          '2b6648b1fd48af16aa0877b0592b144d15070783673e038a379fdbc51d40e365',
        ),
      },
      q4: {
        weights: weights(
          'LFM3-Audio-2B-Q4_K_M.gguf',
          1_099_626_016,
          '9a773289bd321ed879cd3a76545f6aca506e403851a45fb315420aee45625be2',
        ),
        projector: weights(
          'mmproj-LFM3-Audio-2B-Q4_K_M.gguf',
          172_418_048,
          '1a3a895160aad17c1f52117a6ee4cea8e68988651ea5a33c5b990539e8eae81d',
        ),
      },
    },
  },
  'lfm3-omni-2b': {
    modelId: 'lfm3-omni-2b' as const,
    repo: 'LiquidAI/LFM3-Omni-2B-GGUF',
    revision: OMNI_REVISION,
    license: 'LFM Open License v1.0',
    variants: {
      q8: {
        weights: weights(
          'LFM3-Omni-2B-Q8_0.gguf',
          1_846_240_768,
          '59118f661eaacb93d204723d76355b53347f0940b508c11412f6290fd49158d4',
        ),
        projector: weights(
          'mmproj-LFM3-Omni-2B-Q8_0.gguf',
          506_842_528,
          '8a25f9d1931244429de404fccacfb7fb933970a36aa5688d2f5069f29c6b27b1',
        ),
      },
      q4: {
        weights: weights(
          'LFM3-Omni-2B-Q4_K_M.gguf',
          1_099_630_080,
          '9f8d30e9d4fd7a9349d586e077988229b3ca0a0e4ad730897563d1eccc9893e2',
        ),
        projector: weights(
          'mmproj-LFM3-Omni-2B-Q4_K_M.gguf',
          291_586_720,
          '0a746c0794782a16d4456b230c2a0b5888a2d94a6677211edbed7d7a4177a39a',
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
 * The default variant for a model, re-exported so a host does not need a second
 * lookup table.
 *
 * `q4` is the audio and omni default because those are the two a low-memory
 * machine reaches for first and the two where latency matters most; the text and
 * vision models default to `q8` because quality is what they are for.
 */
export function defaultVariantFor(model: LocalModelId): LocalModelVariant {
  return model === 'lfm3-audio-2b' || model === 'lfm3-omni-2b' ? 'q4' : 'q8';
}

/** Every id and variant, for a test that walks the pins. */
export const CHAT_PIN_KEYS = LOCAL_MODEL_IDS.flatMap((modelId) =>
  LOCAL_MODEL_VARIANTS.map((variant) => ({modelId, variant})),
);
