/**
 * Shared fetch helpers: browser-ish headers, retries, and a politeness delay.
 *
 * A plain request is tried first because it is far cheaper, but the portals now
 * answer most of them with a bot challenge. A 403 therefore falls back to
 * session.js, which reissues the same request from inside a real browser. Once
 * a host has refused us this run we stop asking it the cheap way, so a source
 * with a dozen pages pays for that discovery once.
 */

import { canFallBack, fetchViaBrowser, hostNeedsBrowser, noteHostRefused } from './session.js';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function baseHeaders(extra = {}) {
  return {
    'User-Agent': UA,
    'Accept-Language': 'it-IT,it;q=0.9,en;q=0.8',
    'Sec-Ch-Ua': '"Chromium";v="131", "Not_A Brand";v="24"',
    'Sec-Ch-Ua-Mobile': '?0',
    'Sec-Ch-Ua-Platform': '"Windows"',
    ...extra,
  };
}

/**
 * fetch with a timeout and bounded retries.
 * Retries network errors and 5xx/429; a 403 is bot protection, not bad luck,
 * so we fail fast rather than hammering the site.
 */
export async function fetchWithRetry(url, opts = {}, net = {}) {
  const timeoutMs = net.timeoutMs ?? 30000;
  const retries = net.retries ?? 2;
  let lastErr;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...opts, signal: ac.signal });
      clearTimeout(timer);

      if (res.status === 403) {
        const e = new Error(`403 blocked by bot protection`);
        e.blocked = true;
        e.status = 403;
        throw e;
      }
      if (res.status === 429 || res.status >= 500) {
        throw new Error(`HTTP ${res.status}`);
      }
      return res;
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      if (err.blocked) throw err; // no point retrying a challenge page
      if (attempt < retries) {
        await sleep(900 * (attempt + 1)); // linear backoff
      }
    }
  }
  throw lastErr;
}

/**
 * Fetch `url` as text, over the browser if a plain request is refused.
 * `net.browserFallback: false` turns the fallback off and restores the older
 * behaviour of simply failing.
 */
async function fetchBody(url, accept, headers, net = {}) {
  const useBrowser = net.browserFallback !== false && canFallBack(url);

  if (!(useBrowser && hostNeedsBrowser(url))) {
    try {
      const res = await fetchWithRetry(
        url,
        { headers: baseHeaders({ Accept: accept, ...headers }) },
        net
      );
      return res.text();
    } catch (err) {
      if (!(err.blocked && useBrowser)) throw err;
      noteHostRefused(url);
    }
  }

  return fetchViaBrowser(url, accept, net);
}

export async function fetchJson(url, headers, net) {
  const body = await fetchBody(url, 'application/json', headers, net);
  try {
    return JSON.parse(body);
  } catch {
    // A challenge page can arrive with a 200, and it is not JSON. Calling that
    // a block rather than a parse error is what lets the source rest and retry.
    const e = new Error('response was not JSON - likely a bot challenge');
    e.blocked = true;
    throw e;
  }
}

export async function fetchText(url, headers, net) {
  return fetchBody(
    url,
    'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    headers,
    net
  );
}
