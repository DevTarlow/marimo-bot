/**
 * Harness versions: what makes a turn reproducible and a change reversible.
 *
 * A version is a resolved `HarnessSpec` plus the fingerprint of its parent. The
 * hash is over canonical JSON, so two specs that differ only in key order are
 * the same version, and a spec that changes in any way is a different one. The
 * chain is what the Learning screen rolls back along; nothing else mutates a
 * stored version.
 */
import {createHash} from 'node:crypto';

import {z} from 'zod';

import {harnessSpecSchema} from './spec.js';
import type {HarnessSpec} from './spec.js';

/**
 * A JSON encoding that does not depend on property insertion order.
 *
 * `JSON.stringify` preserves insertion order, and two objects built by two code
 * paths can carry the same fields in a different order. Hashing that difference
 * would make a no-op edit look like a new version.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => sortValue(entry));
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      const entry = record[key];
      if (entry !== undefined) {
        sorted[key] = sortValue(entry);
      }
    }
    return sorted;
  }
  return value;
}

/** The canonical fingerprint of a resolved spec. */
export function harnessHash(spec: HarnessSpec): string {
  return createHash('sha256').update(canonicalJson(spec)).digest('hex');
}

export const harnessVersionSchema = z.object({
  profileId: z.string().min(1),
  version: z.number().int().positive(),
  /** The version this one was edited from; absent only for version 1. */
  parent: z.number().int().positive().optional(),
  hash: z.string().regex(/^[a-f0-9]{64}$/),
  spec: harnessSpecSchema,
  createdAt: z.string().min(1),
  reason: z.string().min(1),
});

export type HarnessVersion = z.infer<typeof harnessVersionSchema>;

export class HarnessVersionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HarnessVersionError';
  }
}

/**
 * Checks that a version is the direct child of the one before it.
 *
 * The checks are deliberately redundant with the store's own: a version file
 * can be hand-edited, copied between machines or restored from a backup, and
 * the chain is only useful if a broken link is refused rather than displayed.
 */
export function assertHarnessVersion(
  previous: HarnessVersion | undefined,
  next: HarnessVersion,
): HarnessVersion {
  const actualHash = harnessHash(next.spec);
  if (actualHash !== next.hash) {
    throw new HarnessVersionError(
      `Harness version ${next.version} does not match its own hash.`,
    );
  }
  if (next.spec.version !== next.version) {
    throw new HarnessVersionError(
      `Harness version ${next.version} carries a spec for version ${next.spec.version}.`,
    );
  }
  if (previous === undefined) {
    if (next.version !== 1 || next.parent !== undefined) {
      throw new HarnessVersionError(
        'The first harness version must be version 1 with no parent.',
      );
    }
    return next;
  }
  if (next.profileId !== previous.profileId) {
    throw new HarnessVersionError(
      'A harness version cannot be attached to a different profile.',
    );
  }
  if (next.version !== previous.version + 1) {
    throw new HarnessVersionError(
      `Expected harness version ${previous.version + 1}, got ${next.version}.`,
    );
  }
  if (next.parent !== previous.version) {
    throw new HarnessVersionError(
      `Harness version ${next.version} names parent ${next.parent ?? 'none'}, not ${previous.version}.`,
    );
  }
  return next;
}

/**
 * Builds the next version in a chain.
 *
 * The caller owns the spec; this owns the invariants around it. `now` is an
 * argument so a test can name the timestamp rather than match a pattern.
 */
export function nextHarnessVersion(params: {
  previous?: HarnessVersion;
  spec: HarnessSpec;
  reason: string;
  now?: Date;
}): HarnessVersion {
  const version = (params.previous?.version ?? 0) + 1;
  const spec: HarnessSpec = {...params.spec, version};
  const candidate: HarnessVersion = {
    profileId: spec.id,
    version,
    ...(params.previous === undefined ? {} : {parent: params.previous.version}),
    hash: harnessHash(spec),
    spec,
    createdAt: (params.now ?? new Date()).toISOString(),
    reason: params.reason,
  };
  return assertHarnessVersion(params.previous, candidate);
}
