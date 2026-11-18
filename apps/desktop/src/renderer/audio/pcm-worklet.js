/**
 * Capture one mono stream and report each block with its RMS.
 *
 * The processor does no downsampling: the context runs at the device's native
 * rate, and the main thread resamples the whole clip once with an
 * `OfflineAudioContext`. That keeps the worklet to a copy and a square root, and
 * leaves the band-limited resampling to Chromium.
 *
 * The output is deliberately silent. The node is connected to the context
 * destination so it keeps being pulled, but nothing is written to the output,
 * which is what stops the microphone from becoming a speaker.
 */
class MarimoPcmCapture extends AudioWorkletProcessor {
  process(inputs) {
    const channels = inputs[0];
    if (
      channels !== undefined &&
      channels.length > 0 &&
      channels[0] !== undefined
    ) {
      const frames = channels[0].length;
      const mono = new Float32Array(frames);
      for (let channel = 0; channel < channels.length; channel += 1) {
        const data = channels[channel];
        if (data === undefined) {
          continue;
        }
        for (let index = 0; index < frames; index += 1) {
          mono[index] += data[index] / channels.length;
        }
      }
      let sum = 0;
      for (let index = 0; index < frames; index += 1) {
        sum += mono[index] * mono[index];
      }
      this.port.postMessage({pcm: mono, rms: Math.sqrt(sum / frames)}, [
        mono.buffer,
      ]);
    }
    return true;
  }
}

registerProcessor('marimo-pcm-capture', MarimoPcmCapture);
