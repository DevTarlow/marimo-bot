/**
 * An explicit release check, not an updater.
 *
 * This build has no signed feed and no installer pipeline, so downloading and
 * applying an update is deliberately absent: an unsigned auto-update is a
 * remote-code path nobody asked for. What this does is answer the smaller
 * question the Settings card can act on — is there a newer published release,
 * and where can the person read it? It runs only when the button is pressed.
 *
 * The feed is the repository's public latest-release endpoint. A caller can
 * inject the URL and fetch for a test or an enterprise mirror; there is no
 * background polling and no telemetry.
 */
import type {UpdateCheck} from '@marimo/protocol';

const RELEASES_URL =
  'https://api.github.com/repos/DevTarlow/marimo-bot/releases/latest';
const TIMEOUT_MS = 10_000;

export interface CheckForUpdatesOptions {
  currentVersion: string;
  /** Injected in tests; the app uses the process's fetch. */
  fetchImpl?: typeof fetch;
  releasesUrl?: string;
  timeoutMs?: number;
  now?: () => Date;
}

export async function checkForUpdates(
  options: CheckForUpdatesOptions,
): Promise<UpdateCheck> {
  const now = options.now ?? (() => new Date());
  const checkedAt = now().toISOString();
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = options.releasesUrl ?? RELEASES_URL;
  const timeout = options.timeoutMs ?? TIMEOUT_MS;
  try {
    const response = await fetchImpl(url, {
      signal: AbortSignal.timeout(timeout),
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': 'Marimo-Bot-update-check',
      },
    });
    if (response.status === 404) {
      return {
        currentVersion: options.currentVersion,
        available: false,
        checkedAt,
        error: 'No releases are published yet.',
      };
    }
    if (!response.ok) {
      return {
        currentVersion: options.currentVersion,
        available: false,
        checkedAt,
        error: `The release feed answered ${String(response.status)}.`,
      };
    }
    const body: unknown = await response.json();
    if (
      typeof body !== 'object' ||
      body === null ||
      typeof (body as Record<string, unknown>)['tag_name'] !== 'string'
    ) {
      return {
        currentVersion: options.currentVersion,
        available: false,
        checkedAt,
        error: 'The release feed did not answer with a release.',
      };
    }
    const record = body as Record<string, unknown>;
    const latestVersion = String(record['tag_name']);
    const latest = parseVersion(latestVersion);
    const current = parseVersion(options.currentVersion);
    const available =
      latest !== undefined &&
      current !== undefined &&
      compareVersions(latest, current) > 0;
    return {
      currentVersion: options.currentVersion,
      latestVersion,
      available,
      ...(typeof record['html_url'] === 'string'
        ? {url: record['html_url']}
        : {}),
      ...(typeof record['body'] === 'string' && record['body'].trim().length > 0
        ? {notes: String(record['body']).slice(0, 4_000)}
        : {}),
      checkedAt,
    };
  } catch (error) {
    return {
      currentVersion: options.currentVersion,
      available: false,
      checkedAt,
      error:
        error instanceof Error && error.name === 'TimeoutError'
          ? 'The release feed did not answer in time.'
          : `Could not check for updates: ${
              error instanceof Error ? error.message : String(error)
            }`,
    };
  }
}

interface ParsedVersion {
  parts: [number, number, number];
  prerelease: boolean;
}

/** `v1.2.3`, `1.2.3-beta.1`; an unparseable tag answers undefined. */
export function parseVersion(value: string): ParsedVersion | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+](.*))?$/u.exec(value.trim());
  if (match === null) {
    return undefined;
  }
  return {
    parts: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: (match[4] ?? '').length > 0,
  };
}

/** Positive when `left` is newer than `right`. */
export function compareVersions(
  left: ParsedVersion,
  right: ParsedVersion,
): number {
  for (let index = 0; index < 3; index += 1) {
    const difference = left.parts[index] - right.parts[index];
    if (difference !== 0) {
      return difference;
    }
  }
  if (left.prerelease === right.prerelease) {
    return 0;
  }
  return left.prerelease ? -1 : 1;
}
