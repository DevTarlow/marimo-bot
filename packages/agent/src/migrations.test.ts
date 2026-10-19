import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {afterEach, beforeEach, describe, expect, it} from 'vitest';

import {
  assertWritable,
  DocumentTooNewError,
  readVersionedDocument,
} from './migrations.js';
import type {DocumentMigration} from './migrations.js';

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'marimo-migrations-'));
  file = join(dir, 'document.json');
});

afterEach(async () => {
  await rm(dir, {recursive: true, force: true, maxRetries: 5, retryDelay: 20});
});

async function write(value: unknown): Promise<void> {
  await writeFile(file, JSON.stringify(value), 'utf8');
}

const LABEL = 'The jobs file';

/*
 * The three cases below are the whole point of the module, so they are named
 * after the outcomes rather than the inputs: a bug here is a user losing data,
 * not a function returning the wrong enum.
 */
describe('reading a versioned document', () => {
  it('reports a missing file as absent rather than as an error', async () => {
    const read = await readVersionedDocument(file, {label: LABEL});
    expect(read.state).toBe('absent');
  });

  it('reports an empty file as absent, because that is a fresh install', async () => {
    await writeFile(file, '\n  \n', 'utf8');
    const read = await readVersionedDocument(file, {label: LABEL});
    expect(read.state).toBe('absent');
  });

  it('reports unparseable JSON as unreadable, naming the file', async () => {
    await writeFile(file, '{not json', 'utf8');
    const read = await readVersionedDocument(file, {label: LABEL});
    expect(read.state).toBe('unreadable');
    if (read.state === 'unreadable') {
      expect(read.reason).toContain(LABEL);
    }
  });

  it('refuses a document that is not an object', async () => {
    await write('[1, 2, 3]');
    const read = await readVersionedDocument(file, {label: LABEL});
    expect(read.state).toBe('unreadable');
  });

  it('refuses a document with no version rather than guessing version 1', async () => {
    await write({jobs: []});
    const read = await readVersionedDocument(file, {label: LABEL});
    expect(read.state).toBe('unreadable');
    if (read.state === 'unreadable') {
      expect(read.reason).toContain('version');
    }
  });

  it('returns the document unchanged when the version is current', async () => {
    await write({version: 1, jobs: [{id: 'a'}]});
    const read = await readVersionedDocument(file, {label: LABEL});
    expect(read.state).toBe('current');
    if (read.state === 'current') {
      expect(read.document['jobs']).toEqual([{id: 'a'}]);
    }
  });

  /*
   * The case that made this module necessary. Before it existed, the store's
   * `safeParse` failed on this file and returned an empty document — so the user
   * saw their jobs disappear, and the next write made it true on disk.
   */
  it('refuses to downgrade a document written by a newer build', async () => {
    await write({version: 7, jobs: [{id: 'a'}]});
    const read = await readVersionedDocument(file, {label: LABEL});
    expect(read.state).toBe('too-new');
    if (read.state === 'too-new') {
      expect(read.found).toBe(7);
      expect(read.supported).toBe(1);
    }
  });

  it('upgrades an older document and stamps the current version', async () => {
    const migrations: DocumentMigration[] = [
      {
        from: 1,
        to: 2,
        summary: 'renamed `schedule` to `schedules`',
        migrate: (document) => {
          const {schedule, ...rest} = document;
          return {...rest, schedules: [schedule]};
        },
      },
    ];

    await write({version: 1, schedule: '0 9 * * *'});
    const read = await readVersionedDocument(file, {
      label: LABEL,
      migrations,
      current: 2,
    });

    expect(read.state).toBe('migrated');
    if (read.state === 'migrated') {
      expect(read.from).toBe(1);
      expect(read.steps).toEqual(['renamed `schedule` to `schedules`']);
      expect(read.document['schedules']).toEqual(['0 9 * * *']);
      expect(read.document['version']).toBe(2);
    }
  });

  it('applies steps in order when several versions are behind', async () => {
    const migrations: DocumentMigration[] = [
      {from: 1, to: 2, summary: 'one', migrate: (d) => ({...d, one: true})},
      {from: 2, to: 3, summary: 'two', migrate: (d) => ({...d, two: true})},
    ];

    await write({version: 1});
    const read = await readVersionedDocument(file, {
      label: LABEL,
      migrations,
      current: 3,
    });

    expect(read.state).toBe('migrated');
    if (read.state === 'migrated') {
      expect(read.steps).toEqual(['one', 'two']);
      expect(read.document).toMatchObject({one: true, two: true, version: 3});
    }
  });

  it('reports unreadable when a step is missing rather than guessing', async () => {
    await write({version: 1});
    const read = await readVersionedDocument(file, {
      label: LABEL,
      migrations: [],
      current: 2,
    });
    expect(read.state).toBe('unreadable');
  });
});

describe('assertWritable', () => {
  it('lets a current document through', async () => {
    await write({version: 1, jobs: []});
    await expect(assertWritable(file, {label: LABEL})).resolves.toBeUndefined();
  });

  it('lets a missing file through, because that is a first write', async () => {
    await expect(assertWritable(file, {label: LABEL})).resolves.toBeUndefined();
  });

  it('throws a typed error rather than overwriting a newer document', async () => {
    await write({version: 4, jobs: [{id: 'kept'}]});

    await expect(assertWritable(file, {label: LABEL})).rejects.toBeInstanceOf(
      DocumentTooNewError,
    );

    // The file is the point: refusing is only useful if it leaves it alone.
    const raw = await readVersionedDocument(file, {label: LABEL});
    expect(raw.state).toBe('too-new');
  });

  it('names the app in the message, because a user reads it', async () => {
    await write({version: 4});
    await expect(assertWritable(file, {label: LABEL})).rejects.toThrow(
      /newer version of Marimo Bot/u,
    );
  });
});
