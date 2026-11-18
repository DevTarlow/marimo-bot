/**
 * The voice-input model's two small files, read and checked.
 *
 * `streaming_config.json` is the authority on the graph's dimensions and on the
 * frontend's carry-over state. `tokenizer.bin` is the authority on the token
 * table. Both are pinned, so the checks here are about a truncated or mismatched
 * download rather than about hostile input; they still fail with a sentence that
 * names the card, because the person seeing it is the one who can press Repair.
 */
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';

import {parseBinTokenizer} from './tokenizer.js';
import type {ListenBinTokenizer, ListenConfig, ListenStateShapes} from './types.js';

/** Read `streaming_config.json` and turn its snake_case into the engine's shape. */
export async function readListenConfig(dir: string): Promise<ListenConfig> {
  const path = join(dir, 'streaming_config.json');
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, 'utf8'));
  } catch (failure) {
    throw new Error(
      `The voice-input settings could not be read: ${describe(failure)}. ` +
        'Download the voice-input model again from Settings → Voice input.',
    );
  }
  return parseListenConfig(raw);
}

/** Whether a parsed document is the shape this build can drive. */
export function parseListenConfig(raw: unknown): ListenConfig {
  const object = asRecord(raw, 'The voice-input settings');
  const frameLen = positiveInt(object, 'frame_len');
  if (frameLen !== 80) {
    throw new Error(
      `The voice-input model's frame is ${String(frameLen)} samples, not the 80 ` +
        'this build expects. Download the pinned model again.',
    );
  }
  const dModelFrontend = positiveInt(object, 'd_model_frontend');
  const c1 = positiveInt(object, 'c1');
  const c2 = positiveInt(object, 'c2');
  const stateShapes = parseStateShapes(object['frontend_state_shapes']);
  requireProduct(stateShapes.sample_buffer, frameLen - 1, 'sample_buffer');
  requireProduct(stateShapes.sample_len, 1, 'sample_len');
  requireProduct(stateShapes.conv1_buffer, dModelFrontend * 4, 'conv1_buffer');
  requireProduct(stateShapes.conv2_buffer, c1 * 4, 'conv2_buffer');
  requireProduct(stateShapes.frame_count, 1, 'frame_count');
  const config: ListenConfig = {
    encoderDim: positiveInt(object, 'encoder_dim'),
    decoderDim: positiveInt(object, 'decoder_dim'),
    depth: positiveInt(object, 'depth'),
    nheads: positiveInt(object, 'nheads'),
    headDim: positiveInt(object, 'head_dim'),
    vocabSize: positiveInt(object, 'vocab_size'),
    bosId: integer(object, 'bos_id'),
    eosId: integer(object, 'eos_id'),
    frameLen,
    totalLookahead: nonNegativeInt(object, 'total_lookahead'),
    dModelFrontend,
    c1,
    c2,
    stateShapes,
  };
  if (config.eosId < 0 || config.bosId < 0) {
    throw new Error('The voice-input model has no beginning or end token.');
  }
  if (config.vocabSize < 2) {
    throw new Error('The voice-input model has no vocabulary.');
  }
  return config;
}

/** Read `tokenizer.bin`; the parser itself is in `tokenizer.ts`. */
export async function readBinTokenizer(
  dir: string,
): Promise<ListenBinTokenizer> {
  let buffer: Uint8Array;
  try {
    buffer = await readFile(join(dir, 'tokenizer.bin'));
  } catch (failure) {
    throw new Error(
      `The voice-input tokenizer could not be read: ${describe(failure)}. ` +
        'Download the voice-input model again from Settings → Voice input.',
    );
  }
  const tokenizer = parseBinTokenizer(buffer);
  return tokenizer;}

/** Both small files, read together so a caller cannot load one without the other. */
export async function readListenAssets(dir: string): Promise<{
  config: ListenConfig;
  tokenizer: ListenBinTokenizer;
}> {
  const config = await readListenConfig(dir);
  const tokenizer = await readBinTokenizer(dir);
  if (tokenizer.tokens.length < config.vocabSize) {
    throw new Error(
      `The voice-input tokenizer has ${String(tokenizer.tokens.length)} tokens ` +
        `but the model emits ${String(config.vocabSize)}. Download the model ` +
        'again from Settings → Voice input.',
    );
  }
  return {config, tokenizer};
}

function parseStateShapes(value: unknown): ListenStateShapes {
  const object = asRecord(value, 'The voice-input state shapes');
  return {
    sample_buffer: shape(object, 'sample_buffer'),
    sample_len: shape(object, 'sample_len'),
    conv1_buffer: shape(object, 'conv1_buffer'),
    conv2_buffer: shape(object, 'conv2_buffer'),
    frame_count: shape(object, 'frame_count'),
  };
}

function shape(object: Record<string, unknown>, key: string): number[] {
  const value = object[key];
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`The voice-input state shape ${key} is missing.`);
  }
  return value.map((entry) => {
    if (
      typeof entry !== 'number' ||
      !Number.isSafeInteger(entry) ||
      entry <= 0
    ) {
      throw new Error(`The voice-input state shape ${key} is malformed.`);
    }
    return entry;
  });
}

function requireProduct(shape: readonly number[], expected: number, name: string): void {
  const product = shape.reduce((total, entry) => total * entry, 1);
  if (product !== expected) {
    throw new Error(
      `The voice-input state shape ${name} holds ${String(product)} values, ` +
        `not ${String(expected)}.`,
    );
  }
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} is not an object.`);
  }
  return value as Record<string, unknown>;
}

function positiveInt(object: Record<string, unknown>, key: string): number {
  const value = integer(object, key);
  if (value <= 0) {
    throw new Error(`The voice-input setting ${key} is not positive.`);
  }
  return value;
}

function nonNegativeInt(object: Record<string, unknown>, key: string): number {
  const value = integer(object, key);
  if (value < 0) {
    throw new Error(`The voice-input setting ${key} is negative.`);
  }
  return value;
}

function integer(object: Record<string, unknown>, key: string): number {
  const value = object[key];
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new Error(`The voice-input setting ${key} is missing or malformed.`);
  }
  return value;
}

function describe(failure: unknown): string {
  return failure instanceof Error ? failure.message : String(failure);
}
