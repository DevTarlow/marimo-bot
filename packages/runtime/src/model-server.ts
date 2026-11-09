/**
 * The person's model server, probed rather than started.
 *
 * The app used to own a chat engine: it downloaded weights, picked a free port,
 * spawned `llama-server`, waited for health and stopped it after a quiet spell.
 * That whole class of work is gone. What is left is one question the app can ask
 * and one answer it must trust:
 *
 * - **Is anything answering at the address in Settings?** A GET of `/models` on
 *   loopback is the whole liveness check. It is a read, so asking on every
 *   settings read is harmless, and it is never a reason to start a process.
 * - **What does that server call its model, and how large is its window?** The
 *   answer comes from `/models` and, when the server offers it, `/props`. The
 *   transport is generic; this is where the names a turn needs are discovered.
 *
 * Three rules shape the implementation:
 *
 * **The address cannot leave the machine.** The settings schema already refuses
 * a non-loopback URL, so this class trusts the parsed document rather than
 * re-deciding. That is deliberate: two checks that can disagree about what
 * "local" means are worse than one, and the schema is the one the window can
 * show a sentence from.
 *
 * **A turn probes, a badge caches.** `resolve()` runs before every turn because
 * a cached success would send a request to a server the person has since
 * stopped. `status()` is for the badge and the card, where a few seconds of
 * staleness is invisible and a probe on every render is not.
 *
 * **No process, no pid file, no idle timer.** The server's lifetime belongs to
 * the person. This class reports what it finds; it never starts, stops or
 * reaps anything. Recall keeps the `LocalModelService` for the engine it still
 * owns, and that is the only child process left.
 */
import {readdir, rm} from 'node:fs/promises';
import {join} from 'node:path';

import type {
  LeftOverModelId,
  ModelServerSettings,
  ModelServerStatus,
  StoredSettings,
} from '@marimo/protocol';
import {LEFT_OVER_MODEL_IDS} from '@marimo/protocol';

export type ResolvedModelEndpoint =
  | {ok: true; baseUrl: string; model: string; contextTokens: number}
  | {ok: false; problem: string};

export interface ModelServerOptions {
  /** The directory old chat files live under (`model/` beside user data). */
  modelRoot: string;
  /** The settings, read per call so a change applies to the next turn. */
  readSettings: () => Promise<Pick<StoredSettings, 'modelServer'>>;
  /** Injected for tests, which must not dial or download. */
  fetchImpl?: typeof fetch;
  /** How long one probe waits for an answer. */
  timeoutMs?: number;
  /** How long the card's copy of a probe may stand. */
  cacheMs?: number;
  log?: (line: string) => void;
}

/** The default wait. Loopback refuses instantly when nothing is listening. */
const DEFAULT_TIMEOUT_MS = 3000;

/**
 * How long the badge may show the last probe.
 *
 * Longer than a turn, shorter than a person's patience when they have just
 * started the server and want the dot to change. `refresh()` ignores it.
 */
const DEFAULT_CACHE_MS = 8000;

interface Probe {
  status: ModelServerStatus;
  /** The endpoint a turn would use, when the probe was ready. */
  endpoint?: {baseUrl: string; model: string; contextTokens: number};
}

interface ModelEntry {
  id: string;
  maxModelLen?: number;
}

interface Props {
  nCtx?: number;
  chatTemplate?: string;
  tools?: boolean;
  vision?: boolean;
}

export class ModelServer {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly cacheMs: number;
  private cached:
    | {key: string; at: number; probe: Probe}
    | undefined;
  private inflight: {key: string; promise: Promise<Probe>} | undefined;

  constructor(private readonly options: ModelServerOptions) {
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.cacheMs = options.cacheMs ?? DEFAULT_CACHE_MS;
  }

  /**
   * The endpoint a turn should use, or the sentence that stops it.
   *
   * Always probes. A server can stop between two turns, and a cached success
   * would turn that into a request that hangs or fails with a transport error
   * rather than the sentence naming the address.
   */
  async resolve(): Promise<ResolvedModelEndpoint> {
    const settings = await this.options.readSettings();
    const probe = await this.probe(settings.modelServer);
    if (probe.endpoint === undefined) {
      return {
        ok: false,
        problem:
          probe.status.detail ??
          nothingListening(probe.status.url),
      };
    }
    return {ok: true, ...probe.endpoint};
  }

  /** The card's copy of the situation, cached for a few seconds. */
  async status(): Promise<ModelServerStatus> {
    const settings = await this.options.readSettings();
    const key = keyFor(settings.modelServer);
    if (
      this.cached !== undefined &&
      this.cached.key === key &&
      Date.now() - this.cached.at < this.cacheMs
    ) {
      return this.cached.probe.status;
    }
    return (await this.probe(settings.modelServer)).status;
  }

