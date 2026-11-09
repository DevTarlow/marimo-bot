/**
 * The OpenAI-compatible client for Google ADK-JS, over the local model server.
 *
 * ADK ships Gemini and Apigee model classes only, so an OpenAI-compatible client
 * is a normal `BaseLlm` implementation registered with `LLMRegistry`. Everything
 * here is transport: message translation lives in `openai-mapping.ts`, SSE
 * framing in `sse.ts`.
 *
 * There is one endpoint now: an OpenAI-compatible server the person runs on
 * loopback, with a model they chose. The transport stays generic on purpose — it
 * is the same dialect, and a different engine is a base URL rather than a second
 * client — but the two endpoint facts that used to arrive from a provider
 * descriptor are now constants this build expects: `stream_options.include_usage`
 * is accepted, and thinking arrives as `reasoning_content`. A server that
 * implements neither is not one a turn can use.
 *
 * Protocol references:
 *   https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md
 */
import {BaseLlm} from '@google/adk';
import type {BaseLlmConnection, LlmRequest, LlmResponse} from '@google/adk';
import {FinishReason} from '@google/genai';
import type {
  FunctionDeclaration,
  GenerateContentResponseUsageMetadata,
  Part,
} from '@google/genai';

import {
  systemInstructionToText,
  toOpenAiMessages,
  toOpenAiTools,
} from './openai-mapping.js';
import type {OpenAiMessage} from './openai-mapping.js';
import {iterateSseData} from './sse.js';

export interface OpenAiCompatLlmOptions {
  model: string;
  /**
   * Where requests go: the loopback address of the person's model server.
   *
   * Required rather than defaulted, because a client built without one would post
   * a conversation to `undefined` — and the mistake would look like a model that
   * is down.
   */
  baseUrl: string;
  /**
   * The credential, or an empty string for a server that takes none.
   *
   * Empty means no `Authorization` header is sent at all, rather than an empty
   * one: a bearer token with nothing in it is refused where an absent header is
   * ignored, and a local server may not look at it either way.
   */
  apiKey?: string;
  maxOutputTokens?: number;
  timeoutMs?: number;
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

/** Raised when the engine answers with a non-2xx status or the call fails. */
export class OpenAiCompatRequestError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'OpenAiCompatRequestError';
    this.status = status;
  }
}

interface StreamToolCallAccumulator {
  id?: string;
  name?: string;
  args: string;
}

const DEFAULT_TIMEOUT_MS = 120_000;

export class OpenAiCompatLlm extends BaseLlm {
  /**
   * Only documentation, today: the ADK driver constructs this class directly and
   * never consults `LLMRegistry`, so nothing here decides which client runs.
   *
   * Empty, and that is the honest answer rather than an oversight. Model ids are
   * the local catalogue's ids, and no pattern can claim them without also
   * claiming a registry lookup meant for ADK's native Gemini client.
   */
  static override readonly supportedModels: Array<string | RegExp> = [];

