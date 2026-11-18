/**
 * One reply, from text to a WAV.
 *
 * The pieces this file is responsible for are the ones that are invisible in
 * the finished audio but audible when wrong:
 *
 * - **A chunk is spoken on its own.** The model's style vector is chosen by the
 *   token count, and the first chunk keeps its start pause while later chunks
 *   lose it; that is what makes two chunks join without a swallowed word.
 * - **The duration frame is cut, not the word.** Each chunk's first and last
 *   duration frame are trimmed, then a 5 ms fade is applied. Without the fade a
 *   join clicks; without the trim the model reads the sentence twice.
 * - **A total cap.** An answer written for reading can be minutes long; the cap
 *   ends at a sentence or a space and reports that it did, so the window can say
 *   the end was not read rather than pretending the reply was complete.
 *
 * The engine talks to a session interface rather than to ONNX. That is what lets
 * the trimming, fading, joining and WAV encoding be tested without an 82 MB
 * model, and it keeps the native runtime in the main process where the rest of
 * the app's processes live.
 */
import {SPEECH_MAX_CHARS} from '@marimo/protocol';

import {chunkPhonemes, styleRow, tokenIds, type Phonemize} from './frontend.js';
import {encodeWav} from './wav.js';

/** What one ONNX run needs. */
export interface SpeechSessionInput {
  inputIds: BigInt64Array;
  style: Float32Array;
  speed: number;
}

/** What one ONNX run answers: the waveform and the duration of each token. */
export interface SpeechSessionOutput {
  waveform: Float32Array;
  durations: ArrayLike<number>;
}

/** The session the engine drives. The main process supplies the ONNX one. */
export interface SpeechSession {
  run(input: SpeechSessionInput): Promise<SpeechSessionOutput>;
}

export interface SynthesizeOptions {
  text: string;
  vocab: Readonly<Record<string, number>>;
  /** The selected voice's `[rows, 256]` style table. */
  voicePack: Float32Array;
  session: SpeechSession;
  phonemize: Phonemize;
  sampleRate: number;
  /** How fast the voice speaks; the model's own speed tensor. Default 1. */
  speed?: number;
  maxChars?: number;
}

export interface Synthesized {
  wav: Uint8Array;
  sampleRate: number;
  /** True when the reply was longer than the cap. */
  truncated: boolean;
}

/** The pause between two chunks, as the model repository joins them. */
const GAP_SECONDS = 0.15;

/** The length of the fade at each end of a chunk, in samples at 24 kHz. */
const FADE_SAMPLES = 120;

export async function synthesize(
  options: SynthesizeOptions,
): Promise<Synthesized> {
  const cap = options.maxChars ?? SPEECH_MAX_CHARS;
  const {text, truncated} = trimForSpeech(options.text, cap);
  if (text.length === 0) {
    throw new Error('There were no words to speak.');
  }
  const {phonemes} = await options.phonemize(text);
  const chunks = chunkPhonemes(phonemes);
  if (chunks.length === 0) {
    throw new Error('There were no words to speak.');
  }

  const speed = Math.min(2, Math.max(0.5, options.speed ?? 1));
  const pieces: Float32Array[] = [];
  for (const chunk of chunks) {
    const {ids} = tokenIds(chunk, options.vocab);
    if (ids.length <= 2) {
      continue;
    }
    const output = await options.session.run({
      inputIds: BigInt64Array.from(ids, (id) => BigInt(id)),
      style: styleRow(options.voicePack, ids.length),
      speed,
    });
    pieces.push(trimAndFade(output.waveform, output.durations));
  }
  if (pieces.length === 0) {
    throw new Error('There were no words to speak.');
  }

  const joined = joinWithGaps(pieces, options.sampleRate);
  return {
    wav: encodeWav(joined, options.sampleRate),
    sampleRate: options.sampleRate,
    truncated,
  };
}

/**
 * Trim the model's first and last duration frame and fade the ends.
 *
 * The samples per frame is derived from the waveform and the summed durations
 * rather than assumed, which is what keeps a 510-row voice pack and a shorter
 * one on the same arithmetic. The guard keeps an unusually short chunk from
 * trimming itself away.
 */
export function trimAndFade(
  waveform: Float32Array,
  durations: ArrayLike<number>,
): Float32Array {
  const wav = Float32Array.from(waveform, (value) =>
    Math.max(-1, Math.min(1, value)),
  );
  let total = 0;
  for (let index = 0; index < durations.length; index += 1) {
    total += Number(durations[index] ?? 0);
  }
  const samplesPerFrame = Math.max(
    1,
    Math.round(wav.length / Math.max(total, 1)),
  );
  const lead = Math.max(0, Number(durations[0] ?? 0) - 1) * samplesPerFrame;
  const trail =
    Math.max(0, Number(durations[durations.length - 1] ?? 0) - 1) *
    samplesPerFrame;
  let out = wav;
  if (lead + trail + samplesPerFrame < wav.length) {
    out = trail > 0 ? wav.slice(lead, wav.length - trail) : wav.slice(lead);
  }
  const faded = new Float32Array(out);
  const fade = Math.min(FADE_SAMPLES, Math.floor(faded.length / 8));
  if (fade > 0) {
    for (let index = 0; index < fade; index += 1) {
      faded[index] = (faded[index] ?? 0) * (index / fade);
    }
    for (let index = 0; index < fade; index += 1) {
      const at = faded.length - 1 - index;
      faded[at] = (faded[at] ?? 0) * (index / fade);
    }
  }
  return faded;
}

/** Join chunks with the model's 0.15 s of silence between them. */
export function joinWithGaps(
  pieces: readonly Float32Array[],
  sampleRate: number,
): Float32Array {
  if (pieces.length === 0) {
    return new Float32Array(0);
  }
  const gap = Math.round(GAP_SECONDS * sampleRate);
  const length =
    pieces.reduce((total, piece) => total + piece.length, 0) +
    gap * (pieces.length - 1);
  const out = new Float32Array(Math.max(0, length));
  let at = 0;
  for (const [index, piece] of pieces.entries()) {
    out.set(piece, at);
    at += piece.length;
    if (index < pieces.length - 1) {
      at += gap;
    }
  }
  return out;
}

/**
 * The part of a reply that is worth hearing.
 *
 * Ends at the last sentence boundary before the cap, then at the last space,
 * then at the cap. The window's `toSpeech` has already turned markdown into
 * prose; this is the second gate, for a reply that arrives long.
 */
export function trimForSpeech(
  text: string,
  maxChars = SPEECH_MAX_CHARS,
): {text: string; truncated: boolean} {
  const clean = text.trim();
  if (clean.length <= maxChars) {
    return {text: clean, truncated: false};
  }
  const room = clean.slice(0, maxChars);
  const sentence = Math.max(
    room.lastIndexOf('. '),
    room.lastIndexOf('! '),
    room.lastIndexOf('? '),
    room.lastIndexOf('.\n'),
  );
  if (sentence > 80) {
    return {
      text: room.slice(0, sentence + 1).trim(),
      truncated: true,
    };
  }
  const space = room.lastIndexOf(' ');
  if (space > 80) {
    return {text: room.slice(0, space).trim(), truncated: true};
  }
  return {text: room.trim(), truncated: true};
}
