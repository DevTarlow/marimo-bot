/**
 * Which permissions this app's own windows may ask for.
 *
 * Two, and both are features the user pressed something to reach: the
 * microphone (a voice turn) and a sanitized clipboard write (every Copy
 * button). Everything else stays refused — a page that is not one of this
 * app's own windows must not open a microphone, and the app has no feature
 * that needs a camera, location or notifications.
 *
 * Extracted from `main.ts` so the rule can be tested without booting Electron.
 * The failure it exists for is silent by nature: a permission check that
 * answers `false` makes `navigator.clipboard.writeText()` reject, and a
 * rejection handler that only logs nothing looks exactly like a button that
 * was never wired up.
 */

/** The permission names this app answers `true` to for one of its own pages. */
const APP_PERMISSIONS: ReadonlySet<string> = new Set([
  'media',
  'clipboard-sanitized-write',
]);

/** Whether a permission is one this app has a feature for. */
export function isAppPermission(permission: string): boolean {
  return APP_PERMISSIONS.has(permission);
}

/**
 * Whether a URL belongs to one of this app's own windows.
 *
 * The packaged window is a `file://` document; the development window is the
 * Vite server. Both are trusted because both are this app, and neither check
 * is about the content of the page — it is about which page is asking.
 */
export function isOwnPage(url: string, devServerUrl?: string): boolean {
  return (
    url.startsWith('file://') ||
    (devServerUrl !== undefined &&
      devServerUrl.length > 0 &&
      url.startsWith(devServerUrl))
  );
}
