/**
 * The model server: the one endpoint that answers, and the rules about it.
 *
 * This app no longer ships or downloads a chat model. It talks to an
 * OpenAI-compatible server the person runs on their own computer — llama.cpp on
 * `127.0.0.1:8080`, or any server that speaks the same dialect — so the model is
 * whatever that server loaded rather than a name baked into the build.
 *
 * That changes what a "model" is in this codebase. It is not a catalogue entry
 * with a licence, a size and a digest; it is a **base URL**, a **model name the
 * server reports**, and the **window the server says it has**. The three are
 * stored as preferences, because the app needs them before it can ask anything,
 * and the live status is a separate value read from the running server.
 *
 * **Only this computer.** The address is the one place the app chooses where a
 * conversation goes. A public host, a public IP or a server on the local network
 * would make the app's promise — "nothing you type is sent to a model service"
 * — false, so the schema refuses them at the door and the probe never dials
 * one. The check is syntactic rather than a DNS lookup: `localhost`, a `127.*`
 * literal and `[::1]` are the whole allowed set, which is also the only set a
 * person starting llama.cpp on their own machine needs.
 *
 * **The server is not the app's process.** It is started, stopped and upgraded
 * by the person. The app probes it, names its model and hands the address to
 * the transport; it never downloads weights, picks a port, spawns an engine or
 * waits for one to load. A scheduled job needs the server running at that
 * moment, and says so rather than starting one.
 */
import {z} from 'zod';

/**
 * The part of the URL parser this module reads.
 *
 * Declared rather than imported: this package has no DOM or Node types by
 * design, because the sandboxed renderer imports it too, and `URL` is a global
 * in both places. Naming only the fields the address rules use keeps the
 * dependency to the parser rather than to a platform.
 */
interface UrlParts {
  protocol: string;
  username: string;
  password: string;
  hostname: string;
  host: string;
  pathname: string;
  search: string;
  hash: string;
}

const Url = (
  globalThis as unknown as {URL: new (input: string) => UrlParts}
).URL;

/** Where a server started with `llama-server --port 8080` answers by default. */
export const DEFAULT_MODEL_SERVER_URL = 'http://127.0.0.1:8080/v1';

/**
 * The window a server is assumed to have when it cannot report one.
 *
 * 32K is what the app was pinned at before, so a machine that upgrades sees the
 * same budget until it points at a server whose `/props` says otherwise. A
 * server that reports its window always wins over this.
 */
export const DEFAULT_MODEL_SERVER_CONTEXT = 32_768;

/**
 * The tokens the harness keeps back from the server's window.
 *
 * The reply, the tool schemas and the instruction share the same window; a
 * harness allowed to fill all of it would leave no room to answer in. Capped by
 * a quarter of the window so a small context (a 4K model) still gets a usable
 * prompt rather than a negative budget.
 */
export const MODEL_SERVER_RESERVE_TOKENS = 8192;

/**
 * What the address is, or why it cannot be used.
 *
 * One reader for the schema and for the window that shows a field: a second
 * normaliser in the renderer would be a second set of rules, and the one that
 * disagreed would be the one that let an address through.
 */
