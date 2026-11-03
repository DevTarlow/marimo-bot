/**
 * The block a message with files on it carries.
 *
 * Everything here is a failure that is invisible on screen. A block read one
 * line too far turns a sentence after the list into a file name; a block the
 * window failed to recognise draws no file at all while the agent was told
 * about it; a format listed for one reader and not the other makes a thumbnail
 * that never loads. The runtime and the window share this reader, so what is
 * pinned here is the one answer both get.
 */
import {describe, expect, it} from 'vitest';

import {
  ATTACHED_FILES_HEADING,
  imageMimeType,
  isImagePath,
  readAttachedFiles,
} from './attachments.js';

describe('readAttachedFiles', () => {
  it('reads the block the composer writes', () => {
    const read = readAttachedFiles(
      `what is this\n\n${ATTACHED_FILES_HEADING}\n- one.ts\n- two.ts`,
    );

    expect(read.body).toBe('what is this');
    expect(read.files).toEqual([
      {path: 'one.ts', name: 'one.ts'},
      {path: 'two.ts', name: 'two.ts'},
    ]);
  });

  it('names a file by its last segment, with either separator', () => {
    const read = readAttachedFiles(
      `${ATTACHED_FILES_HEADING}\n- notes/one.ts\n- pictures\\two.png`,
    );

    expect(read.files.map((file) => file.name)).toEqual(['one.ts', 'two.png']);
  });

  it('leaves a message with no block exactly as it was', () => {
    const text = '  two spaces, and\n\na blank line  ';
    expect(readAttachedFiles(text)).toEqual({body: text, files: []});
  });

  it('keeps the words but no block when nothing was typed', () => {
    // A message that is only files is a real message, and its bubble is the
    // picture rather than an empty paragraph.
    const read = readAttachedFiles(`${ATTACHED_FILES_HEADING}\n- shot.png`);

    expect(read.body).toBe('');
    expect(read.files).toHaveLength(1);
  });

  it('is empty for a message that merely mentions the heading', () => {
    expect(
      readAttachedFiles(`why does ${ATTACHED_FILES_HEADING} not work`),
    ).toEqual({
      body: `why does ${ATTACHED_FILES_HEADING} not work`,
      files: [],
    });
  });

  it('takes the last block, which is where the composer puts it', () => {
    // A user can type the heading themselves. The composer's own block comes
    // after whatever they typed, so the last one is the real list.
    const read = readAttachedFiles(
      `${ATTACHED_FILES_HEADING}\n- what-i-typed.ts\n\nlook at these\n\n` +
        `${ATTACHED_FILES_HEADING}\n- real.ts`,
    );

    expect(read.files.map((file) => file.path)).toEqual(['real.ts']);
    /*
     * The first heading is the person's own words rather than a block the app
     * wrote, so it stays in the text. Dropping it would hide a sentence they
     * typed because it happened to share a spelling with the composer.
     */
    expect(read.body).toContain(`${ATTACHED_FILES_HEADING}\n- what-i-typed.ts`);
    expect(read.body).toContain('look at these');
  });

  it('stops at the first line that is not a bullet, and keeps that text', () => {
    const read = readAttachedFiles(
      `${ATTACHED_FILES_HEADING}\n- one.ts\nand that is all`,
    );

    expect(read.files.map((file) => file.path)).toEqual(['one.ts']);
    expect(read.body).toBe('and that is all');
  });

  it('treats the heading with no list under it as the person\u2019s own words', () => {
    // The composer never writes an empty block, so a heading with nothing
    // bulleted under it is a sentence somebody typed — and dropping it would
    // lose what they said from their own transcript.
    const text = `${ATTACHED_FILES_HEADING}\n\nand that is the end`;
    expect(readAttachedFiles(text)).toEqual({body: text, files: []});
  });

  it('skips a blank line inside the list', () => {
    const read = readAttachedFiles(
      `look\n\n${ATTACHED_FILES_HEADING}\n- one.ts\n\n- two.ts`,
    );

    expect(read.files.map((file) => file.path)).toEqual(['one.ts', 'two.ts']);
  });
});

describe('the image formats', () => {
  it('names the type each format is served and sent with', () => {
    expect(imageMimeType('shot.png')).toBe('image/png');
    expect(imageMimeType('shot.JPG')).toBe('image/jpeg');
    expect(imageMimeType('shot.jpeg')).toBe('image/jpeg');
    expect(imageMimeType('shot.webp')).toBe('image/webp');
    expect(imageMimeType('a/b/shot.gif')).toBe('image/gif');
    expect(imageMimeType('a\\b\\shot.bmp')).toBe('image/bmp');
  });

  it('refuses a file that is not one of them', () => {
    for (const path of [
      'notes.md',
      'shot.png.txt',
      'archive.png.zip',
      '.png',
    ]) {
      expect(isImagePath(path)).toBe(false);
    }
    expect(isImagePath('shot.png')).toBe(true);
  });
});
