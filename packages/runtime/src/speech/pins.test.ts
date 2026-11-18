import {describe, expect, it} from 'vitest';

import {SPEECH_MODEL_BYTES, SPEECH_MODEL_LABEL} from '@marimo/protocol';

import {TTS_FILES, TTS_REVISION, TTS_TOTAL_BYTES, ttsFileUrl} from './pins.js';

describe('the voice-model pins', () => {
  it('total the size the Settings card names', () => {
    expect(TTS_TOTAL_BYTES).toBe(SPEECH_MODEL_BYTES);
    expect(SPEECH_MODEL_LABEL).toBe('about 92 MB');
  });

  it('pin every file by a sha256 and a size', () => {
    expect(TTS_FILES).toHaveLength(5);
    for (const file of TTS_FILES) {
      expect(file.sha256).toMatch(/^[0-9a-f]{64}$/u);
      expect(file.bytes).toBeGreaterThan(0);
      expect(file.name.length).toBeGreaterThan(0);
      expect(file.path.length).toBeGreaterThan(0);
    }
  });

  it('pin the repository revision, not main', () => {
    expect(TTS_REVISION).toMatch(/^[0-9a-f]{40}$/u);
    const url = ttsFileUrl(TTS_FILES[0]!);
    expect(url).toContain(TTS_REVISION);
    expect(url).toContain('KittenML/kitten-tts-2-mini');
    expect(url.endsWith('/kitten_tts_2_mini.onnx')).toBe(true);
  });
});
