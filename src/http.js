/** Shared fetch helpers: browser-ish headers, retries, and a politeness delay. */

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

export async function fetchJson(url, headers, net) {
  const res = await fetchWithRetry(
    url,
    { headers: baseHeaders({ Accept: 'application/json', ...headers }) },
    net
  );
  return res.json();
}

export async function fetchText(url, headers, net) {
  const res = await fetchWithRetry(
    url,
    {
      headers: baseHeaders({
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        ...headers,
      }),
    },
    net
  );
  return res.text();
}
