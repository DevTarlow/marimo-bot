/**
 * The window's resizable panes.
 *
 * What is asserted here is the arithmetic, not the drawing: a drag can end
 * anywhere, so the value it produces has to be one a grid column or a flex
 * basis can hold. The failure this file exists for is the quiet one — `NaN`
 * does not throw, it drops the column, which reads as a panel that failed to
 * render.
 */
import {describe, expect, it} from 'vitest';

import {
  clampDocumentsLibraryShare,
  clampDocumentsWidth,
  clampRailWidth,
  DEFAULT_DOCUMENTS_LIBRARY_SHARE,
  MAX_DOCUMENTS_LIBRARY_SHARE,
  MAX_DOCUMENTS_WIDTH,
  MAX_RAIL_WIDTH,
  MIN_DOCUMENTS_LIBRARY_SHARE,
  MIN_DOCUMENTS_WIDTH,
  MIN_RAIL_WIDTH,
} from '../src/renderer/layout.js';

describe('clampRailWidth', () => {
  it('rounds a dragged width and keeps it inside the bounds', () => {
    expect(clampRailWidth(320.4)).toBe(320);
    expect(clampRailWidth(100)).toBe(MIN_RAIL_WIDTH);
    expect(clampRailWidth(900)).toBe(MAX_RAIL_WIDTH);
    expect(clampRailWidth(Number.NaN)).toBe(MIN_RAIL_WIDTH);
  });
});

describe('clampDocumentsWidth', () => {
  it('rounds a dragged width and keeps it inside the bounds', () => {
    expect(clampDocumentsWidth(320.4)).toBe(320);
    expect(clampDocumentsWidth(100)).toBe(MIN_DOCUMENTS_WIDTH);
    expect(clampDocumentsWidth(900)).toBe(MAX_DOCUMENTS_WIDTH);
    expect(clampDocumentsWidth(Number.NaN)).toBe(MIN_DOCUMENTS_WIDTH);
  });
});

describe('clampDocumentsLibraryShare', () => {
  it('keeps both halves of the drawer usable', () => {
    expect(clampDocumentsLibraryShare(0.5)).toBe(0.5);
    expect(clampDocumentsLibraryShare(0)).toBe(MIN_DOCUMENTS_LIBRARY_SHARE);
    expect(clampDocumentsLibraryShare(1)).toBe(MAX_DOCUMENTS_LIBRARY_SHARE);
  });

  /*
   * The coordinate that is not a number has to become a share rather than
   * `NaN%`, which is not a flex basis: the library would collapse and the
   * editor would draw over the whole column.
   */
  it('falls back to the default for a value that is not a number', () => {
    expect(clampDocumentsLibraryShare(Number.NaN)).toBe(
      DEFAULT_DOCUMENTS_LIBRARY_SHARE,
    );
  });

  it('stores a share a person could have meant, not a subpixel', () => {
    expect(clampDocumentsLibraryShare(0.43219)).toBe(0.432);
  });
});
