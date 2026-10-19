/**
 * The index on disk, and the four ways it is not the index we wrote.
 *
 * Every test here is about the difference between "there is an index" and "there
 * is something that parses". A vector file one record short, a file built by
 * another model, a file from a newer build: each of those reads as a perfectly
 * good document and produces scores attached to the wrong text, which is the
 * worst kind of wrong this feature can be. The answer to all of them is the same
 * — there is no index here, build one — and that is what is asserted.
 */
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';

import {afterEach, beforeEach, describe, expect, it} from 'vitest';

import {
  digestOf,
  emptyIndex,
  INDEX_FILE,
  INDEX_VERSION,
  indexMatchesModel,
  MEMORY_SOURCE,
  normalize,
  previewOf,
  readIndex,
  removeIndex,
  VECTORS_FILE,
  writeIndex,
} from './store.js';
import type {IndexData, IndexModel} from './store.js';

const MODEL: IndexModel = {
  repo: 'unsloth/embeddinggemma-2-GGUF',
  revision: 'rev2',
  dims: 4,
};

describe('the index files', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(process.cwd(), '.marimo-recall-store-'));
  });

  afterEach(async () => {
    await rm(dir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 20,
    });
  });

  function data(overrides: Partial<IndexData> = {}): IndexData {
    return {
      file: {
        ...emptyIndex(MODEL, new Date('2026-01-01T00:00:00.000Z')),
        count: 2,
        records: [
          {
            kind: 'text',
            path: 'src/a.ts',
            startLine: 1,
            endLine: 3,
            sha256: digestOf('one'),
          },
          {
            kind: 'memory',
            path: MEMORY_SOURCE,
            section: 'Notes',
            sha256: digestOf('two'),
          },
        ],
      },
      vectors: Float32Array.from([1, 0, 0, 0, 0, 1, 0, 0]),
      ...overrides,
    };
  }

  it('reads back exactly what it wrote', async () => {
    const written = data();
    await writeIndex(dir, written);
    const read = await readIndex(dir);

    expect(read?.file.records).toEqual(written.file.records);
    expect(read?.file.builtAt).toBe('2026-01-01T00:00:00.000Z');
    expect(Array.from(read?.vectors ?? [])).toEqual(
      Array.from(written.vectors),
    );
  });

  it('says there is no index rather than failing when there is none', async () => {
    expect(await readIndex(dir)).toBeUndefined();
  });

  /*
   * The count in `index.json` is what a reader trusts, so a vector file that does
   * not match it is the one case where a *parseable* pair of files is still
   * refused. A crash between the two writes leaves exactly this.
   */
  it('refuses a vector file that does not match the count', async () => {
    await writeIndex(dir, data());
    await writeFile(join(dir, VECTORS_FILE), Buffer.alloc(4 * 4), undefined);

    expect(await readIndex(dir)).toBeUndefined();
  });

  it('refuses an index built by another model, when it is told which to expect', async () => {
    await writeIndex(dir, data());
    const file = JSON.parse(
      await (
        await import('node:fs/promises')
      ).readFile(join(dir, INDEX_FILE), 'utf8'),
    ) as {count: number; model: {revision: string}};
    file.model.revision = 'something-else';
    await writeFile(join(dir, INDEX_FILE), JSON.stringify(file), 'utf8');

    // Readable as a document — it is only wrong relative to a model — and refused
    // the moment a caller says which model it is asking about.
    expect(await readIndex(dir)).toBeDefined();
    expect(await readIndex(dir, MODEL)).toBeUndefined();
  });

  /*
   * The one place this contradicts the rest of the app: a newer index is rebuilt
   * rather than refused, because it is a cache of things that are still on disk.
   * Nothing of the user's is in here to lose.
   */
  it('refuses a version it does not know, newer or older', async () => {
    await writeIndex(dir, data());
    const raw = JSON.parse(
      await (
        await import('node:fs/promises')
      ).readFile(join(dir, INDEX_FILE), 'utf8'),
    ) as Record<string, unknown>;
    raw['version'] = INDEX_VERSION + 1;
    await writeFile(join(dir, INDEX_FILE), JSON.stringify(raw), 'utf8');

    expect(await readIndex(dir)).toBeUndefined();
  });

  it('refuses a document whose records do not add up to its count', async () => {
    const broken = data();
    broken.file.count = 3;
    await writeIndex(dir, broken);

    expect(await readIndex(dir)).toBeUndefined();
  });

  it('compares the model by repository, revision and width', () => {
    const file = emptyIndex(MODEL);

    expect(indexMatchesModel(file, MODEL)).toBe(true);
    expect(indexMatchesModel(file, {...MODEL, dims: 768})).toBe(false);
    expect(indexMatchesModel(file, {...MODEL, revision: 'other'})).toBe(false);
  });

  it('removes both files, so Forget leaves nothing behind', async () => {
    await writeIndex(dir, data());
    await removeIndex(dir);

    expect(await readIndex(dir)).toBeUndefined();
  });
});

describe('normalize', () => {
  it('scales a vector to unit length', () => {
    const unit = normalize(Float32Array.from([3, 4, 0, 0]));

    expect(unit[0]).toBeCloseTo(0.6);
    expect(unit[1]).toBeCloseTo(0.8);
    expect(Math.hypot(...unit)).toBeCloseTo(1);
  });

  /*
   * A zero vector has no direction to preserve, and dividing by its norm would
   * put NaNs into the file the client goes to some trouble to keep them out of.
   * Every score against it is zero, which is the honest answer.
   */
  it('leaves an all-zero vector alone rather than dividing by zero', () => {
    const zeros = Float32Array.from([0, 0, 0, 0]);
    const unit = normalize(zeros);

    expect(Array.from(unit)).toEqual([0, 0, 0, 0]);
  });
});

describe('previewOf', () => {
  it('takes the first line with something on it', () => {
    expect(previewOf('\n\n  export function withRetry() {\n  return;\n}')).toBe(
      'export function withRetry() {',
    );
  });

  it('collapses whitespace, because it is drawn on one line', () => {
    expect(previewOf('title:   a    b')).toBe('title: a b');
  });

  it('cuts a very long line rather than storing a paragraph', () => {
    const preview = previewOf('x'.repeat(400));

    expect(preview.length).toBeLessThanOrEqual(161);
    expect(preview.endsWith('…')).toBe(true);
  });

  it('answers with nothing for text that has nothing on it', () => {
    expect(previewOf('\n   \n')).toBe('');
  });
});
