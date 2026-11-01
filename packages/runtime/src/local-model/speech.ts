/**
 * The two speech endpoints of the audio model's llama-server.
 *
 * They are not the chat endpoint and they are not one endpoint: transcription is
 * an ordinary chat completion whose user content is an audio part and whose
 * system prompt is `Perform ASR in <language>.`; synthesis is `POST /tts`, which
 * returns raw WAV bytes rather than JSON. Both were run against the pinned
 * engine and the real weights before they were written here — the transcription
 * came back word for word, and the synthesis returned a 24kHz mono PCM WAV.
 *
 * Three things this file is responsible for:
 *
 * - **The root URL, not `/v1`.** The chat endpoint lives under `/v1`; `/tts` is
 *   at the server root. The host hands this the root and the paths here are the
 *   whole path, so there is one place a version prefix can be wrong.
 * - **A WAV is checked, not assumed.** A refusal from the engine may arrive as a
 *   JSON error with a 200, and a data URL built from that is a player that fails
 *   silently in the window. The header is inspected before anything is returned.
 * - **A cap on what is spoken.** A reply written for reading can be minutes
 *   long; a voice answer is meant to be short, and a cap that truncates at a
 *   sentence boundary is better than one that cuts a word in half. The flag
 *   travels back so the window can say the end was not read.
 */
import type {SpeechLanguage, SpeechVoice} from '@marimo/protocol';
import {speechLanguage as languageFor} from '@marimo/protocol';

/**
 * Fixed so the companion has one voice. Without it the acoustic sampler draws a
 * new speaker on every answer, and two replies sound like two people.
 */
const SPEECH_SEED = 42;

/** How long one request may take before it is abandoned. */
const DEFAULT_TIMEOUT_MS = 120_000;

/** The most characters one spoken reply may carry. */
export const MAX_SPEECH_CHARS = 1200;

/** Raised with a sentence meant for a person. */
export class SpeechError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SpeechError';
  }
}

export interface TranscribeOptions {
  /** The engine's root: `http://127.0.0.1:<port>`. */
  baseUrl: string;
  /** The alias the engine was started with, sent as the request's model. */
  model: string;
  /** Mono 16-bit PCM WAV. */
  wav: Buffer;
  /** Absent means "let the model infer the language". */
  language?: SpeechLanguage;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export async function transcribeAudio(
  options: TranscribeOptions,
): Promise<string> {
  const instruction =
    options.language === undefined
      ? 'Perform ASR.'
      : `Perform ASR in ${languageFor(options.language).asr}.`;
  const body = {
    model: options.model,
    messages: [
      {role: 'system', content: instruction},
      {
        role: 'user',
        content: [
          {
            type: 'input_audio',
            input_audio: {
              data: options.wav.toString('base64'),
              format: 'wav',
            },
          },
        ],
      },
    ],
    temperature: 0,
    stream: false,
  };

  const response = await post(
    `${options.baseUrl}/v1/chat/completions`,
    body,
    options,
  );
  const parsed = await parseJson(response, 'The speech model');
  const content = (
    parsed as {
      choices?: Array<{message?: {content?: unknown}}>;
    }
  ).choices?.[0]?.message?.content;
  if (typeof content !== 'string' || content.trim().length === 0) {
    throw new SpeechError('The speech model returned no words.');
  }
  return content.trim();
}

export interface SpeakOptions {
  /** The engine's root: `http://127.0.0.1:<port>`. */
  baseUrl: string;
  text: string;
  language?: SpeechLanguage;
  voice?: SpeechVoice;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface SpokenAudio {
  wav: Buffer;
  sampleRate: number;
  /** True when the reply was longer than `MAX_SPEECH_CHARS`. */
  truncated: boolean;
}

export async function synthesizeSpeech(
  options: SpeakOptions,
): Promise<SpokenAudio> {
  const {text, truncated} = trimForSpeech(options.text);
  const response = await post(
    `${options.baseUrl}/tts`,
    {
      input: text,
      ...(options.language === undefined
        ? {}
        : {lang: languageFor(options.language).tts}),
      ...(options.voice === undefined ? {} : {voice: options.voice}),
      response_format: 'wav',
      stream: false,
      /*
       * Fixed so the companion has one voice. Without it the acoustic sampler
       * draws a new speaker on every sentence, and the same setting sounds like
       * a different person between two answers.
       */
      seed: SPEECH_SEED,
    },
    { ...options, timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS },
    true,
  );

  if (response.status !== 200) {
    const detail = await response.text().catch(() => '');
    throw new SpeechError(
      `The voice model would not speak that (${String(response.status)})${
        serverMessage(detail) === undefined
          ? ''
          : `: ${serverMessage(detail)}`
      }.`,
    );
  }

  const wav = Buffer.from(await response.arrayBuffer());
  if (
    wav.length < 44 ||
    wav.toString('ascii', 0, 4) !== 'RIFF' ||
    wav.toString('ascii', 8, 12) !== 'WAVE'
  ) {
    throw new SpeechError(
      'The voice model answered with something that is not a WAV file.',
    );
  }
  const sampleRate = wav.readUInt32LE(24);
  return {wav, sampleRate, truncated};
}

/**
 * The part of a reply that is worth hearing.
 *
 * Ends at the last sentence boundary before the cap, then at the last space,
 * then at the cap. A code block or a bare URL is not made shorter here — the
 * window's own `toSpeech` has already turned markdown into prose — but a reply
 * that arrives with one is still bounded.
 */
export function trimForSpeech(text: string): {text: string; truncated: boolean} {
  const clean = text.trim();
  if (clean.length <= MAX_SPEECH_CHARS) {
    return {text: clean, truncated: false};
  }
  const room = clean.slice(0, MAX_SPEECH_CHARS);
  const sentence = Math.max(
    room.lastIndexOf('. '),
    room.lastIndexOf('! '),
    room.lastIndexOf('? '),
    room.lastIndexOf('.\n'),
  );
  if (sentence > 80) {
    return {text: room.slice(0, sentence + 1).trim(), truncated: true};
  }
  const space = room.lastIndexOf(' ');
  if (space > 80) {
    return {text: room.slice(0, space).trim(), truncated: true};
  }
  return {text: room.trim(), truncated: true};
}

async function post(
  url: string,
  body: unknown,
  options: {fetchImpl?: typeof fetch; timeoutMs?: number},
  raw = false,
): Promise<Response> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch (failure) {
    throw new SpeechError(
      `The speech model could not be reached: ${describe(failure)}.`,
    );
  }
  if (!raw && !response.ok) {
    const detail = await response.text().catch(() => '');
    throw new SpeechError(
      `The speech model refused the request (${String(response.status)})${
        serverMessage(detail) === undefined
          ? ''
          : `: ${serverMessage(detail)}`
      }.`,
    );
  }
  return response;
}

function parseJson(response: Response, label: string): Promise<unknown> {
  return response.text().then(
    (body) => {
      try {
        return JSON.parse(body) as unknown;
      } catch {
        throw new SpeechError(
          `${label} answered with something that is not JSON.`,
        );
      }
    },
    () => {
      throw new SpeechError(`${label} answered with nothing readable.`);
    },
  );
}

function serverMessage(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as {error?: {message?: unknown}};
    const message = parsed.error?.message;
    return typeof message === 'string' && message.length > 0
      ? message
      : undefined;
  } catch {
    return undefined;
  }
}

function describe(failure: unknown): string {
  return failure instanceof Error ? failure.message : String(failure);
}
