import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

import react from '@vitejs/plugin-react';
import {defineConfig, type Plugin} from 'vite';

const appRoot = dirname(fileURLToPath(import.meta.url));
const DEV_PORT = 5273;

/*
 * The packaged window loads the build over `file:` rather than from a server,
 * so the policy has to allow `file:` and the renderer reaches the machine only
 * through IPC — which is why the released build needs no network privileges at
 * all (`connect-src 'none'`).
 *
 * Both policies allow `marimo-asset:`, the app's own scheme for images it holds
 * on the user's behalf. It must be named here as well as registered in the main
 * process: a scheme that is privileged but absent from `img-src` is still
 * blocked, and the picture would silently fail to appear with nothing but a
 * console message to explain it.
 *
 * `media-src` is what lets a spoken reply play. The voice model returns a WAV,
 * the main process hands it back as a data URL, and without this line the
 * element is refused before any sound is made — the same silent-failure shape as
 * the missing image scheme.
 */
const BUILD_POLICY = [
  "default-src 'self' file:",
  "script-src 'self' file:",
  "style-src 'self' 'unsafe-inline' file:",
  "img-src 'self' data: blob: file: marimo-asset:",
  "media-src 'self' data: blob: file:",
  "font-src 'self' file:",
  "connect-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

/**
 * Development needs inline scripts (the React refresh preamble), inline styles,
 * and a websocket for HMR — but not `unsafe-eval`, which is the one concession
 * Electron's security check actually complains about. Keeping a policy here
 * means the warning never trains us to ignore it, and dev stays close to the
 * posture the packaged app ships with.
 */
const DEV_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: marimo-asset:",
  "media-src 'self' data: blob:",
  "font-src 'self' data:",
  `connect-src 'self' ws://localhost:${DEV_PORT} http://localhost:${DEV_PORT}`,
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

function contentSecurityPolicy(): Plugin {
  return {
    name: 'marimo-csp',
    transformIndexHtml(html, context) {
      const policy = context.server ? DEV_POLICY : BUILD_POLICY;
      return html.replace(
        '<!--CSP-->',
        `<meta http-equiv="Content-Security-Policy" content="${policy}" />`,
      );
    },
  };
}

export default defineConfig({
  root: appRoot,
  // Relative asset URLs, because the packaged window has no server to be
  // relative to.
  base: './',
  plugins: [react(), contentSecurityPolicy()],
  server: {
    port: DEV_PORT,
    strictPort: true,
  },
  build: {
    outDir: 'dist/renderer',
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {
      /*
       * Two windows, two documents. The companion is a separate entry rather
       * than a route in the main window because it is a separate *window* — a
       * frameless transparent one with a different policy about size, focus and
       * the mouse — and giving it its own document is what keeps the main
       * window's layout from having to know it exists.
       */
      input: {
        index: resolve(appRoot, 'index.html'),
        companion: resolve(appRoot, 'companion.html'),
      },
    },
  },
});
