/**
 * Runs work after a quiet delay, and never two runs for one key at a time.
 *
 * Written for the recall index and kept free of it: a turn that has just ended
 * should bring the index forward, but a burst of turns should be one pass, and a
 * pass that is already writing should not be joined by a second one reading the
 * same index before it. Both of those are timing, not recall, so they live in a
 * class small enough to test with fake timers and no engine, model or folder.
 */
export interface SoonOptions {
  /** How much quiet is required after the last call before the work starts. */
  delayMs: number;
  /** The work. It reports its own failures; the scheduler only keeps going. */
  run: (key: string) => Promise<void>;
}

export class Soon {
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly running = new Map<string, Promise<void>>();
  /** Keys asked for again while their work was still running. */
  private readonly again = new Set<string>();

  constructor(private readonly options: SoonOptions) {}

  /** Arms the work for a key, or pushes it back if it was already armed. */
  soon(key: string): void {
    this.cancelTimer(key);
    const timer = setTimeout(() => {
      this.timers.delete(key);
      this.fire(key);
    }, this.options.delayMs);
    // Not a reason to keep the process alive on its own, like the review timer.
    timer.unref?.();
    this.timers.set(key, timer);
  }

  /** Drops a pending run. One already running is left to finish. */
  cancel(key: string): void {
    this.cancelTimer(key);
    this.again.delete(key);
  }

  cancelAll(): void {
    for (const key of [...this.timers.keys()]) {
      this.cancelTimer(key);
    }
    /*
     * A key whose timer has fired is no longer in `timers` while its work runs,
     * and the flag that would run it once more is the thing that must not
     * survive a shutdown: cancelling everything is the caller saying the machine
     * is going away, not asking for one last pass.
     */
    this.again.clear();
  }

  private fire(key: string): void {
    if (this.running.has(key)) {
      /*
       * One follow-up is enough. The work reads the current state when it
       * starts, so a request that arrived during a pass is covered by the pass
       * after this one, and a third arrival changes nothing the second would not.
       */
      this.again.add(key);
      return;
    }
    const run = Promise.resolve()
      .then(() => this.options.run(key))
      .catch(() => {
        /*
         * The task has already logged what went wrong. Swallowing here is only
         * about the key staying usable: a scheduler that latched on one
         * rejection would stop indexing for the rest of the session.
         */
      })
      .finally(() => {
        this.running.delete(key);
        if (this.again.delete(key)) {
          this.soon(key);
        }
      });
    this.running.set(key, run);
  }

  private cancelTimer(key: string): void {
    const timer = this.timers.get(key);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.timers.delete(key);
    }
  }
}