  /** A fresh probe, whatever the cache says. The card's button uses this. */
  async refresh(): Promise<ModelServerStatus> {
    const settings = await this.options.readSettings();
    this.cached = undefined;
    return (await this.probe(settings.modelServer)).status;
  }

  /** Forgets a cached answer, after a settings write. */
  invalidate(): void {
    this.cached = undefined;
  }

  /**
   * Deletes one old chat download and answers the new situation.
   *
   * The id is an enum and the path is joined under the model root, so a window
   * cannot ask for a path of its own. The `rm` is force-and-recursive because
   * these are the app's own directories; a missing one is already removed. It
   * never touches `recall/`: that is a separate directory and a separate model
   * this build still uses.
   */
  async removeLeftOver(id: LeftOverModelId): Promise<ModelServerStatus> {
    try {
      await rm(join(this.options.modelRoot, id), {
        recursive: true,
        force: true,
      });
    } catch (failure) {
      throw new Error(
        `Could not remove ${id}: ${describe(failure)}. Close anything using ` +
          'those files and try again.',
      );
    }
    return await this.refresh();
  }

  /** Stops nothing: there is no process here. Kept for the service's shutdown. */
  dispose(): void {
    this.cached = undefined;
    this.inflight = undefined;
  }

  private async probe(settings: ModelServerSettings): Promise<Probe> {
    const key = keyFor(settings);
    if (this.inflight !== undefined && this.inflight.key === key) {
      return await this.inflight.promise;
    }
    const promise = this.probeNow(settings);
    this.inflight = {key, promise};
    try {
      const probe = await promise;
      if (this.inflight?.promise === promise) {
        this.inflight = undefined;
      }
      this.cached = {key, at: Date.now(), probe};
      return probe;
    } catch (failure) {
      if (this.inflight?.promise === promise) {
        this.inflight = undefined;
      }
      throw failure;
    }
  }

  private async probeNow(settings: ModelServerSettings): Promise<Probe> {
    const {url} = settings;
    const leftOver = await this.leftOver();

    let response: Response;
    try {
      response = await this.fetchImpl(`${url}/models`, {
        method: 'GET',
        headers: {Accept: 'application/json'},
        signal: AbortSignal.timeout(this.timeoutMs),
        redirect: 'error',
      });
    } catch (failure) {
      this.options.log?.(
        `[marimo] the model server at ${url} did not answer: ${describe(failure)}`,
      );
      return {
        status: {
          state: 'off',
          url,
          models: [],
          detail: nothingListening(url),
          leftOver,
        },
      };
    }

    if (response.status === 401 || response.status === 403) {
      return {
        status: failed(
          url,
          leftOver,
          `The server at ${url} asks for an API key. This build sends none: ` +
            'start it without one.',
        ),
      };
    }

    if (!response.ok) {
      return {
        status: failed(
          url,
          leftOver,
          response.status === 404
            ? `${url} answered, but not like an OpenAI-compatible server: ` +
              'GET /models returned 404. Check the address, including /v1.'
            : `${url} answered ${String(response.status)} on GET /models. ` +
              'Check the address in Settings → Model server.',
        ),
      };
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return {
        status: failed(
          url,
          leftOver,
          `${url} answered with something that is not OpenAI-compatible ` +
            'JSON. Check that the address is the server’s API base, ending in /v1.',
        ),
      };
    }

    const entries = readModels(body);
    if (entries.length === 0 && settings.model.length === 0) {
      return {
        status: failed(
          url,
          leftOver,
          `The server at ${url} reports no models. Start it with a model ` +
            'loaded, then try again.',
        ),
      };
    }

    const chosen =
      settings.model.length > 0
        ? entries.find((entry) => entry.id === settings.model)
        : entries[0];
    const model = settings.model.length > 0 ? settings.model : entries[0]?.id;
    if (model === undefined || model.length === 0) {
      return {
        status: failed(
          url,
          leftOver,
          `The server at ${url} reports no models. Start it with a model ` +
            'loaded, then try again.',
        ),
      };
    }

    const props = await this.props(url);
    const reported = props.nCtx ?? chosen?.maxModelLen;
    const contextTokens =
      reported !== undefined && reported > 0
        ? reported
        : settings.contextTokens;

    return {
      status: {
        state: 'ready',
        url,
        model,
        models: entries.map((entry) => entry.id),
        contextTokens,
        contextSource: reported === undefined ? 'settings' : 'server',
        ...(props.tools === undefined
          ? props.chatTemplate === undefined
            ? {}
            : {tools: templateLooksToolCapable(props.chatTemplate)}
          : {tools: props.tools}),
        ...(props.vision === undefined ? {} : {vision: props.vision}),
        leftOver,
      },
      endpoint: {baseUrl: url, model, contextTokens},
    };
  }

