/**
 * Local voice input: the preference, the model's state, the microphone lease
 * and the PCM one transcription carries.
 *
 * The preference is a block for the same reason spoken replies are one: the
 * switch, the chosen device and the two behaviour answers are one question, and
 * a window that sent back only the switch must not erase the microphone it did
 * not mention.
 *
 * **The model is not a preference.** Whether it is on disk, how far a download
 * has got and whether the CPU graphs are loaded are facts about this machine, so
 * they travel as a status read beside the settings and never as fields in the
 * settings file. A settings file that claimed the model was installed would be a
 * card describing a download nobody had made.
 *
 * **The microphone is a lease, not a setting.** Two windows share one
 * conversation and one computer; the main process grants one capture at a time
 * and answers with a token. A transcription that arrives with an old token is a
 * stale recording, not a second customer.
 */
import {z} from 'zod';

/**
 * The bytes the voice-input model downloads.
 *
 * The sum of the seven pinned files. It is here rather than only in the pins so
 * the Settings card and the README can name the size without importing the
 * download code; a runtime test asserts the two are the same number, which is
 * what stops the sentence and the download from drifting apart.
 */
export const LISTEN_MODEL_BYTES = 165_489_086;

/** The size in the words the card uses, rounded because a byte count is noise. */
export const LISTEN_MODEL_LABEL = 'about 158 MB';

/**
 * The longest clip one microphone press may produce.
 *
 * A stuck-open microphone is a memory leak with a UI; the runtime trims to this
 * and the renderer stops at it. Sixty seconds is long enough for a dictated
 * question and short enough that the decoder's 6.5-token-per-second guard does
 * not run into the model's own 448-token ceiling.
 */
export const LISTEN_MAX_SECONDS = 60;

/**
 * The shortest clip worth sending.
 *
 * Under a third of a second the model has no words to condition on and
 * hallucinates one. The renderer refuses to transcribe a shorter press; this is
 * the number both the capture hook and the live check use.
 */
export const LISTEN_MIN_SECONDS = 0.3;

/** The surfaces that can ask for the microphone. */
export const LISTEN_SURFACES = ['window', 'pet', 'settings'] as const;

export type ListenSurface = (typeof LISTEN_SURFACES)[number];

/**
 * What the settings file holds about voice input.
 *
 * `deviceId` is null for the OS default, which is also what a fresh install
 * uses. `deviceLabel` is the friendly name captured when the device was
 * chosen, so the card can say which disconnected microphone it is falling back
 * from; the id remains the authority for reconnecting it.
 */
export const listenSettingsSchema = z.object({
  /** Off until the person turns it on; a fresh install downloads nothing. */
  enabled: z.boolean(),
  /** The chosen `audioinput` device, or null for whatever the OS calls default. */
  deviceId: z.string().max(512).nullable(),
  /** The label at the moment it was chosen, for the missing-device sentence. */
  deviceLabel: z.string().max(200).nullable(),
  /** Off inserts the transcript for review; on sends it. */
  autoSend: z.boolean(),
  /** Off is click-to-start/stop; on stops after trailing silence. */
  autoStopOnSilence: z.boolean(),
});

export type ListenSettings = z.infer<typeof listenSettingsSchema>;

export function defaultListenSettings(): ListenSettings {
  return {
    enabled: false,
    deviceId: null,
    deviceLabel: null,
    // Review before sending is the safe default: a wrong transcript that was
    // sent is a turn the person has to correct, while one in the box costs a
    // glance.
    autoSend: false,
    // Silence detection is a convenience, and a noisy room makes it the wrong
    // answer. Off by default; the person turns it on knowing their room.
    autoStopOnSilence: false,
  };
}

/** A patch of the block: any subset, merged over what is stored. */
export const listenSettingsPatchSchema = listenSettingsSchema.partial();

export type ListenSettingsPatch = z.infer<typeof listenSettingsPatchSchema>;

/** Which CPU graphs a ready host is holding, if any. */
export type ListenEngineState = 'idle' | 'loading' | 'ready';

/** How far one download has got, in the terms the card's bar needs. */
export interface ListenDownloadProgress {
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
 * no graph is loaded, `loading` is the first transcription's wait, and `ready`
 * means the host is holding the decoder. A card that called that "installed"
 * would confuse the disk with the memory.
 */
export interface ListenStatus {
  installed: boolean;
  /** The bytes a fresh install downloads, for the card's sentence. */
  modelBytes: number;
  /** The clip cap, so the card and the README cannot disagree. */
  maxSeconds: number;
  downloading?: ListenDownloadProgress;
  /** Why the model cannot be used, when it is installed but unreadable. */
  error?: string;
  engine: ListenEngineState;
}

/** Why a capture was refused, in the words the card turns into a sentence. */
export type ListenCaptureReason =
  | 'disabled'
  | 'not-installed'
  | 'in-use'
  | 'transcribing'
  | 'permission-denied';

/**
 * The answer to a capture request.
 *
 * A granted lease carries the token every later call must present. A refusal
 * carries the reason and, for `in-use`, the surface holding it — the window and
 * the moss have different words for each other.
 */
export interface ListenCaptureGrant {
  granted: boolean;
  token?: string;
  reason?: ListenCaptureReason;
  holder?: ListenSurface;
}

/** What one transcription returns. `text` is empty when it was cancelled. */
export interface ListenTranscription {
  text: string;
  /** True when a stop, a cancel or the lease timeout dropped the result. */
  cancelled: boolean;
  /** True when the clip was longer than `LISTEN_MAX_SECONDS` or hit the token cap. */
  truncated: boolean;
  /** How long the CPU took, for the live check and the card's quiet receipt. */
  ms: number;
  /** Echoed so a renderer can discard a result for a recording it has left. */
  clipId: string;
}
