/**
 * The window's resizable panes: how far each edge may be dragged.
 *
 * Pure and without a DOM, for the reason the drawer's own reading is: the
 * arithmetic a drag does is where the plausible-looking wrong answer lives. A
 * width of `NaN` drops a grid column, and a share of zero hides the very list
 * the drawer is for — both draw as "the panel is broken" rather than as a
 * number that was out of bounds.
 *
 * The settings schema enforces the same bounds. Keeping them here as well is
 * what lets a drag obey them before a write is attempted: a value that only
 * became valid after a round trip would let the panel jump under the cursor.
 */

/** The left rail's bounds, in pixels. */
export const MIN_RAIL_WIDTH = 200;
export const MAX_RAIL_WIDTH = 560;

/** The width a fresh window opens with, matching the design token. */
export const DEFAULT_RAIL_WIDTH = 272;

/** The documents drawer's bounds, in pixels. */
export const MIN_DOCUMENTS_WIDTH = 240;
export const MAX_DOCUMENTS_WIDTH = 560;

/** The width a fresh drawer opens with, matching the design token. */
export const DEFAULT_DOCUMENTS_WIDTH = 420;

/**
 * How much of the drawer's body the library keeps while a file is open.
 *
 * A fraction rather than a height, because the drawer is as tall as the window:
 * a height dragged on a tall monitor would leave the editor with nothing on a
 * shorter one. The lower bound keeps the filter and a row or two visible, and
 * the upper one leaves the editor enough lines to be worth opening.
 */
export const MIN_DOCUMENTS_LIBRARY_SHARE = 0.12;
export const MAX_DOCUMENTS_LIBRARY_SHARE = 0.8;

/**
 * The share a fresh drawer opens with, and the one the stylesheet draws before
 * the stored preference has loaded. The library is for finding a file; the
 * editor is where the time goes, so the split starts in the editor's favour.
 */
export const DEFAULT_DOCUMENTS_LIBRARY_SHARE = 0.34;

/** A dragged width, rounded and inside the rail's bounds. */
export function clampRailWidth(width: number): number {
  return clampWidth(width, MIN_RAIL_WIDTH, MAX_RAIL_WIDTH);
}

/** A dragged width, rounded and inside the drawer's bounds. */
export function clampDocumentsWidth(width: number): number {
  return clampWidth(width, MIN_DOCUMENTS_WIDTH, MAX_DOCUMENTS_WIDTH);
}

/**
 * A dragged split, inside the library's bounds.
 *
 * Rounded to a thousandth so a stored share is a number a person could have
 * meant rather than the pointer's last subpixel. A coordinate that is not a
 * number falls back to the default for the reason a width does: `NaN%` is not a
 * flex basis, and it collapses the panel instead of clamping it.
 */
export function clampDocumentsLibraryShare(share: number): number {
  if (!Number.isFinite(share)) {
    return DEFAULT_DOCUMENTS_LIBRARY_SHARE;
  }
  const bounded = Math.min(
    MAX_DOCUMENTS_LIBRARY_SHARE,
    Math.max(MIN_DOCUMENTS_LIBRARY_SHARE, share),
  );
  return Math.round(bounded * 1000) / 1000;
}

function clampWidth(width: number, min: number, max: number): number {
  if (!Number.isFinite(width)) {
    return min;
  }
  return Math.min(max, Math.max(min, Math.round(width)));
}
