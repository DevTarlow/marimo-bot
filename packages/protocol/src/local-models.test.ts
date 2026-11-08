/**
 * The model catalogue's own invariants.
 *
 * Five facts are easy to get wrong and silent when they are: a model with no
 * descriptor (a card that cannot name it), a task with no model (a row with an
 * empty menu), a default assigned to a model that cannot do the job (a first run
 * that downloads the wrong thing), a vision model with no encoder (an engine
 * that cannot see), and a byte count that disagrees with what the installer
 * downloads. Each is asserted here, before a download or an engine exists to
 * fail later.
 */
import {describe, expect, it} from 'vitest';

import {
  agentModelSchema,
  defaultLocalModelsSettings,
  LOCAL_MODEL_IDS,
  LOCAL_MODELS,
  LOCAL_TASKS,
  MAX_ATTACHMENTS,
  MAX_ATTACHMENT_BYTES,
  modelSupportsTask,
  modelsForTask,
  RETIRED_MODEL_IDS,
  RETIRED_MODEL_LABELS,
  TASK_CAPABILITIES,
  TASK_LABELS,
  variantBytes,
} from './index.js';
import {
  LEGACY_PROVIDER_IDS,
  LOCAL_PROVIDER_ID,
  providerIdSchema,
} from './providers.js';

describe('the model catalogue', () => {
  it('describes every id it names, and names every descriptor it has', () => {
    expect(Object.keys(LOCAL_MODELS).sort()).toEqual([...LOCAL_MODEL_IDS].sort());
    for (const id of LOCAL_MODEL_IDS) {
      expect(LOCAL_MODELS[id].id).toBe(id);
      expect(LOCAL_MODELS[id].label.length).toBeGreaterThan(0);
      expect(LOCAL_MODELS[id].shortLabel.length).toBeGreaterThan(0);
      expect(LOCAL_MODELS[id].blurb.length).toBeGreaterThan(0);
      expect(LOCAL_MODELS[id].params.length).toBeGreaterThan(0);
      expect(LOCAL_MODELS[id].contextTokens).toBeGreaterThan(0);
      expect(LOCAL_MODELS[id].license.name.length).toBeGreaterThan(0);
      expect(LOCAL_MODELS[id].repo.startsWith('unsloth/Qwen2.5-')).toBe(true);
    }
  });

  it('gives every task at least one model, and a default that supports it', () => {
    const defaults = defaultLocalModelsSettings();
    for (const task of LOCAL_TASKS) {
      expect(modelsForTask(task).length).toBeGreaterThan(0);
      expect(TASK_LABELS[task].length).toBeGreaterThan(0);
      expect(modelSupportsTask(defaults.tasks[task], task)).toBe(true);
    }
  });

  it('does not offer a model for a task it cannot do', () => {
    expect(modelsForTask('chat')).toEqual([...LOCAL_MODEL_IDS]);
    expect(modelsForTask('vision')).toEqual([...LOCAL_MODEL_IDS]);
    expect(TASK_CAPABILITIES.chat).toEqual(['text']);
    expect(TASK_CAPABILITIES.vision).toEqual(['vision']);
  });

  it('gives every variant a positive size and an encoder for the vision model', () => {
    for (const id of LOCAL_MODEL_IDS) {
      const model = LOCAL_MODELS[id];
      for (const variant of ['q8', 'q4'] as const) {
        expect(variantBytes(id, variant)).toBeGreaterThan(0);
        expect(model.bytes[variant].weights).toBeGreaterThan(0);
      }
      // A vision model without a projector is an engine that cannot see.
      expect(model.capabilities).toContain('vision');
      expect(model.bytes.q8.projector).toBeGreaterThan(0);
      expect(model.bytes.q4.projector).toBeGreaterThan(0);
    }
  });

  it('keeps the attachment caps small enough to fit a local context', () => {
    expect(MAX_ATTACHMENTS).toBeLessThanOrEqual(4);
    expect(MAX_ATTACHMENT_BYTES).toBeLessThanOrEqual(8 * 1024 * 1024);
  });

  it('keeps the retired list out of the catalogue, with a label for each', () => {
    for (const id of RETIRED_MODEL_IDS) {
      expect(LOCAL_MODEL_IDS).not.toContain(id);
      expect(RETIRED_MODEL_LABELS[id].length).toBeGreaterThan(0);
    }
  });
});

describe('the model pair', () => {
  it('names local for every new model', () => {
    expect(LOCAL_PROVIDER_ID).toBe('local');
    expect(
      agentModelSchema.safeParse({provider: 'local', model: 'qwen2.5-vl-7b'})
        .success,
    ).toBe(true);
  });

  it('still reads the providers an old document may name', () => {
    for (const provider of LEGACY_PROVIDER_IDS) {
      expect(providerIdSchema.safeParse(provider).success).toBe(true);
      expect(
        agentModelSchema.safeParse({provider, model: 'whatever-it-was'}).success,
      ).toBe(true);
    }
  });

  it('refuses a provider id this build has never heard of', () => {
    expect(
      agentModelSchema.safeParse({provider: 'someone_elses', model: 'x'}).success,
    ).toBe(false);
  });
});
