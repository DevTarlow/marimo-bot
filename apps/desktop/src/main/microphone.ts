/**
 * The one platform question a microphone asks before the renderer does.
 *
 * On macOS, Chromium's `getUserMedia` is not enough on its own: the app has to
 * ask the OS for microphone access, and a refusal has to become a sentence the
 * card can show rather than a promise that rejects somewhere invisible. On
 * Windows and Linux the renderer's `getUserMedia` and the app's permission
 * handler are the whole story.
 *
 * It lives here rather than in `permissions.ts` because that file is deliberately
 * Electron-free and tested without a browser; this is the thin Electron seam the
 * host injects in tests.
 */
import {systemPreferences} from 'electron';

export async function ensureMicrophoneAccess(): Promise<boolean> {
  if (process.platform !== 'darwin') {
    return true;
  }
  try {
    return await systemPreferences.askForMediaAccess('microphone');
  } catch {
    return false;
  }
}
