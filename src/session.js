/**
 * A shared browser kept as a fallback transport for the plain HTTP sources.
 *
 * Immobiliare's api-next endpoint used to answer ordinary headers and no longer
 * does: DataDome now covers it, and Casa.it's search pages too. A bare fetch
 * gets a captcha-delivery challenge, and so does a headless browser - that part
 * is fingerprinting, not addressing, since both are refused from a home
 * connection as well. A real browser window passes. So when a request comes
 * back 403 it is reissued from inside a page on the site itself, which carries
 * the site's own cookies and TLS fingerprint rather than imitating them.
 *
 * One context serves the whole run. The costly parts are the launch and the
 * site's bot check, and reusing the page means paying each once per host
 * instead of once per page of results.
 *
 * This keeps a profile directory of its own. idealista.js and enrich.js both
 * open the shared profile for their own browser work, and two Chromium
 * instances cannot hold one profile at the same time.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { launchOptions } from './browser.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROFILE_DIR = path.resolve(__dirname, '..', 'data', '.browser-profile-http');

/**
 * Where to land before requesting anything from a given host.
 *
 * The bot check is cleared by loading a normal page, not by the API call, so
 * each host needs somewhere sensible to arrive first. Subito's search API lives
 * on a separate hostname and is reached from the main site, which its CORS
 * headers allow.
 */
const LANDING = {
  'www.immobiliare.it': 'https://www.immobiliare.it/affitto-case/genova/',
  'www.casa.it': 'https://www.casa.it/',
  'www.subito.it': 'https://www.subito.it/',
  'hades.subito.it': 'https://www.subito.it/',
};

let context = null;
let page = null;
let landedOn = null;

/** Hosts already known to refuse a plain fetch this run, so we stop trying one. */
const refusing = new Set();

export function hostNeedsBrowser(url) {
  try {
    return refusing.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

export function noteHostRefused(url) {
  try {
    refusing.add(new URL(url).hostname);
  } catch {
    /* a malformed URL will fail on its own further down */
  }
}

export function canFallBack(url) {
  try {
    return !!LANDING[new URL(url).hostname];
  } catch {
    return false;
  }
}

async function ensurePage() {
  if (page) return page;

  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    throw new Error('playwright is not installed - run "npm install" then "npm run install-browser"');
  }

  // Asking for a visible window; browser.js downgrades that to headless if the
  // machine has no display, which on a server means running under xvfb-run.
  context = await chromium.launchPersistentContext(PROFILE_DIR, launchOptions(false));
  page = context.pages()[0] || (await context.newPage());
  return page;
}

/**
 * Issue `url` from inside a page on its own site and hand back the body text.
 * Throws with `.blocked` set if the site refuses the browser too, which is how
 * an address-level block (as opposed to a fingerprint one) shows up.
 */
export async function fetchViaBrowser(url, accept, net = {}) {
  const host = new URL(url).hostname;
  const landing = LANDING[host];
  if (!landing) throw new Error(`no landing page configured for ${host}`);

  const p = await ensurePage();
  const timeout = net.timeoutMs ?? 45000;

  if (landedOn !== landing) {
    landedOn = landing;
    let status = null;

    // Casa.it answers a cold profile with a challenge that sets its own cookie
    // as it refuses us, so the first 403 is not an answer - reloading with that
    // cookie in hand is what gets through. Three tries is enough to tell that
    // apart from a block that is really aimed at this address.
    for (let attempt = 1; attempt <= 3; attempt++) {
      const nav = await p.goto(landing, { waitUntil: 'domcontentloaded', timeout });
      status = nav ? nav.status() : null;

      // The check runs while the page loads, so give it room before judging.
      await p.waitForTimeout(attempt === 1 ? 6000 : 4000);
      if (status !== 403) break;
    }

    if (status === 403) {
      const e = new Error(`403 refused the browser as well at ${host}`);
      e.blocked = true;
      e.status = 403;
      throw e;
    }
  }

  const res = await p.evaluate(
    async ([u, a]) => {
      try {
        const r = await fetch(u, { headers: { Accept: a } });
        return { status: r.status, body: await r.text() };
      } catch (err) {
        return { status: 0, body: '', error: String(err) };
      }
    },
    [url, accept]
  );

  if (res.status === 403) {
    const e = new Error('403 refused the browser as well');
    e.blocked = true;
    e.status = 403;
    throw e;
  }
  if (res.status === 0) throw new Error(`in-page request failed - ${res.error || 'no response'}`);
  if (res.status >= 400) throw new Error(`HTTP ${res.status} via browser`);

  return res.body;
}

/** Called once the fetch stage is over, so the run can exit. */
export async function closeSession() {
  if (!context) return;
  await context.close().catch(() => {});
  context = null;
  page = null;
  landedOn = null;
}
