/**
 * The probe: what a running server says, and what the absence of one says.
 *
 * The app no longer owns a chat process, so this is the only thing between a
 * settings address and a turn. The cases below are the ones that used to be
 * download and engine failures: nothing listening, the wrong path, a server that
 * wants a key, a server with no model loaded. Each has to become a sentence a
 * person can act on rather than a transport error in a turn.
 *
 * `fetchImpl` is injected throughout: a test that dialled a real port would be a
 * test that fails on a machine with something else on 8080.
 */
import {mkdtemp, mkdir, readdir, rm} from 'node:fs/promises';
import {join} from 'node:path';

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {defaultModelServerSettings} from '@marimo/protocol';
import type {ModelServerSettings} from '@marimo/protocol';

import {ModelServer} from './model-server.js';

describe('ModelServer', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(process.cwd(), '.marimo-model-server-'));
  });

  afterEach(async () => {
    await rm(dir, {recursive: true, force: true, maxRetries: 5});
  });

  function client(
    settings: Partial<ModelServerSettings>,
    fetchImpl: typeof fetch,
    overrides: {cacheMs?: number} = {},
  ): ModelServer {
    return new ModelServer({
      modelRoot: dir,
      readSettings: async () => ({
        modelServer: {...defaultModelServerSettings(), ...settings},
      }),
      fetchImpl,
      ...overrides,
    });
  }

  function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: {'content-type': 'application/json'},
    });
  }

  /** A server whose two endpoints answer from a table. */
  function answering(paths: {
    models?: unknown;
    props?: unknown;
    modelsStatus?: number;
    propsStatus?: number;
  }): typeof fetch {
    return (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/models')) {
        return json(
          paths.models ?? {data: [{id: 'qwen3-8b'}]},
          paths.modelsStatus ?? 200,
        );
      }
      if (url.endsWith('/props')) {
        return json(
          paths.props ?? {},
          paths.propsStatus ?? 200,
        );
      }
      return json({}, 404);
    }) as typeof fetch;
  }

  it('is ready when the server names a model, and reports its window', async () => {
    const probe = client(
      {},
      answering({
        models: {data: [{id: 'qwen3-8b', max_model_len: 65_536}]},
        props: {
          default_generation_settings: {n_ctx: 32_768},
          chat_template: '{% if tools %}{{ tool_calls }}{% endif %}',
        },
      }),
    );

    const status = await probe.status();
    expect(status.state).toBe('ready');
    expect(status.model).toBe('qwen3-8b');
    expect(status.models).toEqual(['qwen3-8b']);
    // /props is the server's own answer and wins over the model listing.
    expect(status.contextTokens).toBe(32_768);
    expect(status.contextSource).toBe('server');
    expect(status.tools).toBe(true);
    expect(status.detail).toBeUndefined();
  });

  it('takes the model’s own context when the server has no /props', async () => {
    const probe = client(
      {},
      answering({
        models: {data: [{id: 'qwen3-8b', max_model_len: 8192}]},
        propsStatus: 404,
      }),
    );

    const status = await probe.status();
    expect(status.state).toBe('ready');
    expect(status.contextTokens).toBe(8192);
    expect(status.contextSource).toBe('server');
    expect(status.tools).toBeUndefined();
  });

  it('asks /props at the server root, not under /v1', async () => {
    const calls: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      calls.push(url);
      return url.endsWith('/models')
        ? json({data: [{id: 'qwen3-8b'}]})
        : json({default_generation_settings: {n_ctx: 8192}});
    }) as typeof fetch;
    const probe = client({}, fetchImpl);
    await probe.status();
    expect(calls).toContain('http://127.0.0.1:8080/props');
    expect(calls).not.toContain('http://127.0.0.1:8080/v1/props');
  });

  it('falls back to the settings window when the server says neither', async () => {
    const probe = client(
      {model: 'qwen3-8b', contextTokens: 16_384},
      answering({models: {data: [{id: 'other'}]}, propsStatus: 404}),
    );

    const status = await probe.status();
    expect(status.model).toBe('qwen3-8b');
    expect(status.contextTokens).toBe(16_384);
    expect(status.contextSource).toBe('settings');
  });

  it('warns when a template exists but has no tools block', async () => {
    const probe = client(
      {},
      answering({
        models: {data: [{id: 'qwen3-8b'}]},
        props: {chat_template: '{% for message in messages %}{{ message }}{% endfor %}'},
      }),
    );
    expect((await probe.status()).tools).toBe(false);
  });

  it('believes the capabilities the server reports', async () => {
    const probe = client(
      {},
      answering({
        models: {data: [{id: 'qwen3-8b'}]},
        props: {
          chat_template: 'renders tools somewhere',
          chat_template_caps: {
            supports_tools: false,
            supports_tool_calls: false,
          },
          modalities: {vision: true},
        },
      }),
    );
    const status = await probe.status();
    expect(status.tools).toBe(false);
    expect(status.vision).toBe(true);
  });

  it('resolves the endpoint a turn will use', async () => {
    const probe = client(
      {},
      answering({models: {data: [{id: 'qwen3-8b'}]}}),
    );
    expect(await probe.resolve()).toEqual({
      ok: true,
      baseUrl: 'http://127.0.0.1:8080/v1',
      model: 'qwen3-8b',
      contextTokens: 32_768,
    });
  });

  it('probes per turn instead of trusting a cached success', async () => {
    const fetchImpl = vi.fn(
      answering({models: {data: [{id: 'qwen3-8b'}]}}),
    ) as unknown as typeof fetch;
    const probe = client({}, fetchImpl);

    expect((await probe.resolve()).ok).toBe(true);
    expect((await probe.resolve()).ok).toBe(true);
    // Two /models calls and two /props calls, not one cached pair.
    expect(vi.mocked(fetchImpl).mock.calls.length).toBe(4);
  });

  it('caches the badge’s copy for a few seconds', async () => {
    const fetchImpl = vi.fn(
      answering({models: {data: [{id: 'qwen3-8b'}]}}),
    ) as unknown as typeof fetch;
    const probe = client({}, fetchImpl, {cacheMs: 60_000});

    await probe.status();
    await probe.status();
    expect(vi.mocked(fetchImpl).mock.calls.length).toBe(2);
    await probe.refresh();
    expect(vi.mocked(fetchImpl).mock.calls.length).toBe(4);
  });

  it('says nothing is listening rather than showing a transport error', async () => {
    const probe = client(
      {},
      (async () => {
        throw new TypeError('fetch failed');
      }) as unknown as typeof fetch,
    );

    const status = await probe.status();
    expect(status.state).toBe('off');
    expect(status.models).toEqual([]);
    expect(status.detail).toContain('Nothing is answering at');
    expect((await probe.resolve()).ok).toBe(false);
  });

  it('names a key this build will not send', async () => {
    const probe = client({}, answering({modelsStatus: 401}));
    const status = await probe.status();
    expect(status.state).toBe('failed');
    expect(status.detail).toContain('asks for an API key');
  });

  it('names the path when the server is not OpenAI-compatible', async () => {
    const probe = client({}, answering({modelsStatus: 404}));
    const status = await probe.status();
    expect(status.state).toBe('failed');
    expect(status.detail).toContain('OpenAI-compatible');
    expect(status.detail).toContain('/v1');
  });

  it('refuses a server that reports no models', async () => {
    const probe = client({}, answering({models: {data: []}}));
    const status = await probe.status();
    expect(status.state).toBe('failed');
    expect(status.detail).toContain('reports no models');
  });

  it('reports JSON that is not a model list', async () => {
    const probe = client(
      {},
      (async () =>
        new Response('not json', {status: 200})) as unknown as typeof fetch,
    );
    const status = await probe.status();
    expect(status.state).toBe('failed');
    expect(status.detail).toContain('not OpenAI-compatible');
  });

  it('lists old chat directories but never recall’s', async () => {
    for (const name of ['engine', 'qwen2.5-vl-7b', 'lfm3-1.7b', 'recall']) {
      await mkdir(join(dir, name), {recursive: true});
    }
    const probe = client({}, answering({}));

    const status = await probe.status();
    expect(status.leftOver).toEqual([
      'engine',
      'qwen2.5-vl-7b',
      'lfm3-1.7b',
    ]);

    const after = await probe.removeLeftOver('engine');
    expect(after.leftOver).not.toContain('engine');
    const names = await readdir(dir);
    expect(names).not.toContain('engine');
    // The search feature still uses this directory, so removing an old chat
    // engine must not take it.
    expect(names).toContain('recall');
  });

  it('removes the Qwen copy and says so', async () => {
    await mkdir(join(dir, 'qwen2.5-vl-7b'), {recursive: true});
    const probe = client({}, answering({}));
    expect((await probe.status()).leftOver).toContain('qwen2.5-vl-7b');
    expect((await probe.removeLeftOver('qwen2.5-vl-7b')).leftOver).not.toContain(
      'qwen2.5-vl-7b',
    );
  });
});
