/**
 * Cross-portal duplicate collapsing.
 *
 * Agencies list the same flat on Immobiliare, Casa and Idealista at once, so a
 * raw merge shows the same apartment three times. There is no shared id, so we
 * match on the physical facts an agency cannot vary: rent, floor area, and
 * either location or phone number.
 *
 * Survivors keep a `alsoOn` list, which is genuinely useful - seeing one flat on
 * three portals is a hint it has been sitting unrented for a while.
 */

import { haversineMeters, norm } from './zones.js';

// Prefer the portal that gives us the most to work with: Immobiliare has exact
// bedroom counts and phones, Subito has structured furnished/AC flags.
const SOURCE_RANK = {
  'Immobiliare.it': 4,
  'Casa.it': 3,
  'Subito.it': 2,
  'Idealista.it': 1,
};

const digits = (s) => String(s || '').replace(/\D/g, '');

function sameArea(a, b) {
  if (Number.isFinite(a.surfaceSqm) && Number.isFinite(b.surfaceSqm)) {
    // Portals round differently; 3 m2 of slack absorbs that.
    return Math.abs(a.surfaceSqm - b.surfaceSqm) <= 3;
  }
  return false;
}

function sameSpot(a, b) {
  if (
    Number.isFinite(a.lat) &&
    Number.isFinite(a.lon) &&
    Number.isFinite(b.lat) &&
    Number.isFinite(b.lon)
  ) {
    // Portals fuzz exact coordinates for privacy, so this cannot be tight.
    return haversineMeters(a.lat, a.lon, b.lat, b.lon) < 150;
  }
  return false;
}

/**
 * Reduce an address to a comparable street token: drop the street-type word and
 * any house number, so "Via Napoli 10" and "via Napoli, 10" both become "napoli".
 */
function streetKey(listing) {
  const raw = listing.address || '';
  if (!raw) return null;
  let s = norm(raw)
    .replace(
      /\b(via|viale|piazza|piazzale|salita|corso|vico|largo|calata|passo|scalinata|strada|lungomare|mura|ponte|galleria)\b/g,
      ' '
    )
    .replace(/\d+/g, ' ')
    // Strip punctuation too, or "Via Napoli 10" and "Via Napoli, 10" produce
    // "napoli" and "napoli," and never compare equal.
    .replace(/[^a-z ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // Very short tokens ("nord", "sud") are too generic to identify a flat.
  return s.length >= 5 ? s : null;
}

function sameStreet(a, b) {
  const ka = streetKey(a);
  const kb = streetKey(b);
  return !!ka && ka === kb;
}

function samePhone(a, b) {
  const pa = new Set((a.contactPhones || []).map(digits).filter((d) => d.length >= 8));
  if (!pa.size) return false;
  return (b.contactPhones || [])
    .map(digits)
    .some((d) => d.length >= 8 && pa.has(d));
}

/** Two listings are the same flat if rent AND area match, plus place or phone. */
function isDuplicate(a, b) {
  if (!Number.isFinite(a.rentPerMonth) || !Number.isFinite(b.rentPerMonth)) return false;
  if (a.rentPerMonth !== b.rentPerMonth) return false;
  if (!sameArea(a, b)) return false;
  // Rent+area alone collides constantly - round prices and common sizes repeat.
  // Require a third, independent signal: same place, same phone, or same street.
  // Street is what catches Idealista, which publishes neither coordinates nor
  // a phone number in its list view.
  return sameSpot(a, b) || samePhone(a, b) || sameStreet(a, b);
}

/** Fold `dup` into `keep`, filling gaps rather than overwriting good data. */
function merge(keep, dup) {
  const fillable = [
    'description', 'address', 'microzone', 'macrozone', 'lat', 'lon',
    'bathrooms', 'floor', 'surfaceSqm', 'rooms', 'contactName', 'contactPhone',
    'agencyUrl', 'condoFeesPerMonth',
  ];
  for (const k of fillable) {
    if (keep[k] == null && dup[k] != null) keep[k] = dup[k];
  }

  // Tri-state booleans: a definite true/false beats an unknown null.
  for (const k of ['furnished', 'elevator', 'airConditioning', 'balcony', 'cellar', 'parking', 'renovated', 'billsIncluded']) {
    if (keep[k] == null && dup[k] != null) keep[k] = dup[k];
  }

  if ((dup.photos?.length || 0) > (keep.photos?.length || 0)) keep.photos = dup.photos;

  keep.contactPhones = [...new Set([...(keep.contactPhones || []), ...(dup.contactPhones || [])])];
  if (!keep.contactPhone && keep.contactPhones.length) keep.contactPhone = keep.contactPhones[0];

  keep.alsoOn = keep.alsoOn || [];
  if (!keep.alsoOn.some((x) => x.source === dup.source)) {
    keep.alsoOn.push({ source: dup.source, url: dup.url });
  }
  return keep;
}

export function dedupe(listings) {
  // Best source first, so the richer record is the one that survives.
  const sorted = [...listings].sort(
    (a, b) => (SOURCE_RANK[b.source] || 0) - (SOURCE_RANK[a.source] || 0)
  );

  const kept = [];
  let removed = 0;

  // isDuplicate requires identical rent, so bucketing on rent is exact and keeps
  // this linear-ish instead of comparing every listing against every other one.
  const byRent = new Map();

  for (const l of sorted) {
    const bucket = byRent.get(l.rentPerMonth);
    const hit = bucket && bucket.find((k) => isDuplicate(k, l));
    if (hit) {
      merge(hit, l);
      removed++;
    } else {
      kept.push(l);
      if (bucket) bucket.push(l);
      else byRent.set(l.rentPerMonth, [l]);
    }
  }

  return { listings: kept, removed };
}
