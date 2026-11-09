/**
 * Talking to the app window over the DevTools protocol.
 *
 * Two scripts drive the real window now — the smoke check and the live
 * journeys — and both need the same request/answer plumbing and the same
 * "wait until it happens" loop. One implementation, so a protocol change does
 * not leave one of them speaking an older dialect. `app-process.mjs` owns the
 * process; this owns the socket.
 *
 * No dependencies: Node 22 ships a WebSocket client, which is what lets the
 * checks speak the protocol directly rather than through a driver package that
 * has to be kept current for a script that must not itself rot.
 */

/** The default wait when a caller does not name one. */
const DEFAULT_WAIT_MS = 45_000;

/** Waits for something, or gives up. */
export async function until(
  what,
  attempt,
  {everyMs = 250, withinMs = DEFAULT_WAIT_MS} = {},
) {
  const deadline = Date.now() + withinMs;
  let last;
  while (Date.now() < deadline) {
    try {
      const value = await attempt();
      if (value !== undefined) {
        return value;
      }
    } catch (error) {
      last = error;
    }
    await new Promise((resolve) => setTimeout(resolve, everyMs));
  }
  throw new Error(
    `timed out waiting for ${what}${last ? `: ${last.message}` : ''}`,
  );
}

/**
 * The request/answer side of the socket, plus the page's console.
 *
 * `send` has a ten-second deadline of its own: a DevTools call that never
 * answers is a dead socket, and waiting for the outer timeout would turn it
 * into "the app did not do the thing" rather than "the debugger hung".
 */
export async function attach(socket) {
  let nextId = 1;
  const pending = new Map();
  const console = [];

  socket.addEventListener('message', (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }

    if (message.method === 'Runtime.consoleAPICalled') {
      const level = message.params?.type ?? 'log';
      const text = (message.params?.args ?? [])
        .map((arg) => arg?.value ?? arg?.description ?? '')
        .join(' ');
      if (text.length > 0) {
        console.push(`${level}: ${text}`);
      }
      return;
    }

    const entry = pending.get(message.id);
    if (entry === undefined) {
      return;
    }
    pending.delete(message.id);
    if (message.error) {
      entry.reject(new Error(message.error.message));
    } else {
      entry.resolve(message.result);
    }
  });

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, {resolve, reject});
      socket.send(JSON.stringify({id, method, params}));
      setTimeout(() => {
        if (pending.delete(id)) {
          reject(new Error(`${method} did not answer within 10s`));
        }
      }, 10_000);
    });

  // Asks for the console stream before anything else, so a complaint made
  // during startup is not missed by being early.
  await send('Runtime.enable');

  return {send, console};
}
