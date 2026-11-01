/**
 * Translation between ADK's Gemini-shaped request/response types and the
 * OpenAI-compatible chat-completions wire format that DeepSeek speaks.
 *
 * ADK passes `Content[]` (roles `user` / `model`, parts carrying text, function
 * calls, or function responses) while DeepSeek expects a flat message list with
 * `tool_calls` on assistant messages and separate `role: "tool"` messages. This
 * module owns that impedance mismatch so the provider class stays readable.
 */
import type {Content, FunctionDeclaration, Part} from '@google/genai';
import {REQUEST_CONFIRMATION_FUNCTION_CALL_NAME} from '@google/adk';

export interface OpenAiToolCall {
  id: string;
  type: 'function';
  function: {name: string; arguments: string};
}

export interface OpenAiMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  /**
   * Text, or the content array an image-bearing user message needs.
   *
   * The OpenAI dialect allows a user message's content to be a list of typed
   * parts. Everything that is not a user message with an image stays a string,
   * because a second shape for text would be a second thing every reader of this
   * type has to handle for no gain.
   */
  content: string | OpenAiContentPart[];
  tool_calls?: OpenAiToolCall[];
  tool_call_id?: string;
  /**
   * The model's chain of thought for this turn.
   *
   * The local LFM3 template carries thinking in a `<think>` block that llama.cpp
   * parses into this field, and the harness replays it on later tool-carrying
   * turns. It is not decoration: a template that expects the block back and does
   * not get it produces a worse turn, and DeepSeek's own API refused a
   * tool-carrying turn whose reasoning was missing.
   */
  reasoning_content?: string;
}

export type OpenAiContentPart =
  | {type: 'text'; text: string}
  | {type: 'image_url'; image_url: {url: string}};

export interface OpenAiTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

const SUPPORTED_FORMATS = new Set([
  'date-time',
  'date',
  'time',
  'duration',
  'email',
  'hostname',
  'ipv4',
  'ipv6',
  'uuid',
]);

const DROPPED_SCHEMA_KEYS = new Set([
  '$schema',
  'additionalProperties',
  'propertyOrdering',
  'title',
  'nullable',
  'exclusiveMinimum',
  'exclusiveMaximum',
]);

/**
 * JSON Schema keywords whose value has to be a number.
 *
 * ADK's Zod bridge emits some of them as strings — `z.string().min(1)` becomes
 * `minLength: "1"` — and a strict validator rejects the whole request over it:
 * `"1" is not of type "integer"`. Others are genuinely numbers (`minimum: 0`,
 * `maxItems: 50`), so both spellings are coerced rather than trusted.
 *
 * `exclusiveMinimum` / `exclusiveMaximum` also belong to this family but are
 * dropped above: ADK emits the draft-4 boolean form alongside `minimum`, which
 * is invalid in the dialect we send. Dropping the bound is safe because Zod
 * re-validates every tool call's arguments before the tool runs.
 */
const NUMERIC_SCHEMA_KEYS = new Set([
  'maximum',
  'minimum',
  'minItems',
  'maxItems',
  'minLength',
  'maxLength',
  'minProperties',
  'maxProperties',
  'multipleOf',
]);

/** Flattens an ADK `systemInstruction` (string or `Content`) into plain text. */
export function systemInstructionToText(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (value && typeof value === 'object' && 'parts' in value) {
    return partsToText((value as Content).parts);
  }
  return '';
}

/**
 * Concatenates the text parts of a part list, ignoring thought parts and
 * non-text parts. Thought parts carry the model's reasoning and must not leak
 * into visible content or into a system instruction.
 */
export function partsToText(parts: Part[] | undefined): string {
  if (!parts?.length) {
    return '';
  }
  const chunks: string[] = [];
  for (const part of parts) {
    if (part.thought === true) {
      continue;
    }
    if (typeof part.text === 'string' && part.text.length > 0) {
      chunks.push(part.text);
    }
  }
  return chunks.join('');
}

/** Concatenates the reasoning carried by a turn's thought parts. */
export function partsToReasoning(parts: Part[] | undefined): string {
  if (!parts?.length) {
    return '';
  }
  const chunks: string[] = [];
  for (const part of parts) {
    if (part.thought === true && typeof part.text === 'string' && part.text) {
      chunks.push(part.text);
    }
  }
  return chunks.join('');
}

/**
 * Converts ADK contents into DeepSeek messages.
 *
 * One ADK content can expand into several OpenAI messages: an assistant turn
 * that both speaks and calls tools becomes a single assistant message carrying
 * `content` plus `tool_calls`, and a content holding function responses becomes
 * one `role: "tool"` message per response.
 */
