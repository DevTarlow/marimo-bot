/**
 * The file-backed event log.
 *
 * One JSON object per line, one file per conversation, append-only. The engine's
 * `EventStore` seam is the only thing that reads or writes it, so the format is
 * not a second API: it is an implementation detail of this file.
 *
 * A malformed line is refused rather than skipped. The rest of the app's rule is
 * that an unreadable document is quarantined before anything writes over it,
 * because a lenient read plus a write is how a conversation disappears. The
 * caller gets an `EventLogError` naming the line and decides what to do.
 */
import {
  access,
  appendFile,
  mkdir,
  readFile,
  readdir,
  unlink,
} from 'node:fs/promises';
import {join} from 'node:path';

import {parseSessionEvent} from '@marimo/agent';
import type {EventStore, SessionEvent} from '@marimo/agent';

export class EventLogError extends Error {
  readonly sessionId: string;
  readonly line?: number;

  constructor(sessionId: string, message: string, line?: number) {
    super(message);
    this.name = 'EventLogError';
    this.sessionId = sessionId;
    if (line !== undefined) {
      this.line = line;
    }
  }
}

const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

function assertSessionId(sessionId: string): void {
  if (!SESSION_ID.test(sessionId)) {
    throw new EventLogError(
      sessionId,
      `"${sessionId}" is not a session id this log will write.`,
    );
  }
}

export interface FileEventStoreOptions {
  /** The directory holding one `<sessionId>.jsonl` per conversation. */
  rootDir: string;
}

export class FileEventStore implements EventStore {
  private readonly rootDir: string;
  private readonly queues = new Map<string, Promise<void>>();
  private ready: Promise<void> | undefined;

  constructor(options: FileEventStoreOptions) {
    this.rootDir = options.rootDir;
  }

  async append(
    sessionId: string,
    events: readonly SessionEvent[],
  ): Promise<void> {
    assertSessionId(sessionId);
    if (events.length === 0) {
      return;
    }
    for (const event of events) {
      const parsed = parseSessionEvent(event);
      if (!parsed.ok) {
        throw new EventLogError(
          sessionId,
          `Refusing to append an invalid event: ${parsed.problem}`,
        );
      }
      if (parsed.event.sessionId !== sessionId) {
        throw new EventLogError(
          sessionId,
          `Event ${parsed.event.id} belongs to ${parsed.event.sessionId}.`,
        );
      }
    }

    /*
     * Append order within one conversation is the state machine's order. Two
     * writers in one process would interleave lines; the engine holds one active
     * turn per session, and this queue holds the rest.
     */
    const previous = this.queues.get(sessionId) ?? Promise.resolve();
    const next = previous.then(async () => {
      await this.ensureRoot();
      const body = events.map((event) => JSON.stringify(event)).join('\n');
      await appendFile(this.fileFor(sessionId), `${body}\n`, 'utf8');
    });
    this.queues.set(
      sessionId,
      next.catch(() => {
        // A failed write must not poison every later write to the session; the
        // caller sees the failure, the queue moves on.
      }),
    );
    await next;
  }

  async read(sessionId: string): Promise<SessionEvent[]> {
    assertSessionId(sessionId);
    let text: string;
    try {
      text = await readFile(this.fileFor(sessionId), 'utf8');
    } catch (error) {
      if (isMissing(error)) {
        return [];
      }
      throw new EventLogError(
        sessionId,
        `Could not read this conversation: ${describeError(error)}`,
      );
    }
    if (text.length === 0) {
      return [];
    }
    if (!text.endsWith('\n')) {
      throw new EventLogError(
        sessionId,
        'The conversation ends with a partial line. It was not written by this build.',
      );
    }

    const events: SessionEvent[] = [];
    const lines = text.split('\n');
    // A trailing newline produces one empty segment; it is not a line.
    for (let index = 0; index < lines.length - 1; index += 1) {
      const line = lines[index] ?? '';
      if (line.trim().length === 0) {
        continue;
      }
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        throw new EventLogError(
          sessionId,
          `Line ${index + 1} is not JSON.`,
          index + 1,
        );
      }
      const parsed = parseSessionEvent(value);
      if (!parsed.ok) {
        throw new EventLogError(
          sessionId,
          `Line ${index + 1} is not a session event: ${parsed.problem}`,
          index + 1,
        );
      }
      if (parsed.event.sessionId !== sessionId) {
        throw new EventLogError(
          sessionId,
          `Line ${index + 1} belongs to ${parsed.event.sessionId}.`,
          index + 1,
        );
      }
      events.push(parsed.event);
    }
    return events;
  }

  async list(): Promise<string[]> {
    await mkdir(this.rootDir, {recursive: true});
    const names = await readdir(this.rootDir);
    return names
      .filter((name) => name.endsWith('.jsonl'))
      .map((name) => name.slice(0, -'.jsonl'.length));
  }

  async has(sessionId: string): Promise<boolean> {
    assertSessionId(sessionId);
    try {
      await access(this.fileFor(sessionId));
      return true;
    } catch {
      return false;
    }
  }

  async delete(sessionId: string): Promise<void> {
    assertSessionId(sessionId);
    const previous = this.queues.get(sessionId) ?? Promise.resolve();
    const next = previous.then(async () => {
      await unlink(this.fileFor(sessionId)).catch((error: unknown) => {
        if (!isMissing(error)) {
          throw new Error(
            `Could not delete this conversation: ${describeError(error)}`,
          );
        }
      });
    });
    this.queues.set(
      sessionId,
      next.catch(() => {
        // The caller sees the failure; the queue moves on.
      }),
    );
    await next;
  }

  private fileFor(sessionId: string): string {
    return join(this.rootDir, `${sessionId}.jsonl`);
  }

  private async ensureRoot(): Promise<void> {
    this.ready ??= mkdir(this.rootDir, {recursive: true}).then(() => undefined);
    await this.ready;
  }
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as {code?: unknown}).code === 'ENOENT'
  );
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
