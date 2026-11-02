/**
 * The CUDA gate, without a GPU.
 *
 * The switch in Models is only offered when this probe says the driver can run
 * the pinned CUDA build. Getting the comparison wrong in the permissive
 * direction is a 776 MB download that ends in a process that cannot start; in
 * the restrictive direction it is a faster engine the user is never offered.
 */
import {describe, expect, it} from 'vitest';

import {probeCuda} from './cuda.js';

function answer(stdout: string): () => Promise<{
  stdout: string;
  stderr: string;
}> {
  return async () => ({stdout, stderr: ''});
}

describe('probeCuda', () => {
  it('offers CUDA for an NVIDIA card with a new enough driver', async () => {
    const support = await probeCuda({
      platform: 'linux',
      arch: 'x64',
      execFileImpl: answer('NVIDIA GeForce RTX 3060, 580.82.09\n'),
    });
    expect(support).toEqual({
      available: true,
      device: 'NVIDIA GeForce RTX 3060',
      driver: '580.82.09',
    });
  });

  it('refuses a driver below the pinned Linux CUDA floor', async () => {
    const support = await probeCuda({
      platform: 'linux',
      arch: 'x64',
      execFileImpl: answer('NVIDIA GeForce RTX 3060, 550.54.14\n'),
    });
    expect(support.available).toBe(false);
    expect(support.reason).toMatch(/570\.65/u);
    expect(support.device).toBe('NVIDIA GeForce RTX 3060');
  });

  it('accepts the Windows CUDA 12.4 floor and refuses the one below it', async () => {
    const ok = await probeCuda({
      platform: 'win32',
      arch: 'x64',
      execFileImpl: answer('NVIDIA GeForce RTX 3060, 550.54.14\n'),
    });
    expect(ok.available).toBe(true);

    const old = await probeCuda({
      platform: 'win32',
      arch: 'x64',
      execFileImpl: answer('NVIDIA GeForce RTX 3060, 550.40.07\n'),
    });
    expect(old.available).toBe(false);
  });

  it('does not offer CUDA when nvidia-smi is absent', async () => {
    const support = await probeCuda({
      platform: 'linux',
      arch: 'x64',
      execFileImpl: async () => {
        throw new Error('spawn nvidia-smi ENOENT');
      },
    });
    expect(support.available).toBe(false);
    expect(support.reason).toMatch(/No NVIDIA GPU/u);
  });

  it('does not offer CUDA on macOS or on an unsupported architecture', async () => {
    expect(
      (await probeCuda({platform: 'darwin', arch: 'arm64'})).available,
    ).toBe(false);
    expect(
      (await probeCuda({platform: 'linux', arch: 'arm64'})).available,
    ).toBe(false);
  });
});
