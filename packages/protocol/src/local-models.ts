/**
 * The one model this build runs, as data.
 *
 * This app no longer asks which service answers. It downloads one
 * vision-language model and runs it on the machine, so the catalogue here is
 * the whole of what can answer: the labels a card shows, which tasks each model
 * is able to do, how large each copy is, and the licence the weights arrive
 * under.
 *
 * **The model is not the same thing as the file.** A model has two quantized
 * copies — an 8-bit one for quality and a 4-bit one for small machines — and
 * which copy is on disk is a fact about the disk, not a preference. Settings
 * stores the task assignments and the idle timeout; the installed copy is
 * recorded beside the files by the installer. That split is what keeps a
 * settings file from claiming a 4-bit copy that was never downloaded.
 *
 * **A task is a capability, not a name.** Chat needs text and images need
 * vision. A model that cannot do the thing is not an option for that task, and
 * the schema refuses a hand-edited assignment rather than letting a turn fail
 * at the engine.
 *
 * The file names, digests and exact byte counts live in
 * `packages/runtime/src/local-model/chat-pins.ts`, where both the window and the
 * headless runner can read them. The sizes below are for the download button
 * before either process has touched the disk; a runtime test holds them equal to
 * the pins so the number on the card cannot drift from the number downloaded.
 */
import {z} from 'zod';

export const LOCAL_MODEL_IDS = ['qwen2.5-vl-7b'] as const;
export const localModelIdSchema = z.enum(LOCAL_MODEL_IDS);
export type LocalModelId = z.infer<typeof localModelIdSchema>;

/**
 * What a model can do.
 *
 * `text` is required by every task. `vision` is what makes an attached picture
 * an input rather than a file name, and it is separate because the engine
 * needs a second download — the image projector — before it can see at all.
 */
export const LOCAL_MODEL_CAPABILITIES = ['text', 'vision'] as const;
export const localModelCapabilitySchema = z.enum(LOCAL_MODEL_CAPABILITIES);
export type LocalModelCapability = z.infer<typeof localModelCapabilitySchema>;

/** The two jobs a model can be assigned to. */
export const LOCAL_TASKS = ['chat', 'vision'] as const;
export const localTaskSchema = z.enum(LOCAL_TASKS);
export type LocalTask = z.infer<typeof localTaskSchema>;

/** The two quantized copies each model ships in. */
export const LOCAL_MODEL_VARIANTS = ['q8', 'q4'] as const;
export const localModelVariantSchema = z.enum(LOCAL_MODEL_VARIANTS);
export type LocalModelVariant = z.infer<typeof localModelVariantSchema>;

export const TASK_LABELS: Record<LocalTask, string> = {
  chat: 'Chat',
  vision: 'Images',
};

/** What each task needs from its model, in the order the rows are drawn. */
export const TASK_CAPABILITIES: Record<
  LocalTask,
  readonly LocalModelCapability[]
> = {
  chat: ['text'],
  vision: ['vision'],
};

/**
 * The files one variant needs, in bytes.
 *
 * Two numbers rather than one because the projector is a second download and a
 * second failure: a vision model with its weights but no projector is not a
 * slower answer, it is an engine with no image encoder in it at all. The card
 * shows the sum; the installer downloads the two parts and the status names the
 * missing one.
 */
export interface LocalModelVariantBytes {
  weights: number;
  projector: number;
}

export interface LocalModelDescriptor {
  id: LocalModelId;
  /** The card's title. */
  label: string;
  /** What the composer's badge has room for. */
  shortLabel: string;
  /** What the model is for, in one sentence. */
  blurb: string;
  /** The parameter count, as the card states it. */
  params: string;
  /**
   * The window the app runs the model at, in tokens.
   *
   * Not the model's maximum: the GGUF advertises 128K, and a 7B model's KV
   * cache at that length costs more memory than the weights. The app runs a
   * working window small enough for a laptop and compacts within it.
   */
  contextTokens: number;
  capabilities: readonly LocalModelCapability[];
  /** What the card downloads when nobody chooses. */
  defaultVariant: LocalModelVariant;
  bytes: Record<LocalModelVariant, LocalModelVariantBytes>;
  license: {name: string; url: string};
  /** The Hugging Face repository the weights come from. */
  repo: string;
}

export const LOCAL_MODELS: Record<LocalModelId, LocalModelDescriptor> = {
  'qwen2.5-vl-7b': {
    id: 'qwen2.5-vl-7b',
    label: 'Qwen2.5 VL 7B',
    shortLabel: 'Qwen VL',
    blurb:
      'One model for text and pictures: reads screenshots, documents and ' +
      'charts, calls tools and answers from the files in its Space. The 4-bit ' +
      'copy plus its image encoder is the first download.',
    params: '7.6B',
    contextTokens: 32_768,
    capabilities: ['text', 'vision'],
    defaultVariant: 'q4',
    bytes: {
      q8: {weights: 8_098_524_032, projector: 1_354_163_040},
      q4: {weights: 4_683_072_384, projector: 1_354_163_040},
    },
    license: {
      name: 'Apache-2.0',
      url: 'https://huggingface.co/Qwen/Qwen2.5-VL-7B-Instruct',
    },
    repo: 'unsloth/Qwen2.5-VL-7B-Instruct-GGUF',
  },
};

