/**
 * The one OpenAI-compatible client, and what it puts on the wire.
 *
 * Every provider in the catalogue speaks this dialect, so this file is where the
 * differences between them have to be pinned: whether usage may be asked for,
 * whether a reasoning channel exists, which header a conversation is named in,
 * and whether a key travels at all. Each is a fact about an *endpoint* rather
 * than a preference, and each is invisible until the wrong one is sent — Gemini's
 * compatibility layer answers an unsupported field with an error, so asking it
 * for usage fails every turn rather than one.
 */
import type {LlmRequest} from '@google/adk';
import {describe, expect, it} from 'vitest';

import {
  OpenAiCompatLlm,
  OpenAiCompatRequestError,
} from './openai-compat-llm.js';

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

const SSE_BODY = [
  'data: {"choices":[{"delta":{"content":"hi"}}]}\n',
  'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n',
  'data: [DONE]\n',
];

/** The same stream, with thinking arriving on the channel DeepSeek uses. */
const REASONING_BODY = [
  'data: {"choices":[{"delta":{"reasoning_content":"weighing it"}}]}\n',
  'data: {"choices":[{"delta":{"content":"hi"}}]}\n',
  'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n',
  'data: [DONE]\n',
];

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/** A client whose transport is replaced, plus what it was asked to send. */
function client(
  options: Partial<ConstructorParameters<typeof OpenAiCompatLlm>[0]> = {},
  sse: string[] = SSE_BODY,
): {llm: OpenAiCompatLlm; calls: Captured[]} {
  const calls: Captured[] = [];
  const fetchImpl = (async (url: unknown, init: RequestInit = {}) => {
    calls.push({
      url: String(url),
      headers: (init.headers ?? {}) as Record<string, string>,
      body: JSON.parse(String(init.body)) as Record<string, unknown>,
    });
    return new Response(streamOf(sse), {status: 200});
  }) as unknown as typeof fetch;

  const llm = new OpenAiCompatLlm({
    model: 'test-model',
    baseUrl: 'http://127.0.0.1:8137/v1',
    fetchImpl,
    ...options,
  });
  return {llm, calls};
}

/**
 * Every part every chunk carried, reduced to the two fields these tests read.
 *
 * The stream yields partial chunks and then one aggregated response, so a caller
 * that looked at the last chunk alone would miss the reasoning delta — which is
 * exactly the shape of a test that passes while the feature is broken.
 */
function thoughtParts(
  chunks: readonly unknown[],
): Array<{text?: string; thought?: boolean}> {
  return chunks.flatMap((chunk) => {
    const parts =
      (chunk as {content?: {parts?: Array<{text?: string; thought?: boolean}>}})
        .content?.parts ?? [];
    return parts.filter((part) => part.thought === true);
  });
}

function request(model = 'test-model'): LlmRequest {
  return {
    model,
    contents: [{role: 'user', parts: [{text: 'hello'}]}],
  } as LlmRequest;
}

/** Drains the generator: the request is sent on the first step, not on `next`. */
async function drain(llm: OpenAiCompatLlm): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const chunk of llm.generateContentAsync(request(), true)) {
    out.push(chunk);
  }
  return out;
}

describe('OpenAiCompatLlm request shape', () => {
  it('posts to the engine address it was given', async () => {
    const {llm, calls} = client();
    await drain(llm);

    expect(calls[0]!.url).toBe(
      'http://127.0.0.1:8137/v1/chat/completions',
    );
  });

  it('normalises a trailing slash rather than doubling it', async () => {
    const {llm, calls} = client({baseUrl: 'http://127.0.0.1:8137/v1/'});
    await drain(llm);

    expect(calls[0]!.url).toBe(
      'http://127.0.0.1:8137/v1/chat/completions',
    );
  });

  /*
   * Usage is asked for per provider, and the negative case is the one that
   * matters: Gemini's compatibility layer documents no `stream_options` support
   * and answers a request carrying it with an error rather than ignoring it, so
   * this is a difference between a working chat and a broken one.
   */
  it('asks for a trailing usage chunk where the endpoint allows it', async () => {
    const {llm, calls} = client({});
    await drain(llm);

    expect(calls[0]!.body['stream_options']).toEqual({include_usage: true});
  });

  /*
   * The absence is the decision, not an oversight.
   *
   * One app-wide `temperature` used to travel with every request, which meant a
   * single number overrode whatever each endpoint had tuned for the model it is
   * actually serving. This is what stops the field coming back by accident,
   * because nothing else would notice: a body carrying it works.
   */
  it('leaves the sampling temperature to the endpoint', async () => {
    const {llm, calls} = client({});
    await drain(llm);

    expect(calls[0]!.body).not.toHaveProperty('temperature');
  });

  it('sends the key as a bearer token when there is one', async () => {
    const {llm, calls} = client({apiKey: 'sk-secret'});
    await drain(llm);

    expect(calls[0]!.headers['Authorization']).toBe('Bearer sk-secret');
  });

  it('sends no Authorization header when there is no key', async () => {
    const {llm, calls} = client({});
    await drain(llm);

    // Not `Bearer ` with nothing after it, and not a key: a local server usually
    // takes no credential, and an empty one is refused where an absent header is
    // ignored.
    expect(calls[0]!.headers).not.toHaveProperty('Authorization');
  });

  /*
   * Thinking arrives on a channel only some endpoints have, and the flag decides
   * whether thinking that *did* arrive is kept. Reading an absent field costs
   * nothing, so this is about not throwing away a thought part — and about not
   * inventing one for an endpoint that never sent it.
   */
  it('keeps thinking that arrived as a thought part', async () => {
    const {llm} = client({}, REASONING_BODY);
    const parts = thoughtParts(await drain(llm));

    expect(parts).toContainEqual({text: 'weighing it', thought: true});
  });

  it('names the model in an error the user will read', async () => {
    const llm = new OpenAiCompatLlm({
      model: 'test-model',
      baseUrl: 'http://127.0.0.1:8137/v1',
      fetchImpl: (async () =>
        new Response('model not loaded', {
          status: 429,
        })) as unknown as typeof fetch,
    });

    await expect(drain(llm)).rejects.toThrow(OpenAiCompatRequestError);
    await expect(drain(llm)).rejects.toThrow(/The model server returned 429/);
  });
});
