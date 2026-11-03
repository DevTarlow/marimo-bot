/**
 * The `marimo-asset://` scheme, which serves the pictures the app shows for the
 * user.
 *
 * Two kinds, and neither is a file the renderer could open itself. An uploaded
 * bot icon lives in the user-data directory; an attached picture lives in the
 * Space the conversation works in. The renderer is sandboxed and, in
 * development, served from `http://localhost`, so it cannot read a `file://`
 * URL — and handing it one would also mean handing it a path it could use for
 * anything else. A scheme of the app's own is what lets the same image arrive in
 * a browser window and in a packaged one, through a handler that decides
 * exactly which files exist for it.
 *
 * The URLs' shapes are built by the protocol's own helpers:
 * `marimo-asset://bot/<profile id>.png?v=<version>` and
 * `marimo-asset://space/<profile id>/<session id>?path=<relative path>`. The
 * bot URL's version is ignored by this handler; it is there so a replacement is
 * a different URL and no cache has to be told to forget the old one.
 */
import {readFile, stat} from 'node:fs/promises';
import {join, resolve, sep} from 'node:path';

import {protocol, session} from 'electron';

import {resolveInsideWorkspace} from '@marimo/agent';
import {
  ASSET_SCHEME,
  imageMimeType,
  isImagePath,
  MAX_ATTACHMENT_BYTES,
} from '@marimo/protocol';
import {avatarFileName} from '@marimo/runtime';

/**
 * Registers the scheme, and **must be called before Electron's `app` is ready**.
 *
 * Electron reads a scheme's privileges once, while it builds the URL request
 * factory inside the ready sequence. A call after that is a warning nobody reads
 * and a scheme that stays non-standard.
 */
export function registerAssetScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: ASSET_SCHEME,
      privileges: {
        standard: true,
        secure: true,
      },
    },
  ]);
}

/**
 * The profile id a `marimo-asset://bot/...` URL names, or undefined.
 *
 * The decoded id may not contain a path separator. The app's own ids are UUIDs
 * and never do; a hand-edited URL that tries to reach another file is refused
 * here rather than relied on to be sanitised one step later.
 */
export function botAvatarProfileIdFromUrl(url: string): string | undefined {
  // Refused before the URL parser normalises a `..` away: the answer would be a
  // different name that happens to resolve inside the directory, not the one
  // that was asked for.
  if (url.includes('..')) {
    return undefined;
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== `${ASSET_SCHEME}:` || parsed.hostname !== 'bot') {
    return undefined;
  }
  const encoded = parsed.pathname.replace(/^\//u, '');
  if (!encoded.endsWith('.png')) {
    return undefined;
  }
  let id: string;
  try {
    id = decodeURIComponent(encoded.slice(0, -'.png'.length));
  } catch {
    return undefined;
  }
  if (id.length === 0 || id.includes('/') || id.includes('\\')) {
    return undefined;
  }
  return id;
}

/** A conversation's image, as its URL names it. */
export interface SpaceImageRef {
  /** The bot whose conversation holds it. */
  profileId: string;
  /** The conversation the message belongs to. */
  sessionId: string;
  /** The path the message spells, relative to that conversation's Space. */
  path: string;
}

/**
 * The conversation and path a `marimo-asset://space/...` URL names, or undefined.
 *
 * The URL names a conversation rather than a folder, because the main process
 * can resolve that through the same rule a turn uses. Nothing here touches the
 * filesystem: what the path is allowed to reach is decided by
 * `readSpaceImage`, whose guard is the one the file tools use.
 */
export function spaceImageFromUrl(url: string): SpaceImageRef | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== `${ASSET_SCHEME}:` || parsed.hostname !== 'space') {
    return undefined;
  }
  const encoded = parsed.pathname.replace(/^\//u, '');
  const slash = encoded.indexOf('/');
  if (slash <= 0) {
    return undefined;
  }
  let profileId: string;
  let sessionId: string;
  try {
    profileId = decodeURIComponent(encoded.slice(0, slash));
    sessionId = decodeURIComponent(encoded.slice(slash + 1));
  } catch {
    return undefined;
  }
  /*
   * A second separator after decoding means the URL named something other than
   * the two ids — the parser turns `%2F` into a slash here, and an id with one
   * is a file name the app does not have.
   */
  if (!isIdentifier(profileId) || !isIdentifier(sessionId)) {
    return undefined;
  }
  const path = parsed.searchParams.get('path') ?? '';
  if (path.length === 0 || path.includes('\u0000')) {
    return undefined;
  }
  return {profileId, sessionId, path};
}

/**
 * An id the app itself could have written.
 *
 * No separator and no `.`/`..`: the ids are UUIDs, and this is the boundary
 * rather than a guess about which characters a future id might use.
 */
function isIdentifier(value: string): boolean {
  return (
    value.length > 0 &&
    value !== '.' &&
    value !== '..' &&
    !value.includes('/') &&
    !value.includes('\\') &&
    !value.includes('\u0000')
  );
}

