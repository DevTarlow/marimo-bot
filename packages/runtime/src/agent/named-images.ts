/**
 * The pictures a message names, attached before the turn.
 *
 * The agent's file tools are text-only, so a question about a picture in the
 * Space used to end with "I have no vision": the server could see an image, but
 * only one that travelled as an `image_url` part, and only the composer's `+`
 * made those. A person who names an image and asks about it has asked for it to
 * be looked at, so the turn now carries it.
 *
 * The rules are deliberately narrow. An image extension has to be in the text,
 * the message has to ask about it (a question or a picture verb), and the path
 * has to resolve inside the Space. Attaching every file a message happens to
 * mention would spend context on a delete or a rename that never needed the
 * bytes, and a narrower trigger is easier to explain when it does not fire. An
 * explicit attachment turns it off: the composer already knows what the person
 * chose.
 */
import {readdir, stat} from 'node:fs/promises';

import {resolveInsideWorkspace} from '@marimo/agent';
import {
  composeMessage,
  imageMimeType,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS,
  readAttachedFiles,
} from '@marimo/protocol';
import type {Attachment} from '@marimo/protocol';

/** Words that make a mention of a picture a request to look at it. */
const PICTURE_CUE =
  /\b(what|which|who|describe|look|see|show|picture|image|photo|screenshot|colour|color|content|depict)\b|\?/iu;

/** A path-shaped token ending in an image extension. */
const IMAGE_TOKEN =
  /(?:^|[\s"'`(])([\w./-]+\.(?:png|jpe?g|webp|gif|bmp))/giu;

/** Whether the message is asking about a picture rather than naming one. */
export function asksAboutPicture(text: string): boolean {
  return PICTURE_CUE.test(text);
}

/** The image-shaped names in a message, in the order they appear. */
export function imageNamesIn(text: string): string[] {
  const names: string[] = [];
  for (const match of text.matchAll(IMAGE_TOKEN)) {
    const name = match[1];
    if (name !== undefined) {
      names.push(name);
    }
  }
  return names;
}

/**
 * Adds the images a message asks about to its attachments.
 *
 * The message is recomposed with the attachment block so the window draws the
 * picture the model was given: the transcript and the request have to show the
 * same message. Anything already attached, or a message that already carries a
 * block, is left exactly as it is.
 */
export async function attachNamedImages(
  workspaceRoot: string | undefined,
  text: string,
  existing: readonly Attachment[] = [],
): Promise<{text: string; attachments: Attachment[]}> {
  const unchanged = {text, attachments: [...existing]};
  if (workspaceRoot === undefined || existing.length > 0) {
    return unchanged;
  }
  const read = readAttachedFiles(text);
  if (read.files.length > 0 || !asksAboutPicture(read.body)) {
    return unchanged;
  }

  const found: Attachment[] = [];
  for (const name of imageNamesIn(read.body)) {
    if (found.length >= MAX_ATTACHMENTS) {
      break;
    }
    if (imageMimeType(name) === undefined) {
      continue;
    }
    const relative = await resolveNamedImage(workspaceRoot, name);
    if (relative === undefined || found.some((entry) => entry.path === relative)) {
      continue;
    }
    found.push({path: relative, kind: 'image'});
  }
  if (found.length === 0) {
    return unchanged;
  }
  return {
    text: composeMessage(
      read.body,
      found.map((entry) => ({relative: entry.path})),
    ),
    attachments: found,
  };
}

/**
 * The name as the Space spells it, or undefined when there is no such image.
 *
 * The literal path is tried first, which is what a person pasting a filename
 * gets. The fallback is case-insensitive within the same folder, because a
 * person typing `ladybug.png` at a file saved as `Ladybug.png` has named the
 * file they mean, and on a case-sensitive filesystem the literal lookup misses
 * it.
 */
async function resolveNamedImage(
  workspaceRoot: string,
  name: string,
): Promise<string | undefined> {
  if (await isImageAt(workspaceRoot, name)) {
    return name;
  }

  const cut = name.lastIndexOf('/');
  const dir = cut < 0 ? '' : name.slice(0, cut);
  const base = cut < 0 ? name : name.slice(cut + 1);
  let entries: string[];
  try {
    const resolved = await resolveInsideWorkspace(
      workspaceRoot,
      dir.length === 0 ? '.' : dir,
    );
    entries = await readdir(resolved);
  } catch {
    return undefined;
  }

  const wanted = base.toLowerCase();
  for (const entry of entries) {
    if (entry.toLowerCase() !== wanted) {
      continue;
    }
    const relative = dir.length === 0 ? entry : `${dir}/${entry}`;
    if (await isImageAt(workspaceRoot, relative)) {
      return relative;
    }
  }
  return undefined;
}

/** Whether the Space has an image at this relative path that the app can send. */
async function isImageAt(
  workspaceRoot: string,
  relative: string,
): Promise<boolean> {
  if (imageMimeType(relative) === undefined) {
    return false;
  }
  try {
    const resolved = await resolveInsideWorkspace(workspaceRoot, relative);
    const info = await stat(resolved);
    return info.isFile() && info.size <= MAX_ATTACHMENT_BYTES;
  } catch {
    return false;
  }
}
