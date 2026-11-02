/**
 * The LFM3 family, as data.
 *
 * This app no longer asks which service answers. It downloads one of four small
 * Liquid AI models and runs it on the machine, so the catalogue here is the whole
 * of what can answer: the labels a picker shows, which task each model is able
 * to do, how large each copy is, and the licence the weights arrive under.
 *
 * **The model is not the same thing as the file.** A model has two quantized
 * copies — an 8-bit one for quality and a 4-bit one for small machines — and
 * which copy is on disk is a fact about the disk, not a preference. Settings
 * stores the task assignments and the idle timeout; the installed copy is
 * recorded beside the files by the installer. That split is what keeps a
 * settings file from claiming a 4-bit copy that was never downloaded.
 *
 * **A task is a capability, not a name.** Chat needs text, images need vision,
 * and voice needs audio input *and* speech output. A model that cannot do the
 * thing is not an option for that task, and the schema refuses a hand-edited
 * assignment rather than letting a turn fail at the engine.
 *
 * The file names, digests and exact byte counts live in
 * `packages/runtime/src/local-model/chat-pins.ts`, where both the window and the
 * headless runner can read them. The sizes below are for the download button
 * before either process has touched the disk; a runtime test holds them equal to
 * the pins so the number on the card cannot drift from the number downloaded.
 */
import {z} from 'zod';

export const LOCAL_MODEL_IDS = [
  'lfm3-1.7b',
  'lfm3-vl-2b',
  'lfm3-audio-2b',
  'lfm3-omni-2b',
] as const;
export const localModelIdSchema = z.enum(LOCAL_MODEL_IDS);
export type LocalModelId = z.infer<typeof localModelIdSchema>;

/**
 * What a model can do.
 *
 * `audio` is the input half and `speech` the output half, deliberately separate:
 * a transcription-only model would have the first without the second, and a
 * voice turn needs both. The two are not one flag because the failure of a
 * model that can hear but not speak is different from one that can do neither.
 */
export const LOCAL_MODEL_CAPABILITIES = [
  'text',
  'vision',
  'audio',
  'speech',
] as const;
export const localModelCapabilitySchema = z.enum(LOCAL_MODEL_CAPABILITIES);
export type LocalModelCapability = z.infer<typeof localModelCapabilitySchema>;

/** The three jobs a model can be assigned to. */
export const LOCAL_TASKS = ['chat', 'vision', 'voice'] as const;
export const localTaskSchema = z.enum(LOCAL_TASKS);
export type LocalTask = z.infer<typeof localTaskSchema>;

/** The two quantized copies each model ships in. */
export const LOCAL_MODEL_VARIANTS = ['q8', 'q4'] as const;
export const localModelVariantSchema = z.enum(LOCAL_MODEL_VARIANTS);
export type LocalModelVariant = z.infer<typeof localModelVariantSchema>;

export const TASK_LABELS: Record<LocalTask, string> = {
  chat: 'Chat',
  vision: 'Images',
  voice: 'Voice',
};

/** What each task needs from its model, in the order the rows are drawn. */
export const TASK_CAPABILITIES: Record<
  LocalTask,
  readonly LocalModelCapability[]
