/**
 * The audio arithmetic the renderer owns: level, silence, resampling and the
 * Int16 form the IPC carries.
 *
 * The model takes 16 kHz Float32; a microphone usually gives 44.1 or 48 kHz. The
 * resampler is an `OfflineAudioContext` because Chromium already has a
 * band-limited one, and a hand-written decimator without a filter would fold
 * high frequencies back into the speech band. `downsampleLinear` is the fallback
 * for a context that is unavailable, not the first choice.
 */
/** The renderer's copy of the model rate, which it cannot import as a runtime value. */
const SAMPLE_RATE = 16_000;

/** Root mean square of a block, for the level meter and the silence test. */
export function rmsOf(samples: Float32Array): number {
  if (samples.length === 0) {
    return 0;
  }
  let sum = 0;
  for (const sample of samples) {
    sum += sample * sample;
  }
  return Math.sqrt(sum / samples.length);
}

/** Whether a block is loud enough to be speech rather than room. */
export function isSpeech(rms: number, threshold = 0.015): boolean {
  return rms >= threshold;
}

/**
 * Whether the recording has heard speech and then gone quiet long enough.
 *
 * The first 600 ms are a grace period: a person who presses the button and takes
 * a breath should not have the recording end before they speak. With no speech
 * yet, silence never stops anything; a silent room runs to the duration cap.
 */
export function silenceReached(
  state: {speechSeen: boolean; silentMs: number; elapsedMs: number},
  options: {silenceMs?: number; minMs?: number} = {},
): boolean {
  const silenceMs = options.silenceMs ?? 1500;
  const minMs = options.minMs ?? 600;
  return (
    state.speechSeen && state.elapsedMs >= minMs && state.silentMs >= silenceMs
  );
}

/** How many samples a resampled clip will have. */
export function resampleLength(
  samples: number,
  sourceRate: number,
  targetRate = SAMPLE_RATE,
): number {
  if (sourceRate === targetRate) {
    return samples;
  }
  return Math.max(1, Math.round((samples * targetRate) / sourceRate));
}

/**
 * Resample to 16 kHz with Chromium's own offline graph, or fall back to linear.
 *
 * The fallback is documented as a fallback: it interpolates and does not filter,
 * so an aliased recording is a recording that will transcribe worse rather than
 * one that fails. Electron ships `OfflineAudioContext`, so it should not run.
 */
export async function resampleTo16k(
  samples: Float32Array,
  sourceRate: number,
): Promise<Float32Array> {
  if (sourceRate === SAMPLE_RATE) {
    return samples;
  }
  if (typeof OfflineAudioContext === 'undefined') {
    return downsampleLinear(samples, sourceRate);
  }
  const length = resampleLength(samples.length, sourceRate);
  const context = new OfflineAudioContext(1, length, SAMPLE_RATE);
  const buffer = context.createBuffer(1, samples.length, sourceRate);
  buffer.getChannelData(0).set(samples);
  const source = context.createBufferSource();
  source.buffer = buffer;
  source.connect(context.destination);
  source.start();
  const rendered = await context.startRendering();
  return rendered.getChannelData(0);
}

/** Linear interpolation, for a context that is not available. */
export function downsampleLinear(
  samples: Float32Array,
  sourceRate: number,
  targetRate = SAMPLE_RATE,
): Float32Array {
  if (sourceRate === targetRate) {
    return samples;
  }
  const length = resampleLength(samples.length, sourceRate, targetRate);
  const out = new Float32Array(length);
  const ratio = sourceRate / targetRate;
  for (let index = 0; index < length; index += 1) {
    const at = index * ratio;
    const low = Math.floor(at);
    const high = Math.min(samples.length - 1, low + 1);
    const fraction = at - low;
    const a = samples[low] ?? 0;
    const b = samples[high] ?? a;
    out[index] = a + (b - a) * fraction;
  }
  return out;
}

/** Join the worklet's blocks into one clip. */
export function concatChunks(chunks: readonly Float32Array[]): Float32Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Float32Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

/**
 * Float32 to little-endian Int16 base64, clamped before rounding.
 *
 * The model runs on floats, but the IPC payload is Int16: 60 seconds is 1.92 MB
 * instead of 3.84 MB, and 16 bits is more than speech recognition needs. The
 * clamp is what stops a loud sample from wrapping to the opposite sign.
 */
export function int16Base64(samples: Float32Array): string {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < samples.length; index += 1) {
    const value = Math.max(-1, Math.min(1, samples[index] ?? 0));
    view.setInt16(index * 2, Math.round(value * 32767), true);
  }
  let binary = '';
  const chunk = 0x8000;
  for (let at = 0; at < bytes.length; at += chunk) {
    binary += String.fromCharCode(...bytes.subarray(at, at + chunk));
  }
  return btoa(binary);
}
