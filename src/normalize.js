/**
 * Turns each portal's own shape into one common Listing, and reads the Italian
 * free text for the things the structured fields leave out.
 *
 * The unified Listing shape:
 * {
 *   id, source, url, title, caption, description,
 *   rentPerMonth, condoFeesPerMonth, billsIncluded,
 *   estimatedTotalPerMonth, costConfidence,
 *   bedrooms, rooms, surfaceSqm, bathrooms, floor,
 *   furnished, elevator, airConditioning, balcony, cellar, parking, renovated,
 *   address, microzone, macrozone, lat, lon,
 *   contactName, contactPhone, contactType, agencyUrl,
 *   photos: [url], firstSeen, lastSeen
 * }
 */

import { norm } from './zones.js';

/* ------------------------------------------------------------------ *
 * Italian feature vocabulary
 * ------------------------------------------------------------------ */

/**
 * True when `positive` appears without a negation right before it.
 * Italian ads say "non arredato" and "senza ascensore", so a naive
 * substring test would get both of those exactly backwards.
 */
function hasFeature(text, positive, negatives = []) {
  const t = norm(text);
  for (const neg of negatives) {
    if (new RegExp(neg).test(t)) return false;
  }
  if (positive.some((p) => new RegExp(p).test(t))) return true;

  // Tri-state on purpose. An ad that never mentions a lift is not an ad for a
  // flat without one - most Italian listings simply omit it. Returning false
  // here would print a confident "no lift" on half the report and would let the
  // preference scoring quietly penalise ads for being vague.
  return null;
}

export function detectFurnished(text) {
  const t = norm(text);
  // Check the explicit negatives first - they are decisive.
  if (/\bnon\s+arredat/.test(t)) return false;
  if (/\bnon\s+ammobiliat/.test(t)) return false;
  if (/\bda\s+arredare\b/.test(t)) return false;
  if (/\bvuoto\b/.test(t) && !/\barredat/.test(t)) return false;
  if (/\bsenza\s+arredamento\b/.test(t)) return false;
  // "parzialmente arredato" is a maybe, not a yes - report it as unknown.
  if (/\bparzialmente\s+arredat/.test(t)) return null;
  if (/\bsemi[\s-]?arredat/.test(t)) return null;
  if (/\barredat/.test(t) || /\bammobiliat/.test(t) || /\bmobiliat/.test(t)) return true;
  return null; // genuinely unknown
}

export function detectAirConditioning(text) {
  return hasFeature(
    text,
    [
      /\baria\s+condizionata\b/,
      /\bclimatizzat/,
      /\bclimatizzazione\b/,
      /\bcondizionator/,
      /\bpompa\s+di\s+calore\b/,
      /\baria\s+condiz/,
      /\bclima\b/,
      /\ba\/c\b/,
    ],
    [/\bsenza\s+aria\s+condizionata\b/, /\bno\s+clima/]
  );
}

export function detectElevator(text) {
  return hasFeature(text, [/\bascensore\b/, /\bascensori\b/], [
    /\bsenza\s+ascensore\b/,
    /\bno\s+ascensore\b/,
    /\bassenza\s+di\s+ascensore\b/,
    /\bprivo\s+di\s+ascensore\b/,
  ]);
}

export const detectBalcony = (t) =>
  hasFeature(t, [/\bbalcon/, /\bterrazz/, /\bveranda\b/]);
export const detectCellar = (t) => hasFeature(t, [/\bcantina\b/, /\bsoffitta\b/]);
export const detectParking = (t) =>
  hasFeature(t, [/\bposto\s+auto\b/, /\bbox\s+auto\b/, /\bgarage\b/, /\bautorimessa\b/]);
export const detectRenovated = (t) =>
  hasFeature(t, [/\bristrutturat/, /\bnuova\s+costruzione\b/, /\bnuovo\s+edificio\b/]);

