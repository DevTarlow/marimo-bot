/**
 * The command line the recall engine is handed, as data.
 *
 * A function that returns an array rather than a `spawn` call with the flags
 * inline, for the reason `service/plan.ts` is split the same way: every mistake
 * worth catching is in the *content* of what gets run, and a test can assert on
 * an array in a millisecond where starting a 310 MB model takes seconds and a
 * machine. The one caller that spawns is tested with a fake.
 *
 * Every flag here has been run against the pinned engine with the real weights —
 * `--embeddings`, `--pooling mean` and both batch sizes, at 8K, with an image and
 * a two-second clip coming back as vectors. That is the standard this file is held
 * to, because each of these fails silently in a different way.
 */
import type {EmbeddingPooling} from './manifest.js';
import type {LocalModelSpec} from './files.js';

/**
 * The id the recall engine answers to, as `--alias` and as the request's `model`.
 *
 * One constant on both sides of the wire: the file name has a quantization in it,
 * and a request that named the file would be a second place the quantization is
 * written down.
 */
export const EMBEDDING_ALIAS = 'embeddinggemma-2';

/**
 * Everything a recall input is given, in tokens.
 *
 * Not a tuning knob but the boundary that makes a media request possible at all:
 * llama.cpp's physical batch defaults to 512, and an input larger than it is
 * refused with a 500 rather than truncated. Measured, on the pinned build: a
 * two-second video is 669 tokens and failed at the default, and the largest
 * input this app will ever send — a 120-second WAV, at about 27 tokens per
 * second — is around 3,000. Two thousand and forty-eight was tried first and is
 * not enough for that WAV, which is why this is a measured number and not a
 * round one.
 */
const EMBEDDING_BATCH = 4096;

/**
 * The command line for the recall model.
 *
 * A function rather than flags written inline at the spawn, for the reason above:
 * this is the one thing about the process that can be asserted without starting
 * one, and every flag that is absent here is absent on purpose.
 *
 * - No `--jinja`. There is no chat template and no tool call; the input is text
 *   the caller assembled, and `--jinja` on an embedding server would be a flag
 *   that does nothing while looking load-bearing.
 * - No `--flash-attn` and no quantized cache. Those exist to make a long chat
 *   context affordable, and an embedding pass keeps no KV cache worth quantizing.
 * - **`--n-gpu-layers 0`**: the recall engine runs on the processor. This model's
 *   card warns that its activations exceed float16's range and return NaN in it,
 *   while the CPU backend accumulates in f32 — so the slower path is also the one
 *   that does not need the model card's warning. An embedding is a single pass
 *   over at most 8K tokens, which is the other half of why a GPU buys less here
 *   than it does for a conversation.
 * - No `--no-webui` omission: there is still no browser to serve.
 *
 * `--batch-size` and `--ubatch-size` are both set, and setting only the second
 * would be wrong: llama.cpp clamps `n_batch` down to `n_ubatch` with a warning,
 * so an install that raised one and not the other would silently lose the batching
 * that makes indexing a folder quick.
 */
export function embeddingArgs(spec: EmbeddingSpec): string[] {
  return [
    '--model',
    spec.model,
    ...(spec.projector === undefined
      ? []
      : ['--mmproj', spec.projector]),
    '--alias',
    EMBEDDING_ALIAS,
    '--host',
    '127.0.0.1',
    '--port',
    String(spec.port),
    '--ctx-size',
    String(spec.contextSize),
    '--n-gpu-layers',
    '0',
    '--embeddings',
    '--pooling',
    spec.pooling,
    '--parallel',
    '1',
    '--batch-size',
    String(EMBEDDING_BATCH),
    '--ubatch-size',
    String(EMBEDDING_BATCH),
    '--no-webui',
  ];
}

export interface EmbeddingSpec {
  /** The `llama-server` binary. */
  engine: string;
  /** The text backbone's GGUF. */
  model: string;
  /**
   * The vision and audio projector, when this install has one.
   *
   * Absent is not "text preferred": without it the engine has no image encoder
   * in the process, and a picture cannot be embedded at all.
   */
  projector?: string;
  /**
   * The loopback port it came up on.
   *
   * A string is allowed for the one caller that has no port yet: the status the
   * Recall card draws shows the command *before* anything is running, and
   * `--port <port>` is a truer answer there than a zero that looks like one.
   */
  port: number | string;
  contextSize: number;
  pooling: EmbeddingPooling;
}

/**
 * The command line for one LFM3 model.
 *
 * Every flag here was run against the pinned engine and the real weights before
 * it was written down, because each one fails silently in its own way:
 *
 * - `--jinja` is what makes tool calls work. The GGUF carries the model's own
 *   chat template, and the template is what renders the tools; without it the
 *   model answers prose and the harness sees no call.
 * - `--reasoning off` is the measured choice described in `files.ts`: the small
 *   model's default thinking produced 271 hidden tokens for a greeting on a
 *   laptop processor. The answer is still the answer; only the rehearsal is
 *   gone.
 * - `--n-gpu-layers 0` is the CPU path the archive is pinned for. A machine with
 *   a graphics card can be made faster later; a build that needs one cannot run
 *   at all on the machines this app is for.
 * - `--ctx-size` is the descriptor's working window, not the model's maximum.
 *   The 256K window a 1.7B model supports would cost more KV cache than the
 *   weights; the harness compacts inside the smaller one.
 * - Sampling travels here rather than in the request so every turn uses the
 *   model card's recipe, including a turn with no settings of its own.
 * - `--no-ui` is the engine's own browser; there is no browser to serve.
 */
export function localModelArgs(spec: LocalModelSpec, port: number | string): string[] {
  const sampling = spec.sampling;
  return [
    '--model',
    spec.files.model,
    ...(spec.files.projectorPresent && spec.files.projector.length > 0
      ? ['--mmproj', spec.files.projector]
      : []),
    '--alias',
    spec.alias,
    '--host',
    '127.0.0.1',
    '--port',
    String(port),
    '--ctx-size',
    String(spec.contextSize),
    '--n-gpu-layers',
    '0',
    '--parallel',
    '1',
    '--no-ui',
    '--jinja',
    '--reasoning',
    spec.reasoning,
    '--temp',
    String(sampling.temperature),
    '--top-k',
    String(sampling.topK),
    '--repeat-penalty',
    String(sampling.repeatPenalty),
    ...(sampling.topP === undefined
      ? []
      : ['--top-p', String(sampling.topP)]),
  ];
}
