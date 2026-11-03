/**
 * Putting text on the clipboard, and saying whether it worked.
 *
 * The web API is the right call, but it is not the only one available to a
 * sandboxed Electron window and it is not guaranteed: Chromium routes the
 * write through the session's permission handlers, and a `false` there makes
 * the promise reject. The old call sites swallowed that rejection, so a denied
 * copy looked exactly like a button nobody had wired up.
 *
 * So this tries the modern API, falls back to the selection-based copy that
 * needs no permission, and answers with the truth. The components that use it
 * render "Copied" only for `true`, and "Copy failed" for `false`; the text is
 * also on screen and selectable by hand in every place that offers this.
 */
import {useEffect, useRef, useState} from 'react';

const COPIED_FOR_MS = 1_500;

/**
 * Writes `text` to the clipboard, resolving to whether it landed.
 *
 * The fallback is `execCommand('copy')` over a temporary textarea. It is
 * deprecated and still the one path that works when the asynchronous API is
 * refused, which is exactly the case this exists for. The element is off
 * screen rather than hidden with `display: none` — a hidden element cannot be
 * selected, and an unselectable element cannot be copied.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard !== undefined) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // The permission or the platform refused it; try the older path below.
  }

  const active = document.activeElement;
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.setAttribute('aria-hidden', 'true');
  area.style.position = 'fixed';
  area.style.top = '0';
  area.style.left = '0';
  area.style.width = '1px';
  area.style.height = '1px';
  area.style.padding = '0';
  area.style.border = 'none';
  area.style.opacity = '0';
  document.body.append(area);

  try {
    area.select();
    area.setSelectionRange(0, text.length);
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    area.remove();
    // A copy from a menu should leave the keyboard where it was, and a copy
    // from a code block should not scroll the transcript to the top.
    if (active instanceof HTMLElement) {
      active.focus();
    }
  }
}

/** What the button last did, long enough to read and no longer. */
export type CopyState = 'idle' | 'copied' | 'failed';

/**
 * The state a copy button draws, and the action that sets it.
 *
 * One hook rather than the same three lines in the session menu, the transcript
 * and the companion: the bug these buttons shared was a failure that looked
 * like nothing happening, and a second copy of the state machine is a second
 * place for the failure to go quiet again.
 */
export function useCopy(): {state: CopyState; copy: (text: string) => void} {
  const [state, setState] = useState<CopyState>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(
    () => () => {
      if (timer.current !== undefined) {
        clearTimeout(timer.current);
      }
    },
    [],
  );

  const copy = (text: string): void => {
    void copyText(text).then((ok) => {
      setState(ok ? 'copied' : 'failed');
      if (timer.current !== undefined) {
        clearTimeout(timer.current);
      }
      timer.current = setTimeout(() => {
        setState('idle');
      }, COPIED_FOR_MS);
    });
  };

  return {state, copy};
}

/** The label a copy button shows for a state. */
export function copyLabel(state: CopyState): string {
  if (state === 'copied') {
    return 'Copied';
  }
  return state === 'failed' ? 'Copy failed' : 'Copy';
}