/** One attached image's bytes and the type they are served as. */
export interface SpaceImage {
  bytes: Uint8Array;
  mime: string;
}

/**
 * One image from a Space, or a refusal.
 *
 * `root` is the conversation's folder and every rule here is the agent's own:
 * the path is resolved by `resolveInsideWorkspace`, so `..`, an absolute path
 * and a symlink that leaves the folder are one refusal. The file must still be
 * an image by extension and under the same byte cap the picker applied, because
 * a file can be replaced on disk between the message and the read — a picture
 * swapped for a hundred-megabyte one must not be loaded into this process.
 */
export async function readSpaceImage(
  root: string,
  path: string,
): Promise<SpaceImage> {
  const resolved = await resolveInsideWorkspace(root, path);
  if (!isImagePath(resolved)) {
    throw new Error(`"${path}" is not an image this app can draw.`);
  }
  const info = await stat(resolved);
  if (!info.isFile()) {
    throw new Error(`"${path}" is not a regular file.`);
  }
  if (info.size > MAX_ATTACHMENT_BYTES) {
    throw new Error(`"${path}" is larger than this app sends.`);
  }
  const bytes = new Uint8Array(await readFile(resolved));
  // The file can grow between the stat above and this read, and the cap has to
  // be true of the bytes actually handed to the window.
  if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
    throw new Error(`"${path}" is larger than this app sends.`);
  }
  return {bytes, mime: imageMimeType(resolved) ?? 'application/octet-stream'};
}

/** What the handler needs to answer a URL. */
export interface AssetSources {
  /** Where the one PNG for each custom bot icon lives. */
  avatarsDir: string;
  /**
   * The folder a conversation works in, or undefined when there is none.
   *
   * Injected rather than read here: resolving a conversation to its Space is
   * the runtime's rule, and a second derivation would be a second answer to
   * "where does this chat work".
   */
  conversationRoot: (
    profileId: string,
    sessionId: string,
  ) => Promise<string | undefined>;
}

let installed = false;

/**
 * Installs the one handler for the scheme, after the app is ready.
 *
 * A module-level guard because Electron refuses a second handler on one scheme;
 * the app calls this once at boot, and the guard means a test or a future second
 * caller cannot turn that into a startup warning.
 */
export function installAssetHandler(sources: AssetSources): void {
  if (installed) {
    return;
  }
  installed = true;
  const root = resolve(sources.avatarsDir);

  session.defaultSession.protocol.handle(ASSET_SCHEME, async (request) => {
    const space = spaceImageFromUrl(request.url);
    if (space !== undefined) {
      return await serveSpaceImage(space, sources.conversationRoot);
    }

    const profileId = botAvatarProfileIdFromUrl(request.url);
    if (profileId === undefined) {
      return refuse(404, 'That is not an image this app serves.');
    }
    const file = resolve(join(root, avatarFileName(profileId)));
    /*
     * The second check, against the resolved path. `avatarFileName` is already
     * one segment, and this asserts the boundary rather than trusting that the
     * helper is still one segment after a later change.
     */
    if (!file.startsWith(`${root}${sep}`)) {
      return refuse(403, 'That image is not one this app keeps.');
    }

    let bytes: Buffer;
    try {
      bytes = await readFile(file);
    } catch {
      return refuse(404, 'That image is not there.');
    }
    return new Response(new Uint8Array(bytes), {
      status: 200,
      headers: {
        'content-type': 'image/png',
        // The URL carries the version, so a replacement is a new request.
        'cache-control': 'private, max-age=31536000, immutable',
        'x-content-type-options': 'nosniff',
      },
    });
  });
}

/**
 * One attached picture, read from the conversation's own Space.
 *
 * Every refusal is a 404 with one sentence: the window's answer to any of them
 * is the same — draw the file's name instead of a picture that is not there —
 * and a status that distinguished "outside the folder" from "missing" would be
 * telling the page which of the two it tried.
 */
async function serveSpaceImage(
  reference: SpaceImageRef,
  conversationRoot: AssetSources['conversationRoot'],
): Promise<Response> {
  let root: string | undefined;
  try {
    root = await conversationRoot(reference.profileId, reference.sessionId);
  } catch {
    return refuse(404, 'That conversation has no Space to read an image from.');
  }
  if (root === undefined) {
    return refuse(404, 'That conversation has no Space to read an image from.');
  }

  let image: SpaceImage;
  try {
    image = await readSpaceImage(root, reference.path);
  } catch {
    return refuse(404, "That image is not in this conversation's Space.");
  }
  return new Response(new Uint8Array(image.bytes), {
    status: 200,
    headers: {
      'content-type': image.mime,
      /*
       * Not cached. The message names a path, not a version, so a file the
       * agent rewrote under the same name has to be read again — and it is a
       * local read, which is cheaper than showing yesterday's picture.
       */
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}

function refuse(status: number, message: string): Response {
  return new Response(message, {
    status,
    headers: {'content-type': 'text/plain; charset=utf-8'},
  });
}
