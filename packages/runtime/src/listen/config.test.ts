import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';

import {afterEach, beforeEach, describe, expect, it} from 'vitest';

import {readListenAssets, parseListenConfig} from './config.js';

const CONFIG = {
  encoder_dim: 2,
  decoder_dim: 2,
  depth: 1,
  nheads: 1,
  head_dim: 1,
  vocab_size: 4,
  bos_id: 1,
  eos_id: 2,
  frame_len: 80,
  total_lookahead: 0,
  d_model_frontend: 2,
  c1: 4,
  c2: 2,
  frontend_state_shapes: {
    sample_buffer: [1, 79],
    sample_len: [1],
    conv1_buffer: [1, 2, 4],
    conv2_buffer: [1, 4, 4],
    frame_count: [1],
  },
};

describe('parseListenConfig', () => {
  it('reads the model dimensions and state shapes', () => {
    const config = parseListenConfig(CONFIG);
    expect(config.frameLen).toBe(80);
    expect(config.stateShapes.sample_buffer).toEqual([1, 79]);
    expect(config.vocabSize).toBe(4);
  });

  it('refuses a frame that is not 80 samples', () => {
    expect(() => parseListenConfig({...CONFIG, frame_len: 81})).toThrow(
      /not the 80/u,
    );
  });

  it('refuses a state shape that does not match the model', () => {
    expect(() =>
      parseListenConfig({
        ...CONFIG,
        frontend_state_shapes: {...CONFIG.frontend_state_shapes, sample_buffer: [1, 80]},
      }),
    ).toThrow(/sample_buffer/u);
  });
});

describe('readListenAssets', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(process.cwd(), '.marimo-listen-config-'));
  });

  afterEach(async () => {
    await rm(dir, {recursive: true, force: true, maxRetries: 5});
  });

  it('reads the config and a token table big enough for the vocabulary', async () => {
    await writeFile(join(dir, 'streaming_config.json'), JSON.stringify(CONFIG));
    // Four tokens: empty, empty, empty, "hi".
    await writeFile(
      join(dir, 'tokenizer.bin'),
      Uint8Array.from([0, 0, 0, 2, 0x68, 0x69]),
    );
    const assets = await readListenAssets(dir);
    expect(assets.config.vocabSize).toBe(4);
    expect(assets.tokenizer.tokens).toHaveLength(4);
  });

  it('refuses a token table shorter than the vocabulary', async () => {
    await writeFile(join(dir, 'streaming_config.json'), JSON.stringify(CONFIG));
    await writeFile(join(dir, 'tokenizer.bin'), Uint8Array.from([0, 0]));
    await expect(readListenAssets(dir)).rejects.toThrow(/tokens/u);
  });
});
