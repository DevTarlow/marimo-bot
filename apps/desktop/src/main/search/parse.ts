/**
 * DuckDuckGo result extraction.
 *
 * The extraction runs inside the page, so it lives here as a string. Its output
 * is untrusted — it is whatever the loaded page happens to contain — and is
 * validated below before anything reaches the model. Keeping both halves in one
 * pure module is what makes the part that can rot (selectors) reviewable and
 * testable without launching Electron.
 */
import type {WebSearchResult} from '@marimo/agent';

const MAX_SNIPPET_CHARS = 300;
const MAX_TITLE_CHARS = 200;

/**
 * The words an anti-bot page uses, in one place so the page and its test agree.
 *
 * DuckDuckGo's current interstitial says "Please complete the following
 * challenge" and "Select all squares containing a duck". The words "anomaly"
 * and "unusual traffic" this used to look for appear only in the page's markup,
 * never in its `innerText`, so a blocked search was reported as an empty one:
 * the model was told the web had nothing, retried once, and answered from
 * memory. A refusal has to be visible as a refusal, or it reads as an answer.
 */
export const CHALLENGE_TEXT =
  /complete the following challenge|select all squares|bots use duckduckgo|unusual traffic|too many requests/i;

/**
 * Evaluated in the search page. Returns `{results, blocked}`:
 *
 * - `results` are the title links with their snippets, newest layouts first
 *   (`article[data-testid="result"]`) with fallbacks for the older markup.
 * - `blocked` marks the anti-bot interstitial, so "the engine refused us" is
 *   reported as a failure rather than as "no results". The text check is what a
 *   person sees; the selector check catches a challenge whose wording has not
 *   rendered yet when the first poll runs.
 */
export const EXTRACT_RESULTS_SCRIPT = `(() => {
  const seen = new Set();
  const results = [];
  const text = (node) => (node && (node.innerText || node.textContent) || '').trim();
  const directUrl = (raw) => {
    try {
      const parsed = new URL(raw, location.href);
      if (parsed.pathname.startsWith('/l/') && /(^|\\.)duckduckgo\\.com$/.test(parsed.hostname)) {
        const target = parsed.searchParams.get('uddg');
        if (target) return target;
      }
      return parsed.href;
    } catch {
      return raw;
    }
  };
  const collect = (anchor, snippetNode) => {
    if (!anchor) return;
    const url = directUrl(anchor.href || '');
    const title = text(anchor);
    if (url && title && !seen.has(url)) {
      seen.add(url);
      results.push({title, url, snippet: text(snippetNode)});
    }
  };
  const containers = document.querySelectorAll(
    'article[data-testid="result"], .result, .web-result, [data-layout="organic"]',
  );
  for (const container of containers) {
    collect(
      container.querySelector('a[data-testid="result-title-a"], h2 a, a.result__a'),
      container.querySelector('[data-result="snippet"], .result__snippet'),
    );
  }
  if (results.length === 0) {
    for (const anchor of document.querySelectorAll('a[data-testid="result-title-a"], a.result__a')) {
      collect(anchor, null);
    }
  }
  const body = text(document.body);
  const challengeForm = document.querySelector(
    '#challenge-form, .anomaly-modal, form[action*="anomaly"]',
  );
  const blocked =
    results.length === 0 &&
    (challengeForm !== null ||
      new RegExp(${JSON.stringify(CHALLENGE_TEXT.source)}, 'i').test(body));
  return {results: results.slice(0, 50), blocked};
})()`;

export interface NormalizedExtraction {
  results: WebSearchResult[];
  /** The engine served an anti-bot interstitial rather than results. */
  blocked: boolean;
}

/**
 * Validates one extraction payload.
 *
 * Everything is treated as hostile input: a page could return objects instead of
 * strings, `javascript:` URLs, or thousands of rows. Only `http(s)` results with
 * a usable title survive, and the list is capped and de-duplicated by URL.
 */
export function normalizeExtraction(
  raw: unknown,
  limit: number,
): NormalizedExtraction {
  const source = isRecord(raw) ? raw : {};
  const blocked = source['blocked'] === true;
  const list = Array.isArray(source['results']) ? source['results'] : [];
  const results: WebSearchResult[] = [];
  const seen = new Set<string>();

  for (const entry of list) {
    if (results.length >= Math.max(limit, 0)) {
      break;
    }
    const url = httpUrl(isRecord(entry) ? entry['url'] : undefined);
    if (!url || seen.has(url)) {
      continue;
    }
    const title = clean(
      isRecord(entry) ? entry['title'] : undefined,
      MAX_TITLE_CHARS,
    );
    seen.add(url);
    results.push({
      title: title.length > 0 ? title : new URL(url).hostname,
      url,
      snippet: clean(
        isRecord(entry) ? entry['snippet'] : undefined,
        MAX_SNIPPET_CHARS,
      ),
    });
  }

  return {results, blocked};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function clean(value: unknown, max: number): string {
  if (typeof value !== 'string') {
    return '';
  }
  return value.replace(/\s+/g, ' ').trim().slice(0, max);
}

/** `http(s)` only: a relative or script URL from a page is not a result. */
function httpUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return undefined;
  }
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    return undefined;
  }
  return parsed.protocol === 'http:' || parsed.protocol === 'https:'
    ? parsed.toString()
    : undefined;
}
