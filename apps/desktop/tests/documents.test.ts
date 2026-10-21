/**
 * The documents drawer's reading of what the server sent.
 *
 * Tested without a DOM, for the reason the rail's own reading is: the decisions
 * with a wrong answer that looks right on screen are the grouping, the filter,
 * the name a chat is offered and — the one the whole feature rests on — what a
 * write's answer does to a draft somebody is still typing.
 */
import {describe, expect, it} from 'vitest';

import type {DocumentEntry} from '@marimo/protocol';

import {
  afterWrite,
  filterFiles,
  groupFiles,
  isMarkdownPath,
  modifiedLabel,
  suggestChatName,
} from '../src/renderer/documents.js';
import type {OpenDocument} from '../src/renderer/documents.js';

function entry(
  path: string,
  overrides: Partial<DocumentEntry> = {},
): DocumentEntry {
  const cut = path.lastIndexOf('/');
  return {
    path,
    name: cut === -1 ? path : path.slice(cut + 1),
    dir: cut === -1 ? '' : path.slice(0, cut),
    bytes: 12,
    modifiedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function opened(overrides: Partial<OpenDocument> = {}): OpenDocument {
  return {
    spaceId: 'ws-a',
    spaceName: 'alpha',
    path: 'notes.md',
    text: 'draft',
    saved: 'draft',
    revision: {bytes: 5, modifiedAtMs: 1_000},
    ...overrides,
  };
}

describe('groupFiles', () => {
  /*
   * The server's order is the order — inside a group and between them. The top
   * level is not privileged over a folder whose first file arrived earlier; the
   * listing is the server's, and this only files it.
   */
  it('files by directory in the order it was sent', () => {
    const groups = groupFiles([
      entry('sub/b.md'),
      entry('a.md'),
      entry('sub/c.md'),
      entry('z.md'),
    ]);
    expect(
      groups.map((group) => [group.dir, group.files.map((file) => file.path)]),
    ).toEqual([
      ['sub', ['sub/b.md', 'sub/c.md']],
      ['', ['a.md', 'z.md']],
    ]);
    expect(groups.map((group) => group.label)).toEqual(['sub', 'Top level']);
  });

  it('keeps the order the server sent inside a group', () => {
    const groups = groupFiles([
      entry('b.md'),
      entry('sub/x.md'),
      entry('a.md'),
      entry('sub/y.md'),
    ]);
    const root = groups.find((group) => group.dir === '');
    expect(root?.files.map((file) => file.path)).toEqual(['b.md', 'a.md']);
  });

  it('answers nothing for an empty listing', () => {
    expect(groupFiles([])).toEqual([]);
  });
});

describe('isMarkdownPath', () => {
  /*
   * The editor opens any UTF-8 text file; this is the one question that decides
   * whether Preview is offered. `.MD` is markdown to every other tool, so the
   * check cannot be case-sensitive without making Preview vanish for a file the
   * rest of the machine calls markdown.
   */
  it('recognizes markdown, whatever the case and wherever it sits', () => {
    expect(isMarkdownPath('notes.md')).toBe(true);
    expect(isMarkdownPath('docs/guide.markdown')).toBe(true);
    expect(isMarkdownPath('docs/README.MD')).toBe(true);
  });

  it('is false for every other text file', () => {
    for (const path of ['index.html', 'styles.css', 'notes.txt', 'README']) {
      expect(isMarkdownPath(path)).toBe(false);
    }
  });
});

describe('filterFiles', () => {
  const files = [entry('notes/2026-plan.md'), entry('plan.md')];

  it('matches the whole path, so a directory can be half the query', () => {
    expect(filterFiles(files, 'notes/2026').map((file) => file.path)).toEqual([
      'notes/2026-plan.md',
    ]);
  });

  it('ignores case and surrounding space', () => {
    expect(filterFiles(files, '  PLAN ').map((file) => file.path)).toEqual([
      'notes/2026-plan.md',
      'plan.md',
    ]);
  });

  it('is the whole list when nothing was typed, and nothing when nothing matches', () => {
    expect(filterFiles(files, '')).toHaveLength(2);
    expect(filterFiles(files, 'roof')).toEqual([]);
  });
});

describe('suggestChatName', () => {
  it('turns a title into a file name', () => {
    expect(suggestChatName('Notes about the roof')).toBe(
      'notes-about-the-roof.md',
    );
  });

  /*
   * The point of slugging rather than trusting: a title can be anything a
   * conversation's first message happened to say, and a name is not a path.
   */
  it('keeps a path out of a title that looks like one', () => {
    expect(suggestChatName('../../secrets')).toBe('secrets.md');
  });

  it('falls back to a name when there is nothing to name', () => {
    expect(suggestChatName('   ')).toBe('chat.md');
    expect(suggestChatName('!!!')).toBe('chat.md');
  });

  it('caps a title that is a paragraph', () => {
    const name = suggestChatName('word '.repeat(80));
    expect(name.endsWith('.md')).toBe(true);
    expect(name.length).toBeLessThanOrEqual(63);
  });

  it('keeps letters that are not ASCII', () => {
    expect(suggestChatName('Про космос')).toBe('про-космос.md');
  });
});

describe('modifiedLabel', () => {
  const now = new Date(2026, 0, 15, 14, 30);

  it('gives the time for today', () => {
    const today = new Date(2026, 0, 15, 9, 5);
    expect(modifiedLabel(today.toISOString(), now)).toBe(
      today.toLocaleTimeString(undefined, {hour: '2-digit', minute: '2-digit'}),
    );
  });

  it('gives a date before that', () => {
    const earlier = new Date(2026, 0, 12, 9, 5);
    expect(modifiedLabel(earlier.toISOString(), now)).toBe(
      earlier.toLocaleDateString(undefined, {month: 'short', day: 'numeric'}),
    );
  });

  it('says nothing about a time it cannot read', () => {
    expect(modifiedLabel('not a date', now)).toBe('');
  });
});

describe('afterWrite', () => {
  /*
   * The keystrokes typed during the round trip are the whole reason `saved` is
   * the text that was *sent*: recording what is on screen instead would make the
   * next autosave think there was nothing left to write.
   */
  it('records the text that was written, not the text on screen', () => {
    const document = opened({
      text: 'the draft so far',
      saved: 'the file',
      revision: {bytes: 8, modifiedAtMs: 5},
    });
    const outcome = afterWrite(document, 'the draft', {
      ok: true,
      revision: {bytes: 12, modifiedAtMs: 9},
    });
    expect(outcome.conflict).toBe(false);
    expect(outcome.document.text).toBe('the draft so far');
    expect(outcome.document.saved).toBe('the draft');
    expect(outcome.document.revision).toEqual({bytes: 12, modifiedAtMs: 9});
  });

  it('leaves nothing to save when the whole draft went out', () => {
    const outcome = afterWrite(
      opened({text: 'mine', saved: 'theirs'}),
      'mine',
      {
        ok: true,
        revision: {bytes: 4, modifiedAtMs: 2},
      },
    );
    expect(outcome.document.text).toBe(outcome.document.saved);
  });

  /*
   * The refusal is the point of the feature: nothing on disk moved, so nothing
   * here may move either — not the draft, and not the revision the next attempt
   * has to be based on.
   */
  it('keeps the draft and its revision when the write was refused', () => {
    const document = opened({
      text: 'what I typed',
      saved: 'what the file said',
      revision: {bytes: 4, modifiedAtMs: 7},
    });
    const outcome = afterWrite(document, 'what I typed', {
      ok: false,
      conflict: true,
      revision: {bytes: 9, modifiedAtMs: 20},
    });
    expect(outcome.conflict).toBe(true);
    expect(outcome.document).toBe(document);
  });
});
