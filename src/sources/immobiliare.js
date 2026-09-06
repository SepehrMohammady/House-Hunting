/**
 * Immobiliare.it
 *
 * The public website sits behind DataDome, but its internal `api-next` JSON
 * endpoint is reachable with ordinary headers and returns far better data than
 * the HTML would: exact bedroom counts, an elevator flag, neighbourhood tags,
 * GPS, agency phone numbers and photo sets.
 *
 * Genoa identifiers, resolved from their geography autocomplete API:
 *   region lig / province GE / comune 6846
 *   idContratto 2 = rent, idCategoria 1 = residential
 */

import { fetchJson, sleep } from '../http.js';

const API = 'https://www.immobiliare.it/api-next/search-list/listings/';
const REFERER = 'https://www.immobiliare.it/affitto-case/genova/';

/** A floor plan tells you nothing about whether you want to live somewhere. */
const isFloorPlan = (caption) => /planimetri|piantina|mappa/i.test(caption || '');

function pickPhotos(property, limit) {
  const photos = property?.multimedia?.photos || [];

  // Ads often lead with the floor plan, which then becomes the thumbnail in the
  // report. Sort real photos ahead of plans while keeping the original order
  // within each group, so the first image is something you can actually judge.
  const ordered = [
    ...photos.filter((p) => !isFloorPlan(p?.caption)),
    ...photos.filter((p) => isFloorPlan(p?.caption)),
  ];

  const out = [];
  for (const p of ordered) {
    // Prefer the largest variant the ad offers; these keys vary by listing age.
    const u = p?.urls?.large || p?.urls?.medium || p?.urls?.small;
    if (u) out.push(u);
    if (out.length >= limit) break;
  }

  if (!out.length && property?.photo?.urls) {
    const u =
      property.photo.urls.large || property.photo.urls.medium || property.photo.urls.small;
    if (u) out.push(u);
  }
  return out;
}

function pickContact(advertiser) {
  const agency = advertiser?.agency;
  const agent = advertiser?.agent;

  const phones = []
    .concat(agency?.phones || [], agent?.phones || [])
    .map((p) => p?.value)
    .filter(Boolean);

  return {
    contactName:
      agent?.displayName || agency?.displayName || (advertiser ? 'Privato' : null),
    contactPhone: phones[0] || null,
    contactPhones: [...new Set(phones)],
    // `label` is "agenzia" for agencies; anything else is effectively a private ad.
    contactType: agency?.label === 'agenzia' || agency ? 'agency' : 'private',
    agencyUrl: agency?.agencyUrl || null,
  };
}

export async function fetchImmobiliare(config, log) {
  const { maxPages } = config.sources.immobiliare;
  const net = config.network;
  const listings = [];
  let blocked = false;

  for (let page = 1; page <= maxPages; page++) {
    const params = new URLSearchParams({
      fkRegione: 'lig',
      idProvincia: 'GE',
      idComune: '6846',
      idContratto: '2',
      idCategoria: '1',
      criterio: 'rilevanza',
      __lang: 'it',
      pag: String(page),
      paramsCount: '1',
      path: '/affitto-case/genova/',
      prezzoMassimo: String(config.budget.searchRentCap),
    });

    let data;
    try {
      data = await fetchJson(`${API}?${params}`, { Referer: REFERER }, net);
    } catch (err) {
      if (err.blocked) {
        blocked = true;
        log.warn(`immobiliare: blocked at page ${page} - ${err.message}`);
      } else {
        log.warn(`immobiliare: page ${page} failed - ${err.message}`);
      }
      break;
    }

    const results = data?.results || [];
    if (!results.length) break;

    for (const r of results) {
      const re = r.realEstate;
      if (!re) continue;
      const prop = (re.properties || [])[0] || {};
      const loc = prop.location || {};
      const contact = pickContact(re.advertiser);

      listings.push({
        id: `immobiliare:${re.id}`,
        source: 'Immobiliare.it',
        url: r.seo?.url || `https://www.immobiliare.it/annunci/${re.id}/`,
        title: re.title || prop.caption || null,
        caption: prop.caption || null,
        description: null, // only on the detail page; the list view is enough to filter

        rentPerMonth: re.price?.value ?? null,
        billsIncluded: null, // inferred from text later

        rooms: prop.rooms ?? null,
        explicitBedrooms: prop.bedRoomsNumber ?? null,
        surfaceSqm: prop.surface ?? null,
        bathrooms: prop.bathrooms ?? null,
        floor: prop.floor?.value || prop.floor?.abbreviation || null,

        // Structured flags from the portal beat any text guess.
        elevator: typeof prop.elevator === 'boolean' ? prop.elevator : null,
        furnished: null,
        airConditioning: null,

        address: loc.address || null,
        microzone: loc.microzone || null,
        macrozone: loc.macrozone || null,
        lat: loc.latitude ?? null,
        lon: loc.longitude ?? null,

        ...contact,

        photos: pickPhotos(prop, config.report.photosPerListing + 2),
        rawFeatures: (prop.featureList || []).map((f) => f.label).filter(Boolean),
        isNew: !!re.isNew,
      });
    }

    log.step(`immobiliare: page ${page} -> ${results.length} ads (total ${listings.length})`);

    if (data.maxPages && page >= data.maxPages) break;
    await sleep(net.requestDelayMs);
  }

  return { listings, blocked };
}
