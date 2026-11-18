import {describe, expect, it} from 'vitest';

import {LISTEN_MODEL_BYTES, LISTEN_MODEL_LABEL} from '@marimo/protocol';

import {
  LISTEN_FILES,
  LISTEN_REVISION,
  LISTEN_TOTAL_BYTES,
  listenFileUrl,
} from './pins.js';

describe('the voice-input pins', () => {
  it('total the size the Settings card names', () => {
    expect(LISTEN_TOTAL_BYTES).toBe(LISTEN_MODEL_BYTES);
    expect(LISTEN_MODEL_LABEL).toBe('about 158 MB');
  });

  it('pin every file by a sha256 and a size', () => {
    expect(LISTEN_FILES).toHaveLength(7);
    for (const file of LISTEN_FILES) {
      expect(file.sha256).toMatch(/^[0-9a-f]{64}$/u);
      expect(file.bytes).toBeGreaterThan(0);
      expect(file.name.length).toBeGreaterThan(0);
      expect(file.path.length).toBeGreaterThan(0);
    }
  });

  it('pin the asset revision, not main', () => {
    expect(LISTEN_REVISION).toMatch(/^[0-9a-f]{40}$/u);
    const url = listenFileUrl(LISTEN_FILES[0]!);
    expect(url).toContain(LISTEN_REVISION);
    expect(url).toContain('moonshine-ai/moonshine-voice-assets');
    expect(url).toContain('quantized_26_07_30');
    expect(url.endsWith('/frontend.ort')).toBe(true);
  });

  it('name every stored file exactly once', () => {
    const names = LISTEN_FILES.map((file) => file.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