  /**
   * `/props`, when the server has it.
   *
   * llama.cpp answers it with the generation settings and the chat template in
   * use; other compatible servers do not answer it at all. A failure is not a
   * failed probe — the server already proved it answers `/models` — so this
   * quietly falls back to the settings' window and an unknown tool template.
   */
  private async props(url: string): Promise<Props> {
    /*
     * `/props` is an engine endpoint at the server's root, not under `/v1`:
     * llama.cpp answers `http://host:8080/props` while its OpenAI API is
     * `http://host:8080/v1`. Asking `${url}/props` would be a 404 on the one
     * server this build is tested against, and the probe would silently fall
     * back to the settings window and an unknown template.
     */
    const propsUrl = rootOf(url);
    let response: Response;
    try {
      response = await this.fetchImpl(`${propsUrl}/props`, {
        method: 'GET',
        headers: {Accept: 'application/json'},
        signal: AbortSignal.timeout(this.timeoutMs),
        redirect: 'error',
      });
    } catch {
      return {};
    }
    if (!response.ok) {
      return {};
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return {};
    }
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      return {};
    }
    const record = body as Record<string, unknown>;
    const nested = asRecord(record['default_generation_settings']);
    const nCtx =
      positiveNumber(nested['n_ctx']) ??
      positiveNumber(record['n_ctx']) ??
      positiveNumber(record['context_length']);
    const chatTemplate =
      typeof record['chat_template'] === 'string'
        ? record['chat_template']
        : typeof nested['chat_template'] === 'string'
          ? nested['chat_template']
          : undefined;
    /*
     * llama.cpp reports what its template can do beside the template; a model
     * listing reports its own modalities. Both are more reliable than scanning
     * the template text, which is only the fallback for a server that reports
     * neither.
     */
    const caps = asRecord(record['chat_template_caps']);
    const saidTools =
      caps['supports_tools'] === true || caps['supports_tool_calls'] === true
        ? true
        : caps['supports_tools'] === false && caps['supports_tool_calls'] === false
          ? false
          : undefined;
    const modalities = asRecord(record['modalities']);
    const vision = typeof modalities['vision'] === 'boolean' ? modalities['vision'] : undefined;
    return {
      ...(nCtx === undefined ? {} : {nCtx}),
      ...(chatTemplate === undefined ? {} : {chatTemplate}),
      ...(saidTools === undefined ? {} : {tools: saidTools}),
      ...(vision === undefined ? {} : {vision}),
    };
  }

  /** Which old chat directories are still under the model root. */
  private async leftOver(): Promise<LeftOverModelId[]> {
    let names: string[];
    try {
      names = (
        await readdir(this.options.modelRoot, {withFileTypes: true})
      )
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      // No model directory yet is no leftovers, not a failed read.
      return [];
    }
    return LEFT_OVER_MODEL_IDS.filter((id) => names.includes(id));
  }
}

/** The server's origin, so an engine endpoint outside `/v1` can be reached. */
function rootOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url.replace(/\/+$/u, '');
  }
}

function keyFor(settings: ModelServerSettings): string {
  // The window is part of the key: changing only the fallback window must not
  // serve a status that still reports the old one.
  return `${settings.url}\u0000${settings.model}\u0000${String(settings.contextTokens)}`;
}

function failed(
  url: string,
  leftOver: LeftOverModelId[],
  detail: string,
): ModelServerStatus {
  return {state: 'failed', url, models: [], detail, leftOver};
}

function nothingListening(url: string): string {
  return `Nothing is answering at ${url}. Start your model server, then try again.`;
}

/**
 * A tool-capable template names the tools block or renders a tool call.
 *
 * A heuristic rather than a guarantee: a template can be tool-capable in a
 * dialect that spells neither, and the warning it feeds is advisory. What it
 * catches is the common failure — a model started with a chat-only template,
 * where every tool call comes back as prose.
 */
function templateLooksToolCapable(template: string): boolean {
  return /\btools?\b|\btool_calls\b/u.test(template);
}

function readModels(body: unknown): ModelEntry[] {
  const record = asRecord(body);
  const data = Array.isArray(record['data']) ? record['data'] : [];
  const entries: ModelEntry[] = [];
  for (const entry of data) {
    const model = asRecord(entry);
    const id = model['id'];
    if (typeof id !== 'string' || id.length === 0) {
      continue;
    }
    const maxModelLen =
      positiveNumber(model['max_model_len']) ??
      positiveNumber(model['context_length']);
    entries.push({
      id,
      ...(maxModelLen === undefined ? {} : {maxModelLen}),
    });
  }
  return entries;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : undefined;
}

function describe(failure: unknown): string {
  return failure instanceof Error ? failure.message : String(failure);
}
