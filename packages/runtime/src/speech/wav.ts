/**
 * Mono 16-bit PCM in a WAV container.
 *
 * The model returns float32 samples at 24 kHz; the window plays a data URL, and
 * a WAV header is the whole container it needs. Samples are clamped rather than
 * wrapped: a synthesis artefact outside [-1, 1] becomes a loud click when
 * wrapped, and silence at the end of one is the less surprising failure.
 */
export function encodeWav(
  samples: Float32Array,
  sampleRate: number,
): Uint8Array {
  const bytes = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(bytes.buffer);
  const write = (text: string, at: number): void => {
    bytes.set(new TextEncoder().encode(text), at);
  };
  write('RIFF', 0);
  view.setUint32(4, 36 + samples.length * 2, true);
  write('WAVE', 8);
  write('fmt ', 12);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  write('data', 36);
  view.setUint32(40, samples.length * 2, true);
  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index] ?? 0));
    view.setInt16(44 + index * 2, Math.round(sample * 32_767), true);
  }
  return bytes;
}
