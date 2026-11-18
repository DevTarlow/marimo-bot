/**
 * The shapes the voice-input pipeline speaks in.
 *
 * The engine talks to an interface rather than to ONNX, for the reason the
 * speech engine does: the padding, windowing, greedy loop and tokenisation have
 * to be testable without a 165 MB model, and the native runtime has to stay in
 * the main process. The main process supplies `ListenGraphs`; everything in this
 * file is plain data.
 */

/** One pinned file, as the installer downloads and verifies it. */
export interface ListenFile {
  /** The name the file is stored under inside `model/listen/small/`. */
  name: string;
  /** The path in the asset repository, which includes the dated snapshot. */
  path: string;
  /** What the progress bar says it is fetching. */
  label: string;
  bytes: number;
  sha256: string;
}

/**
 * The frontend's carry-over state, exactly as `streaming_config.json` names it.
 *
 * The shapes are read rather than derived: the model is the authority on how
 * many samples and convolution frames it carries, and a derived shape that
 * disagreed with the graph would fail on the first run with a tensor-shape
 * error rather than a sentence.
 */
export interface ListenStateShapes {
  sample_buffer: number[];
  sample_len: number[];
  conv1_buffer: number[];
  conv2_buffer: number[];
  frame_count: number[];
}

/** The model's own dimensions, read from the pinned `streaming_config.json`. */
export interface ListenConfig {
  encoderDim: number;
  decoderDim: number;
  depth: number;
  nheads: number;
  headDim: number;
  vocabSize: number;
  bosId: number;
  eosId: number;
  frameLen: number;
  totalLookahead: number;
  dModelFrontend: number;
  c1: number;
  c2: number;
  stateShapes: ListenStateShapes;
}

/** One frontend call: an audio chunk plus the state carried from the last one. */
export interface ListenFrontendInput {
  audio: Float32Array;
  sampleBuffer: Float32Array;
  sampleLen: number;
  conv1Buffer: Float32Array;
  conv2Buffer: Float32Array;
  frameCount: number;
}

/** What the frontend answers: features and the state for the next chunk. */
export interface ListenFrontendOutput {
  features: Float32Array;
  featureFrames: number;
  sampleBuffer: Float32Array;
  sampleLen: number;
  conv1Buffer: Float32Array;
  conv2Buffer: Float32Array;
  frameCount: number;
}

/** Cross-attention keys and values for the whole memory span. */
export interface ListenCross {
  k: Float32Array;
  v: Float32Array;
  frames: number;
}

/** One decoder step. */
export interface ListenDecoderInput {
  token: number;
  kSelf: Float32Array;
  vSelf: Float32Array;
  cacheLen: number;
  kCross: Float32Array;
  vCross: Float32Array;
  crossLen: number;
}

export interface ListenDecoderOutput {
  logits: Float32Array;
  kSelf: Float32Array;
  vSelf: Float32Array;
  cacheLen: number;
}

/**
 * The five graphs, as the engine drives them.
 *
 * The main process owns the sessions and the release rules: `crossKv` may
 * release the four encoding graphs once it has copied their answers, and
 * `release` drops everything. The engine only calls the methods in order.
 */
export interface ListenGraphs {
  frontend(input: ListenFrontendInput): Promise<ListenFrontendOutput>;
  encoder(features: Float32Array, frames: number): Promise<Float32Array>;
  adapter(
    encoded: Float32Array,
    frames: number,
    posOffset: number,
  ): Promise<Float32Array>;
  crossKv(memory: Float32Array, frames: number): Promise<ListenCross>;
  decoder(input: ListenDecoderInput): Promise<ListenDecoderOutput>;
  release(): Promise<void>;
}

/** The decoded token table, as `tokenizer.bin` stores it. */
export interface ListenBinTokenizer {
  readonly tokens: readonly Uint8Array[];
}

/** What one transcription produces. */
export interface ListenResult {
  text: string;
  tokens: number[];
  durationSeconds: number;
  /** True when the clip was longer than the cap or the token cap was hit. */
  truncated: boolean;
  truncatedByTokens: boolean;
  ms: number;
}
