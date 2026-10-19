/**
 * The search extraction payload is whatever the loaded page produced, so this
 * is the boundary that decides what a page can put in front of the model.
 */
import {describe, expect, it} from 'vitest';

import {
  CHALLENGE_TEXT,
  EXTRACT_RESULTS_SCRIPT,
  normalizeExtraction,
} from '../src/main/search/parse.js';

describe('EXTRACT_RESULTS_SCRIPT', () => {
  it('is syntactically valid JavaScript', () => {
    // The script only ever runs inside a page, where a syntax error would look
    // like "no results". Parsing it here is the cheap way to catch that.
    expect(() => new Function(EXTRACT_RESULTS_SCRIPT)).not.toThrow();
  });

  it('returns the shape the normalizer expects', () => {
    expect(EXTRACT_RESULTS_SCRIPT).toContain('{results:');
    expect(EXTRACT_RESULTS_SCRIPT).toContain('blocked');
  });

  it('carries the challenge check the page needs', () => {
    // Both halves of the check, because either one alone missed the page that
    // DuckDuckGo actually serves: the wording, and the challenge form.
    expect(EXTRACT_RESULTS_SCRIPT).toContain('complete the following challenge');
    expect(EXTRACT_RESULTS_SCRIPT).toContain('challenge-form');
  });
});

/**
 * The page DuckDuckGo serves a blocked search, copied from its own wording.
 *
 * This is the regression: the old pattern looked for "anomaly" and "unusual
 * traffic", which are class names in the markup and never appear in the text a
 * person (or `innerText`) sees, so the block read as "no results".
 */
describe('CHALLENGE_TEXT', () => {
  it('recognises the challenge DuckDuckGo actually serves', () => {
    const body =
      'Unfortunately, bots use DuckDuckGo too. Please complete the following ' +
      'challenge to confirm this search was made by a human. Select all squares ' +
      'containing a duck: Submit';
    expect(CHALLENGE_TEXT.test(body)).toBe(true);
  });

  it('leaves an ordinary results page alone', () => {
    const body =
      'Top fruits by global production. 1. Banana — 135 million tonnes. ' +
      '2. Watermelon — 100 million tonnes.';
    expect(CHALLENGE_TEXT.test(body)).toBe(false);
  });
});

describe('normalizeExtraction', () => {
  it('keeps http(s) results and tidies their text', () => {
    const {results, blocked} = normalizeExtraction(
      {
        results: [
          {
            title: '  Marimo Bot   docs ',
            url: 'https://example.com/a',
            snippet: 'A\nreactive  notebook',
          },
        ],
        blocked: false,
      },
      5,
    );
    expect(blocked).toBe(false);
    expect(results).toEqual([
      {
        title: 'Marimo Bot docs',
        url: 'https://example.com/a',
        snippet: 'A reactive notebook',
      },
    ]);
  });

  it('drops anything that is not an http(s) URL', () => {
    const {results} = normalizeExtraction(
      {
        results: [
          {title: 'script', url: 'javascript:alert(1)', snippet: ''},
          {title: 'local', url: '/relative/path', snippet: ''},
          {title: 'file', url: 'file:///etc/passwd', snippet: ''},
          {title: 'good', url: 'https://example.com', snippet: ''},
        ],
      },
      10,
    );
    expect(results.map((result) => result.url)).toEqual([
      'https://example.com/',
    ]);
  });

  it('falls back to the hostname when a page omits the title', () => {
    const {results} = normalizeExtraction(
      {results: [{url: 'https://example.com/page', title: '   '}]},
      5,
    );
    expect(results[0]?.title).toBe('example.com');
  });

  it('de-duplicates by URL', () => {
    const {results} = normalizeExtraction(
      {
        results: [
          {url: 'https://example.com', title: 'a'},
          {url: 'https://example.com', title: 'b'},
        ],
      },
      5,
    );
    expect(results).toHaveLength(1);
  });

  it('caps the list and the snippet', () => {
    const many = Array.from({length: 20}, (_value, index) => ({
      url: `https://example.com/${index}`,
      title: `t${index}`,
      snippet: 'y'.repeat(900),
    }));
    const {results} = normalizeExtraction({results: many}, 3);
    expect(results).toHaveLength(3);
    expect(results[0]?.snippet.length).toBe(300);
  });

  it('reports a challenge page', () => {
    expect(normalizeExtraction({results: [], blocked: true}, 5).blocked).toBe(
      true,
    );
  });

  it('survives junk payloads', () => {
    for (const junk of [undefined, null, 'text', 42, {}, {results: 'nope'}]) {
      const {results, blocked} = normalizeExtraction(junk, 5);
      expect(results).toEqual([]);
      expect(blocked).toBe(false);
    }
  });
});
