/**
 * Every distinct harness a turn has run under, kept by hash.
 *
 * A turn records the version and hash it started with. That is enough to know
 * *that* a turn changed, not to know what it was: a profile edit, a model swap or
 * a narrowed gate leaves only the new document behind. This ledger keeps the old
 * one, so a support report can answer "what was this bot told, and with which
 * grants" after the fact.
 *
 * The file name is the hash and the body is the whole spec. A write is
 * idempotent: the first record wins, and a second turn under the same harness
 * does not touch the file. A file this build cannot read is never overwritten —
 * it might be from a newer build, and replacing it would be the same
 * lenient-read-plus-write failure every other store guards against.
 */
import {access, mkdir, readdir, rename, writeFile} from 'node:fs/promises';
import {join} from 'node:path';

import {
  harnessHash,
  harnessSpecSchema,
  type HarnessSpec,
} from '@marimo/agent';
import {readVersionedDocument} from '@marimo/agent';

/** One harness, as it was recorded. */
export interface HarnessVersionRecord {
  hash: string;
  /** The bot's own spec version, not this file's format version. */
  harnessVersion: number;
  /** The version this one was edited from, absent on version 1. */
  parent?: number;
  /** Why the version exists, for the ledger list. */
  reason?: string;
  recordedAt: string;
  spec: HarnessSpec;
}

export interface HarnessVersionStoreOptions {
  rootDir: string;
}

const HASH = /^[a-f0-9]{64}$/u;
const FILE_FORMAT = 1;

export class HarnessVersionStore {
  constructor(private readonly options: HarnessVersionStoreOptions) {}

  /**
   * Records a spec, once per hash.
   *
   * Returns `created: false` when this exact harness was already recorded. The
   * turn does not fail if the ledger is unavailable; the caller may catch, but
   * the ledger is audit data, not the conversation.
   */
  async record(
    spec: HarnessSpec,
    details?: {parent?: number; reason?: string},
  ): Promise<{record: HarnessVersionRecord; created: boolean}> {
    const hash = harnessHash(spec);
    if (!HASH.test(hash)) {
      throw new Error('The harness hash is not a file name.');
    }
    await mkdir(this.options.rootDir, {recursive: true});
    const file = this.fileFor(hash);
    const exists = await access(file).then(
      () => true,
      () => false,
    );
    const existing = await this.read(file, hash);
    if (existing !== undefined) {
      return {record: existing, created: false};
    }
    if (exists) {
      throw new Error(
        'A harness record exists but this build cannot read it. It has been left untouched.',
      );
    }

    const record: HarnessVersionRecord = {
      hash,
      harnessVersion: spec.version,
      ...(details?.parent === undefined ? {} : {parent: details.parent}),
      ...(details?.reason === undefined ? {} : {reason: details.reason}),
      recordedAt: new Date().toISOString(),
      spec,
    };
    const body = JSON.stringify(
      {
        version: FILE_FORMAT,
        hash: record.hash,
        harnessVersion: record.harnessVersion,
        ...(record.parent === undefined ? {} : {parent: record.parent}),
        ...(record.reason === undefined ? {} : {reason: record.reason}),
        recordedAt: record.recordedAt,
        spec: record.spec,
      },
      null,
      2,
    );
    const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, `${body}\n`, {encoding: 'utf8', mode: 0o600});
    await rename(temporary, file);
    return {record, created: true};
  }

  /** The recorded harness for a hash, or `undefined` when there is none. */
  async load(hash: string): Promise<HarnessVersionRecord | undefined> {
    if (!HASH.test(hash)) {
      return undefined;
    }
    return await this.read(this.fileFor(hash), hash);
  }

  /** The newest version recorded for one bot, or undefined. */
  async latestFor(profileId: string): Promise<HarnessVersionRecord | undefined> {
    const records = await this.list();
    return records.find((record) => record.spec.id === profileId);
  }

  /** Every readable record, newest first. */
  async list(): Promise<HarnessVersionRecord[]> {
    const names = await readdir(this.options.rootDir).catch(() => [] as string[]);
    const records: HarnessVersionRecord[] = [];
    for (const name of names) {
      if (!name.endsWith('.json')) {
        continue;
      }
      const hash = name.slice(0, -'.json'.length);
      try {
        const record = await this.load(hash);
        if (record !== undefined) {
          records.push(record);
        }
      } catch {
        // One unreadable record must not hide the rest of the ledger.
      }
    }
    return records.sort((left, right) =>
      right.recordedAt.localeCompare(left.recordedAt),
    );
  }

  private fileFor(hash: string): string {
    return join(this.options.rootDir, `${hash}.json`);
  }

  private async read(
    file: string,
    expectedHash: string,
  ): Promise<HarnessVersionRecord | undefined> {
    const read = await readVersionedDocument(file, {
      label: 'The harness ledger',
      current: FILE_FORMAT,
    });
    if (read.state === 'absent') {
      return undefined;
    }
    if (read.state === 'too-new' || read.state === 'unreadable') {
      throw new Error(
        read.state === 'too-new'
          ? `A harness record was written by a newer version of Marimo Bot (format ${String(read.found)}; this build understands ${String(read.supported)}). It has been left untouched.`
          : `A harness record is unreadable: ${read.reason}`,
      );
    }
    const document = read.document;
    if (
      document['hash'] !== expectedHash ||
      typeof document['harnessVersion'] !== 'number' ||
      typeof document['recordedAt'] !== 'string' ||
      (document['parent'] !== undefined &&
        typeof document['parent'] !== 'number') ||
      (document['reason'] !== undefined && typeof document['reason'] !== 'string')
    ) {
      return undefined;
    }
    const parsed = harnessSpecSchema.safeParse(document['spec']);
    if (!parsed.success || harnessHash(parsed.data) !== expectedHash) {
      return undefined;
    }
    return {
      hash: expectedHash,
      harnessVersion: document['harnessVersion'],
      ...(document['parent'] === undefined
        ? {}
        : {parent: document['parent']}),
      ...(document['reason'] === undefined
        ? {}
        : {reason: document['reason']}),
      recordedAt: document['recordedAt'],
      spec: parsed.data,
    };
  }
}