/**
 * The models an older build installed, kept so their files can be removed.
 *
 * They are not in the catalogue: no pin, no status card, no download. Settings
 * → Models lists whichever of their directories is still on disk, and deleting
 * one is a button the person presses — never a migration that removes files on
 * its own.
 */
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

/** The bytes one model variant asks the disk for. */
export function variantBytes(
  model: LocalModelId,
  variant: LocalModelVariant,
): number {
  const bytes = LOCAL_MODELS[model].bytes[variant];
  return bytes.weights + bytes.projector;
}

/** Whether `model` can do every half of `task`. */
export function modelSupportsTask(
  model: LocalModelId,
  task: LocalTask,
): boolean {
  const capabilities = new Set(LOCAL_MODELS[model].capabilities);
  return TASK_CAPABILITIES[task].every((capability) =>
    capabilities.has(capability),
  );
}

/**
 * A file handed to the model as bytes rather than as a path.
 *
 * The path is relative to the conversation's Space and is resolved again by the
 * process that reads it, so a renderer that invents a path gets the same refusal
 * a tool would. Only images exist today: text files still travel as a path in
 * the message, because the agent's own reader is the one that opens them.
 */
export const attachmentKindSchema = z.enum(['image']);
export type AttachmentKind = z.infer<typeof attachmentKindSchema>;

export const attachmentSchema = z.object({
  path: z.string().min(1),
  kind: attachmentKindSchema,
});
export type Attachment = z.infer<typeof attachmentSchema>;

/** The most images one message may carry. */
export const MAX_ATTACHMENTS = 4;

/** The largest image one message may carry, in bytes. */
export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;

/** Every model a task may be assigned to, in catalogue order. */
export function modelsForTask(task: LocalTask): LocalModelId[] {
  return LOCAL_MODEL_IDS.filter((id) => modelSupportsTask(id, task));
}

/**
 * The token reserve the engine keeps back from the harness.
 *
 * The engine window is 32K. The harness is told to compact at `context - this`,
 * because the reply, the tool schemas and the stable instruction all share the
 * same window; a harness allowed to fill all 32K would leave no room to answer
 * in, and the engine would fail at the first long turn rather than the first
 * long conversation.
 */
export const LOCAL_MODEL_RESERVE_TOKENS = 8192;

/** The prompt budget a harness gets for one model. */
export function workContextTokens(modelId: LocalModelId): number {
  return Math.max(
    4096,
    LOCAL_MODELS[modelId].contextTokens - LOCAL_MODEL_RESERVE_TOKENS,
  );
}

/**
 * Which GPU engine build the app is asked to run.
 *
 * `vulkan` is the default name for the archive the app pins on Linux and
 * Windows; on macOS the same choice is the Metal build. `cuda` is the opt-in
 * NVIDIA build and is only offered where the driver can run it.
 */
export const ENGINE_BACKENDS = ['vulkan', 'cuda'] as const;
export const engineBackendSchema = z.enum(ENGINE_BACKENDS);
export type EngineBackend = z.infer<typeof engineBackendSchema>;

/**
 * The task a turn runs on, when nobody overrides it.
 *
 * Kept here rather than in the runtime because the settings schema and the
 * window's task rows have to agree about which model is the default for a new
 * install, and a default written twice is a default that can disagree.
 *
 * Chat and Images start on the one model. A picture is answered by the same
 * weights that answer text, so the assignment is not a choice between two
 * downloads.
 */
export function defaultLocalModelsSettings(): LocalModelsSettings {
  return {
    tasks: {
      chat: 'qwen2.5-vl-7b',
      vision: 'qwen2.5-vl-7b',
    },
    idleMinutes: 3,
    engineBackend: 'vulkan',
  };
}

/**
 * Which model each task runs on.
 *
 * A model that cannot do the task is refused here rather than at the engine: a
 * hand-edited document with Chat pointed at a text-only model is a settings
 * file that looks valid and produces a turn whose prompt is wrong for the
 * weights.
 */
