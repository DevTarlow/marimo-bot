/**
 * The two pieces of audio plumbing the microphone needs.
 *
 * Both are pure functions over buffers, which is the point: a WAV header with
 * the wrong byte rate is a file the engine transcribes as noise, and a resampler
 * that reads past the end is a click in the middle of a word. Neither is visible
 * from the window, so both are tested without a microphone.
 */

/**
 * Mono 16-bit PCM in a WAV container.
 *
 * The engine's `input_audio` part names `wav` and nothing more specific; 16-bit
 * PCM is the conventional shape and the one a speech model's preprocessing
 * expects. Samples are clamped rather than wrapped: a lossy capture can produce
 * one outside [-1, 1], and a wrapped sample is a loud click.
 */
export function encodeWav(
  samples: Float32Array,
  sampleRate: number,
): Uint8Array {
  const bytes = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode('RIFF'), 0);
  view.setUint32(4, 36 + samples.length * 2, true);
  bytes.set(new TextEncoder().encode('WAVE'), 8);
  bytes.set(new TextEncoder().encode('fmt '), 12);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  bytes.set(new TextEncoder().encode('data'), 36);
  view.setUint32(40, samples.length * 2, true);
  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index] ?? 0));
    view.setInt16(44 + index * 2, Math.round(sample * 32_767), true);
  }
  return bytes;
}

/**
 * Linear resampling to the rate the audio model was trained on.
 *
 * A microphone often runs at 44.1 or 48kHz even when asked for 16, and the
 * model's preprocessing assumes 16. Linear interpolation is not a studio
 * resampler; for speech at this length it is more than enough, and the
 * alternative is a dependency whose only job would be to do the same arithmetic
 * more precisely than a recogniser needs.
 */
export function resample(
  samples: Float32Array,
  fromRate: number,
  toRate: number,
): Float32Array {
  if (fromRate === toRate || samples.length === 0) {
    return samples;
  }
  const ratio = fromRate / toRate;
  const length = Math.max(1, Math.round(samples.length / ratio));
  const output = new Float32Array(length);
  for (let index = 0; index < length; index += 1) {
    const position = index * ratio;
    const left = Math.floor(position);
    const right = Math.min(samples.length - 1, left + 1);
    const fraction = position - left;
    output[index] =
      (samples[left] ?? 0) * (1 - fraction) +
      (samples[right] ?? 0) * fraction;
  }
  return output;
}

/**
 * Base64, in chunks.
 *
 * `String.fromCharCode(...bytes)` on a two-megabyte WAV spreads the array into
 * one call and overflows the argument limit; the loop is what keeps a
 * push-to-talk clip from throwing before it reaches the main process.
 */
export function base64FromBytes(bytes: Uint8Array): string {
  const chunk = 0x8000;
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  }
  return btoa(binary);
}
