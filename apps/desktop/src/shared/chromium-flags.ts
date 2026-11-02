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