export function toOpenAiMessages(contents: Content[]): OpenAiMessage[] {
  const messages: OpenAiMessage[] = [];

  /**
   * The tool-call ids that were actually issued to the provider. ADK's
   * human-in-the-loop gate is an assistant-authored `adk_request_confirmation`
   * call, and the user's approval is a function response answering *that* call
   * id — neither belongs on the wire, and a `tool` message answering an id the
   * assistant never issued is rejected by OpenAI-compatible APIs.
   */
  const issuedCallIds = new Set<string>();
  contents.forEach((content, contentIndex) => {
    if (content.role !== 'model' && content.role !== 'assistant') {
      return;
    }
    (content.parts ?? []).forEach((part, partIndex) => {
      const call = part.functionCall;
      if (!call || call.name === REQUEST_CONFIRMATION_FUNCTION_CALL_NAME) {
        return;
      }
      issuedCallIds.add(callIdForCall(call.id, contentIndex, partIndex));
    });
  });

  contents.forEach((content, contentIndex) => {
    const isAssistant =
      content.role === 'model' || content.role === 'assistant';
    const parts = content.parts ?? [];

    const text = partsToText(parts);
    const toolCalls: OpenAiToolCall[] = [];
    const toolResults: OpenAiMessage[] = [];

    parts.forEach((part, partIndex) => {
      if (part.functionCall) {
        const call = part.functionCall;
        if (call.name === REQUEST_CONFIRMATION_FUNCTION_CALL_NAME) {
          return;
        }
        toolCalls.push({
          id: callIdForCall(call.id, contentIndex, partIndex),
          type: 'function',
          function: {
            name: call.name ?? '',
            arguments: stringifyArguments(call.args),
          },
        });
      }
      if (part.functionResponse) {
        const response = part.functionResponse;
        const id = callIdForCall(response.id, contentIndex, partIndex);
        if (response.name === REQUEST_CONFIRMATION_FUNCTION_CALL_NAME) {
          return;
        }
        if (!issuedCallIds.has(id)) {
          return;
        }
        toolResults.push({
          role: 'tool',
          tool_call_id: id,
          content: toolResponseToText(response.response),
        });
      }
    });

    if (isAssistant) {
      if (text.length > 0 || toolCalls.length > 0) {
        const message: OpenAiMessage = {role: 'assistant', content: text};
        if (toolCalls.length > 0) {
          message.tool_calls = toolCalls;
        }
        // Echoed on every later turn that carries tools; DeepSeek rejects the
        // request when a turn's reasoning is missing.
        const reasoning = partsToReasoning(parts);
        if (reasoning.length > 0) {
          message.reasoning_content = reasoning;
        }
        messages.push(message);
      }
      return;
    }

    // A user-authored content carrying tool results is the framework reporting
    // what a tool returned, not the human speaking.
    messages.push(...toolResults);
    /*
     * An image arrives as ADK `inlineData` and leaves as an OpenAI `image_url`
     * data URL. The bytes are read by the driver from the Space at request time;
     * a missing or unreadable file has already been turned into a text note, so
     * there is nothing here to refuse.
     */
    const images = parts.flatMap((part): OpenAiContentPart[] => {
      const inline = part.inlineData;
      if (
        inline === undefined ||
        typeof inline.data !== 'string' ||
        inline.data.length === 0
      ) {
        return [];
      }
      const mimeType =
        typeof inline.mimeType === 'string' && inline.mimeType.length > 0
          ? inline.mimeType
          : 'image/png';
      return [
        {
          type: 'image_url',
          image_url: {url: `data:${mimeType};base64,${inline.data}`},
        },
      ];
    });
    if (images.length > 0) {
      messages.push({
        role: 'user',
        content: [
          ...(text.length > 0 ? [{type: 'text' as const, text}] : []),
          ...images,
        ],
      });
    } else if (text.length > 0) {
      messages.push({role: 'user', content: text});
    }
  });

  return withAnsweredToolCalls(messages);
}

/**
 * The answer a call gets when the transcript has none.
 *
 * It says the call did not run rather than leaving an empty result, because an
 * empty result reads as a tool that ran and returned nothing — a different, and
 * wrong, thing to tell the model.
 */
const UNANSWERED_TOOL_RESULT =
  'This call did not run: it was never answered, so it has no result.';

/**
 * Fills in a tool message for every call an assistant message left unanswered.
 *
 * An assistant message carrying `tool_calls` must be followed by one tool
 * message per call id, and DeepSeek refuses the whole request otherwise:
 * "An assistant message with 'tool_calls' must be followed by tool messages
 * responding to each 'tool_call_id'". That refusal is not a one-off — the gap is
 * in the stored session, so every later turn of that conversation replays it and
 * fails the same way, which is what makes a repair here worth having rather
 * than only preventing the gap.
 *
 * Gaps are reachable without a bug in this module. ADK asks about each gated
 * call of a turn separately, so a decision delivered for one gate resumes the
 * turn while its siblings are still unanswered, and a turn stopped while a gate
 * is open never records a result at all. `toOpenAiMessages` is the layer that
 * owns the wire format, so it is the layer that refuses to emit a request the
 * provider will reject.
 *
 * The messages are walked in order, tracking the assistant turn whose calls are
 * still open: a tool message closes the call it answers, and any message that is
 * not a tool message ends the turn, so the placeholders land directly after the
 * assistant message they belong to, where the provider requires them.
 */
