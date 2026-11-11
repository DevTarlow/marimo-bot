/**
 * Merging Chromium feature switches instead of replacing them.
 *
 * `--disable-features` is one comma-separated value, and Electron's command
 * line may already carry one from whatever launched the app. Appending a second
 * switch with only the feature this app needs would replace the launcher's set
 * in some builds and silently turn something back on. This merges the two,
 * keeping order and dropping duplicates.
 *
 * It lives outside `main.ts` because that file imports Electron and cannot be
 * reached by a test; the merge is the part worth pinning.
 */
export function withDisabledFeature(existing: string, feature: string): string {
  const features = existing
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (!features.includes(feature)) {
    features.push(feature);
  }
  return features.join(',');
}

/**
 * Whether this run renders through Ozone/Wayland.
 *
 * Asked rather than guessed from the session: Electron has already resolved
 * `--ozone-platform`, `--ozone-platform-hint` and its own auto-detection by the
 * time the main script runs, and that resolved value is the one Chromium will
 * use. A session can have `WAYLAND_DISPLAY` set and still be running an X11
 * window — `DISPLAY` alone is no better — so the environment is only the
 * fallback for a build that does not publish the switch.
 *
 * `platform` and `env` are parameters so a test can ask without being on Linux.
 */
export function isWaylandSession(
  platform: string,
  effectivePlatform: string,
  env: NodeJS.ProcessEnv,
): boolean {
  if (platform !== 'linux') {
    return false;
  }
  if (effectivePlatform.length > 0) {
    return effectivePlatform === 'wayland';
  }
  return (
    env['XDG_SESSION_TYPE'] === 'wayland' ||
    env['WAYLAND_DISPLAY'] !== undefined
  );
}
