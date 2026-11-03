/**
 * Reading the attachment block out of a message.
 *
 * A message with files on it is one string: what the person typed, then a
 * heading and a bulleted list of paths relative to the Space. That string is
 * what is stored and what the model is sent, so it is also the only thing the
 * window can draw from — the transcript holds no second copy of the
 * attachments.
 *
 * The reader lives here rather than beside either caller because there are now
 * three of them: the runtime, which tells the model what was attached; the
 * window, which draws a picture instead of its file name; and the tests that
 * pin the block's shape. Two implementations would be two answers to "was this
 * attached", and the one that disagreed would be invisible — the model would be
 * told about a file the window did not draw, or the other way round.
 *
 * Pure, and with no Node imports: the sandboxed renderer is one of the callers.
 */

/**
 * The line attached paths sit under, as the message spells it.
 *
 * Here rather than beside the composer that writes it, because every reader
 * depends on the same spelling. A second literal in a second reader is a block
 * that silently stops being recognised the day somebody rewords the first.
 */
export const ATTACHED_FILES_HEADING = 'Attached files:';

/**
 * The image formats this app hands to the vision model, and draws.
 *
 * One list for both jobs, because the two have to agree: a format the model
 * reads but the window cannot draw is a thumbnail that never loads, and one the
 * window draws but the model cannot read is a picture the agent was given and
 * cannot answer about.
 */
const IMAGE_MIME_TYPES: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
};

/**
 * The file's extension, lower-cased, or `''` when it has none.
 *
 * Split by hand rather than with `node:path`: this module is shared with the
 * renderer, and both separators are recognised because a path that came from a
 * Windows Space arrives with backslashes in the message.
 */
function extensionOf(path: string): string {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  const name = path.slice(cut + 1);
  const dot = name.lastIndexOf('.');
  // Dot zero is a hidden file called `.png`, which has no extension. A path
  // with no name left after the separator has none either.
  return dot <= 0 ? '' : name.slice(dot).toLowerCase();
}

/**
 * The media type of an image this app can draw, or undefined for anything else.
 *
 * By extension, which is what the picker and the engine both judge by: the
 * vision model takes bytes and names formats the same way.
 */
export function imageMimeType(path: string): string | undefined {
  return IMAGE_MIME_TYPES[extensionOf(path)];
}

/** Whether this is one of the images the app can hand over and draw. */
export function isImagePath(path: string): boolean {
  return imageMimeType(path) !== undefined;
}

/** One file a message names, as the message spells it. */
export interface AttachedFile {
  /** The path relative to the conversation's Space, exactly as written. */
  path: string;
  /**
   * The file's own name, for a chip or a caption.
   *
   * Derived rather than stored: the message holds paths, and the last segment
   * of one is its name on every platform this app runs on.
   */
  name: string;
}

/** What a message's text says, split into the words and the files it names. */
export interface MessageAttachments {
  /**
   * What the person typed, without the block the composer appended.
   *
   * Text after the block is kept rather than dropped: the composer never writes
   * any, but somebody who types the heading themselves should not lose what
   * follows it to a rule about a block the app usually owns.
   */
  body: string;
  /** The files the block names, in the order it names them. */
  files: AttachedFile[];
}

/**
 * The message, split into its words and the files it names.
 *
 * The heading is taken from its last occurrence, which is where the composer
 * puts it: after whatever the user typed. Only bulleted lines under it are
 * paths, so a message that merely *mentions* the heading does not turn the
 * sentence after it into a file list.
 */
export function readAttachedFiles(text: string): MessageAttachments {
  const lines = text.split('\n');
  let start = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index]?.trim() === ATTACHED_FILES_HEADING) {
      start = index;
      break;
    }
  }
  if (start < 0) {
    return {body: text, files: []};
  }

  const files: AttachedFile[] = [];
  let end = start + 1;
  for (; end < lines.length; end += 1) {
    const line = lines[end] ?? '';
    const match = /^\s*-\s+(.+?)\s*$/u.exec(line);
    if (match?.[1] !== undefined) {
      const path = match[1];
      files.push({path, name: fileNameOf(path)});
      continue;
    }
    // The first line that is neither a bullet nor blank ends the block; the
    // heading is followed by the list and nothing else.
    if (line.trim().length > 0) {
      break;
    }
  }

  /*
   * A heading with no list is not a block. The composer never writes one, so
   * this is somebody's own sentence — and dropping it would make a message
   * they typed disappear from their own transcript because it shared a
   * spelling with the heading.
   */
  if (files.length === 0) {
    return {body: text, files: []};
  }

  const before = lines.slice(0, start).join('\n').replace(/\n+$/u, '');
  const after = lines.slice(end).join('\n').replace(/^\n+/u, '');
  const body =
    after.length === 0
      ? before
      : before.length === 0
        ? after
        : `${before}\n\n${after}`;
  return {body, files};
}

/** The last segment of a path, whatever separator it uses. */
function fileNameOf(path: string): string {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  const name = path.slice(cut + 1);
  return name.length === 0 ? path : name;
}
