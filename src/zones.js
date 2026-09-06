/**
 * Genoa neighbourhood matching.
 *
 * The user's 12 target areas are a mix of three different things, and each needs
 * a different matching strategy:
 *
 *   1. Portal "microzones"  - Albaro, Manin, Molo, Foce, Carignano, San Martino,
 *                             San Vincenzo. Immobiliare tags these directly, so an
 *                             exact name match is reliable.
 *   2. Streets / squares    - Via Assarotti, Via XX Settembre, Corso Europa, Via Torti.
 *                             No portal tags these, so we match the address text.
 *   3. Landmarks            - Brignole (a station, not a district). Address text plus
 *                             a tight GPS radius.
 *
 * Every zone therefore carries: exact microzone names, address regexes, and a
 * centroid+radius fallback for ads that only publish coordinates.
 */

const DEG = Math.PI / 180;

/** Great-circle distance in metres. */
export function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * DEG;
  const dLon = (lon2 - lon1) * DEG;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/**
 * Strip accents and collapse whitespace so "Sant'Ilario", "SAN  MARTINO" and
 * "san martino" all compare equal.
 */
export function norm(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // drop combining accents: "Pre" stays "pre"
    .toLowerCase()
    .replace(/['`’]/g, ' ') // apostrophes: "Sant'Ilario" -> "sant ilario"
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Genoa's central districts are roughly 300-400 m across, so radii are tight.
 * An early version used 500-900 m and produced confident nonsense: Pre' flats
 * labelled Molo, Marassi flats labelled Piazza Manin.
 *
 * Patterns list only streets genuinely IN the area. Whole-district aliases were
 * removed after "San Fruttuoso" under Via Torti swept in the entire district,
 * and no pattern may appear under two zones - the first match would win
 * arbitrarily.
 */
export const ZONES = [
  {
    key: 'albaro',
    label: 'Albaro',
    microzones: ['albaro'],
    macrozones: ['albaro, sturla'],
    patterns: [/\balbaro\b/, /\bpuggia\b/, /\bcaprera\b/, /\bmontallegro\b/],
    centroid: { lat: 44.3925, lon: 8.9686 },
    radius: 750,
  },
  {
    key: 'manin',
    label: 'Piazza Manin',
    microzones: ['manin'],
    macrozones: [],
    // Via Marcello Durazzo runs off Piazza Manin - confirmed against live ads.
    patterns: [/\bmanin\b/, /\bmarcello durazzo\b/],
    centroid: { lat: 44.4166, lon: 8.9497 },
    radius: 450,
  },
  {
    key: 'assarotti',
    label: 'Via Assarotti',
    microzones: [],
    macrozones: [],
    // Assarotti runs Corvetto -> Manin. Portals file it under Castelletto, a much
    // larger area, so the street name does the work and GPS stays tight.
    patterns: [/\bassarotti\b/, /\bcorvetto\b/, /\bpeschiera\b/],
    centroid: { lat: 44.4133, lon: 8.945 },
    radius: 350,
  },
  {
    key: 'xxsettembre',
    label: 'Via XX Settembre',
    microzones: [],
    macrozones: [],
    // "colombo" was removed: Via Colombo sits nearer San Vincenzo and was
    // matching both zones depending on iteration order.
    patterns: [/\bxx settembre\b/, /\bventi settembre\b/, /\bxxsettembre\b/, /\bde ferrari\b/],
    centroid: { lat: 44.4053, lon: 8.9375 },
    radius: 400,
  },
  {
    key: 'carignano',
    label: 'Carignano',
    microzones: ['carignano'],
    macrozones: [],
    patterns: [/\bcarignano\b/, /\bcorso aurelio saffi\b/, /\bstalingrado\b/],
    centroid: { lat: 44.3985, lon: 8.9375 },
    radius: 450,
  },
  {
    key: 'molo',
    label: 'Molo',
    microzones: ['molo', 'caricamento'],
    macrozones: [],
    // "maddalena" dropped - it is a distinct centro storico quarter, not Molo.
    // Pre' is deliberately absent for the same reason.
    patterns: [/\bmolo\b/, /\bcaricamento\b/, /\bporto antico\b/, /\bsarzano\b/],
    centroid: { lat: 44.4085, lon: 8.9265 },
    radius: 400,
  },
  {
    key: 'foce',
    label: 'Foce',
    microzones: ['foce'],
    macrozones: [],
    patterns: [/\bfoce\b/, /\brossetti\b/, /\bcorso buenos aires\b/, /\bbarabino\b/],
    centroid: { lat: 44.3975, lon: 8.9515 },
    radius: 550,
  },
  {
    key: 'corsoeuropa',
    label: 'Corso Europa',
    microzones: [],
    macrozones: [],
    // A long arterial road: the street name carries the match, and the GPS
    // fallback is tight so it cannot swallow half of eastern Genoa.
    patterns: [/\bcorso europa\b/],
    centroid: { lat: 44.3945, lon: 8.985 },
    radius: 500,
  },
  {
    key: 'brignole',
    label: 'Brignole',
    microzones: [],
    macrozones: [],
    // "serra" and "galata" removed - both are generic and collided with
    // San Vincenzo, which is the better home for Via Galata.
    patterns: [/\bbrignole\b/, /\bpiazza verdi\b/],
    centroid: { lat: 44.4072, lon: 8.9428 },
    radius: 400,
  },
  {
    key: 'sanmartino',
    label: 'San Martino',
    microzones: ['san martino'],
    macrozones: ['san martino, borgoratti'],
    patterns: [/\bsan martino\b/, /\bbenedetto xv\b/],
    centroid: { lat: 44.4013, lon: 8.9718 },
    radius: 600,
  },
  {
    key: 'sanvincenzo',
    label: 'San Vincenzo',
    microzones: ['san vincenzo'],
    macrozones: [],
    patterns: [/\bsan vincenzo\b/, /\bgalata\b/],
    centroid: { lat: 44.4062, lon: 8.94 },
    radius: 400,
  },
  {
    key: 'torti',
    label: 'Via Torti',
    microzones: [],
    macrozones: [],
    // District aliases removed: "san fruttuoso" pulled in the whole district.
    patterns: [/\btorti\b/],
    centroid: { lat: 44.4022, lon: 8.9585 },
    radius: 450,
  },
];

/**
 * Genoa neighbourhoods that are explicitly NOT targets.
 *
 * When a portal tags a listing with one of these, it is making a positive claim
 * about a different area, and a loose GPS hit must not silently overrule it -
 * Pre' and Molo are adjacent but not interchangeable. Presence here forces the
 * much tighter GPS threshold in tier 3.
 */
const NON_TARGET_MICROZONES = new Set([
  'pre', 'maddalena', 'castelletto', 'centro citta', 'quadrilatero', 'principe',
  'carmine', 'marassi', 'san fruttuoso', 'quezzi', 'staglieno', 'terralba',
  'borgoratti', 'sturla', 'quarto', 'quinto', 'nervi', 'sant ilario',
  'sampierdarena', 'sestri ponente', 'cornigliano', 'pegli', 'multedo', 'pra',
  'voltri', 'oregina', 'lagaccio', 'granarolo', 'righi', 'dinegro',
  'san teodoro', 'rivarolo', 'certosa', 'bolzaneto', 'pontedecimo',
  'molassana', 'struppa', 'belvedere', 'vesima - crevari',
]);

/** Metres. A GPS hit may only overrule an explicit non-target tag inside this. */
const TIGHT_GPS_OVERRIDE = 300;

const BY_KEY = new Map(ZONES.map((z) => [z.key, z]));
export const zoneByKey = (k) => BY_KEY.get(k);

/**
 * Decide which target zone a listing belongs to.
 *
 * Returns { zone, confidence, via } where confidence is 0..1 and `via` explains
 * the evidence used, so the report can show why a listing was included.
 * Returns null when nothing matched.
 */
export function matchZone(listing, opts = {}) {
  const enabledKeys = opts.enabledKeys || null;
  const gpsRadius = opts.gpsFallbackRadiusMeters || 700;

  const zones = enabledKeys
    ? ZONES.filter((z) => enabledKeys.includes(z.key))
    : ZONES;

  const micro = norm(listing.microzone);
  const macro = norm(listing.macrozone);
  // Address first, then title/caption - the street name is often only in the title.
  const text = norm(
    [listing.address, listing.title, listing.caption].filter(Boolean).join(' ')
  );

  // --- Tier 1: exact microzone tag. Strongest signal a portal gives us. ---
  if (micro) {
    for (const z of zones) {
      if (z.microzones.includes(micro)) {
        return { zone: z, confidence: 1.0, via: `zone tag "${listing.microzone}"` };
      }
    }
  }

  // --- Tier 2: street / landmark name in the address or title. ---
  const contradictedByPortal = micro && NON_TARGET_MICROZONES.has(micro);

  for (const z of zones) {
    for (const re of z.patterns) {
      if (!re.test(text)) continue;

      const inAddress = re.test(norm(listing.address));
      if (inAddress) {
        return { zone: z, confidence: 0.95, via: 'street name in address' };
      }

      // Hit came from the title or the agency's marketing headline. Agencies
      // name the nearest desirable landmark on purpose - a real ad for a flat in
      // Staglieno opens "Manin inizio Montaldo". That is not a lie (the street
      // does start at Piazza Manin) but it is weaker than the portal's own tag,
      // so when the two disagree we keep the match and mark it down rather than
      // presenting the agency's framing as fact.
      return contradictedByPortal
        ? {
            zone: z,
            confidence: 0.45,
            via: `advertised as ${z.label}, portal says ${listing.microzone}`,
            disputed: true,
          }
        : { zone: z, confidence: 0.75, via: 'street name in title' };
    }
  }

  // --- Tier 3: GPS proximity. Catches ads with a vague address but real coords. ---
  // `coarseLocation` means the source gave a city/comune centroid rather than the
  // flat's own position. Those coordinates are identical for every ad from that
  // source, so matching on them assigns the whole feed to whichever zone happens
  // to sit nearest the centroid. Never trust them for zone matching.
  if (!listing.coarseLocation && Number.isFinite(listing.lat) && Number.isFinite(listing.lon)) {
    // Each zone has its own tuned radius (Albaro is genuinely bigger than
    // Assarotti). The config value scales them all proportionally rather than
    // flattening them to one number, so tuning it stays predictable.
    const scale = gpsRadius / 700;

    // The portal has named a different neighbourhood. Believe it unless the
    // coordinates put the flat practically on top of a target - which is the
    // real case for streets inside a bigger district, e.g. Via Assarotti
    // sitting inside Castelletto.
    const contradicts = micro && NON_TARGET_MICROZONES.has(micro);

    let best = null;
    for (const z of zones) {
      const d = haversineMeters(listing.lat, listing.lon, z.centroid.lat, z.centroid.lon);
      const limit = contradicts
        ? Math.min(TIGHT_GPS_OVERRIDE, z.radius * scale)
        : z.radius * scale;
      if (d <= limit && (!best || d < best.d)) best = { z, d };
    }
    if (best) {
      return {
        zone: best.z,
        // A hit that had to overrule an explicit tag is inherently less certain.
        confidence: contradicts ? 0.55 : 0.65,
        via: `${Math.round(best.d)} m from ${best.z.label}`,
      };
    }
  }

  // --- Tier 4: broad macrozone. Only when the portal gave us nothing finer. ---
  // Macrozones are combined labels like "Albaro, Sturla" and "San Martino,
  // Borgoratti". If the portal already said "Sturla", it has told us the flat is
  // in the half we did NOT ask for, so this tier must not claim it.
  if (macro && !micro) {
    for (const z of zones) {
      if (z.macrozones.includes(macro)) {
        return { zone: z, confidence: 0.5, via: `district "${listing.macrozone}"` };
      }
    }
  }

  return null;
}

/** Distance from the listing to the nearest target zone, for the "Nearby" section. */
export function nearestZoneDistance(listing) {
  if (!Number.isFinite(listing.lat) || !Number.isFinite(listing.lon)) return null;
  let best = null;
  for (const z of ZONES) {
    const d = haversineMeters(listing.lat, listing.lon, z.centroid.lat, z.centroid.lon);
    if (!best || d < best.meters) best = { zone: z, meters: Math.round(d) };
  }
  return best;
}
