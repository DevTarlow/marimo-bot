/**
 * Taking this install back to the state it was in before anything was set up.
 *
 * **The user-data folder is the unit, not a list of documents.** Every other
 * file in this package names one path and one reader; a reset has to name all of
 * them, including the ones added after it was written, and a hand-kept list is a
 * promise with a hole in it — a store nobody remembered shows up as the one file
 * that survived a factory reset. So the folder's *contents* are enumerated and
 * removed, and the only paths that can be named at all are inside it. That is
 * also what makes the two things a reset must never touch safe by construction
 * rather than by care: the folders the user loaded, documents and
 * `.marimo/<profile>/memory.md` notes alike, and the search weights when
 * `MARIMO_MODEL_DIR` has pointed the model somewhere else — neither is under
 * here. `defaultWorkspace` is the app's starting folder inside the home
 * directory (`<home>/Marimo`), so it is not either: the starting folder's files
 * are the person's, and a reset that erased them would be a factory reset that
 * took their work with it.
 *
 * The folder itself is left standing. Electron keeps its single-instance lock
 * inside it, the next launch's `applyUserDataPath` recreates it anyway, and a
 * reset that removed the directory it was called with would be one bug away from
 * removing an ancestor instead.
 *
 * **The second pass is not belt and braces.** A writer — a settings write
 * already in flight, a background job runner mid-message — can put a file back
 * while the first sweep is running, and a `settings.json` that comes back is not
 * a leftover: the next launch reads it as a current file, the first-run screen
 * never appears, and the reset has silently undone itself. One bounded retry,
 * not a loop — a writer that keeps winning is reported rather than fought, and
 * whatever lands after this returns is the caller's business (the desktop app
 * sweeps once more, immediately before it exits).
 */
import {readdir, rm} from 'node:fs/promises';
import {join} from 'node:path';

import type {AppPaths} from './paths.js';

export interface ResetReport {
  /** The folder that was emptied. Never removed itself. */
  userData: string;
  /** How many entries were removed, across both passes. */
  removed: number;
  /**
   * What could not be removed, with the reason.
   *
   * Empty on an ordinary install. A file the OS will not let go of is the
   * ordinary case — Chromium's own cache, locked on Windows — and it is the
   * app's profile rather than the user's data, so it is reported and the reset
   * carries on rather than stopping with more of the folder still there.
   */
  failures: {entry: string; reason: string}[];
}

/**
 * Erases everything this install keeps, and nothing else.
 *
 * Absent, unreadable or already empty all answer the same way: nothing removed,
 * nothing wrong. A reset somebody asks for twice is not an error.
 */
export async function resetInstall(paths: AppPaths): Promise<ResetReport> {
  const {userData} = paths;
  const failures: ResetReport['failures'] = [];
  let removed = 0;

  /*
   * Two sweeps and then an answer: the first removes what is there, the second
   * removes what appeared while it ran. Each pass's verdict replaces the last,
   * so what is reported is what survived the second one.
   */
  for (let pass = 0; pass < 2; pass += 1) {
    let names: string[];
    try {
      names = (await readdir(userData, {withFileTypes: true})).map(
        (entry) => entry.name,
      );
    } catch (failure) {
      /*
       * A folder that is not there is the state this leaves behind when somebody
       * resets twice, and is not a failure. Anything else — a folder this
       * process may not read — is, because answering "nothing was removed" as
       * though it were done would be the quietest possible lie.
       */
      failures.length = 0;
      if (!isMissing(failure)) {
        failures.push({entry: userData, reason: reasonFor(failure)});
      }
      break;
    }

    failures.length = 0;
    if (names.length === 0) {
      break;
    }
    for (const name of names) {
      /*
       * A name off the filesystem is a single path segment, so it cannot contain
       * a separator and `join` cannot leave the folder. What is named here is
       * the app's own documents and its stores' directories, plus whatever a
       * browser profile keeps beside them.
       */
      try {
        await rm(join(userData, name), {recursive: true, force: true});
        removed += 1;
      } catch (failure) {
        failures.push({entry: name, reason: reasonFor(failure)});
      }
    }
  }

  return {userData, removed, failures};
}

function isMissing(failure: unknown): boolean {
  return (failure as NodeJS.ErrnoException).code === 'ENOENT';
}

function reasonFor(failure: unknown): string {
  return failure instanceof Error ? failure.message : String(failure);
}
