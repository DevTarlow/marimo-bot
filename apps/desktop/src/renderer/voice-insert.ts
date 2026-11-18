/**
 * Putting a finished transcript where the person is typing, once.
 *
 * Two small rules that are easy to get wrong and expensive to get wrong:
 *
 * - **Append, do not replace.** A dictation that overwrites a half-written
 *   message is a lost thought. The transcript joins the box with one space and
 *   the box keeps everything that was already there.
 * - **A cancelled recording never arrives.** Every recording gets a run number;
 *   a cancel or a newer recording moves it on, and a transcription that comes
 *   back for the old one is dropped. The main process has its own lease token for
 *   the same failure; this is the renderer's half.
 */

/** Join a transcript onto what is already in a composer. */
export function appendTranscript(existing: string, transcript: string): string {
  const clean = transcript.trim();
  if (clean.length === 0) {
    return existing;
  }
  const current = existing.trimEnd();
  return current.length === 0 ? clean : `${current} ${clean}`;
}

/** A run counter for recordings, so a stale transcript can be recognised. */
export class TranscriptGate {
  private run = 0;

  /** Start a recording and return the id its transcript must carry. */
  begin(): number {
    this.run += 1;
    return this.run;
  }

  /** Forget every recording in flight; none of their transcripts may land. */
  cancel(): void {
    this.run += 1;
  }

  /** Whether a transcript belongs to the newest recording. */
  accepts(id: number): boolean {
    return id === this.run;
  }
}