function withAnsweredToolCalls(messages: OpenAiMessage[]): OpenAiMessage[] {
  const guarded: OpenAiMessage[] = [];
  let open: {ids: Set<string>; answered: Set<string>} | undefined;

  const closeAnsweredTurn = (): void => {
    if (!open) {
      return;
    }
    for (const id of open.ids) {
      if (!open.answered.has(id)) {
        guarded.push({
          role: 'tool',
          tool_call_id: id,
          content: UNANSWERED_TOOL_RESULT,
        });
      }
    }
    open = undefined;
  };

  for (const message of messages) {
    if (message.role === 'tool') {
      const id = message.tool_call_id ?? '';
      if (open && (!open.ids.has(id) || open.answered.has(id))) {
        // A second answer to the same call, or one for a call this turn never
        // issued. Neither can be attached to the turn, and both are refused
        // where they stand.
        continue;
      }
      open?.answered.add(id);
      guarded.push(message);
      continue;
    }

    closeAnsweredTurn();
    guarded.push(message);
    if (message.role === 'assistant' && message.tool_calls?.length) {
      open = {
        ids: new Set(message.tool_calls.map((call) => call.id)),
        answered: new Set<string>(),
      };
    }
  }

  closeAnsweredTurn();
  return guarded;
}

function callIdForCall(
  id: string | undefined,
  contentIndex: number,
  partIndex: number,
): string {
  return id ?? `call_${contentIndex}_${partIndex}`;
}

/** Converts ADK function declarations into DeepSeek `tools` entries. */
export function toOpenAiTools(
  declarations: FunctionDeclaration[] | undefined,
): OpenAiTool[] {
  if (!declarations?.length) {
    return [];
  }
  const tools: OpenAiTool[] = [];
  for (const declaration of declarations) {
    if (!declaration.name) {
      continue;
    }
    const raw =
      (declaration as {parametersJsonSchema?: unknown}).parametersJsonSchema ??
      declaration.parameters;
    tools.push({
      type: 'function',
      function: {
        name: declaration.name,
        description: declaration.description ?? '',
        parameters: normalizeSchema(raw),
      },
    });
  }
  return tools;
}

/**
 * Rewrites a Gemini-flavoured schema into the JSON Schema dialect DeepSeek
 * accepts: lowercase `type` names, no `nullable`, and none of the annotation
 * keys Gemini tolerates but strict OpenAI-compatible validators reject.
 */
export function normalizeSchema(input: unknown): Record<string, unknown> {
  const schema = normalizeNode(input);
  if (!schema.type) {
    schema.type = 'object';
  }
  if (schema.type === 'object' && !schema.properties) {
    schema.properties = {};
  }
  return schema;
}

function normalizeNode(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return {type: 'object', properties: {}};
  }

  const source = input as Record<string, unknown>;
  const output: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(source)) {
    if (DROPPED_SCHEMA_KEYS.has(key) || value === undefined) {
      continue;
    }

    if (key === 'type') {
      if (typeof value === 'string') {
        output.type = value.toLowerCase();
      } else if (Array.isArray(value)) {
        // Optional unions like ["string", "null"] are legal JSON Schema, but
        // DeepSeek's validator is happier with the non-null branch alone.
        const first = value.find((entry) => entry !== 'null');
        output.type =
          typeof first === 'string' ? first.toLowerCase() : 'string';
      }
      continue;
    }

    if (key === 'properties' && value && typeof value === 'object') {
      const properties: Record<string, unknown> = {};
      for (const [propName, propSchema] of Object.entries(
        value as Record<string, unknown>,
      )) {
        properties[propName] = normalizeNode(propSchema);
      }
      output.properties = properties;
      continue;
    }

    if (key === 'items') {
      output.items = normalizeNode(value);
      continue;
    }

    if (key === 'anyOf' && Array.isArray(value)) {
      output.anyOf = value.map((entry) => normalizeNode(entry));
      continue;
    }

    if (key === 'format') {
      if (typeof value === 'string' && SUPPORTED_FORMATS.has(value)) {
        output.format = value;
      }
      continue;
    }

    if (NUMERIC_SCHEMA_KEYS.has(key)) {
      const numeric = toFiniteNumber(value);
      if (numeric !== undefined) {
        output[key] = numeric;
      }
      continue;
    }

    output[key] = value;
  }

  return output;
}

/** A schema bound as a number, whether it arrived as a number or as a string. */
function toFiniteNumber(value: unknown): number | undefined {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function stringifyArguments(args: unknown): string {
  if (args === undefined || args === null) {
    return '{}';
  }
  if (typeof args === 'string') {
    return args;
  }
  try {
    return JSON.stringify(args);
  } catch {
    return '{}';
  }
}

function toolResponseToText(response: unknown): string {
  if (response === undefined || response === null) {
    return '';
  }
  if (typeof response === 'string') {
    return response;
  }
  // ADK wraps a tool's return value as `{result: ...}`; unwrap the common case
  // so the model reads the payload instead of a JSON envelope.
  if (typeof response === 'object' && 'result' in (response as object)) {
    const inner = (response as {result: unknown}).result;
    if (typeof inner === 'string') {
      return inner;
    }
  }
  try {
    return JSON.stringify(response);
  } catch {
    return String(response);
  }
}
