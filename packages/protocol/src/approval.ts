/**
 * What an approval gate shows, on every surface that shows one.
 *
 * ADK's generic gate hint talks about FunctionResponse payloads, which means
 * nothing to the person deciding, so the card is built from the tool name and
 * its arguments instead. That summary lives here rather than beside a surface
 * because there are two — the window's approval card and the companion's
 * bubble — and "Approve" has to mean the same thing in both: the exact command,
 * the exact path, the exact bytes that were pinned for this call.
 *
 * Free of React, the DOM and Node, so it is unit-tested in plain Node and can be
 * imported by either side of the IPC boundary.
 */
import {describeCron} from './cron.js';

export interface ApprovalPreview {
  /** One line naming the action. */
  headline: string;
  /** The exact argument text, shown verbatim in a monospace block. */
  primary: string;
  /** A short line of context, when there is one. */
  note?: string;
  /** Extra content behind the primary text (a file's new contents). */
  detail?: string;
  /** What the collapsible `detail` holds, when it needs naming. */
  detailLabel?: string;
}

const PREVIEW_CHARS = 2_000;
const PREVIEW_LINES = 20;

export function summarizeApproval(
  tool: string,
  args: unknown,
): ApprovalPreview {
  const record = isRecord(args) ? args : {};

  if (tool === 'run_shell') {
    const command = stringValue(record['command']);
    const cwd = stringValue(record['cwd']);
    return {
      headline: 'Run this command in the workspace',
      primary: command ?? pretty(args),
      ...(cwd ? {note: `Working directory: ${cwd}`} : {}),
    };
  }

  if (tool === 'write_file') {
    const path = stringValue(record['path']);
    const content = stringValue(record['content']) ?? '';
    const preview = previewOf(content);
    return {
      headline: 'Overwrite this existing file',
      primary: path ?? pretty(args),
      note: `${byteLength(content)} bytes of new content will replace it`,
      ...(preview.length > 0
        ? {detail: preview, detailLabel: 'Show the new contents'}
        : {}),
    };
  }

  if (tool === 'save_skill') {
    /*
     * The instructions are the decision here, not the name: this text becomes
     * part of the agent's system prompt from the next request onwards, so the
     * person approving it is the last chance to read what it says. The name and
     * description are context underneath.
     */
    const name = stringValue(record['name']);
    const description = stringValue(record['description']);
    const instructions = stringValue(record['instructions']) ?? '';
    const label = name ?? 'a new skill';
    const note = [label, description].filter(Boolean).join(' — ');
    const preview = previewOf(instructions);
    return {
      headline: 'Save this skill and switch it on',
      primary: preview.length > 0 ? preview : pretty(args),
      ...(note.length > 0 ? {note} : {}),
    };
  }

  if (tool === 'create_job') {
    const name = stringValue(record['name']);
    const description = stringValue(record['description']);
    const schedules = stringValues(record['schedules']);
    const when =
      schedules.length > 0
        ? schedules.map((schedule) => describeCron(schedule)).join('; ')
        : 'at its default time';
    return {
      headline: 'Schedule this job',
      primary: name ?? pretty(args),
      note: `Runs ${when}`,
      ...(description
        ? {
            detail: previewOf(description),
            detailLabel: 'Show the instruction it runs',
          }
        : {}),
    };
  }

  if (tool === 'update_job') {
    const jobId = stringValue(record['jobId']);
    const changes: string[] = [];
    if (stringValue(record['name']) !== undefined) {
      changes.push('name');
    }
    if (stringValue(record['description']) !== undefined) {
      changes.push('instruction');
    }
    if (record['schedules'] !== undefined) {
      changes.push('times');
    }
    if (typeof record['enabled'] === 'boolean') {
      changes.push(record['enabled'] ? 'resumed' : 'paused');
    }
    return {
      headline: 'Change a scheduled job',
      primary: jobId ?? pretty(args),
      ...(changes.length > 0 ? {note: `Changes: ${changes.join(', ')}.`} : {}),
    };
  }

  if (tool === 'delete_job') {
    const jobId = stringValue(record['jobId']);
    return {
      headline: 'Delete a scheduled job',
      primary: jobId ?? pretty(args),
      note: 'This removes it for good. The conversation it ran in is kept.',
    };
  }

  if (tool === 'send_discord_message') {
    const text = stringValue(record['text']) ?? '';
    const channel = stringValue(record['channel']);
    return {
      headline: 'Post this message on Discord',
      primary: previewOf(text) || pretty(args),
      note: channel
        ? `Channel: #${channel}`
        : 'Channel: the one you already pointed the bot at',
    };
  }

  if (tool === 'ask_agent') {
    const agent = stringValue(record['agent']);
    const task = stringValue(record['task']);
    return {
      headline: 'Hand work to another bot',
      primary: agent ?? pretty(args),
      ...(task ? {note: firstLine(task, 160)} : {}),
    };
  }

  return {headline: `Use ${tool.replaceAll('_', ' ')}`, primary: pretty(args)};
}

/**
 * Whether ADK's own hint says anything useful. Its boilerplate is written for a
 * model, not a person, so it is dropped in favour of the summary above.
 */
export function meaningfulHint(hint: string): boolean {
  const text = hint.trim();
  if (text.length === 0) {
    return false;
  }
  return !/FunctionResponse|ToolConfirmation/i.test(text);
}

function previewOf(content: string): string {
  const lines = content.split('\n').slice(0, PREVIEW_LINES).join('\n');
  const clipped =
    lines.length > PREVIEW_CHARS ? lines.slice(0, PREVIEW_CHARS) : lines;
  const truncated = clipped.length < content.length ? `${clipped}\n…` : clipped;
  return truncated.trimEnd();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function stringValues(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

/** The first line of a block, bounded, so a note stays a note. */
function firstLine(text: string, max: number): string {
  const line = text.split('\n')[0]?.trim() ?? '';
  return line.length > max ? `${line.slice(0, max).trimEnd()}…` : line;
}

function pretty(value: unknown): string {
  if (value === undefined || value === null) {
    return '';
  }
  if (typeof value === 'string') {
    return value;
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/** UTF-8 byte length without depending on a DOM or Node global. */
function byteLength(text: string): number {
  let bytes = 0;
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 0x7f) {
      bytes += 1;
    } else if (code <= 0x7ff) {
      bytes += 2;
    } else if (code <= 0xffff) {
      bytes += 3;
    } else {
      bytes += 4;
    }
  }
  return bytes;
}
