/**
 * The two halves of a bot icon that can be reasoned about without a display.
 *
 * The decode itself is Electron's, and the picker needs a window; what is tested
 * here is the URL the renderer asks for and the shape the stored image takes.
 * Those are where the quiet failures live: a hostile path that reaches a
 * different file, or an aspect ratio flattened by a resize.
 */
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';

import {dialog, nativeImage} from 'electron';
import {describe, expect, it, vi} from 'vitest';

vi.mock('electron', () => ({
  BrowserWindow: {getFocusedWindow: () => null},
  dialog: {showOpenDialog: vi.fn()},
  nativeImage: {createFromBuffer: vi.fn()},
  protocol: {registerSchemesAsPrivileged: vi.fn()},
  session: {
    defaultSession: {protocol: {handle: vi.fn()}},
  },
}));

import {botAvatarUrl} from '@marimo/protocol';

import {
  MAX_AVATAR_BYTES,
  MAX_AVATAR_EDGE,
  avatarTargetSize,
  uploadBotAvatar,
} from '../src/main/avatar.js';
import {botAvatarProfileIdFromUrl} from '../src/main/assets.js';

describe('botAvatarProfileIdFromUrl', () => {
  it('reads back the id the protocol helper wrote', () => {
    const url = botAvatarUrl('6f7c4f5a-3a1b-4c9d-8e2f-1a2b3c4d5e6f', 'v1');
    expect(botAvatarProfileIdFromUrl(url)).toBe(
      '6f7c4f5a-3a1b-4c9d-8e2f-1a2b3c4d5e6f',
    );
  });

  it('refuses a path that is not the bot icon it serves', () => {
    for (const url of [
      'marimo-asset://bot/../profiles.png',
      'marimo-asset://bot/%2e%2e%2fprofiles.png',
      'marimo-asset://bot/a%2Fb.png',
      'marimo-asset://other/bot.png',
      'marimo-asset://bot/bot.png.txt',
      'https://bot/agent.png',
      'not a url',
    ]) {
      expect(botAvatarProfileIdFromUrl(url)).toBeUndefined();
    }
  });

  it('refuses an id with a separator after decoding', () => {
    expect(
      botAvatarProfileIdFromUrl('marimo-asset://bot/a%5Cb.png'),
    ).toBeUndefined();
  });
});

describe('avatarTargetSize', () => {
  it('scales the longest side to the cap and keeps the ratio', () => {
    expect(avatarTargetSize(1024, 512)).toEqual({width: 512, height: 256});
    expect(avatarTargetSize(512, 1024)).toEqual({width: 256, height: 512});
    expect(avatarTargetSize(1024, 1024)).toEqual({width: 512, height: 512});
  });

  it('never upscales a small icon', () => {
    expect(avatarTargetSize(64, 48)).toEqual({width: 64, height: 48});
    expect(avatarTargetSize(1, 1)).toEqual({width: 1, height: 1});
  });

  it('has a defined answer for a malformed size', () => {
    expect(avatarTargetSize(0, 0)).toEqual({width: 1, height: 1});
    expect(avatarTargetSize(-1, 100)).toEqual({width: 1, height: 1});
  });
});

describe('the upload limits', () => {
  it('caps a decoded image at a size the rail can draw', () => {
    expect(MAX_AVATAR_EDGE).toBe(512);
    expect(MAX_AVATAR_BYTES).toBeGreaterThan(0);
  });
});

describe('uploadBotAvatar', () => {
  it('writes one PNG for the bot and answers that it changed', async () => {
    const dir = await mkdtemp(join(process.cwd(), '.marimo-avatar-'));
    try {
      const source = join(dir, 'source.jpg');
      await writeFile(source, 'not really a jpeg', 'utf8');
      const image = {
        isEmpty: () => false,
        getSize: () => ({width: 1024, height: 512}),
        resize: vi.fn(() => image),
        toPNG: () => Buffer.from('one png', 'utf8'),
      };
      vi.mocked(dialog.showOpenDialog).mockResolvedValue({
        canceled: false,
        filePaths: [source],
      } as never);
      vi.mocked(nativeImage.createFromBuffer).mockReturnValue(image as never);

      const changed = await uploadBotAvatar(join(dir, 'avatars'), 'Bot.Id');

      expect(changed).toBe(true);
      expect(await readFile(join(dir, 'avatars', 'bot.id.png'), 'utf8')).toBe(
        'one png',
      );
      // The aspect ratio is preserved rather than stretched to a square.
      expect(image.resize).toHaveBeenCalledWith({
        width: 512,
        height: 256,
        quality: 'best',
      });
    } finally {
      await rm(dir, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 20,
      });
    }
  });

  it('answers false when the picker is closed, and writes nothing', async () => {
    const dir = await mkdtemp(join(process.cwd(), '.marimo-avatar-'));
    try {
      vi.mocked(dialog.showOpenDialog).mockResolvedValue({
        canceled: true,
        filePaths: [],
      } as never);

      await expect(uploadBotAvatar(join(dir, 'avatars'), 'bot')).resolves.toBe(
        false,
      );
      await expect(
        readFile(join(dir, 'avatars', 'bot.png'), 'utf8'),
      ).rejects.toThrow();
    } finally {
      await rm(dir, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 20,
      });
    }
  });
});
