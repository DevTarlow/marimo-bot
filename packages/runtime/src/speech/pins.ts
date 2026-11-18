/**
 * The voice model, pinned by repository revision and by the sha256 of every
 * file the app downloads.
 *
 * The pins are code rather than a manifest the app goes and finds, for the
 * reason recall's are: the window and the headless runner resolve the same
 * directory, and a file read at run time is one more way for the two to
 * disagree. A module has no path to disagree about.
 *
 * The revision is the model repository's current commit when this build was
 * written. It is not `main`: a repository that moves under a shipped app turns
 * a verified download into a file nobody tested. Every digest below was
 * measured against the files at this revision, and the ONNX digest is the LFS
 * object id Hugging Face publishes.
 */
import type {TtsFile} from './types.js';

/** The repository revision every file is fetched at. */
export const TTS_REVISION = 'c01797caec3967b400da457656e011eb81f530a4';

const BASE = 'https://huggingface.co/KittenML/kitten-tts-2-mini/resolve';

/**
 * The five files this build needs.
 *
 * Only the English voice pack is downloaded. The model is one ONNX graph for
 * every language it speaks, but the text frontend in this build is English, so
 * the other fifteen voice packs would be a download with no way to use it. A
 * later language adds its pack here, a frontend and a line in the picker — never
 * a second copy of the model.
 */
export const TTS_FILES: readonly TtsFile[] = [
  {
    /** The name the file is stored under inside `model/tts/`. */
    name: 'kitten_tts_2_mini.onnx',
    /** The path in the repository, which is not always the stored name. */
    path: 'kitten_tts_2_mini.onnx',
    label: 'The voice model',
    bytes: 82_711_386,
    sha256: 'fa821c1cdd8f7fbfdbd5d1cae0a767673871d62696b85af7db059a9bd26b42d2',
  },
  {
    name: 'voices_en.npz',
    path: 'voices_en.npz',
    label: 'The English voices',
    bytes: 5_747_328,
    sha256: '5c18573d075f53f6f218c2056dfc84ad10e976e81e23d55e5a7a6adc6e9135a4',
  },
  {
    name: 'vocab.json',
    path: 'vocab.json',
    label: 'The phoneme list',
    bytes: 1_324,
    sha256: 'b007200ac2a7973ac25c509f8346815076b9d9f33758cb0bfe4de99e2f58f851',
  },
  {
    name: 'config.json',
    path: 'config.json',
    label: 'The voice catalogue',
    bytes: 16_329,
    sha256: 'e6a63545213fbb677da62e1bc9946059033252bf61f57682b47cb6d8a54d0cbf',
  },
  {
    /*
     * The CMU dictionary, converted to the model's phoneme alphabet. It is the
     * fallback for the words misaki's lexicon does not know, which the model
     * card measures at about one word in sixty.
     */
    name: 'cmu_misaki_us.json',
    path: 'g2p/cmu_misaki_us.json',
    label: 'The pronunciation dictionary',
    bytes: 3_418_388,
    sha256: 'ae564e1a76df3501058a5ec99d135d016759c9475042fb6c3811374daee1ef04',
  },
];

/** The bytes a fresh install downloads, for the card's sentence. */
export const TTS_TOTAL_BYTES = TTS_FILES.reduce(
  (total, file) => total + file.bytes,
  0,
);

/** Where one file is fetched from, at the pinned revision. */
export function ttsFileUrl(file: TtsFile): string {
  return `${BASE}/${TTS_REVISION}/${file.path}`;
}

/*
 * A pin that is not a digest is a check that hashes nothing and passes
 * everything. Caught here, at import, so a truncated paste is a loud failure at
 * startup rather than a first download that fails on somebody's machine.
 */
for (const file of TTS_FILES) {
  if (!/^[0-9a-f]{64}$/u.test(file.sha256)) {
    throw new Error(
      `The voice-model pin for ${file.name} is not a sha256 digest.`,
    );
  }
  if (!Number.isSafeInteger(file.bytes) || file.bytes <= 0) {
    throw new Error(`The voice-model pin for ${file.name} has no size.`);
  }
}
