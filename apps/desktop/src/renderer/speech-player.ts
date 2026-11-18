/**
 * Playing sentence chunks without a seam.
 *
 * The host sends one WAV per sentence and keeps synthesising while the previous
 * one plays. An `Audio` element per chunk would insert the element's start-up
 * latency at every join, which is exactly the pause that makes a streamed reply
 * sound stitched. This schedules each decoded buffer on one `AudioContext` at
 * the previous buffer's end, so the joins are sample-accurate.
 *
 * Stopping is synchronous and total: every scheduled source is stopped and its
 * `onended` detached, so a queued sentence cannot leak out after the person
 * pressed Stop or started another utterance.
 */
export class SpeechPlayer {
  private context: AudioContext | undefined;
  private readonly sources = new Set<AudioBufferSourceNode>();
  /** When the next chunk should start, on the context's clock. */
  private nextAt = 0;
  /**
   * Decodes are asynchronous and arrive in event order. Chaining them is what
   * keeps the second chunk from overtaking the first if its decode finishes
   * sooner; the schedule would otherwise put the sentences out of order.
   */
  private chain: Promise<void> = Promise.resolve();
  /**
   * Incremented by `stop`. A decode that was already in flight when the user
   * pressed Stop compares this and does not schedule its buffer, so a stopped
   * utterance cannot leak one more sentence after the stop.
   */
  private generation = 0;

  /**
   * Decode and schedule one chunk.
   *
   * `onEnded` is attached to the last chunk of an utterance, not every chunk:
   * the last buffer's end is the utterance's end.
   */
  play(wavBase64: string, onEnded?: () => void): Promise<void> {
    const generation = this.generation;
    const task = this.chain.then(async () => {
      if (generation !== this.generation) {
        return;
      }
      const context = this.ensure();
      await context.resume().catch(() => undefined);
      const binary = atob(wavBase64);
      const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
      const buffer = await context.decodeAudioData(bytes.buffer);
      if (generation !== this.generation) {
        return;
      }
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(context.destination);
      const startAt = Math.max(context.currentTime + 0.03, this.nextAt);
      this.nextAt = startAt + buffer.duration;
      this.sources.add(source);
      source.onended = () => {
        this.sources.delete(source);
        onEnded?.();
      };
      source.start(startAt);
    });
    this.chain = task.catch(() => undefined);
    return task;
  }

  /** Stop everything scheduled or playing; the next utterance starts fresh. */
  stop(): void {
    this.generation += 1;
    this.chain = Promise.resolve();
    for (const source of this.sources) {
      source.onended = null;
      try {
        source.stop();
      } catch {
        // A source that already ended is not a failure.
      }
    }
    this.sources.clear();
    this.nextAt = 0;
  }

  dispose(): void {
    this.stop();
    const context = this.context;
    this.context = undefined;
    if (context !== undefined) {
      void context.close().catch(() => undefined);
    }
  }

  private ensure(): AudioContext {
    this.context ??= new AudioContext();
    return this.context;
  }
}
