import {describe, expect, it} from 'vitest';

import {npyFloat32, zip} from '../../test-fixtures/npz.js';
import {parseNpy, readNpz} from './npz.js';

describe('readNpz', () => {
  it('reads stored and deflated float32 arrays', () => {
    const one = npyFloat32([1, 2, 3, 4], [2, 2]);
    const two = npyFloat32([5, 6], [1, 2]);
    const archive = zip([
      {name: 'eleanor.npy', data: one},
      {name: 'martha.npy', data: two, method: 8},
    ]);
    const arrays = readNpz(archive);
    expect([...arrays.keys()].sort()).toEqual(['eleanor', 'martha']);
    expect(arrays.get('eleanor')?.shape).toEqual([2, 2]);
    expect([...(arrays.get('eleanor')?.data ?? [])]).toEqual([1, 2, 3, 4]);
    expect(arrays.get('martha')?.shape).toEqual([1, 2]);
    expect([...(arrays.get('martha')?.data ?? [])]).toEqual([5, 6]);
  });

  it('refuses something that is not an archive', () => {
    expect(() => readNpz(Buffer.from('not a zip'))).toThrow(/ZIP/u);
  });

  it('refuses an archive with no arrays', () => {
    expect(() =>
      readNpz(zip([{name: 'readme.txt', data: Buffer.from('x')}])),
    ).toThrow(/no arrays/u);
  });

  it('refuses a non-float32 array', () => {
    const npy = Buffer.from(
      "\x93NUMPY\x01\x00\x4a\x00{'descr': '<i4', 'fortran_order': False, 'shape': (2,), }      \n",
      'latin1',
    );
    expect(() => parseNpy(npy)).toThrow(/float32/u);
  });
});