export function readModelServerUrl(
  value: string,
):
  | {ok: true; url: string}
  | {ok: false; problem: string} {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return {
      ok: false,
      problem:
        'Enter the address of your model server, for example http://127.0.0.1:8080/v1.',
    };
  }

  // A pasted `localhost:8080` is a host and a port rather than a URL with a
  // scheme, and requiring the scheme is a rule about syntax rather than about
  // the server. Prefixing it keeps the common paste working.
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//iu.test(trimmed)
    ? trimmed
    : `http://${trimmed}`;

  let url: UrlParts;
  try {
    url = new Url(withScheme);
  } catch {
    return {
      ok: false,
      problem: `“${trimmed}” is not an address a browser could reach.`,
    };
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return {
      ok: false,
      problem: 'The address has to start with http:// or https://.',
    };
  }
  if (url.username.length > 0 || url.password.length > 0) {
    return {
      ok: false,
      problem:
        'Remove the username or password from the address. This build sends no key.',
    };
  }
  if (url.search.length > 0 || url.hash.length > 0) {
    return {
      ok: false,
      problem: 'Use a plain address: remove the query string and the fragment.',
    };
  }
  if (!isLoopbackHost(url.hostname)) {
    return {
      ok: false,
      problem:
        'Use a server on this computer: localhost, 127.0.0.1 or ::1. ' +
        'Marimo Bot does not talk to a model service.',
    };
  }

  let path = url.pathname.replace(/\/+$/u, '');
  if (path.length === 0) {
    path = '/v1';
  }
  if (/\/chat\/completions$/u.test(path)) {
    return {
      ok: false,
      problem:
        'Use the base address ending at /v1, not the chat completions path.',
    };
  }

  return {ok: true, url: `${url.protocol}//${url.host}${path}`};
}

/**
 * Whether a hostname names this computer.
 *
 * Loopback literals and `localhost` only. A hostname such as `my-desktop` could
 * resolve to the machine itself, but it could just as easily resolve to another
 * one, and the point of this check is that the promise does not depend on what
 * a name happens to point at today.
 */
function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/u, '');
  if (host === 'localhost' || host.endsWith('.localhost')) {
    return true;
  }
  // WHATWG URL keeps the brackets on an IPv6 hostname.
  if (
    host === '[::1]' ||
    host === '::1' ||
    host === '[0:0:0:0:0:0:0:1]'
  ) {
    return true;
  }
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(host);
  if (ipv4 === null) {
    return false;
  }
  return (
    Number(ipv4[1]) === 127 &&
    [2, 3, 4].every((index) => {
      const part = Number(ipv4[index]);
      return part >= 0 && part <= 255;
    })
  );
}

/**
 * The address schema.
 *
 * `superRefine` for the sentence and `transform` for the normal form: the
 * settings document stores the address a request will use, so a pasted
 * `localhost:8080/` becomes `http://localhost:8080/v1` once and every caller
 * afterwards reads the same string.
 */
export const modelServerUrlSchema = z
  .string()
  .trim()
  .min(1)
  .superRefine((value, context) => {
    const read = readModelServerUrl(value);
    if (!read.ok) {
      context.addIssue({code: 'custom', message: read.problem});
    }
  })
  .transform((value) => {
    const read = readModelServerUrl(value);
    return read.ok ? read.url : value;
  });

export const modelServerSettingsSchema = z.object({
  url: modelServerUrlSchema,
  /**
   * The model a request names.
   *
   * Blank is a real answer rather than a missing one: the server reports what it
   * has, and a person with one loaded model should not have to type its file
   * name. The probe fills it from `/v1/models`.
   */
  model: z.string().trim().max(200).default(''),
  contextTokens: z
    .number()
    .int()
    .min(2048)
    .max(1_048_576)
    .default(DEFAULT_MODEL_SERVER_CONTEXT),
});

export type ModelServerSettings = z.infer<typeof modelServerSettingsSchema>;

/** A patch of the block: any subset, merged over what is stored. */
export const modelServerPatchSchema = z.object({
  url: modelServerUrlSchema.optional(),
  model: z.string().trim().max(200).optional(),
  contextTokens: z.number().int().min(2048).max(1_048_576).optional(),
});

export type ModelServerPatch = z.infer<typeof modelServerPatchSchema>;

export function defaultModelServerSettings(): ModelServerSettings {
  return {
    url: DEFAULT_MODEL_SERVER_URL,
    model: '',
    contextTokens: DEFAULT_MODEL_SERVER_CONTEXT,
  };
}

/** Whether the server answered, and how. */
export type ModelServerState = 'off' | 'ready' | 'failed';

