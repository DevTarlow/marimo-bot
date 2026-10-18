import {isAbsolute, join, relative} from 'node:path';

import {describe, expect, it} from 'vitest';

import {
  avatarFile,
  avatarFileName,
  DEFAULT_SPACE_FOLDER,
  resolveAppPaths,
  secretFile,
  secretFileName,
} from './paths.js';

describe('resolveAppPaths', () => {
  const paths = resolveAppPaths('/data/marimo-agent', {home: '/home/someone'});

  it('keeps every location under the directory it was given', () => {
    for (const value of [
      paths.sessions,
      paths.settings,
      paths.secretsDir,
      paths.profiles,
      paths.avatars,
      paths.jobs,
      paths.skills,
      paths.personMemoryDir,
      paths.feedback,
    ]) {
      expect(isAbsolute(value)).toBe(true);
      expect(relative(paths.userData, value).startsWith('..')).toBe(false);
    }
  });

  /*
   * The one folder that is deliberately not under user data. A reset erases the
   * app's directory and must leave a Space alone, because a Space's files are the
   * person's — so the starting folder being derived from home rather than from
   * `userData` is a safety property, not a layout preference.
   */
  it('puts the starting folder in the home directory, not in its data folder', () => {
    expect(paths.defaultWorkspace).toBe(
      join('/home/someone', DEFAULT_SPACE_FOLDER),
    );
    expect(paths.defaultWorkspace).not.toBe('/home/someone');
    expect(
      relative(paths.userData, paths.defaultWorkspace).startsWith('..'),
    ).toBe(true);
  });

  it('remembers the folder a fresh install used to be seeded with', () => {
    // The old default was the home directory itself; the upgrade reads this to
    // recognise the folder an older build wrote.
    expect(paths.formerDefaultWorkspace).toBe('/home/someone');
  });

  /*
   * The person half of memory lives under user data rather than under a
   * workspace, and that is the point of the split: it has to still be there when
   * the user points the app at another folder. Asserting the name keeps a later
   * tidy-up from folding it back in beside `jobs.json`.
   */
  it('puts the person-level memory under user data, not in a folder', () => {
    expect(paths.personMemoryDir).toBe(join('/data/marimo-agent', 'memory'));
  });

  it('keeps what the user said about an answer beside the rest of the state', () => {
    expect(paths.feedback).toBe(join('/data/marimo-agent', 'feedback.json'));
  });

  it('resolves from the argument rather than from the environment', () => {
    // Two calls with different roots must not share anything: this is what lets
    // the app and the headless runner point at the same directory deliberately,
    // and at a throwaway one in a test.
    const other = resolveAppPaths('/tmp/elsewhere');
    expect(other.jobs).toBe(join('/tmp/elsewhere', 'jobs.json'));
    expect(other.jobs).not.toBe(paths.jobs);
  });
});

describe('secretFileName', () => {
  it('keeps an ordinary name readable', () => {
    expect(secretFileName('deepseek')).toBe('deepseek.bin');
    expect(secretFileName('mcp:notes')).toBe('mcp-notes.bin');
  });

  /*
   * A connector name is the one part of a secret path a user types, so it is the
   * one part that can try to leave the directory.
   */
  it('cannot be walked out of the secrets directory', () => {
    for (const hostile of [
      '../../etc/passwd',
      '..',
      '/etc/shadow',
      'a/../../b',
      '....//....//x',
    ]) {
      const name = secretFileName(hostile);
      expect(name).not.toContain('/');
      expect(name).not.toContain('\\');
      expect(name.startsWith('.')).toBe(false);
      expect(relative('/data/secrets', join('/data/secrets', name))).toBe(name);
    }
  });

  it('falls back to a real file name when nothing survives', () => {
    expect(secretFileName('///')).toBe('secret.bin');
    expect(secretFileName('')).toBe('secret.bin');
    expect(secretFileName('..')).toBe('secret.bin');
  });

  it('bounds the length so a long name cannot break the path', () => {
    expect(secretFileName('a'.repeat(500)).length).toBeLessThanOrEqual(84);
  });

  it('folds case, because a case-insensitive filesystem would fold it anyway', () => {
    // The folding has to be deliberate rather than left to the filesystem: on
    // macOS and Windows `Notes.bin` and `notes.bin` are one file, so a name that
    // is only distinguished by case would silently share a secret with another.
    expect(secretFileName('Notes')).toBe(secretFileName('notes'));
    expect(secretFileName('DISCORD')).toBe('discord.bin');
  });

  it('keeps distinct safe characters distinct', () => {
    // `.` and `-` both survive sanitising, and they are not the same character.
    // Folding them together would be a collision invented for no reason.
    expect(secretFileName('my.server')).toBe('my.server.bin');
    expect(secretFileName('my-server')).toBe('my-server.bin');
  });
});

describe('avatarFileName', () => {
  it('turns a profile id into one PNG name', () => {
    expect(avatarFileName('6f7c4f5a-3a1b-4c9d-8e2f-1a2b3c4d5e6f')).toBe(
      '6f7c4f5a-3a1b-4c9d-8e2f-1a2b3c4d5e6f.png',
    );
  });

  it('cannot be walked out of the avatars directory', () => {
    for (const hostile of [
      '../../etc/passwd',
      '..',
      '/etc/shadow',
      'a/../../b',
      '....//....//x',
      'with spaces',
    ]) {
      const file = avatarFile(resolveAppPaths('/data/marimo-agent'), hostile);
      expect(file.startsWith('/data/marimo-agent/avatars/')).toBe(true);
      expect(file).not.toContain('/../');
      expect(file.endsWith('.png')).toBe(true);
    }
  });

  it('falls back to a real name when nothing survives', () => {
    expect(avatarFileName('///')).toBe('bot.png');
    expect(avatarFileName('')).toBe('bot.png');
    expect(avatarFileName('..')).toBe('bot.png');
  });
});

describe('secretFile', () => {
  it('puts a connector secret beside the provider keys', () => {
    const paths = resolveAppPaths('/data/marimo-agent');
    const file = secretFile(paths, 'mcp:notes');
    expect(relative(paths.secretsDir, file)).toBe('mcp-notes.bin');
  });
});
