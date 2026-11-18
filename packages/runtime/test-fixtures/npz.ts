/**
 * Tiny NPZ/NumPy fixtures for the speech tests.
 *
 * The real voice pack is a 5.7 MB download, so the reader is tested against a
 * hand-built archive with the same two shapes it actually meets: a ZIP of
 * `.npy` entries, stored or deflated, holding little-endian float32 arrays.
 * This file is outside `src` on purpose: it is test data, not something the
 * package ships.
 */
import {deflateRawSync} from 'node:zlib';

/** One `.npy` array, written the way NumPy writes a `<f4` C-order array. */
export function npyFloat32(values: readonly number[], shape: number[]): Buffer {
  const header = `{'descr': '<f4', 'fortran_order': False, 'shape': (${shape.join(
    ', ',
  )}${shape.length === 1 ? ',' : ''}), }`;
  const base = Buffer.from(header, 'latin1');
  const padding = (64 - ((10 + base.length + 1) % 64)) % 64;
  const headerBytes = Buffer.concat([
    base,
    Buffer.from(`${' '.repeat(padding)}\n`, 'latin1'),
  ]);
  const prefix = Buffer.alloc(10);
  prefix.write('\x93NUMPY', 0, 'latin1');
  prefix[6] = 1;
  prefix[7] = 0;
  prefix.writeUInt16LE(headerBytes.length, 8);
  const data = Buffer.alloc(values.length * 4);
  for (const [index, value] of values.entries()) {
    data.writeFloatLE(value, index * 4);
  }
  return Buffer.concat([prefix, headerBytes, data]);
}

/** One entry of the archive. */
export interface ZipEntry {
  name: string;
  data: Buffer;
  /** Stored (0) by default; 8 writes deflated data. */
  method?: 0 | 8;
}

/**
 * A ZIP with the local headers, central directory and end record a reader
 * needs. The timestamps and CRC are zero: nothing here verifies them.
 */
export function zip(entries: readonly ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const method = entry.method ?? 0;
    const payload = method === 8 ? deflateRawSync(entry.data) : entry.data;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    const localOffset = offset;
    const localBytes = Buffer.concat([local, name, payload]);
    locals.push(localBytes);
    offset += localBytes.length;

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(0, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(localOffset, 42);
    centrals.push(Buffer.concat([central, name]));
  }
  const centralBytes = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, centralBytes, end]);
}