/**
 * The model situation, as the card and the badge draw it.
 *
 * `state` is about the server, not a process this app owns: `off` is nothing
 * answering, `ready` is a server that named a model, and `failed` is a server
 * that answered but not with something this app can use. The distinction
 * matters because the fixes differ — start it, check the address, or start it
 * with a model loaded.
 */
export interface ModelServerStatus {
  state: ModelServerState;
  /** The normalised address that was probed. */
  url: string;
  /** The model a request will name, when the server named one. */
  model?: string;
  /** Every model the server reported, in its own order. */
  models: string[];
  /** The window a turn will be given. */
  contextTokens?: number;
  /** Whether that number came from the server or from the settings. */
  contextSource?: 'server' | 'settings';
  /**
   * Whether the server's chat template looks tool-capable.
   *
   * Absent when the server does not report a template (a server without
   * `/props`), `false` when it reports one with no tools block. A false here is
   * a warning rather than a refusal: the turn can still run, it will just get
   * prose where a tool call was wanted.
   */
  tools?: boolean;
  /**
   * Whether the server says it can read pictures.
   *
   * Absent when the server does not report its modalities. `false` is a warning:
   * a picture sent to it will be the server's error rather than an answer. The
   * app cannot add a projector to a process it did not start.
   */
  vision?: boolean;
  /** The sentence a person reads when the state is not `ready`. */
  detail?: string;
  /**
   * Old downloaded chat files still on disk.
   *
   * They are not models this build can run. The card lists them so the person
   * can reclaim the space; removing one is an explicit action, never a
   * migration that deletes files on its own.
   */
  leftOver: LeftOverModelId[];
}

/** The models an older build installed, kept so their files can be removed. */
export const RETIRED_MODEL_IDS = [
  'lfm3-1.7b',
  'lfm3-vl-2b',
  'lfm3-audio-2b',
  'lfm3-omni-2b',
] as const;
export const retiredModelIdSchema = z.enum(RETIRED_MODEL_IDS);
export type RetiredModelId = z.infer<typeof retiredModelIdSchema>;

export const RETIRED_MODEL_LABELS: Record<RetiredModelId, string> = {
  'lfm3-1.7b': 'LFM3 1.7B',
  'lfm3-vl-2b': 'LFM3 VL 2B',
  'lfm3-audio-2b': 'LFM3 Audio 2B',
  'lfm3-omni-2b': 'LFM3 Omni 2B',
};

/**
 * Every old chat download the cleanup list can remove.
 *
 * `engine` is the chat engine the app used to unpack at `model/engine`. It is
 * not recall's engine: that one lives at `model/recall/engine` and is what the
 * search feature still runs. Keeping the two apart is why the removal can be a
 * plain `rm` of the named path.
 */
export const LEFT_OVER_MODEL_IDS = [
  'engine',
  'qwen2.5-vl-7b',
  ...RETIRED_MODEL_IDS,
] as const;
export const leftOverModelIdSchema = z.enum(LEFT_OVER_MODEL_IDS);
export type LeftOverModelId = z.infer<typeof leftOverModelIdSchema>;

export const LEFT_OVER_MODEL_LABELS: Record<LeftOverModelId, string> = {
  engine: 'The old llama.cpp engine',
  'qwen2.5-vl-7b': 'Qwen2.5 VL 7B',
  ...RETIRED_MODEL_LABELS,
};

/**
 * The prompt budget a harness gets for a server window.
 *
 * The reserve is capped at a quarter of the window rather than applied whole:
 * an 8K server would otherwise be told to compact at 0 tokens, and a 4K one at
 * less than that. The floor keeps the harness able to hold a short
 * conversation even on a server someone started with a tiny context.
 */
export function workContextTokens(contextTokens: number): number {
  const reserve = Math.min(
    MODEL_SERVER_RESERVE_TOKENS,
    Math.floor(contextTokens / 4),
  );
  return Math.max(1024, contextTokens - reserve);
}
