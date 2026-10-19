/**
 * Where the canonical log lives.
 *
 * The interface is deliberately small: append a batch for one conversation, read
 * it back, and nothing else. The file-backed implementation belongs in
 * `@marimo/runtime`, which owns paths and document versions; the engine only
 * needs the seam. The in-memory implementation is what the engine tests use.
 */
import type {SessionEvent} from './events.js';

export interface EventStore {
  append(sessionId: string, events: readonly SessionEvent[]): Promise<void>;
  read(sessionId: string): Promise<SessionEvent[]>;
  /** Whether a conversation has a stored log. */
  has?(sessionId: string): Promise<boolean>;
  /** Remove a conversation's log, when the conversation is deleted. */
  delete?(sessionId: string): Promise<void>;
}

export class MemoryEventStore implements EventStore {
  private readonly sessions = new Map<string, SessionEvent[]>();

  async append(
    sessionId: string,
    events: readonly SessionEvent[],
  ): Promise<void> {
    const current = this.sessions.get(sessionId) ?? [];
    for (const event of events) {
      if (event.sessionId !== sessionId) {
        throw new Error(
          `Event ${event.id} belongs to ${event.sessionId}, not ${sessionId}.`,
        );
      }
    }
    this.sessions.set(sessionId, [...current, ...events]);
  }

  async read(sessionId: string): Promise<SessionEvent[]> {
    return [...(this.sessions.get(sessionId) ?? [])];
  }

  async has(sessionId: string): Promise<boolean> {
    return this.sessions.has(sessionId);
  }

  async delete(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
  }
}
