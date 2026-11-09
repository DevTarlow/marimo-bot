/**
 * The model server block: the address, the window and the leftovers.
 *
 * The address is the one place a conversation is sent, so most of this file is
 * about what is refused. The rule is deliberately syntactic — `localhost`, a
 * `127.*` literal and `[::1]` — because a promise that depends on what a
 * hostname resolves to today is not a promise about where the words went.
 */
import {describe, expect, it} from 'vitest';

import {
  DEFAULT_MODEL_SERVER_CONTEXT,
  DEFAULT_MODEL_SERVER_URL,
  defaultModelServerSettings,
  LEFT_OVER_MODEL_IDS,
  modelServerPatchSchema,
  modelServerSettingsSchema,
  readModelServerUrl,
  RETIRED_MODEL_IDS,
  workContextTokens,
} from './index.js';

function read(value: string) {
  return readModelServerUrl(value);
}

describe('the model server address', () => {
  it('answers llama.cpp’s own address as it was written', () => {
    expect(read('http://127.0.0.1:8080/v1')).toEqual({
      ok: true,
      url: 'http://127.0.0.1:8080/v1',
    });
  });

  it('adds the scheme a person leaves out, and the /v1 a server needs', () => {
    expect(read('localhost:8080')).toEqual({
      ok: true,
      url: 'http://localhost:8080/v1',
    });
    expect(read('http://127.0.0.1:8080/')).toEqual({
      ok: true,
      url: 'http://127.0.0.1:8080/v1',
    });
  });

  it('keeps a path the server actually uses', () => {
    expect(read('http://localhost:8080/openai/v1')).toEqual({
      ok: true,
      url: 'http://localhost:8080/openai/v1',
    });
  });

  it('reads the IPv6 loopback', () => {
    expect(read('http://[::1]:8080')).toEqual({
      ok: true,
      url: 'http://[::1]:8080/v1',
    });
  });

  it('accepts a localhost subdomain', () => {
    expect(read('http://llama.localhost:8080/v1').ok).toBe(true);
  });

  it('refuses every address that is not on this computer', () => {
    for (const address of [
      'https://api.deepseek.com/v1',
      'http://example.com:8080/v1',
      'http://192.168.1.5:8080/v1',
      'http://10.0.0.2:8080/v1',
      'http://0.0.0.0:8080/v1',
      'http://[::]:8080/v1',
    ]) {
      const result = read(address);
      expect(result.ok, address).toBe(false);
      if (!result.ok) {
        expect(result.problem).toMatch(/this computer/u);
      }
    }
  });

  it('refuses credentials, a query, a fragment and the wrong scheme', () => {
    expect(read('http://user:key@localhost:8080/v1').ok).toBe(false);
    expect(read('http://localhost:8080/v1?key=1').ok).toBe(false);
    expect(read('http://localhost:8080/v1#top').ok).toBe(false);
    expect(read('ftp://localhost:8080/v1').ok).toBe(false);
  });

  it('refuses the completions path rather than appending to it twice', () => {
    const result = read('http://localhost:8080/v1/chat/completions');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problem).toMatch(/ending at \/v1/u);
    }
  });

  it('refuses an empty address and something that is not an address', () => {
    expect(read('   ').ok).toBe(false);
    expect(read('http://').ok).toBe(false);
  });
});

describe('the settings block', () => {
  it('defaults to the address a fresh llama-server listens on', () => {
    expect(defaultModelServerSettings()).toEqual({
      url: DEFAULT_MODEL_SERVER_URL,
      model: '',
      contextTokens: DEFAULT_MODEL_SERVER_CONTEXT,
    });
  });

  it('normalises the address when it is stored', () => {
    const parsed = modelServerSettingsSchema.safeParse({
      url: 'localhost:8080/',
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.url).toBe(
      'http://localhost:8080/v1',
    );
    // The name and the window are filled rather than required.
    expect(parsed.success && parsed.data.model).toBe('');
    expect(parsed.success && parsed.data.contextTokens).toBe(
      DEFAULT_MODEL_SERVER_CONTEXT,
    );
  });

  it('takes a partial patch of one field', () => {
    const parsed = modelServerPatchSchema.safeParse({model: 'qwen3-8b'});
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data).toEqual({model: 'qwen3-8b'});
  });

  it('refuses a window below the smallest a harness can use', () => {
    expect(
      modelServerSettingsSchema.safeParse({
        url: DEFAULT_MODEL_SERVER_URL,
        contextTokens: 512,
      }).success,
    ).toBe(false);
  });
});

describe('the prompt budget', () => {
  it('keeps the reserve whole on a 32K server', () => {
    expect(workContextTokens(32_768)).toBe(24_576);
  });

  it('shrinks the reserve on a small window instead of going negative', () => {
    expect(workContextTokens(8192)).toBe(6144);
    expect(workContextTokens(4096)).toBe(3072);
  });

  it('never returns less than a short conversation', () => {
    expect(workContextTokens(2048)).toBe(1536);
  });
});

describe('the leftovers', () => {
  it('names the chat engine and the old Qwen copy', () => {
    expect(LEFT_OVER_MODEL_IDS).toContain('engine');
    expect(LEFT_OVER_MODEL_IDS).toContain('qwen2.5-vl-7b');
  });

  it('keeps every retired model in the cleanup list', () => {
    for (const id of RETIRED_MODEL_IDS) {
      expect(LEFT_OVER_MODEL_IDS).toContain(id);
    }
  });

  it('never names recall’s own engine', () => {
    // Results are joined under the model root, so a name that was not in this
    // list is a path a window could not ask for.
    expect(LEFT_OVER_MODEL_IDS).not.toContain('recall');
  });
});
