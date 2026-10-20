/**
 * The documents drawer's reading of what the server sent.
 *
 * Pure and without a DOM, for the reason the rail's own reading is: the
 * decisions worth testing are not the drawing but the ones that have a wrong
 * answer which looks plausible on screen — which directory a file is filed
 * under, what a filter matches, what name a chat is offered, and what a write's
 * answer does to a draft somebody is still typing.
 */
import type {
  DocumentEntry,
  DocumentRevision,
  DocumentWrite,
} from '@marimo/protocol';

/**
 * A file open in the editor.
 *
 * `text` is the draft and `saved` is the file's own text as of `revision`: the
 * two together are what "unsaved changes" means, and keeping both is what lets
 * a refused write leave the person's words exactly where they were.
 *
 * The space it was opened in travels with it, because a document belongs to the
 * folder it came from. Opening another conversation can move the drawer to
 * another Space while a draft is on screen, and a write that followed the
 * drawer would put one folder's file into another.
 */
export interface OpenDocument {
  spaceId: string;
  spaceName: string;
  path: string;
  text: string;
  saved: string;
  revision: DocumentRevision;
}

/**
 * Whether a file has a rendered view beside its source.
 *
 * The editor opens any UTF-8 text file, but only markdown has a Preview. The
 * check is case-insensitive because `.MD` is a markdown file to every other
 * tool on the machine.
 */
export function isMarkdownPath(path: string): boolean {
  const lower = path.toLowerCase();
  return lower.endsWith('.md') || lower.endsWith('.markdown');
}

export interface DocumentGroup {
  /** The directory, relative to the space root; `''` is the top level. */
  dir: string;
  /** What is drawn above the rows. */
  label: string;
  files: DocumentEntry[];
}

/**
 * The editor's state after a write answered.
 *
 * Here rather than in the component because both mistakes it prevents are
 * silent. A success records the text *that was sent* as saved — not the text on
 * screen, which is a later draft whenever somebody typed during the round trip,
 * and recording that would leave those keystrokes out of the next write. A
 * refusal changes nothing at all: the draft stays, and so does the revision it
 * is based on, which is the very thing the file no longer matches.
 */
export function afterWrite(
  document: OpenDocument,
  text: string,
  answer: DocumentWrite,
): {document: OpenDocument; conflict: boolean} {
  if (answer.ok) {
    return {
      document: {...document, saved: text, revision: answer.revision},
      conflict: false,
    };
  }
  return {document, conflict: true};
}

/**
 * The files, filed by directory.
 *
 * The server's order is kept inside a group and between groups — "the library
 * lists what the server sent" — rather than sorted here. The one thing this
 * adds is the grouping itself, because a flat list of relative paths makes the
 * reader work out which folder each row is in from the row's own text.
 */
export function groupFiles(files: readonly DocumentEntry[]): DocumentGroup[] {
  const groups = new Map<string, DocumentEntry[]>();
  for (const file of files) {
    const bucket = groups.get(file.dir);
    if (bucket === undefined) {
      groups.set(file.dir, [file]);
    } else {
      bucket.push(file);
    }
  }
  return [...groups].map(([dir, entries]) => ({
    dir,
    // A file at the root has no directory to print, and an empty heading reads
    // as one the window failed to draw.
    label: dir === '' ? 'Top level' : dir,
    files: entries,
  }));
}

/**
 * The files whose path contains what was typed.
 *
 * The whole relative path and not the name, because half a directory and half a
 * file name is how people remember where something is: `notes/2026` is a folder
 * and a file, and a filter that only saw names would miss it. Case-insensitive,
 * which is what everybody expects of a filter and what a case-sensitive one gets
 * wrong silently — it just finds nothing.
 */
export function filterFiles(
  files: readonly DocumentEntry[],
  query: string,
): DocumentEntry[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) {
    return [...files];
  }
  return files.filter((file) => file.path.toLowerCase().includes(needle));
}

/**
 * A file name for a conversation, offered as the whole of "keep this chat".
 *
 * Everything that is not a letter or a digit becomes a dash, which is also what
 * makes this safe for a title somebody pasted: `../../secrets` is a name here,
 * not a path, and the server would refuse it anyway — a heading that produces a
 * refusal is a bad first answer.
 *
 * Capped, because a conversation's title comes from its first message and can
 * be a paragraph; an empty result falls back to a name rather than to `.md`,
 * which is a hidden file.
 */
export function suggestChatName(title: string): string {
  const slug = title
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 60)
    .replace(/-+$/u, '');
  return slug.length === 0 ? 'chat.md' : `${slug}.md`;
}

/**
 * When a file was last changed, in the rail's own words.
 *
 * Deliberately the same rule as the rail's short date — the time for today, a
 * date before it — because two lists of things that changed recently should not
 * date them differently. It is four lines in a component; the alternatives were
 * that component exporting a formatter for one caller, or a new shared module
 * for one rule.
 */
export function modifiedLabel(at: string, now: Date = new Date()): string {
  const when = new Date(at);
  if (Number.isNaN(when.getTime())) {
    return '';
  }
  const sameDay =
    when.getFullYear() === now.getFullYear() &&
    when.getMonth() === now.getMonth() &&
    when.getDate() === now.getDate();
  return sameDay
    ? when.toLocaleTimeString(undefined, {hour: '2-digit', minute: '2-digit'})
    : when.toLocaleDateString(undefined, {month: 'short', day: 'numeric'});
}