/** Ads that fold utilities into the rent - a real budget win, so we detect it. */
export function detectBillsIncluded(text) {
  const t = norm(text);
  return (
    /\bspese\s+incluse\b/.test(t) ||
    /\bspese\s+comprese\b/.test(t) ||
    /\btutto\s+incluso\b/.test(t) ||
    /\butenze\s+incluse\b/.test(t) ||
    /\bincluse\s+nel\s+prezzo\b/.test(t) ||
    /\bcomprese\s+nel\s+canone\b/.test(t) ||
    /\ball[\s-]?inclusive\b/.test(t) ||
    /\bspese\s+condominiali\s+incluse\b/.test(t)
  );
}

/** Pull an explicit "spese condominiali EUR 80/mese" figure when the ad states one. */
export function extractCondoFees(text) {
  const t = norm(text);
  const m =
    t.match(/spese\s+condominiali[^0-9]{0,20}(\d{2,4})/) ||
    t.match(/spese\s+cond[^0-9]{0,20}(\d{2,4})/) ||
    t.match(/condominio[^0-9]{0,20}(\d{2,4})\s*(?:eur|euro|)/);
  if (!m) return null;
  const v = parseInt(m[1], 10);
  // Sanity-check: monthly condo fees outside this band are almost certainly
  // an annual figure or a misparse.
  return v >= 20 && v <= 500 ? v : null;
}

/* ------------------------------------------------------------------ *
 * Numbers
 * ------------------------------------------------------------------ */

/** "1.250 EUR/mese" -> 1250. Italian uses "." as the thousands separator. */
export function parsePrice(raw) {
  if (raw == null) return null;
  if (typeof raw === 'number') return Number.isFinite(raw) ? Math.round(raw) : null;
  const cleaned = String(raw).replace(/[^\d.,]/g, '');
  if (!cleaned) return null;
  // Drop thousands separators, then normalise the decimal comma.
  const n = parseFloat(cleaned.replace(/\.(?=\d{3}\b)/g, '').replace(',', '.'));
  return Number.isFinite(n) ? Math.round(n) : null;
}

export function parseSurface(raw) {
  if (raw == null) return null;
  if (typeof raw === 'number') return Number.isFinite(raw) ? Math.round(raw) : null;
  const m = String(raw).match(/(\d[\d.,]*)/);
  if (!m) return null;
  const n = parseFloat(m[1].replace(/\./g, '').replace(',', '.'));
  return Number.isFinite(n) ? Math.round(n) : null;
}

/**
 * Work out the bedroom count.
 *
 * This is the single most important conversion in the project. Italian ads count
 * TOTAL rooms ("locali") - living room included - not bedrooms:
 *   bilocale     = 2 locali = 1 bedroom
 *   trilocale    = 3 locali = 2 bedrooms   <-- what the user wants
 *   quadrilocale = 4 locali = 3 bedrooms
 * Searching for "2" without this conversion returns one-bedroom flats.
 */
