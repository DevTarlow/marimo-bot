/**
 * The `app.reset` call, over the real IPC entry point.
 *
 * Two things are worth a test here and neither is visible from the runtime's own
 * suite. The first is the wiring: that the window's call arrives on the app's one
 * channel, passes the schema, and reaches the callback that does the work. The
 * second is the property that makes the card a repair rather than a decoration —
 * **this call does not go through `agent()`**, so an install whose agent never
 * started, which is exactly the install somebody reaches for a reset from, can
 * still be reset.
 *
 * The deletion itself is `packages/runtime/src/reset.test.ts`, over a throwaway
 * tree. Electron is mocked because it has to be: `ipcMain.handle` is where the
 * dispatcher is registered, and capturing it is how a test calls the same
 * function the window calls.
 */
import {mkdtemp, rm} from 'node:fs/promises';
import {join} from 'node:path';

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

type Dispatch = (
  event: unknown,
  method: unknown,
  params: unknown,
) => Promise<unknown>;

/*
 * Hoisted above the imports, because the mock below needs it before any module
 * that imports Electron is evaluated.
 */
const captured = vi.hoisted(() => ({
  channel: undefined as string | undefined,
  handler: undefined as Dispatch | undefined,
}));

vi.mock('electron', () => ({
  app: {getName: () => 'Marimo Bot', getVersion: () => '0.0.0'},
  ipcMain: {
    handle: (channel: string, handler: Dispatch) => {
      captured.channel = channel;
      captured.handler = handler;
    },
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value, 'utf8'),
    decryptString: (payload: Buffer) => payload.toString('utf8'),
  },
  nativeTheme: {shouldUseDarkColors: false},
  BrowserWindow: {getFocusedWindow: () => null},
  dialog: {showOpenDialog: async () => ({canceled: true, filePaths: []})},
  shell: {openPath: async () => ''},
}));

import {IPC_CALL_CHANNEL} from '@marimo/protocol';
import {resolveAppPaths} from '@marimo/runtime';
import type {AppPaths} from '@marimo/runtime';

import {registerIpcHandler} from '../src/main/ipc.js';

describe('the app.reset call', () => {
  let dir: string;
  let paths: AppPaths;

  /** The call as the window makes it: the channel's own dispatcher. */
  async function call(params: unknown): Promise<unknown> {
    const handler = captured.handler;
    if (handler === undefined) {
      throw new Error('the IPC channel was never registered');
    }
    return await handler(undefined, 'app.reset', params);
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(process.cwd(), '.marimo-reset-ipc-'));
    paths = resolveAppPaths(dir);
  });

  afterEach(async () => {
    await rm(dir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 20,
    });
  });

  it('reaches the reset, and needs no agent to do it', async () => {
    const onReset = vi.fn(async () => undefined);
    registerIpcHandler({
      paths,
      /*
       * The install this matters for: settings unreadable enough that the agent
       * never started. A handler that went through `agent()` would throw a
       * sentence about the app not running, and the repair would be unavailable
       * exactly when it is needed.
       */
      agent: () => {
        throw new Error('the agent never started');
      },
      onReset,
    });

    expect(captured.channel).toBe(IPC_CALL_CHANNEL);
    await expect(call({})).resolves.toEqual({resetting: true});
    expect(onReset).toHaveBeenCalledTimes(1);
  });

  it('says so rather than doing nothing where there is no reset', async () => {
    registerIpcHandler({paths, agent: () => undefined});

    await expect(call({})).rejects.toThrow(/cannot reset itself/u);
  });
});
