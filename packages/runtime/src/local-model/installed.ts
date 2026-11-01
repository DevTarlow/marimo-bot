/**
 * What is actually on disk for one model.
 *
 * The installer writes a marker only after every file has been verified, and the
 * host reads the marker before it reads a single byte of weights. That order is
 * the whole safety story: a half-written file is not "installed" because a
 * directory exists, and a copy of the wrong quantization is not "installed"
 * because a file of the right size exists under a different name.
 *
 * The check is deliberately cheap — a stat per file, not a re-hash — because it
 * runs on every settings read. A digest is checked once, when the file is
 * downloaded; a file that is the right size and was verified then is a file this
 * app put there. A corruption that keeps the size is the engine's own failure to
 * report, with its log in the card.
 */
import {readFile, rename, stat, writeFile} from 'node:fs/promises';
import {join} from 'node:path';

import type {LocalModelId, LocalModelPart, LocalModelVariant} from '@marimo/protocol';

import {engineBinaryName, engineDir, localModelMarkerFile} from './files.js';
import {defaultVariantFor} from './chat-pins.js';
import type {ChatModelFilePin, ChatModelManifest} from './manifest.js';

export interface LocalModelMarkerFile {
  name: string;
  sha256: string;
  bytes: number;
}

/**
 * What one installed copy records.
 *
 * `revision` is here so a build that moves a model to a new commit re-downloads
 * it rather than running yesterday's weights under today's name.
 */
export interface LocalModelMarker {
  modelId: LocalModelId;
  variant: LocalModelVariant;
  revision: string;
  files: LocalModelMarkerFile[];
}

/** The marker, or undefined when there is none or it is not this shape. */
export async function readLocalModelMarker(
  dir: string,
): Promise<LocalModelMarker | undefined> {
  try {
    const raw: unknown = JSON.parse(
      await readFile(localModelMarkerFile(dir), 'utf8'),
    );
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      return undefined;
    }
    const record = raw as Record<string, unknown>;
    if (
      typeof record['modelId'] !== 'string' ||
      (record['variant'] !== 'q8' && record['variant'] !== 'q4') ||
      typeof record['revision'] !== 'string' ||
      !Array.isArray(record['files'])
    ) {
      return undefined;
    }
    const files: LocalModelMarkerFile[] = [];
    for (const entry of record['files']) {
      if (entry === null || typeof entry !== 'object') {
        return undefined;
      }
      const file = entry as Record<string, unknown>;
      if (
        typeof file['name'] !== 'string' ||
        typeof file['sha256'] !== 'string' ||
        typeof file['bytes'] !== 'number'
      ) {
        return undefined;
      }
      files.push({
        name: file['name'],
        sha256: file['sha256'],
        bytes: file['bytes'],
      });
    }
    return {
      modelId: record['modelId'] as LocalModelId,
      variant: record['variant'],
      revision: record['revision'],
      files,
    };
  } catch {
    return undefined;
  }
}

/** Writes the marker atomically, so a crash cannot leave half of it. */
export async function writeLocalModelMarker(
  dir: string,
  marker: LocalModelMarker,
): Promise<void> {
  const file = localModelMarkerFile(dir);
  const temporary = `${file}.tmp`;
  await writeFile(temporary, `${JSON.stringify(marker, null, 2)}\n`, 'utf8');
  await rename(temporary, file);
}

/**
 * What one model's directory and the shared engine look like right now.
 *
 * `missing` is what a download button should fetch, in the order the installer
 * fetches it. The engine is first because a platform with no engine should be
 * refused before 1.9GB is spent on weights.
 */
export interface LocalModelDiskState {
  installed: boolean;
  variant: LocalModelVariant;
  enginePresent: boolean;
  weightsPresent: boolean;
  projectorPresent: boolean;
  missing: LocalModelPart[];
}

export async function localModelOnDisk(options: {
  root: string;
  manifest: ChatModelManifest;
  modelId: LocalModelId;
  platform?: NodeJS.Platform;
}): Promise<LocalModelDiskState> {
  const {root, manifest, modelId} = options;
  const enginePresent = await isFile(
    join(engineDir(root), engineBinaryName(options.platform)),
  );
  const dir = join(root, modelId);
  const marker = await readLocalModelMarker(dir);
  const variant =
    marker !== undefined && (marker.variant === 'q8' || marker.variant === 'q4')
      ? marker.variant
      : defaultVariantFor(modelId);
  const pin = manifest.models[modelId];

  const weights = pin.variants[variant].weights;
  const projector = pin.variants[variant].projector;

  const markerMatches =
    marker !== undefined &&
    marker.modelId === modelId &&
    marker.revision === pin.revision &&
    markerFilesMatch(marker.files, weights, projector);

  const weightsPresent =
    markerMatches && (await sizeMatches(join(dir, weights.file), weights));
  const projectorPresent =
    projector === undefined
      ? true
      : markerMatches &&
        (await sizeMatches(join(dir, projector.file), projector));

  const missing: LocalModelPart[] = [];
  if (!enginePresent) {
    missing.push('engine');
  }
  if (!weightsPresent) {
    missing.push('weights');
  }
  if (!projectorPresent) {
    missing.push('projector');
  }

  return {
    installed: missing.length === 0,
    variant,
    enginePresent,
    weightsPresent,
    projectorPresent,
    missing,
  };
}

function markerFilesMatch(
  files: readonly LocalModelMarkerFile[],
  weights: ChatModelFilePin,
  projector: ChatModelFilePin | undefined,
): boolean {
  const expected = [weights, ...(projector === undefined ? [] : [projector])];
  if (files.length !== expected.length) {
    return false;
  }
  return expected.every((pin) =>
    files.some(
      (file) =>
        file.name === pin.file &&
        file.sha256 === pin.sha256 &&
        file.bytes === pin.bytes,
    ),
  );
}

async function sizeMatches(
  file: string,
  pin: ChatModelFilePin,
): Promise<boolean> {
  try {
    return (await stat(file)).size === pin.bytes;
  } catch {
    return false;
  }
}

async function isFile(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}