  private readonly baseUrl: string;
  private readonly label = 'The model server';
  private readonly apiKey: string;
  private readonly maxOutputTokens?: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OpenAiCompatLlmOptions) {
    super({model: options.model});
    // A trailing slash here and a leading one on the path would be a different
    // URL, so the address is normalised at the one place it enters.
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.apiKey = options.apiKey ?? '';
    this.maxOutputTokens = options.maxOutputTokens;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  override async *generateContentAsync(
    llmRequest: LlmRequest,
    stream = false,
    abortSignal?: AbortSignal,
  ): AsyncGenerator<LlmResponse, void, undefined> {
    // The wire call always streams, even when ADK asks for a single response.
    // One path means the reasoning channel and the usage chunk are always
    // available; a non-streaming caller just receives the aggregated final
    // response instead of the partial chunks before it.
    const body = this.buildRequestBody(llmRequest, true);
    const response = await this.post(body, abortSignal);

    if (stream) {
      yield* this.streamResponse(response, abortSignal);
      return;
    }

    let final: LlmResponse | undefined;
    for await (const chunk of this.streamResponse(response, abortSignal)) {
      final = chunk;
    }
    if (final) {
      yield final;
    }
  }

  /**
   * These endpoints expose no bidirectional/live transport. ADK only calls this
   * for live-audio agents, which this app does not run.
   */
  override async connect(): Promise<BaseLlmConnection> {
    throw new Error(
      `${this.label} does not support live (bidirectional) connections.`,
    );
  }

  private buildRequestBody(
    llmRequest: LlmRequest,
    stream: boolean,
  ): Record<string, unknown> {
    const messages: OpenAiMessage[] = [];

    const system = systemInstructionToText(
      llmRequest.config?.systemInstruction,
    );
    if (system.length > 0) {
      messages.push({role: 'system', content: system});
    }
    messages.push(...toOpenAiMessages(llmRequest.contents));

    const tools = toOpenAiTools(functionDeclarations(llmRequest));

    const body: Record<string, unknown> = {
      model: llmRequest.model ?? this.model,
      messages,
      stream,
    };

    /*
     * No `temperature`, and the absence is the decision rather than an
     * oversight: it used to travel with every request from one app-wide setting,
     * which meant a single number overrode whatever each endpoint had tuned for
     * the model it is actually serving. The endpoints' own defaults are the
     * better answer, and there is nothing here to keep in step with them.
     */
    const maxTokens =
      llmRequest.config?.maxOutputTokens ?? this.maxOutputTokens;
    if (typeof maxTokens === 'number') {
      body.max_tokens = maxTokens;
    }
    if (tools.length > 0) {
      body.tools = tools;
      body.tool_choice = 'auto';
    }
    if (stream) {
      /*
       * The pinned llama.cpp build accepts `stream_options.include_usage` and
       * answers a trailing usage-only chunk, which is what puts token counts in
       * the window. This was verified against the engine before it was made
       * unconditional; an endpoint that refused it would fail every turn.
       */
      body.stream_options = {include_usage: true};
    }

    return body;
  }

  private async post(
    body: Record<string, unknown>,
    abortSignal?: AbortSignal,
  ): Promise<Response> {
    const signal = this.combineSignals(abortSignal);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
    /*
     * The key is sent only when there is one. A local server usually takes no
     * credential, and `Authorization: Bearer ` with nothing after it is refused
     * where an absent header is ignored.
     */
    if (this.apiKey.length > 0) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal,
      });
    } catch (error) {
      if (abortSignal?.aborted) {
        throw error;
      }
      const reason = error instanceof Error ? error.message : String(error);
      throw new OpenAiCompatRequestError(
        0,
        `${this.label} request failed: ${reason}`,
      );
    }

    if (!response.ok) {
      const detail = await readErrorBody(response);
      throw new OpenAiCompatRequestError(
        response.status,
        `${this.label} returned ${response.status}: ${detail}`,
      );
    }

    return response;
  }

  private async *streamResponse(
    response: Response,
    abortSignal?: AbortSignal,
  ): AsyncGenerator<LlmResponse, void, undefined> {
    if (!response.body) {
      throw new OpenAiCompatRequestError(
        response.status,
        `${this.label} returned a streaming response with no body.`,
      );
    }

    let text = '';
    let reasoning = '';
    let usage: GenerateContentResponseUsageMetadata | undefined;
    let finishReason: FinishReason | undefined;
    const toolCalls = new Map<number, StreamToolCallAccumulator>();

    for await (const payload of iterateSseData(response.body)) {
      if (abortSignal?.aborted) {
        return;
      }
      let chunk: OpenAiStreamChunk;
      try {
        chunk = JSON.parse(payload) as OpenAiStreamChunk;
      } catch {
        // A keep-alive or malformed frame is not worth failing the turn over.
        continue;
      }

      if (chunk.usage) {
        usage = toUsageMetadata(chunk.usage);
      }

      const choice = chunk.choices?.[0];
      if (!choice) {
        continue;
      }

      const delta = choice.delta ?? {};

      /*
       * Read when the endpoint has a reasoning channel, which is a fact about the
       * provider rather than a guess: the name is DeepSeek's convention and
       * llama.cpp emits it under `--reasoning-format deepseek`, while OpenRouter
       * sends the same idea under a different key and Gemini's layer has no
       * equivalent. Reading a field that is never sent costs nothing — a `typeof`
       * check on an absent key — so the flag is what decides whether thinking that
       * arrived is kept.
       */
      if (
        typeof delta.reasoning_content === 'string' &&
        delta.reasoning_content
      ) {
        reasoning += delta.reasoning_content;
        yield {
          content: {
            role: 'model',
            parts: [{text: delta.reasoning_content, thought: true}],
          },
          partial: true,
        };
      }

      if (typeof delta.content === 'string' && delta.content.length > 0) {
        text += delta.content;
        yield {
          content: {role: 'model', parts: [{text: delta.content}]},
          partial: true,
        };
      }

      for (const call of delta.tool_calls ?? []) {
        const index = call.index ?? 0;
        const accumulator = toolCalls.get(index) ?? {args: ''};
        if (call.id) {
          accumulator.id = call.id;
        }
        if (call.function?.name) {
          accumulator.name = call.function.name;
        }
        if (call.function?.arguments) {
          accumulator.args += call.function.arguments;
        }
        toolCalls.set(index, accumulator);
      }

      if (choice.finish_reason) {
        finishReason = mapFinishReason(choice.finish_reason);
      }
    }

    const parts: Part[] = [];
    // Reasoning first, as a thought part: ADK persists it with the turn, the UI
    // shows it as the reasoning block, and the mapping layer echoes it back as
    // `reasoning_content` on the next request. That echo is not decoration — a
    // backend that rejects a tool-carrying turn whose reasoning is missing is
    // the reason it exists, and it costs one field when nothing needs it.
    if (reasoning.length > 0) {
      parts.push({text: reasoning, thought: true});
    }
    if (text.length > 0) {
      parts.push({text});
    }
    for (const [, accumulator] of [...toolCalls.entries()].sort(
      (a, b) => a[0] - b[0],
    )) {
      if (!accumulator.name) {
        continue;
      }
      parts.push({
        functionCall: {
          id: accumulator.id,
          name: accumulator.name,
          args: parseArguments(accumulator.args),
        },
      });
    }

    yield {
      content: {role: 'model', parts},
      partial: false,
      turnComplete: true,
      finishReason,
      usageMetadata: usage,
    };
  }

  private combineSignals(abortSignal?: AbortSignal): AbortSignal | undefined {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    if (!abortSignal) {
      return timeout;
    }
    return AbortSignal.any([abortSignal, timeout]);
  }
}

