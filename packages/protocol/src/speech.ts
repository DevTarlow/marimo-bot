/**
 * Spoken replies: the preference, the model's state and the audio one reply
 * returns.
 *
 * The preference is a block for the reason the companion and recall blocks are
 * one: the switch, the voice and the spoken length are three answers to one
 * question, and a window that sent back only the switch must not erase the
 * voice it did not mention.
 *
 * **The model itself is not a preference.** Whether it is on disk, how far a
 * download has got and whether the engine is loaded are facts about this
 * machine, so they travel as a status read beside the settings and never as
 * fields in the settings file — a file that claimed the model was installed
 * would be a card describing a download nobody had made.
 */
import {z} from 'zod';

import {companionAnswerLengthSchema} from './answer-length.js';

/**
 * The most characters one spoken reply may carry.
 *
 * A reply written for reading can be minutes long; a voice answer is meant to
 * be short. The cap ends at a sentence boundary when it can, and the flag
 * travels back so the window can say the end was not read. The number is shared
 * with nothing else now that speech is one request per turn, so it lives here
 * rather than beside the renderer's cleaner.
 */
export const SPEECH_MAX_CHARS = 1200;

/**
 * What the audition button says.
 *
 * One sentence with no numbers, paths or names. A sample's job is to show the
 * voice, and a sentence that the G2P has to guess at would be a sample of the
 * guess rather than of the voice.
 */
export const SPEECH_SAMPLE_TEXT = 'Hello. This is what I sound like.';

/** The voice a fresh install starts on; one of the model's English voices. */
export const DEFAULT_SPEECH_VOICE = 'eleanor';

/**
 * The bytes the voice model downloads.
 *
 * The sum of the five pinned files. It is here rather than only in the pins so
 * the Settings card can name the size without importing the download code; a
 * runtime test asserts the two are the same number, which is what stops the
 * sentence and the download from drifting apart.
 */
export const SPEECH_MODEL_BYTES = 91_894_755;

/** The size in the words the card uses, rounded because a byte count is noise. */
export const SPEECH_MODEL_LABEL = 'about 92 MB';

/**
 * What the settings file holds about spoken replies.
 *
 * `answerLength` is the spoken length, not the companion's. The two exist
 * separately because they answer different questions: how much room a floating
 * answer has on screen, and how long a listener will sit still for. Keeping them
 * separate is also what lets the spoken default be `brief` without changing what
 * the companion does when speech is off.
 */
export const speechSettingsSchema = z.object({
  /** Off until the person turns it on; a fresh install downloads nothing. */
  enabled: z.boolean(),
  /**
   * The model's voice key, not its display name.
   *
   * The key is what `voices_en.npz` names and what the synthesiser selects; the
   * name is for the picker and can be changed without invalidating a stored
   * choice. A key the model no longer has is resolved to the first voice when it
   * is used rather than failing the settings read.
   */
  voice: z.string().min(1).max(64),
  /**
   * How long a spoken answer should be.
   *
   * `brief` by default: a sentence read aloud costs the listener time that a
   * paragraph on screen does not, and the person asked for the short version.
   * The companion's own length still governs its text when speech is off.
   */
  answerLength: companionAnswerLengthSchema,
});

export type SpeechSettings = z.infer<typeof speechSettingsSchema>;

export function defaultSpeechSettings(): SpeechSettings {
  return {
    enabled: false,
    voice: DEFAULT_SPEECH_VOICE,
    answerLength: 'brief',
  };
}

/** A patch of the block: any subset, merged over what is stored. */
export const speechSettingsPatchSchema = speechSettingsSchema.partial();

/** One voice the downloaded model can speak in. */
export interface SpeechVoice {
  /** The key `voices_en.npz` stores the style vectors under. */
  key: string;
  /** The name a person picks from the list. */
  name: string;
  /** The one line the model repository uses to describe it. */
  description: string;
  /**
   * The language the voice pack belongs to.
   *
   * A literal rather than a string because this build only ships the English
   * frontend; widening it is a real change to the text pipeline, not a label.
   */
  language: 'en';
}

/** How far one download has got, in the terms the card's bar needs. */
export interface SpeechDownloadProgress {
  /** What is being fetched, in words: `The voice model`, `The voices`. */
  label: string;
  receivedBytes: number;
  totalBytes: number;
  /** `0`–`100`, or absent when the server did not say how large it is. */
  percent?: number;
}

/**
 * What the Settings card draws, as the main process found it.
 *
 * `engine` is the session, not the files: `idle` means the model is on disk but
 * no session is loaded, `loading` is the first reply's wait, and `ready` means a
 * session is held. A card that called that "installed" would confuse the disk
 * with the memory.
 */
export interface SpeechStatus {
  installed: boolean;
  voices: SpeechVoice[];
  downloading?: SpeechDownloadProgress;
  /** Why the model cannot be used, when it is installed but unreadable. */
  error?: string;
  engine: 'idle' | 'loading' | 'ready';
}

/** The WAV one reply or sample returns, ready for a data URL. */
export interface SpokenAudio {
  wavBase64: string;
  sampleRate: number;
  /** True when the reply was longer than `SPEECH_MAX_CHARS`. */
  truncated: boolean;
}