export function inferBedrooms({ explicitBedrooms, rooms, text }) {
  const n = parseInt(explicitBedrooms, 10);
  // `rooms` may be a bucket label like "5+", which parses to 5 - close enough.
  const r = parseInt(rooms, 10);

  // Immobiliare's bedroom count is usually the best figure available, and often
  // beats "locali - 1": plenty of genuine trilocali have a dining room and only
  // one bedroom. Measured against live data it is right except when it equals or
  // exceeds the room count - a "bilocale" claiming 2 bedrooms leaves no living
  // room, so that reading is impossible and we fall through to the text.
  if (Number.isFinite(n) && n > 0 && n < 12) {
    if (!Number.isFinite(r) || n < r) return n;
  }

  const t = norm(text);

  // An explicit "2 camere da letto" beats any inference from room counts.
  const cam = t.match(/(\d+)\s*camer[ae](?:\s+da\s+letto)?/);
  if (cam) {
    const c = parseInt(cam[1], 10);
    if (c > 0 && c < 12) return c;
  }
  if (/\bmonolocale\b/.test(t)) return 0; // studio: no separate bedroom
  if (/\bbilocale\b/.test(t)) return 1;
  if (/\btrilocale\b/.test(t)) return 2;
  if (/\bquadrilocale\b/.test(t)) return 3;
  if (/\bcinque\s+locali\b/.test(t) || /\b5\s+locali\b/.test(t)) return 4;

  // Fall back to total rooms minus the living room.
  // "5+" is a bucket, not a count: parseInt gives 5, but the flat may have any
  // number of rooms at or above that, so no honest bedroom figure exists.
  const isBucket = typeof rooms === 'string' && rooms.includes('+');
  if (!isBucket && Number.isFinite(r) && r > 0 && r < 6) {
    return Math.max(0, r - 1);
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Cost model
 * ------------------------------------------------------------------ */

/**
 * The user's EUR 1000 ceiling covers rent + condo fees + utilities, but portals
 * advertise rent alone. We reconstruct the all-in figure and record how much of
 * it is measured versus assumed, so the report can be honest about the guess.
 */
export function estimateTotalCost(listing, budget) {
  const rent = listing.rentPerMonth;
  if (!Number.isFinite(rent)) {
    return { total: null, confidence: 'unknown', breakdown: null };
  }

  if (listing.billsIncluded) {
    return {
      total: rent,
      confidence: 'stated',
      breakdown: { rent, condo: 0, utilities: 0, note: 'ad says bills included' },
    };
  }

  const condoKnown = Number.isFinite(listing.condoFeesPerMonth);
  const condo = condoKnown ? listing.condoFeesPerMonth : budget.assumedCondoFeesPerMonth;
  const utilities = budget.assumedUtilitiesPerMonth;

  return {
    total: rent + condo + utilities,
    confidence: condoKnown ? 'partly-estimated' : 'estimated',
    breakdown: {
      rent,
      condo,
      utilities,
      note: condoKnown
        ? 'condo fees from ad, utilities estimated'
        : 'condo fees and utilities both estimated',
    },
  };
}

/** Everything we scan for keywords: title, caption and body in one string. */
export function textBlob(l) {
  return [l.title, l.caption, l.description, l.address, (l.rawFeatures || []).join(' ')]
    .filter(Boolean)
    .join(' . ');
}

/**
 * Fill in derived fields once a source adapter has produced the raw shape.
 * Structured booleans from the portal win; free-text detection only fills gaps.
 */
export function enrich(listing, config) {
  const blob = textBlob(listing);

  if (listing.furnished === undefined || listing.furnished === null) {
    listing.furnished = detectFurnished(blob);
  }
  if (listing.elevator === undefined || listing.elevator === null) {
    listing.elevator = detectElevator(blob);
  }
  if (listing.airConditioning === undefined || listing.airConditioning === null) {
    listing.airConditioning = detectAirConditioning(blob);
  }
  if (listing.balcony == null) listing.balcony = detectBalcony(blob);
  if (listing.cellar == null) listing.cellar = detectCellar(blob);
  if (listing.parking == null) listing.parking = detectParking(blob);
  if (listing.renovated == null) listing.renovated = detectRenovated(blob);
  if (listing.billsIncluded == null) listing.billsIncluded = detectBillsIncluded(blob);
  if (listing.condoFeesPerMonth == null) {
    listing.condoFeesPerMonth = extractCondoFees(blob);
  }

  if (listing.bedrooms == null) {
    listing.bedrooms = inferBedrooms({
      explicitBedrooms: listing.explicitBedrooms,
      rooms: listing.rooms,
      text: blob,
    });
  }

  const cost = estimateTotalCost(listing, config.budget);
  listing.estimatedTotalPerMonth = cost.total;
  listing.costConfidence = cost.confidence;
  listing.costBreakdown = cost.breakdown;

  return listing;
}
