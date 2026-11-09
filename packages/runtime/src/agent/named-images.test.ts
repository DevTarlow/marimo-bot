/**
 * The pictures a message names, and when they are worth attaching.
 *
 * The failure this exists for is a real one: "what is in ladybug.png?" was
 * answered with "I have no vision", because the file tools are text-only and
 * only an explicit attachment reached the encoder. The rule is deliberately
 * narrower than "mentions a file" — a rename or a delete does not need the
 * bytes — so most of these tests are about what stays untouched.
 */
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';

import {afterEach, beforeEach, describe, expect, it} from 'vitest';

import {ATTACHED_FILES_HEADING} from '@marimo/protocol';

import {
  asksAboutPicture,
  attachNamedImages,
  imageNamesIn,
} from './named-images.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(process.cwd(), '.marimo-named-images-'));
  await writeFile(join(dir, 'Ladybug.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  await writeFile(join(dir, 'notes.txt'), 'hello');
});

afterEach(async () => {
  await rm(dir, {recursive: true, force: true});
});

describe('asksAboutPicture', () => {
  it('sees a question or a picture verb', () => {
    expect(asksAboutPicture('what is in ladybug.png?')).toBe(true);
    expect(asksAboutPicture('show me the screenshot')).toBe(true);
    expect(asksAboutPicture('describe image.jpg')).toBe(true);
    expect(asksAboutPicture('look at this')).toBe(true);
  });

  it('does not turn a command into a request to look', () => {
    expect(asksAboutPicture('delete ladybug.png')).toBe(false);
    expect(asksAboutPicture('rename ladybug.png to bug.png')).toBe(false);
  });
});

describe('imageNamesIn', () => {
  it('finds the image-shaped names, not every path', () => {
    expect(imageNamesIn('what is in Ladybug.png?')).toEqual(['Ladybug.png']);
    expect(imageNamesIn('compare pics/shot.jpeg and notes.txt')).toEqual([
      'pics/shot.jpeg',
    ]);
    expect(imageNamesIn('(see shot.png).')).toEqual(['shot.png']);
    expect(imageNamesIn('no images here')).toEqual([]);
  });
});

describe('attachNamedImages', () => {
  it('attaches the image a question names, and says so in the message', async () => {
    const result = await attachNamedImages(dir, 'what is in ladybug.png?');

    expect(result.attachments).toEqual([{path: 'Ladybug.png', kind: 'image'}]);
    expect(result.text).toContain(
      `${ATTACHED_FILES_HEADING}\n- Ladybug.png`,
    );
    expect(result.text.startsWith('what is in ladybug.png?')).toBe(true);
  });

  it('leaves a command that only mentions the file alone', async () => {
    const result = await attachNamedImages(dir, 'delete ladybug.png');

    expect(result.attachments).toEqual([]);
    expect(result.text).toBe('delete ladybug.png');
  });

  it('does not attach a text file, or a missing image', async () => {
    expect(
      (await attachNamedImages(dir, 'what is in notes.txt?')).attachments,
    ).toEqual([]);
    expect(
      (await attachNamedImages(dir, 'what is in missing.png?')).attachments,
    ).toEqual([]);
  });

  it('does not add to a message that already has an attachment', async () => {
    const result = await attachNamedImages(dir, 'what is in ladybug.png?', [
      {path: 'notes.txt', kind: 'image'},
    ]);

    expect(result.attachments).toEqual([{path: 'notes.txt', kind: 'image'}]);
    expect(result.text).toBe('what is in ladybug.png?');
  });

  it('leaves a block the person typed alone', async () => {
    const text = `what is in ladybug.png?\n\n${ATTACHED_FILES_HEADING}\n- notes.txt`;
    const result = await attachNamedImages(dir, text);

    expect(result.attachments).toEqual([]);
    expect(result.text).toBe(text);
  });

  it('finds a picture in a folder whatever the case', async () => {
    await mkdir(join(dir, 'pics'), {recursive: true});
    await writeFile(
      join(dir, 'pics', 'Shot.PNG'),
      Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    );

    const result = await attachNamedImages(dir, 'describe pics/shot.png');

    expect(result.attachments).toEqual([
      {path: 'pics/Shot.PNG', kind: 'image'},
    ]);
  });

  it('attaches a picture named twice only once', async () => {
    const result = await attachNamedImages(
      dir,
      'compare ladybug.png with ladybug.png?',
    );

    expect(result.attachments).toEqual([{path: 'Ladybug.png', kind: 'image'}]);
  });
});
