/**
 * Whether this machine can run the opt-in CUDA engine.
 *
 * CUDA is not a free choice: the pinned build is tied to a CUDA version, and a
 * driver older than that version fails at process start with a message about a
 * missing symbol rather than about the engine. The probe answers before the
 * Models card offers the switch, so a user is not invited to download 776 MB
 * for an engine their driver cannot load.
 *
 * `nvidia-smi` is the one program every NVIDIA driver installs on Linux and
 * Windows, and it is already the thing a user checks. The probe uses it rather
 * than a Vulkan or Electron query because the runtime also runs in the headless
 * runner, where there is no Electron.
 */
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

const run = promisify(execFile);

export interface CudaSupport {
  available: boolean;
  /** The card `nvidia-smi` named, when it answered. */
  device?: string;
  /** The installed driver, when it answered. */
  driver?: string;
  /** Why CUDA is not being offered, when it is not. */
  reason?: string;
}

/**
 * The oldest driver each pinned CUDA build runs on.
 *
 * Linux is CUDA 12.8 (570.65); Windows is CUDA 12.4 (550.54). A driver below
 * the floor can still run Vulkan, so the fallback is a smaller download rather
 * than a broken app.
 */
const MINIMUM_DRIVER: Partial<
  Record<NodeJS.Platform, readonly [number, number]>
> = {
  linux: [570, 65],
  win32: [550, 54],
};

export interface CudaProbeOptions {
  platform?: NodeJS.Platform;
  arch?: string;
  /** Injectable for tests, which must not spawn `nvidia-smi`. */
  execFileImpl?: (
    file: string,
    args: string[],
  ) => Promise<{stdout: string; stderr: string}>;
}

export async function probeCuda(
  options: CudaProbeOptions = {},
): Promise<CudaSupport> {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const minimum = MINIMUM_DRIVER[platform];
  if (minimum === undefined || arch !== 'x64') {
    return {
      available: false,
      reason:
        'CUDA is published for 64-bit Linux and Windows; this machine uses ' +
        'the default graphics engine.',
    };
  }

  try {
    const exec =
      options.execFileImpl ??
      (async (file, args) => {
        const result = await run(file, args, {
          timeout: 2_500,
          maxBuffer: 64 * 1024,
          windowsHide: true,
        });
        return {
          stdout: String(result.stdout),
          stderr: String(result.stderr),
        };
      });
    /*
     * `nvidia-smi` is on PATH for a desktop session, but the headless runner is
     * started by a service manager and may have a smaller PATH. The absolute
     * locations are the ones the driver installs, and trying them costs nothing
     * when the first answer is already there.
     */
    const candidates =
      platform === 'win32'
        ? [
            'nvidia-smi',
            'C:\\Program Files\\NVIDIA Corporation\\NVSMI\\nvidia-smi.exe',
          ]
        : ['nvidia-smi', '/usr/bin/nvidia-smi', '/usr/local/bin/nvidia-smi'];
    let stdout: string | undefined;
    let lastFailure: unknown;
    for (const command of candidates) {
      try {
        ({stdout} = await exec(command, [
          '--query-gpu=name,driver_version',
          '--format=csv,noheader',
        ]));
        break;
      } catch (failure) {
        lastFailure = failure;
      }
    }
    if (stdout === undefined) {
      throw lastFailure ?? new Error('nvidia-smi did not answer.');
    }
    const line = stdout
      .split('\n')
      .map((value) => value.trim())
      .find((value) => value.length > 0);
    if (line === undefined) {
      return {
        available: false,
        reason: 'nvidia-smi answered without naming a GPU.',
      };
    }

    const comma = line.lastIndexOf(',');
    if (comma < 0) {
      return {
        available: false,
        reason: `nvidia-smi returned a line this app could not read: ${line}`,
      };
    }
    const device = line.slice(0, comma).trim();
    const driver = line.slice(comma + 1).trim();
    const version = parseDriver(driver);
    if (version === undefined) {
      return {
        available: false,
        device,
        driver,
        reason: `The NVIDIA driver version "${driver}" could not be read.`,
      };
    }
    if (
      version[0] < minimum[0] ||
      (version[0] === minimum[0] && version[1] < minimum[1])
    ) {
      return {
        available: false,
        device,
        driver,
        reason:
          `The NVIDIA driver ${driver} is older than CUDA ` +
          `${platform === 'win32' ? '12.4' : '12.8'} needs ` +
          `(${String(minimum[0])}.${String(minimum[1])}). Update the driver, ` +
          'or keep using the default graphics engine.',
      };
    }

    return {available: true, device, driver};
  } catch {
    return {
      available: false,
      reason:
        'No NVIDIA GPU answered. CUDA needs the NVIDIA driver and nvidia-smi; ' +
        'the default graphics engine still works.',
    };
  }
}

function parseDriver(value: string): readonly [number, number] | undefined {
  const match = /^(\d+)\.(\d+)/u.exec(value);
  if (match === null) {
    return undefined;
  }
  return [Number(match[1]), Number(match[2])];
}
