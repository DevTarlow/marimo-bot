/**
 * The search window's user agent is load-bearing: DuckDuckGo challenges a UA
 * that carries a product token it does not recognise, which is exactly what
 * Electron's default does. These assertions are the regression.
 */
import {describe, expect, it} from 'vitest';

import {searchUserAgent} from '../src/main/search/user-agent.js';

describe('searchUserAgent', () => {
  it('describes a browser and nothing else', () => {
    const ua = searchUserAgent('linux', '152.0.7977.167');
    expect(ua).toBe(
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
        'Chrome/152.0.0.0 Safari/537.36',
    );
    // Electron's UA says "Marimo Bot/0.1.0 … Electron/44.9.3"; either token
    // gets the search refused.
    expect(ua).not.toMatch(/electron/iu);
    expect(ua).not.toMatch(/marimo/iu);
  });

  it('reduces the version the way Chrome reduces it', () => {
    // Chrome sends major.0.0.0; a full four-part version is a fingerprint of
    // its own.
    expect(searchUserAgent('win32', '144.0.7559.132')).toContain(
      'Chrome/144.0.0.0',
    );
  });

  it('freezes the platform token the way Chrome freezes it', () => {
    expect(searchUserAgent('darwin', '152.0.1.2')).toContain(
      'Macintosh; Intel Mac OS X 10_15_7',
    );
    expect(searchUserAgent('win32', '152.0.1.2')).toContain(
      'Windows NT 10.0; Win64; x64',
    );
    expect(searchUserAgent('linux', '152.0.1.2')).toContain(
      'X11; Linux x86_64',
    );
  });

  it('refuses a version that is not a version', () => {
    for (const version of ['', 'undefined', 'v152.0']) {
      expect(() => searchUserAgent('linux', version)).toThrow(
        /not a Chrome version/u,
      );
    }
  });

  it('refuses a platform this app does not run on', () => {
    expect(() => searchUserAgent('aix', '152.0.1.2')).toThrow(
      /not a platform/u,
    );
  });
});
