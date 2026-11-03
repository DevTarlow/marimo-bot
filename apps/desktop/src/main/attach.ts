/**
 * Which of the picked files this conversation may attach.
 *
 * Separated from the dialog that asks for them, because the interesting half is
 * not the picker: it is the judgement, and a judgement buried inside an IPC
 * handler cannot be tested — the test would need Electron, a window and a person
 * to click. This half is a function of a folder and a list of paths, and every
 * rule in it is a rule that fails silently otherwise.
 *
 * The rules are the agent's own, deliberately. A file is attached so the agent
 * can read it, and the agent reads through `resolveInsideWorkspace` and
 * `read_file` — so a file this module accepts is one those will accept, and a
 * file it refuses is one they would have refused *after* the user watched it
 * appear in their message. The path guard follows symlinks before deciding,
 * which is the case that matters: a link sitting inside the folder and pointing
 * out of it is exactly what the guard exists for.
 */
import {open, stat} from 'node:fs/promises';
import {basename, relative} from 'node:path';

import {PathOutsideWorkspaceError, resolveInsideWorkspace} from '@marimo/agent';
import {isImagePath, MAX_ATTACHMENT_BYTES} from '@marimo/protocol';
import type {PickedFile, SkippedFile} from '@marimo/protocol';

/**
 * How much of a file is read to decide whether it is text.
 *
 * The same test `read_file` makes on the way out — a NUL byte in the first
 * block — and the same reasoning: it is what separates a binary from a text
 * file for every format anybody attaches by accident, and the size is only there
 * so that the answer does not cost a read of the whole file.
 */
export const BINARY_PROBE_BYTES = 8 * 1024;

export interface AttachableFiles {
  files: PickedFile[];
  skipped: SkippedFile[];
}

/**
 * Splits `paths` into what can be attached and what cannot, with a reason for
 * each refusal.
 *
 * Nothing throws. A file that cannot be attached is not an error the caller can
 * do anything about — it is information for the person who picked it, and the
 * reasons travel back beside the acceptances so the composer can say them in one
 * line.
 */
export async function attachableFiles(
  root: string,
  paths: readonly string[],
): Promise<AttachableFiles> {
  const files: PickedFile[] = [];
  const skipped: SkippedFile[] = [];

  for (const path of paths) {
    const name = basename(path);
    try {
      const resolved = await resolveInsideWorkspace(root, path);
      const info = await stat(resolved);
      if (!info.isFile()) {
        skipped.push({name, reason: 'Not a regular file.'});
        continue;
      }
      /*
       * An image is the one binary this app sends: the vision model takes the
       * bytes, and the file tools cannot read them. It is still the space's
       * file — the guard above resolved it — and the size cap is the same one
       * the driver enforces, so a file this accepts is not one the request will
       * later refuse.
       */
      if (isImagePath(resolved)) {
        if (info.size > MAX_ATTACHMENT_BYTES) {
          skipped.push({
            name,
            reason:
              `That image is larger than ` +
              `${String(Math.round(MAX_ATTACHMENT_BYTES / (1024 * 1024)))} MB.`,
          });
          continue;
        }
        files.push({
          path: resolved,
          name: basename(resolved),
          relative: relative(root, resolved),
          kind: 'image',
        });
        continue;
      }
      if (await looksBinary(resolved)) {
        skipped.push({
          name,
          reason: 'That file is not text, and this app can send only text or images.',
        });
        continue;
      }
      files.push({
        path: resolved,
        name: basename(resolved),
        relative: relative(root, resolved),
        kind: 'file',
      });
    } catch (error) {
      skipped.push({
        name,
        reason:
          error instanceof PathOutsideWorkspaceError
            ? `Outside the space this conversation works in (${root}).`
            : 'That file could not be read.',
      });
    }
  }

  return {files, skipped};
}

/**
 * Whether a file is text, by the same test `read_file` makes: a NUL byte in the
 * first block.
 *
 * An unreadable file answers `false` rather than throwing — that case is already
 * a refusal by another name, and turning it into a second one here would replace
 * "that file could not be read" with a stack trace.
 */
async function looksBinary(path: string): Promise<boolean> {
  const handle = await open(path, 'r').catch(() => undefined);
  if (handle === undefined) {
    return false;
  }
  try {
    const buffer = Buffer.alloc(BINARY_PROBE_BYTES);
    const {bytesRead} = await handle.read(buffer, 0, BINARY_PROBE_BYTES, 0);
    return buffer.subarray(0, bytesRead).includes(0);
  } finally {
    await handle.close();
  }
}
