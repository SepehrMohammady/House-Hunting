/**
 * Subito.it
 *
 * Their `hades` search API is open and returns structured feature flags, which
 * makes it the most reliable source for the two things the user cares about but
 * other portals bury in prose: /furnished and /air_conditioning.
 *
 * It is also the best source for private landlords (`advertiser.company === false`),
 * which means no agency commission.
 *
 * Genoa: region 3 (Liguria) / city 1 (Genova province) / town 010025 (Genova comune).
 * c=7 is "Appartamenti", t=u is "In affitto".
 */

import { fetchJson, sleep } from '../http.js';

const API = 'https://hades.subito.it/v1/search/items';
const PAGE_SIZE = 50;
const IMG_RULE = 'gallery-desktop-1x-auto';

/** Feature values arrive as "Sì" / "No" strings. */
function boolFeature(map, key) {
  const v = map[key];
  if (v == null) return null;
  const s = String(v).trim().toLowerCase();
  if (s === 'si' || s === 'sì' || s === 'yes') return true;
  if (s === 'no') return false;
  return null;
}

export async function fetchSubito(config, log) {
  const { maxPages } = config.sources.subito;
  const net = config.network;
  const listings = [];
  let blocked = false;

  for (let page = 0; page < maxPages; page++) {
    const params = new URLSearchParams({
      c: '7',
      t: 'u',
      r: '3',
      ci: '1',
      town: '010025',
      lim: String(PAGE_SIZE),
      start: String(page * PAGE_SIZE),
      qso: 'false',
      // Subito's price filter is inclusive and cheap to apply server-side.
      ps: '0',
      pe: String(config.budget.searchRentCap),
    });

    let data;
    try {
      data = await fetchJson(`${API}?${params}`, { Referer: 'https://www.subito.it/' }, net);
    } catch (err) {
      if (err.blocked) blocked = true;
      log.warn(`subito: page ${page + 1} failed - ${err.message}`);
      break;
    }

    const ads = data?.ads || [];
    if (!ads.length) break;

    for (const a of ads) {
      // features is a list of {uri, values:[{value}]} - flatten to a lookup.
      const f = {};
      for (const feat of a.features || []) {
        const vals = (feat.values || []).map((v) => v.value ?? v.key).filter(Boolean);
        if (vals.length) f[feat.uri] = vals.join(', ');
      }

      const geo = a.geo || {};
      const photos = (a.images || [])
        .slice(0, config.report.photosPerListing + 2)
        .map((im) => (im.cdn_base_url ? `${im.cdn_base_url}?rule=${IMG_RULE}` : null))
        .filter(Boolean);

      // The numeric ad id inside the urn, used for stable dedupe keys.
      const idMatch = String(a.urn || '').match(/id:ad:(\d+)/);

      listings.push({
        id: `subito:${idMatch ? idMatch[1] : a.urn}`,
        source: 'Subito.it',
        url: a.urls?.default || null,
        title: a.subject || null,
        caption: null,
        description: a.body || null,

        rentPerMonth: f['/price'] ?? null, // "700 €" - parsed downstream
        billsIncluded: null,

        rooms: f['/room'] ?? null,
        explicitBedrooms: null, // Subito reports total rooms only
        surfaceSqm: f['/size'] ?? null, // "55 mq"
        bathrooms: f['/bathrooms'] ?? null,
        floor: f['/floor'] ?? null,

        // Structured flags - Subito's real advantage over the other portals.
        furnished: boolFeature(f, '/furnished'),
        airConditioning: boolFeature(f, '/air_conditioning'),
        elevator: boolFeature(f, '/elevator'),
        balcony: boolFeature(f, '/balcony'),
        parking: f['/parking'] ? true : null,

        address: geo.town?.value || geo.city?.value || null,
        microzone: geo.zone?.value || null,
        macrozone: geo.town?.value || null,

        // Deliberately NOT geo.town.lat/lon. Subito publishes the comune
        // centroid, identical for every Genoa ad, so using it made every
        // listing land ~600 m from Molo and match that zone - Sampierdarena
        // and Molassana flats included. Subito ads carry their real
        // neighbourhood in the title instead, which the text matcher handles.
        lat: geo.zone?.lat ?? null,
        lon: geo.zone?.lon ?? null,
        coarseLocation: !geo.zone,

        contactName: a.advertiser?.name || null,
        contactPhone: null, // Subito routes contact through its own messaging
        contactPhones: [],
        contactType: a.advertiser?.company === false ? 'private' : 'agency',
        agencyUrl: null,

        photos,
        rawFeatures: Object.entries(f).map(([k, v]) => `${k.slice(1)}: ${v}`),
        postedAt: a.dates?.display_iso8601 || a.dates?.display || null,
      });
    }

    log.step(`subito: page ${page + 1} -> ${ads.length} ads (total ${listings.length})`);

    if (ads.length < PAGE_SIZE) break; // last page
    await sleep(net.requestDelayMs);
  }

  return { listings, blocked };
}
