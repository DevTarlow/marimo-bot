/**
 * The voice model's Electron-free half: where it lives, how it is verified,
 * what its voices are, and how text becomes a WAV.
 *
 * The ONNX runtime itself is not here. It is a native package, and the main
 * process owns the processes this app runs; this package owns the arithmetic
 * and the text. That split is what lets the engine be tested with a fake
 * session, and what keeps the headless runner from loading an 82 MB model it
 * will never speak.
 */
export {TTS_DIR_NAME, TTS_MARKER, ttsDir} from './files.js';
export type {TtsInstalledMarker} from './files.js';
export {TTS_FILES, TTS_REVISION, TTS_TOTAL_BYTES, ttsFileUrl} from './pins.js';
export type {TtsFile} from './types.js';
export {installSpeech, isSpeechInstalled} from './install.js';
export type {SpeechInstallOptions} from './install.js';
export {
  readVoiceCatalogue,
  readVoicePacks,
  resolveVoice,
  voicePack,
} from './voices.js';
export type {VoiceCatalogue} from './voices.js';
export {parseNpy, readNpz} from './npz.js';
export type {NpyArray} from './npz.js';
export {cardinal, normalizeEnglish, ordinal, year} from './normalize.js';
export {expandSpeakable, expandToken, spellLetters} from './expand.js';
export {
  chunkPhonemes,
  cmuWord,
  createPhonemizer,
  foldPhonemes,
  MAX_PHONEMES_PER_CHUNK,
  styleRow,
  tokenIds,
} from './frontend.js';
export {ruleBasedPhonemes} from './rule-g2p.js';
export type {PhonemeResult, Phonemize} from './frontend.js';
export {
  joinWithGaps,
  synthesize,
  trimAndFade,
  trimForSpeech,
} from './engine.js';
export type {
  SpeechSession,
  SpeechSessionInput,
  SpeechSessionOutput,
  Synthesized,
  SynthesizeOptions,
} from './engine.js';
export {encodeWav} from './wav.js';
export {splitSpeechSentences} from './sentences.js';
