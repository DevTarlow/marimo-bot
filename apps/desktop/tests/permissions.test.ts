/**
 * The session permission rule.
 *
 * The failure this pins is silent in the window: Electron asks the check
 * handler about `clipboard-sanitized-write`, a `false` makes the promise from
 * `navigator.clipboard.writeText()` reject, and the button that swallowed the
 * rejection simply did nothing. The rule is small enough that the useful test
 * is the exact yes/no, not a booted window.
 */
import {describe, expect, it} from 'vitest';

import {isAppPermission, isOwnPage} from '../src/main/permissions.js';

describe('isAppPermission', () => {
  it('allows the clipboard feature the app has, and nothing else', () => {
    expect(isAppPermission('clipboard-sanitized-write')).toBe(true);

    for (const permission of [
      'media',
      'clipboard-read',
      'geolocation',
      'notifications',
      'openExternal',
      'display-capture',
      'unknown',
    ]) {
      expect(isAppPermission(permission)).toBe(false);
    }
  });
});

describe('isOwnPage', () => {
  it('trusts the packaged file window', () => {
    expect(
      isOwnPage('file:///opt/marimo/resources/app.asar/renderer/index.html'),
    ).toBe(true);
  });

  it('trusts the development server, and only that origin', () => {
    expect(isOwnPage('http://localhost:5173/', 'http://localhost:5173')).toBe(
      true,
    );
    expect(
      isOwnPage('http://localhost:5173/index.html', 'http://localhost:5173'),
    ).toBe(true);
    expect(isOwnPage('https://example.com/', 'http://localhost:5173')).toBe(
      false,
    );
  });

  it('refuses anything that is not one of the app’s own pages', () => {
    expect(isOwnPage('https://example.com/')).toBe(false);
    expect(isOwnPage('')).toBe(false);
    expect(isOwnPage('http://localhost:5173/', '')).toBe(false);
  });
});
