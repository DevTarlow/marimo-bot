/**
 * The voice packs are NumPy `.npz` files: one ZIP archive of `.npy` arrays.
 *
 * Nothing else in the app reads a ZIP, and the only two formats inside are the
 * ones NumPy writes by default — little-endian float32, C order. So this is a
 * reader for exactly that, not a general archive library: the central directory
 * is used for the sizes (a writer may stream and leave them in a data
 * descriptor), the local header for where the bytes start, and `zlib` for the
 * deflated case.
 *
 * The file is read at start-up of a reply, never during one. A malformed voice
 * pack is a sentence at the download/status boundary, not a click in the middle
 * of a word.
 */
import {inflateRawSync} from 'node:zlib';

/** One array: its dimensions and its float32 values. */
export interface NpyArray {
  shape: number[];
  data: Float32Array;
}

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

/**
 * Every array in an `.npz`, keyed by the name NumPy stored.
 *
 * `Buffer` rather than `Uint8Array` because the caller reads a file, and a
 * subarray of the file's buffer is what the reader slices; copying is limited
 * to the one array that has to be aligned for `Float32Array`.
 */
export function readNpz(buffer: Buffer): Map<string, NpyArray> {
  const entries = new Map<string, NpyArray>();
  const eocd = findEndOfCentralDirectory(buffer);
  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  for (let index = 0; index < count; index += 1) {
    if (buffer.readUInt32LE(offset) !== CENTRAL) {
      throw new Error('A voice pack has a damaged ZIP directory.');
    }
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);

    if (buffer.readUInt32LE(localOffset) !== LOCAL) {
      throw new Error(`A voice pack's entry ${name} has no local header.`);
    }
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const raw = buffer.subarray(dataStart, dataStart + compressedSize);
    let bytes: Buffer;
    if (method === 0) {
      bytes = raw;
    } else if (method === 8) {
      bytes = inflateRawSync(raw);
    } else {
      throw new Error(`A voice pack uses an unsupported ZIP method.`);
    }
    if (name.endsWith('.npy')) {
      entries.set(name.slice(0, -4), parseNpy(bytes));
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  if (entries.size === 0) {
    throw new Error('A voice pack holds no arrays.');
  }
  return entries;
}

/** The end record is last, after an optional comment of at most 64 KiB. */
function findEndOfCentralDirectory(buffer: Buffer): number {
  const earliest = Math.max(0, buffer.length - 0xffff - 22);
  for (let offset = buffer.length - 22; offset >= earliest; offset -= 1) {
    if (buffer.readUInt32LE(offset) === EOCD) {
      return offset;
    }
  }
  throw new Error(
    'The voice pack is not a ZIP archive, or it is truncated. Download it again.',
  );
}

/**
 * One `.npy`: a text header padded to a 64-byte boundary, then the values.
 *
 * The values are copied into their own buffer because a ZIP entry's bytes do
 * not necessarily start on a four-byte boundary, and a `Float32Array` over an
 * unaligned offset throws rather than reading slowly.
 */
export function parseNpy(buffer: Buffer): NpyArray {
  if (buffer.toString('latin1', 0, 6) !== '\x93NUMPY') {
    throw new Error('A voice pack holds a file that is not a NumPy array.');
  }
  const major = buffer[6];
  const headerLength =
    major === 1 ? buffer.readUInt16LE(8) : buffer.readUInt32LE(8);
  const headerStart = major === 1 ? 10 : 12;
  const header = buffer.toString(
    'latin1',
    headerStart,
    headerStart + headerLength,
  );
  const descr = /'descr':\s*'([^']+)'/u.exec(header)?.[1];
  if (descr !== '<f4') {
    throw new Error(
      `A voice pack holds a ${descr ?? 'unknown'} array; this build reads float32.`,
    );
  }
  if (/'fortran_order':\s*True/u.test(header)) {
    throw new Error('A voice pack holds a Fortran-ordered array.');
  }
  const shapeText = /'shape':\s*\(([^)]*)\)/u.exec(header)?.[1] ?? '';
  const shape = shapeText
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map(Number);
  if (shape.some((value) => !Number.isInteger(value) || value <= 0)) {
    throw new Error('A voice pack holds an array with no shape.');
  }
  const bytes = buffer.subarray(headerStart + headerLength);
  const aligned = new Uint8Array(bytes.length - (bytes.length % 4));
  aligned.set(bytes.subarray(0, aligned.length));
  return {shape, data: new Float32Array(aligned.buffer)};
}