export const localModelsSettingsSchema = z
  .object({
    tasks: z.object({
      chat: localModelIdSchema,
      vision: localModelIdSchema,
    }),
    /**
     * How long the engine stays warm after its last request.
     *
     * The app runs one model at a time and the whole point is that it does not
     * sit in memory all day: a few minutes covers the follow-up question, and a
     * longer gap pays the load time rather than the battery.
     */
    idleMinutes: z.number().int().min(1).max(30),
    /**
     * The engine archive to run.
     *
     * Vulkan is the default because it is one 35 MB archive and works on NVIDIA,
     * AMD and Intel; CUDA is the opt-in NVIDIA build and is much larger. The
     * setting records the request, not a guarantee: a machine with no usable
     * NVIDIA driver falls back to Vulkan rather than refusing to answer.
     */
    engineBackend: engineBackendSchema.default('vulkan'),
  })
  .superRefine((value, context) => {
    for (const task of LOCAL_TASKS) {
      const model = value.tasks[task];
      if (!modelSupportsTask(model, task)) {
        context.addIssue({
          code: 'custom',
          path: ['tasks', task],
          message: `${model} cannot be used for ${TASK_LABELS[task].toLowerCase()}.`,
        });
      }
    }
  });

export type LocalModelsSettings = z.infer<typeof localModelsSettingsSchema>;

/**
 * A patch of the block.
 *
 * `tasks` is partial one level down so moving Chat does not mean sending the
 * other task back from a window whose copy is older, exactly like the provider
 * block it replaces. The capability check runs after the store has merged this
 * over what it holds; a patch that names only Chat is not asked to prove the
 * other one.
 */
export const localModelsPatchSchema = z.object({
  tasks: z
    .object({
      chat: localModelIdSchema.optional(),
      vision: localModelIdSchema.optional(),
    })
    .optional(),
  idleMinutes: z.number().int().min(1).max(30).optional(),
  engineBackend: engineBackendSchema.optional(),
});

export type LocalModelsPatch = z.infer<typeof localModelsPatchSchema>;

/** The active model, as the composer draws it. */
export const localModelStateSchema = z.enum([
  'off',
  'starting',
  'ready',
  'failed',
]);
export type LocalModelState = z.infer<typeof localModelStateSchema>;

/** Which piece of a model is not on disk. `engine` is shared by both tasks. */
export const LOCAL_MODEL_PARTS = ['engine', 'weights', 'projector'] as const;
export const localModelPartSchema = z.enum(LOCAL_MODEL_PARTS);
export type LocalModelPart = z.infer<typeof localModelPartSchema>;

/**
 * One model as the Models card draws it.
 *
 * `state` is about the process, not the files: a model can be installed and
 * `off`, installed and `ready`, or not installed at all. The two facts are kept
 * apart because the fix differs — a missing file is a download, a failed start
 * is a log.
 */
export interface LocalModelStatus {
  id: LocalModelId;
  installed: boolean;
  installedVariant?: LocalModelVariant;
  /** What is missing from the installed copy, in the order to fetch it. */
  missing: LocalModelPart[];
  state: LocalModelState;
  detail?: string;
  /** The engine's last words, when there was a failure. */
  log?: string[];
  /** The tasks this model is assigned to. */
  usedFor: LocalTask[];
}

/** What the machine offers for the opt-in NVIDIA engine. */
export interface CudaEngineStatus {
  available: boolean;
  /** The card `nvidia-smi` named, when it answered. */
  device?: string;
  /** The installed NVIDIA driver, when it answered. */
  driver?: string;
  /** Why CUDA is not being offered, when it is not. */
  reason?: string;
  /** Bytes the CUDA engine and its runtime add to the download. */
  bytes: number;
}

/** The whole model situation, in one payload. */
export interface LocalModelsStatus {
  /**
   * The shared engine, and whether this platform has one at all.
   *
   * `backend` is what is actually being run, not what the settings asked for: a
   * requested CUDA build on a machine without a usable NVIDIA driver falls back
   * to Vulkan, and `cuda.reason` says why.
   */
  engine: {
    present: boolean;
    platformSupported: boolean;
    tag: string;
    backend: EngineBackend;
    cuda: CudaEngineStatus;
  };
  models: Record<LocalModelId, LocalModelStatus>;
  /** The model the process has loaded, when there is one. */
  active?: {
    id: LocalModelId;
    state: LocalModelState;
    detail?: string;
    log?: string[];
  };
  tasks: Record<LocalTask, LocalModelId>;
  idleMinutes: number;
  /** The engine the settings ask for, before the availability fallback. */
  engineBackend: EngineBackend;
  /** Q4 on an ordinary machine; Q8 where there is room for the larger copy. */
  recommendedVariant: LocalModelVariant;
  /**
   * Old model directories still on disk, in catalogue-ish order.
   *
   * They are not models this build can run. The card lists them so a person can
   * reclaim the space; removing one is an explicit action.
   */
  retired: RetiredModelId[];
}

/** The hardware facts a first run needs to choose a variant and explain itself. */
export interface HostHardware {
  totalMemoryMb: number;
  platform: string;
  arch: string;
}