/* -------------------------------------------------------------------------- */
/* Wire types                                                                  */
/* -------------------------------------------------------------------------- */

interface OpenAiUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

interface OpenAiToolCallDelta {
  index?: number;
  id?: string;
  type?: string;
  function?: {name?: string; arguments?: string};
}

interface OpenAiDelta {
  content?: string | null;
  reasoning_content?: string | null;
  tool_calls?: OpenAiToolCallDelta[];
}

interface OpenAiChoice {
  index?: number;
  delta?: OpenAiDelta;
  message?: OpenAiDelta & {tool_calls?: OpenAiToolCallDelta[]};
  finish_reason?: string | null;
}

interface OpenAiStreamChunk {
  choices?: OpenAiChoice[];
  usage?: OpenAiUsage | null;
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

function toUsageMetadata(
  usage: OpenAiUsage,
): GenerateContentResponseUsageMetadata {
  return {
    promptTokenCount: usage.prompt_tokens ?? 0,
    candidatesTokenCount: usage.completion_tokens ?? 0,
    totalTokenCount:
      usage.total_tokens ??
      (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0),
  };
}

function mapFinishReason(reason: string | undefined): FinishReason | undefined {
  switch (reason) {
    case 'stop':
    case 'tool_calls':
      return FinishReason.STOP;
    case 'length':
      return FinishReason.MAX_TOKENS;
    case 'content_filter':
      return FinishReason.SAFETY;
    case undefined:
    case null:
      return undefined;
    default:
      return FinishReason.OTHER;
  }
}

function parseArguments(raw: string): Record<string, unknown> {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {value: parsed};
  } catch {
    return {__raw: trimmed};
  }
}

function functionDeclarations(llmRequest: LlmRequest): FunctionDeclaration[] {
  const declarations: FunctionDeclaration[] = [];
  for (const tool of llmRequest.config?.tools ?? []) {
    const candidate = tool as {functionDeclarations?: FunctionDeclaration[]};
    if (Array.isArray(candidate.functionDeclarations)) {
      declarations.push(...candidate.functionDeclarations);
    }
  }
  return declarations;
}

async function readErrorBody(response: Response): Promise<string> {
  try {
    const text = await response.text();
    const trimmed = text.trim();
    if (trimmed.length === 0) {
      return response.statusText || 'no response body';
    }
    return trimmed.slice(0, 500);
  } catch {
    return response.statusText || 'unreadable response body';
  }
}
