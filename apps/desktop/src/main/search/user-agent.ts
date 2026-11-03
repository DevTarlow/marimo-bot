/**
 * The user agent the hidden search window presents.
 *
 * Electron's own UA names the application and the engine, which reads roughly
 * `… Marimo Bot/0.1.0 Chrome/152.0.7977.167 Electron/44.9.3 Safari/537.36`. The
 * old code tried to sanitise that in place, stripping ` Electron/x` and
 * ` Marimo Desktop/x` — a name this app has never had, so the product token
 * always survived. DuckDuckGo answers an unrecognised product token with its
 * "select all squares containing a duck" interstitial: the same query loaded in
 * Chrome returns ten results, and returns the challenge the moment
 * `Marimo Bot/0.1.0` is inserted into the UA. A search window is only useful if
 * it looks like the browser it is, so the string is built here instead of
 * derived from Electron's.
 *
 * Two details make it match a real Chrome rather than merely look plausible:
 * the platform token is frozen the way Chrome's user-agent reduction freezes it,
 * and the version is reduced to `<major>.0.0.0`, which is what Chrome sends.
 */
const PLATFORM_TOKENS = {
  darwin: 'Macintosh; Intel Mac OS X 10_15_7',
  win32: 'Windows NT 10.0; Win64; x64',
  linux: 'X11; Linux x86_64',
} as const;

/**
 * Builds the UA for a platform and a Chromium version.
 *
 * Both arguments are checked rather than defaulted: a UA is a fingerprint, so a
 * wrong platform or a `Chrome/undefined` is the exact class of value this module
 * exists to stop sending. Electron only runs on the three platforms above and
 * always reports its Chromium version, so the errors are unreachable in the app
 * and the sentences are there for whoever changes the call site.
 */
export function searchUserAgent(
  platform: string,
  chromeVersion: string,
): string {
  const major = chromeVersion.split('.')[0] ?? '';
  if (!/^\d+$/u.test(major)) {
    throw new Error(`"${chromeVersion}" is not a Chrome version.`);
  }
  if (platform !== 'darwin' && platform !== 'win32' && platform !== 'linux') {
    throw new Error(`"${platform}" is not a platform this app runs on.`);
  }
  return (
    `Mozilla/5.0 (${PLATFORM_TOKENS[platform]}) ` +
    'AppleWebKit/537.36 (KHTML, like Gecko) ' +
    `Chrome/${major}.0.0.0 Safari/537.36`
  );
}
