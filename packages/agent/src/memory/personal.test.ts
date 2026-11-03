/**
 * The personal details a small model cannot be trusted to write itself.
 *
 * The session this exists for had the model answer "my name is tarlow" with
 * "My name is Marimo Bot, not Tarlow": it never called `update_memory`, and the
 * prompt it saw never said the sentence was about the person. These are the
 * shapes that are unambiguous enough to write before the model answers, and the
 * rules that keep a correction from leaving both versions in memory.
 */
import {mkdir, mkdtemp, readFile, rm} from 'node:fs/promises';
import {join} from 'node:path';

import {afterEach, describe, expect, it} from 'vitest';

import {MemoryStore, resolvePersonMemoryFile} from './memory-store.js';
import {personalFactsIn, rememberPersonalDetails} from './personal.js';

const roots: string[] = [];

async function workDir(): Promise<string> {
  const dir = await mkdtemp(join(process.cwd(), '.marimo-personal-'));
  roots.push(dir);
  await mkdir(join(dir, 'space'), {recursive: true});
  return dir;
}

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((dir) =>
        rm(dir, {recursive: true, force: true, maxRetries: 5, retryDelay: 20}),
      ),
  );
});

function storeFor(dir: string): MemoryStore {
  return new MemoryStore({
    workspaceRoot: join(dir, 'space'),
    personMemoryRoot: join(dir, 'person'),
    profileId: 'marimo',
  });
}

function texts(text: string): string[] {
  return personalFactsIn(text).map((fact) => fact.text);
}

describe('personalFactsIn', () => {
  it('reads a name and drops the request attached to it', () => {
    expect(texts('my name is tarlow rember that')).toEqual([
      "The user's name is tarlow.",
    ]);
    expect(texts('my name is Tarlow, remember that')).toEqual([
      "The user's name is Tarlow.",
    ]);
  });

  it('reads two facts from one sentence', () => {
    expect(texts('my name is Tarlow and I live in Berlin')).toEqual([
      "The user's name is Tarlow.",
      'The user lives in Berlin.',
    ]);
  });

  it('reads a preferred name', () => {
    expect(texts('call me T.')).toEqual(['The user prefers to be called T.']);
  });

  it('reads an age, a birthday and a place of origin', () => {
    expect(texts("I'm 34 years old")).toEqual(['The user is 34 years old.']);
    expect(texts('my birthday is 4 May')).toEqual([
      "The user's birthday is 4 May.",
    ]);
    expect(texts("I'm from the moon")).toEqual(['The user is from the moon.']);
  });

  it('reads the people and animals in their life', () => {
    expect(texts('my dog is called Rex')).toEqual([
      "The user's dog is called Rex.",
    ]);
    expect(texts("my partner's name is Sam")).toEqual([
      "The user's partner is called Sam.",
    ]);
  });

  it('keeps a list of favourites together', () => {
    expect(
      texts(
        'my favourite games are Minecraft, Stardew Valley, and Path of Exile',
      ),
    ).toEqual([
      "The user's favourite games are Minecraft, Stardew Valley, and Path of Exile.",
    ]);
  });

  it('does not read a question or a non-answer', () => {
    expect(texts('what is my name?')).toEqual([]);
    expect(texts('my name is a secret')).toEqual([]);
    expect(texts('my name is not important')).toEqual([]);
    expect(texts('I live in here')).toEqual([]);
    expect(texts('I love Minecraft')).toEqual([]);
  });

  it('writes one fact per key and no more than five', () => {
    expect(
      texts('my name is Tarlow. I am 34 years old. I live in Berlin.'),
    ).toEqual([
      "The user's name is Tarlow.",
      'The user is 34 years old.',
      'The user lives in Berlin.',
    ]);

    expect(
      personalFactsIn(
        'my name is A. my age is not a thing. ' +
          'I am 30 years old. I live in B. I work at C. ' +
          'my dog is called D. my cat is called E. my favourite food is F.',
      ),
    ).toHaveLength(5);
  });
});

describe('rememberPersonalDetails', () => {
  it('writes the fact into the person half, before any model runs', async () => {
    const dir = await workDir();
    const memory = storeFor(dir);

    const captured = await rememberPersonalDetails(
      memory,
      'my name is tarlow rember that',
    );

    expect(captured).toEqual({written: 1, corrected: 0});
    const person = await readFile(
      resolvePersonMemoryFile(join(dir, 'person'), 'marimo'),
      'utf8',
    );
    expect(person).toContain('## About the user');
    expect(person).toContain("The user's name is tarlow.");
    // The workspace file is the project's; a fact about the person does not
    // belong there and a project that moves must not take it.
    await expect(readFile(memory.file, 'utf8')).rejects.toThrow();
  });

  it('does not add the same fact twice', async () => {
    const dir = await workDir();
    const memory = storeFor(dir);

    await rememberPersonalDetails(memory, 'my name is Tarlow');
    const again = await rememberPersonalDetails(memory, 'my name is Tarlow');

    expect(again).toEqual({written: 0, corrected: 0});
    const text = await memory.read();
    expect(text.match(/The user's name is Tarlow\./gu)).toHaveLength(1);
  });

  it('replaces a corrected fact instead of leaving both versions', async () => {
    const dir = await workDir();
    const memory = storeFor(dir);

    await rememberPersonalDetails(memory, 'my name is Tarlow');
    const corrected = await rememberPersonalDetails(
      memory,
      'actually my name is Bob',
    );

    expect(corrected).toEqual({written: 0, corrected: 1});
    const text = await memory.read();
    expect(text).toContain("The user's name is Bob.");
    expect(text).not.toContain('Tarlow');
  });

  it('removes every old copy of a fact it is correcting', async () => {
    const dir = await workDir();
    const memory = storeFor(dir);
    await memory.update({
      section: 'About the user',
      content: "The user's name is Tarlow.",
    });
    await memory.update({
      section: 'About the user',
      content: "The user's name is Tarlow!",
    });

    await rememberPersonalDetails(memory, 'my name is Bob');

    const text = await memory.read();
    expect(text).toContain("The user's name is Bob.");
    expect(text).not.toContain('Tarlow');
  });

  it('does nothing when the message holds no personal detail', async () => {
    const dir = await workDir();
    const memory = storeFor(dir);

    expect(await rememberPersonalDetails(memory, 'nice thanks!')).toEqual({
      written: 0,
      corrected: 0,
    });
    expect(await memory.read()).toBe('');
  });
});
