/**
 * Casa.it
 *
 * No public JSON API, but the server-rendered page embeds its whole Redux store
 * in `window.__INITIAL_STATE__ = JSON.parse("...")`. That store carries the full
 * listing objects - including the agency phone number and the long description,
 * which is where "arredato" and "aria condizionata" usually hide.
 *
 * Verified query params: ?priceMax=<eur> and ?page=<n> (20 results per page).
 * Note it is `priceMax`, not `prezzoMax` - the Italian-looking variants are
 * silently ignored and you get unfiltered results back.
 */

import { fetchText, sleep } from '../http.js';

const BASE = 'https://www.casa.it/affitto/residenziale/genova';
const IMG_PREFIX = 'https://images-1.casa.it/720x540';
const PAGE_SIZE = 20;

const QUOTE = String.fromCharCode(34);
const BACKSLASH = String.fromCharCode(92);

/**
 * Pull the embedded store out of the HTML.
 *
 * The payload is a JS string literal passed to JSON.parse, so it is
 * double-encoded: we walk the literal respecting backslash escapes to find its
 * true end, then parse twice. A greedy regex breaks here because listing
 * descriptions routinely contain escaped quotes.
 */
function extractState(html) {
  const marker = 'window.__INITIAL_STATE__ = JSON.parse(';
  const at = html.indexOf(marker);
  if (at < 0) return null;

  const start = html.indexOf(QUOTE, at);
  if (start < 0) return null;

  let end = start + 1;
  let escaped = false;
  while (end < html.length) {
    const ch = html[end];
    if (escaped) escaped = false;
    else if (ch === BACKSLASH) escaped = true;
    else if (ch === QUOTE) break;
    end++;
  }

  try {
    return JSON.parse(JSON.parse(html.slice(start, end + 1)));
  } catch {
    return null;
  }
}

export async function fetchCasa(config, log) {
  const { maxPages } = config.sources.casa;
  const net = config.network;
  const listings = [];
  let blocked = false;

  for (let page = 1; page <= maxPages; page++) {
    const url = `${BASE}?priceMax=${config.budget.searchRentCap}&page=${page}`;

    let state;
    try {
      const html = await fetchText(url, { Referer: 'https://www.casa.it/' }, net);
      state = extractState(html);
    } catch (err) {
      if (err.blocked) blocked = true;
      log.warn(`casa: page ${page} failed - ${err.message}`);
      break;
    }

    if (!state?.search) {
      log.warn(`casa: page ${page} - could not read embedded state (layout may have changed)`);
      break;
    }

    const items = state.search.list || [];
    if (!items.length) break;

    for (const it of items) {
      const f = it.features || {};
      const g = it.geoInfos || {};
      const pub = it.publisher || {};

      const photos = (it.media?.items || [])
        .slice(0, config.report.photosPerListing + 2)
        .map((m) => (m.uri ? `${IMG_PREFIX}${m.uri}` : null))
        .filter(Boolean);

      // district_name is the wide district, block_name the tighter neighbourhood.
      // title.additional often repeats the block, so it is a useful third signal.
      const additional = Array.isArray(it.title?.additional)
        ? it.title.additional.join(', ')
        : null;

      listings.push({
        id: `casa:${it.id}`,
        source: 'Casa.it',
        url: it.uri ? `https://www.casa.it${it.uri}` : null,
        title: it.title?.main || null,
        caption: additional,
        description: it.description || null,

        rentPerMonth: f.price?.marker?.originalPrice ?? f.price?.value ?? null,
        billsIncluded: null,

        rooms: f.rooms ?? null,
        explicitBedrooms: null, // Casa.it reports total rooms only
        surfaceSqm: f.mq ?? null,
        bathrooms: f.bathrooms ?? null,
        floor: f.level || null,

        furnished: null,
        elevator: null,
        airConditioning: null,
        parking: f.parkings ? true : null,

        address: g.street || g.block_name || g.district_name || null,
        microzone: g.block_name || null,
        macrozone: g.district_name || null,
        lat: g.lat ?? null,
        lon: g.lon ?? null,

        contactName: pub.publisherName || null,
        contactPhone: pub.publisherPhone || null,
        contactPhones: pub.publisherPhone ? [pub.publisherPhone] : [],
        contactType: pub.publisherType === 'Agency' ? 'agency' : 'private',
        agencyUrl: pub.publisherSlug
          ? `https://www.casa.it/agenzie/${pub.publisherSlug}`
          : null,

        photos,
        rawFeatures: [additional, f.level, f.energyClass].filter(Boolean),
      });
    }

    log.step(`casa: page ${page} -> ${items.length} ads (total ${listings.length})`);

    const totalPages = state.search.paginator?.totalPages;
    if (items.length < PAGE_SIZE) break;
    if (totalPages && page >= totalPages) break;
    await sleep(net.requestDelayMs);
  }

  return { listings, blocked };
}
