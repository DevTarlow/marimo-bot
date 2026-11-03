/**
 * Web search through a hidden `BrowserWindow`.
 *
 * A plain `fetch` cannot search the web any more: DuckDuckGo answers a scripted
 * challenge (HTTP 202) and Mojeek answers 403, so a keyless search needs a real
 * browser engine. Electron already ships one, so this opens an offscreen window,
 * lets the page render, extracts the results, and closes it again — no extra
 * dependency, no API key, and no second process.
 *
 * Isolation: a non-persistent session partition (nothing survives the window and
 * nothing is shared with the app's own session, let alone the user's Chrome
 * profile), sandbox on, no preload, permission requests denied, and navigation
 * restricted to the engine's own origin. The page can talk to the engine; it
 * cannot redirect the window anywhere else.
 *
 * Searches are serialized, and the window is destroyed in `finally`, so a
 * timeout, a crash, or a quit cannot leave a stray renderer behind.
 */
import {BrowserWindow, session as electronSession} from 'electron';

import type {
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResult,
} from '@marimo/agent';

import {
  CHALLENGE_ERROR,
  EXTRACT_RESULTS_SCRIPT,
  challengeIsFinal,
  normalizeExtraction,
} from './parse.js';
import {searchUserAgent} from './user-agent.js';

const DEFAULT_ENGINE_URL = 'https://duckduckgo.com/';
const DEFAULT_TIMEOUT_MS = 12_000;
const POLL_INTERVAL_MS = 250;
const PARTITION = 'marimo-search';

export interface BrowserSearchProviderOptions {
  engineUrl?: string;
  timeoutMs?: number;
}

export class BrowserSearchProvider implements WebSearchProvider {
  private readonly engine: URL;
  private readonly timeoutMs: number;
  private queue: Promise<unknown> = Promise.resolve();
  private active: BrowserWindow | undefined;
  private disposed = false;

  constructor(options: BrowserSearchProviderOptions = {}) {
    this.engine = new URL(options.engineUrl ?? DEFAULT_ENGINE_URL);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  search(request: WebSearchRequest): Promise<WebSearchResult[]> {
    const run = this.queue.then(
      () => this.runSearch(request),
      () => this.runSearch(request),
    );
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Destroys any live search window and refuses further searches. */
  dispose(): void {
    this.disposed = true;
    const window = this.active;
    this.active = undefined;
    if (window && !window.isDestroyed()) {
      window.destroy();
    }
  }

  private async runSearch(
    request: WebSearchRequest,
  ): Promise<WebSearchResult[]> {
    if (this.disposed) {
      throw new Error('web search is shutting down');
    }

    const window = new BrowserWindow({
      show: false,
      width: 1024,
      height: 768,
      webPreferences: {
        partition: PARTITION,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        spellcheck: false,
      },
    });
    this.active = window;

    const engineOrigin = this.engine.origin;
    const destroy = (): void => {
      if (!window.isDestroyed()) {
        window.destroy();
      }
    };
    const onAbort = (): void => destroy();
    request.signal?.addEventListener('abort', onAbort, {once: true});

    try {
      /*
       * Inside the try so a session that cannot be hardened is a failed search,
       * not a window the `finally` never gets to close.
       */
      hardenSession();
      window.webContents.setWindowOpenHandler(() => ({action: 'deny'}));
      window.webContents.on('will-navigate', (event, url) => {
        if (!isSameOrigin(url, engineOrigin)) {
          event.preventDefault();
        }
      });

      await window.loadURL(
        `${this.engine.origin}${this.engine.pathname}?q=${encodeURIComponent(request.query)}`,
      );

      const deadline = Date.now() + this.timeoutMs;
      let blockedSince: number | undefined;
      for (;;) {
        if (window.isDestroyed()) {
          throw new Error('the search window closed before results arrived');
        }
        const raw: unknown = await window.webContents
          .executeJavaScript(EXTRACT_RESULTS_SCRIPT, true)
          .catch(() => undefined);
        const {results, blocked} = normalizeExtraction(raw, request.limit);
        if (results.length > 0) {
          return results;
        }
        const now = Date.now();
        blockedSince = blocked ? (blockedSince ?? now) : undefined;
        if (challengeIsFinal(blockedSince, now)) {
          throw new Error(CHALLENGE_ERROR);
        }
        if (now >= deadline) {
          /*
           * A challenge still on screen at the deadline is a refusal too: the
           * page never became results, and answering "no results" would say it
           * did. An ordinary page with nothing on it is an honest empty result.
           */
          if (blocked) {
            throw new Error(CHALLENGE_ERROR);
          }
          return [];
        }
        await delay(POLL_INTERVAL_MS, request.signal);
      }
    } catch (error) {
      if (request.signal?.aborted) {
        throw new Error('web search timed out');
      }
      throw error instanceof Error ? error : new Error(String(error));
    } finally {
      request.signal?.removeEventListener('abort', onAbort);
      destroy();
      if (this.active === window) {
        this.active = undefined;
      }
    }
  }
}

let sessionHardened = false;

/**
 * Locks down the shared `marimo-search` partition once: no permissions, and a
 * user agent that is a browser's rather than Electron's.
 *
 * The UA is built, not filtered, because Electron's names this app and the
 * engine and an unknown product token is what DuckDuckGo challenges — the old
 * filter removed `Marimo Desktop`, a name this app never had, so the app token
 * survived and every search was refused. See `user-agent.ts`.
 */
function hardenSession(): void {
  if (sessionHardened) {
    return;
  }
  const searchSession = electronSession.fromPartition(PARTITION);
  searchSession.setPermissionRequestHandler(
    (_contents, _permission, callback) => {
      callback(false);
    },
  );
  searchSession.setUserAgent(
    searchUserAgent(process.platform, process.versions.chrome),
    'en-US,en',
  );
  /*
   * Only after both calls succeed: a hardening that threw must be retried by the
   * next search rather than remembered as done.
   */
  sessionHardened = true;
}

function isSameOrigin(url: string, origin: string): boolean {
  try {
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error('web search aborted'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, {once: true});
  });
}
