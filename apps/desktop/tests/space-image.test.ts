/**
 * The pictures an attached message draws.
 *
 * Two things are pinned here, and both are silent when wrong. The URL is read
 * back into the conversation and path the window meant — an id that decodes to
 * a separator is the one shape that could name another file, and the parser
 * refuses it rather than leaving that to a later step. The read is a file
 * inside the conversation's Space or a refusal: a path outside it, a link that
 * leaves it, a file that is not an image and one over the cap are all one
 * answer, because the window's fallback is the same for every one of them.
 */
import {
  mkdir,
  mkdtemp,
  rm,
  symlink,
  truncate,
  writeFile,
} from 'node:fs/promises';
import {join} from 'node:path';

import {describe, expect, it, beforeEach, afterEach, vi} from 'vitest';

vi.mock('electron', () => ({
  BrowserWindow: {getFocusedWindow: () => null},
  dialog: {showOpenDialog: vi.fn()},
  nativeImage: {createFromBuffer: vi.fn()},
  protocol: {registerSchemesAsPrivileged: vi.fn()},
  session: {
    defaultSession: {protocol: {handle: vi.fn()}},
  },
}));

import {MAX_ATTACHMENT_BYTES, spaceImageUrl} from '@marimo/protocol';

import {readSpaceImage, spaceImageFromUrl} from '../src/main/assets.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0x03]);

describe('spaceImageFromUrl', () => {
  it('reads back the conversation and path the protocol helper wrote', () => {
    const url = spaceImageUrl(
      '6f7c4f5a-3a1b-4c9d-8e2f-1a2b3c4d5e6f',
      '0b0b0b0b-1111-2222-3333-444444444444',
      'pictures/macro shot.png',
    );

    expect(spaceImageFromUrl(url)).toEqual({
      profileId: '6f7c4f5a-3a1b-4c9d-8e2f-1a2b3c4d5e6f',
      sessionId: '0b0b0b0b-1111-2222-3333-444444444444',
      path: 'pictures/macro shot.png',
    });
  });

  it('keeps a Windows separator as the message wrote it', () => {
    const url = spaceImageUrl('profile', 'session', 'pictures\\shot.png');
    expect(spaceImageFromUrl(url)?.path).toBe('pictures\\shot.png');
  });

  it('refuses a URL that names something other than a conversation', () => {
    for (const url of [
      'marimo-asset://bot/profile.png',
      'marimo-asset://other/profile/session?path=shot.png',
      'marimo-asset://space/profile?path=shot.png',
      'marimo-asset://space/profile/session',
      'marimo-asset://space/profile/session?path=',
      'marimo-asset://space/profile/a%2Fb?path=shot.png',
      'marimo-asset://space/..%2F..%2Fsession?path=shot.png',
      'marimo-asset://space/profile/session?path=%00',
      'https://space/profile/session?path=shot.png',
      'not a url',
    ]) {
      expect(spaceImageFromUrl(url)).toBeUndefined();
    }
  });
});

let dir: string;
let space: string;

beforeEach(async () => {
  dir = await mkdtemp(join(process.cwd(), '.marimo-space-image-'));
  space = join(dir, 'space');
  await mkdir(join(space, 'pictures'), {recursive: true});
  await mkdir(join(dir, 'elsewhere'), {recursive: true});
});

afterEach(async () => {
  await rm(dir, {recursive: true, force: true, maxRetries: 5, retryDelay: 20});
});

describe('reading an attached image', () => {
  it('answers the bytes and the type the extension names', async () => {
    await writeFile(join(space, 'pictures', 'shot.png'), PNG);

    const image = await readSpaceImage(space, 'pictures/shot.png');

    expect(Buffer.from(image.bytes)).toEqual(PNG);
    expect(image.mime).toBe('image/png');
  });

  it('refuses a path outside the space', async () => {
    await writeFile(join(dir, 'elsewhere', 'secret.png'), PNG);

    await expect(
      readSpaceImage(space, '../elsewhere/secret.png'),
    ).rejects.toThrow();
  });

  it('refuses a link that points out of the space', async () => {
    await writeFile(join(dir, 'elsewhere', 'secret.png'), PNG);
    await symlink(
      join(dir, 'elsewhere', 'secret.png'),
      join(space, 'link.png'),
    );

    await expect(readSpaceImage(space, 'link.png')).rejects.toThrow();
  });

  it('refuses a file that is not an image', async () => {
    await writeFile(join(space, 'notes.txt'), 'hello');

    await expect(readSpaceImage(space, 'notes.txt')).rejects.toThrow();
  });

  it('refuses an image larger than the cap, without reading it', async () => {
    const big = join(space, 'huge.png');
    await writeFile(big, '');
    // Sparse rather than 8 MB of bytes: the size is all this rule looks at.
    await truncate(big, MAX_ATTACHMENT_BYTES + 1);

    await expect(readSpaceImage(space, 'huge.png')).rejects.toThrow();
  });

  it('refuses a folder and a file that is not there', async () => {
    await mkdir(join(space, 'folder.png'));

    await expect(readSpaceImage(space, 'folder.png')).rejects.toThrow();
    await expect(readSpaceImage(space, 'ghost.png')).rejects.toThrow();
  });
});
