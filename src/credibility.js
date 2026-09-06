/**
 * Scam and lead-farm detection.
 *
 * Rental fraud is common on open-posting portals: an advert shows a large,
 * cheap, fully-equipped flat, and the "landlord" asks for a deposit before any
 * viewing. This module flags the pattern rather than hiding the listing, because
 * a few genuine bargains look the same and the user should make that call.
 *
 * Thresholds are measured, not guessed. Against 448 listings from the
 * established portals (Immobiliare + Casa) the Genoa market ran:
 *     median 10.0 EUR/m2, 5th percentile 6.5, 1st percentile 5.3
 * so below 6 EUR/m2 is the bottom ~2.5% of the market - unusual enough to be
 * worth a warning, common enough that it cannot be an automatic rejection.
 *
 * The trigger for writing this: one advertiser posted 84 of 202 Subito ads in a
 * single run, every implausibly cheap listing in the feed was theirs, and all of
 * them claimed furnished + lift + air conditioning in identical wording.
 */

const CHEAP_EUR_PER_SQM = 6.0; // bottom ~2.5% of the measured Genoa market
const VERY_CHEAP_EUR_PER_SQM = 4.5; // below the 1st percentile
const BULK_POSTER_MIN_ADS = 20; // absolute floor before "bulk" means anything
const BULK_POSTER_SHARE = 0.2; // ...and this share of a single source's feed

const digits = (s) => String(s || '').replace(/\D/g, '');

/**
 * Annotate every listing with `warnings` and a `credibilityPenalty`.
 * Runs across the whole batch because bulk-posting is only visible in aggregate.
 */
export function assessCredibility(listings) {
  // --- Pass 1: how many ads does each advertiser have, per source? ---
  const counts = new Map(); // "source|advertiser" -> count
  const perSource = new Map(); // source -> total ads

  for (const l of listings) {
    const advertiser = (l.contactName || digits(l.contactPhone) || '').toLowerCase().trim();
    if (advertiser) {
      const key = `${l.source}|${advertiser}`;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    perSource.set(l.source, (perSource.get(l.source) || 0) + 1);
  }

  // --- Pass 2: flag each listing ---
  const stats = { bulk: 0, cheap: 0, suspicious: 0 };

  for (const l of listings) {
    const warnings = [];
    let penalty = 0;

    // Rent per square metre, the single most useful fraud signal.
    if (Number.isFinite(l.rentPerMonth) && Number.isFinite(l.surfaceSqm) && l.surfaceSqm >= 30) {
      l.pricePerSqm = +(l.rentPerMonth / l.surfaceSqm).toFixed(1);

      if (l.pricePerSqm < VERY_CHEAP_EUR_PER_SQM) {
        warnings.push(`only €${l.pricePerSqm}/m² - far below market, verify carefully`);
        penalty += 45;
        stats.cheap++;
      } else if (l.pricePerSqm < CHEAP_EUR_PER_SQM) {
        warnings.push(`€${l.pricePerSqm}/m² is well below the €10 median`);
        penalty += 20;
        stats.cheap++;
      }
    }

    // Bulk posting: one advertiser dominating a source's feed.
    const advertiser = (l.contactName || digits(l.contactPhone) || '').toLowerCase().trim();
    if (advertiser) {
      const n = counts.get(`${l.source}|${advertiser}`) || 0;
      const share = n / (perSource.get(l.source) || 1);
      if (n >= BULK_POSTER_MIN_ADS && share >= BULK_POSTER_SHARE) {
        l.bulkPoster = { count: n, share: +(share * 100).toFixed(0) };
        warnings.push(
          `advertiser posted ${n} ads (${l.bulkPoster.share}% of ${l.source}) - likely a lead farm`
        );
        penalty += 30;
        stats.bulk++;
      }
    }

    // The combination is what actually marks a scam: a bulk poster advertising a
    // cheap flat that also claims every premium feature.
    const claimsEverything =
      l.furnished === true && l.elevator === true && l.airConditioning === true;
    if (l.bulkPoster && claimsEverything && l.pricePerSqm < CHEAP_EUR_PER_SQM) {
      warnings.push('cheap, feature-complete and bulk-posted - treat as probable scam');
      penalty += 40;
      stats.suspicious++;
    }

    // No contactable route at all is a mild negative, not a scam signal.
    if (!l.contactPhone && !l.url) penalty += 10;

    l.warnings = warnings;
    l.credibilityPenalty = penalty;
  }

  return stats;
}
