/**
 * The provider ids this build can still *read*, and the one it writes.
 *
 * There is no provider catalogue any more. The app answers with one of its own
 * local models, and `local` is the only id a new turn, profile or settings write
 * uses. But this enum is not only a choice: it is a field in documents that
 * already exist — a v2 `turn.started` event, a frozen harness version, a profile
 * written by an older build — and a schema that stopped knowing the old names
 * would make every one of those files unreadable. Losing a conversation to a
 * vocabulary change is not a migration; it is a deletion.
 *
 * So the five old ids stay here as **historical values**. Nothing in the app
 * offers them, resolves them, or reads a key for them. They are what a reader
 * needs to parse yesterday's audit record, and the day a document with one is
 * read, the next turn still answers on `local`.
 *
 * The model pair (`AgentModel`) is deliberately still a pair. A model id means
 * nothing without the thing that serves it, and the same bytes under a different
 * endpoint are a different model. The only endpoint now is this computer, which
 * is why the second half of every new pair is `local`.
 */
import {z} from 'zod';

/** The only provider id this build writes. */
export const LOCAL_PROVIDER_ID = 'local';

/**
 * The ids an older document may name.
 *
 * Order is the catalogue's old order and is kept only so a reader comparing two
 * files sees the same list; no picker iterates it.
 */
export const LEGACY_PROVIDER_IDS = [
  'deepseek',
  'gemini',
  'llamacpp',
  'opencode_go',
  'openrouter',
] as const;

export const PROVIDER_IDS = [
  LOCAL_PROVIDER_ID,
  ...LEGACY_PROVIDER_IDS,
] as const;

export const providerIdSchema = z.enum(PROVIDER_IDS);
export type ProviderId = z.infer<typeof providerIdSchema>;

/** The old ids, for the one migration that has to name their secret files. */
export function isLegacyProviderId(id: ProviderId): boolean {
  return id !== LOCAL_PROVIDER_ID;
}

/**
 * What a turn answers with.
 *
 * A pair rather than a model id alone, because a model id means nothing apart
 * from the endpoint that serves it. New pairs name `local`; old logs keep
 * whatever they said, and neither the transport nor the window offers a choice
 * of endpoint any more.
 */
export const agentModelSchema = z.object({
  provider: providerIdSchema,
  model: z.string().trim().min(1),
});

export type AgentModel = z.infer<typeof agentModelSchema>;
