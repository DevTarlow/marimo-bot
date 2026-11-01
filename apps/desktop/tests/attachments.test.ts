/**
 * What a message with files attached says.
 *
 * This is the whole of the attachment feature the model actually sees: the
 * window sends text, and the text is what is stored, so a path composed wrongly
 * here is a path the agent will fail to read in a turn the user believes they
 * explained.
 */
import {describe, expect, it} from 'vitest';

import {ATTACHED_HEADING, composeMessage, describeSkipped} from '../src/renderer/attachments.js';

const one = {path: '/home/me/proj/src/index.ts', name: 'index.ts', relative: 'src/index.ts', kind: 'file' as const};
const two = {path: '/home/me/proj/README.md', name: 'README.md', relative: 'README.md', kind: 'file' as const};

describe('composing a message with attachments', () => {
  it('leaves a message with no files exactly as typed', () => {
    expect(composeMessage('  what changed?  ', [])).toBe('what changed?');
  });

  it('names the folder-relative path, not the absolute one', () => {
    const message = composeMessage('look at this', [one]);
    expect(message).toBe(`look at this\n\n${ATTACHED_HEADING}\n- src/index.ts`);
    /*
     * The absolute path is deliberately absent. It is the user's home directory,
     * and it would be written into every conversation that ever mentioned a file
     * — the agent resolves relative paths against the same folder the file was
     * judged against, so nothing is lost by leaving it out.
     */
    expect(message).not.toContain('/home/me');
  });

  it('sends the files alone when nothing was typed', () => {
    // "Look at this" is what a message with only attachments means, and refusing
    // to send it would make the picker a trap.
    expect(composeMessage('   ', [one, two])).toBe(
      `${ATTACHED_HEADING}\n- src/index.ts\n- README.md`,
    );
  });

  it('keeps the order they were attached in', () => {
    expect(composeMessage('', [two, one])).toBe(
      `${ATTACHED_HEADING}\n- README.md\n- src/index.ts`,
    );
  });
});

describe('describing files that were refused', () => {
  it('says nothing when nothing was refused', () => {
    expect(describeSkipped([])).toBeNull();
  });

  it('names each file and the reason it was refused', () => {
    expect(
      describeSkipped([
        {name: 'shot.png', reason: 'That file is not text.'},
        {name: 'notes.txt', reason: 'Outside the folder.'},
      ]),
    ).toBe('shot.png: That file is not text. notes.txt: Outside the folder.');
  });
});