> = {
  chat: ['text'],
  vision: ['vision'],
  voice: ['audio', 'speech'],
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
   * Not the model's maximum: LFM3-1.7B supports 256K, and a 1.7B model's KV
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

const LFM_LICENSE = {
  name: 'LFM Open License v1.0',
  url: 'https://huggingface.co/LiquidAI/LFM3-1.7B/blob/main/LICENSE',
} as const;

export const LOCAL_MODELS: Record<LocalModelId, LocalModelDescriptor> = {
  'lfm3-1.7b': {
    id: 'lfm3-1.7b',
    label: 'LFM3 1.7B',
    shortLabel: 'LFM3 1.7B',
    blurb:
      'The everyday model: reads, writes, calls tools and remembers what it ' +
      'is told. Small enough for a laptop processor.',
    params: '1.73B',
    contextTokens: 32_768,
    capabilities: ['text'],
    defaultVariant: 'q8',
    bytes: {
      q8: {weights: 1_846_238_496, projector: 0},
      q4: {weights: 1_049_615_680, projector: 0},
    },
    license: LFM_LICENSE,
    repo: 'LiquidAI/LFM3-1.7B-GGUF',
  },
  'lfm3-vl-2b': {
    id: 'lfm3-vl-2b',
    label: 'LFM3 VL 2B',
    shortLabel: 'LFM3 VL',
    blurb:
      'Looks at pictures: screenshots, documents, charts and photographs. ' +
      'Used only on turns that carry an image.',
    params: '1.92B',
    contextTokens: 32_768,
    capabilities: ['text', 'vision'],
    defaultVariant: 'q8',
    bytes: {
      q8: {weights: 1_846_238_496, projector: 203_031_872},
      q4: {weights: 1_049_615_648, projector: 203_031_872},
    },
    license: LFM_LICENSE,
    repo: 'LiquidAI/LFM3-VL-2B-GGUF',
  },
  'lfm3-audio-2b': {
    id: 'lfm3-audio-2b',
    label: 'LFM3 Audio 2B',
    shortLabel: 'LFM3 Audio',
    blurb:
      'Listens and speaks. Voice mode uses it for the whole turn so listening, ' +
      'answering and speaking need one model, not three.',
    params: '2B',
    contextTokens: 32_768,
    capabilities: ['text', 'audio', 'speech'],
    defaultVariant: 'q4',
    bytes: {
      q8: {weights: 1_846_236_704, projector: 303_811_840},
      q4: {weights: 1_099_626_016, projector: 172_418_048},
    },
    license: LFM_LICENSE,
    repo: 'LiquidAI/LFM3-Audio-2B-GGUF',
  },
  'lfm3-omni-2b': {
    id: 'lfm3-omni-2b',
    label: 'LFM3 Omni 2B',
    shortLabel: 'LFM3 Omni',
    blurb:
      'One model for text, pictures and speech. The smallest total install, ' +
      'and the one to choose on a machine with little memory.',
    params: '2.17B',
    contextTokens: 32_768,
    capabilities: ['text', 'vision', 'audio', 'speech'],
    defaultVariant: 'q4',
    bytes: {
      q8: {weights: 1_846_240_768, projector: 506_842_528},
      q4: {weights: 1_099_630_080, projector: 291_586_720},
    },
    license: LFM_LICENSE,
    repo: 'LiquidAI/LFM3-Omni-2B-GGUF',
  },
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
 * The task a turn runs on, when nobody overrides it.
 *
 * Kept here rather than in the runtime because the settings schema and the
 * window's task rows have to agree about which model is the default for a new
 * install, and a default written twice is a default that can disagree.
 */
export function defaultLocalModelsSettings(): LocalModelsSettings {
  return {
    tasks: {
      chat: 'lfm3-1.7b',
      vision: 'lfm3-vl-2b',
      voice: 'lfm3-audio-2b',
    },
    idleMinutes: 3,
  };
}

/**
 * Which model each task runs on.
 *
 * A model that cannot do the task is refused here rather than at the engine: a
 * hand-edited document with Chat pointed at the audio model is a settings file
 * that looks valid and produces a turn whose prompt is wrong for the weights.
 */
export const localModelsSettingsSchema = z
  .object({
    tasks: z.object({
      chat: localModelIdSchema,
      vision: localModelIdSchema,
      voice: localModelIdSchema,
    }),
    /**
     * How long the engine stays warm after its last request.
     *
     * The app runs one model at a time and the whole point is that it does not
     * sit in memory all day: a few minutes covers the follow-up question, and a
     * longer gap pays the load time rather than the battery.
     */
    idleMinutes: z.number().int().min(1).max(30),
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
 * other two back from a window whose copy is older, exactly like the provider
 * block it replaces. The capability check runs after the store has merged this
 * over what it holds; a patch that names only Chat is not asked to prove the
 * other two.
 */
export const localModelsPatchSchema = z.object({
  tasks: z
    .object({
      chat: localModelIdSchema.optional(),
      vision: localModelIdSchema.optional(),
      voice: localModelIdSchema.optional(),
    })
    .optional(),
  idleMinutes: z.number().int().min(1).max(30).optional(),
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

/** Which piece of a model is not on disk. `engine` is shared by all four. */
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

/** The whole model situation, in one payload. */
export interface LocalModelsStatus {
  /** The shared engine, and whether this platform has one at all. */
  engine: {present: boolean; platformSupported: boolean; tag: string};
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
  /** Q8 on a machine with room; Q4 where the first run should not spend 1.9GB. */
  recommendedVariant: LocalModelVariant;
}

/** The hardware facts a first run needs to choose a variant and explain itself. */
export interface HostHardware {
  totalMemoryMb: number;
  platform: string;
  arch: string;
}

/**
 * Speech languages the audio model supports.
 *
 * `asr` is the name put in the transcription prompt and `tts` is the code the
 * `/tts` endpoint takes. English has two locale codes for synthesis but one
 * language name for recognition, which is why the two fields are not derived
 * from the same string.
 */
export const SPEECH_LANGUAGES = [
  {code: 'en', label: 'English (US)', asr: 'English', tts: 'en'},
  {code: 'en-gb', label: 'English (UK)', asr: 'English', tts: 'en-gb'},
  {code: 'ar', label: 'Arabic', asr: 'Arabic', tts: 'ar'},
  {code: 'da', label: 'Danish', asr: 'Danish', tts: 'da'},
  {code: 'de', label: 'German', asr: 'German', tts: 'de'},
  {code: 'el', label: 'Greek', asr: 'Greek', tts: 'el'},
  {code: 'es', label: 'Spanish', asr: 'Spanish', tts: 'es'},
  {code: 'fi', label: 'Finnish', asr: 'Finnish', tts: 'fi'},
  {code: 'fr', label: 'French', asr: 'French', tts: 'fr'},
  {code: 'he', label: 'Hebrew', asr: 'Hebrew', tts: 'he'},
  {code: 'it', label: 'Italian', asr: 'Italian', tts: 'it'},
  {code: 'ja', label: 'Japanese', asr: 'Japanese', tts: 'ja'},
  {code: 'ko', label: 'Korean', asr: 'Korean', tts: 'ko'},
  {code: 'nl', label: 'Dutch', asr: 'Dutch', tts: 'nl'},
  {code: 'pl', label: 'Polish', asr: 'Polish', tts: 'pl'},
  {code: 'pt', label: 'Portuguese', asr: 'Portuguese', tts: 'pt'},
  {code: 'sv', label: 'Swedish', asr: 'Swedish', tts: 'sv'},
  {code: 'tr', label: 'Turkish', asr: 'Turkish', tts: 'tr'},
  {code: 'zh', label: 'Chinese', asr: 'Chinese', tts: 'zh'},
] as const;

export const SPEECH_LANGUAGE_CODES = SPEECH_LANGUAGES.map(
  (language) => language.code,
) as [string, ...string[]];

export const speechLanguageSchema = z.enum(SPEECH_LANGUAGE_CODES);
export type SpeechLanguage = z.infer<typeof speechLanguageSchema>;

export function speechLanguage(code: SpeechLanguage): (typeof SPEECH_LANGUAGES)[number] {
  return (
    SPEECH_LANGUAGES.find((language) => language.code === code) ??
    SPEECH_LANGUAGES[0]
  );
}

export const SPEECH_VOICES = ['female', 'male'] as const;
export const speechVoiceSchema = z.enum(SPEECH_VOICES);
export type SpeechVoice = z.infer<typeof speechVoiceSchema>;

/**
 * The most characters one spoken reply may carry.
 *
 * Shared rather than owned by the synthesizer because the window now splits a
 * reply into sentence-sized pieces so playback can start before the whole
 * answer has been generated. The pieces are bounded by the same total the host
 * would have used for one request, so a reply that was too long to speak before
 * is still too long — it just starts sooner.
 */
export const SPEECH_MAX_CHARS = 1200;
