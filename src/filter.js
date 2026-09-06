/**
 * Hard filters (must pass) and soft scoring (ranking) for normalised listings.
 *
 * Every rejection records a reason so the run summary can explain *why* the
 * candidate pool shrank - which is what tells you whether a criterion is too
 * tight, rather than the market simply being empty.
 */

import { matchZone, nearestZoneDistance } from './zones.js';

/** Hard requirements. Returns null if the listing passes, else a reason string. */
export function rejectReason(l, config) {
  const { budget, property } = config;

  if (!Number.isFinite(l.rentPerMonth)) return 'no price';

  // The real ceiling is all-in, not rent - see estimateTotalCost.
  if (
    Number.isFinite(l.estimatedTotalPerMonth) &&
    l.estimatedTotalPerMonth > budget.maxTotalPerMonth
  ) {
    return `over budget (~EUR ${l.estimatedTotalPerMonth}/mo all-in)`;
  }

  // Bedrooms. Unknown is kept rather than dropped: a promising ad with a vague
  // room count is worth a human glance, and the report flags the uncertainty.
  if (l.bedrooms != null) {
    const want = property.bedrooms;
    const ok = property.allowBedroomsPlusOne
      ? l.bedrooms >= want && l.bedrooms <= want + 1
      : l.bedrooms === want;
    if (!ok) return `${l.bedrooms} bedroom(s), want ${want}`;
  }

  if (property.furnished === 'required' && l.furnished === false) {
    return 'not furnished';
  }

  if (property.minSurfaceSqm && Number.isFinite(l.surfaceSqm)) {
    if (l.surfaceSqm < property.minSurfaceSqm) return `${l.surfaceSqm} m2 too small`;
  }
  if (property.maxSurfaceSqm && Number.isFinite(l.surfaceSqm)) {
    if (l.surfaceSqm > property.maxSurfaceSqm) return `${l.surfaceSqm} m2 too large`;
  }

  return null;
}

/**
 * Rank surviving listings. Higher is better.
 *
 * The score exists to float the best few to the top of a long report, so the
 * weights are deliberately blunt: zone fit and the user's two stated wants
 * (elevator, air conditioning) dominate, and money acts as a tiebreaker.
 */
export function scoreListing(l, config) {
  const pref = config.preferences;
  let score = 0;
  const why = [];

  if (l.zoneMatch) {
    const zoneCfg = config.zones.targets.find((t) => t.key === l.zoneMatch.zone.key);
    const w = (zoneCfg?.weight ?? 10) * l.zoneMatch.confidence;
    score += w;
    why.push(`${l.zoneMatch.zone.label} +${Math.round(w)}`);
  }

  const add = (cond, pts, label) => {
    if (cond === true && pts) {
      score += pts;
      why.push(`${label} +${pts}`);
    }
  };

  add(l.elevator, pref.elevator, 'lift');
  add(l.airConditioning, pref.airConditioning, 'A/C');
  add(l.balcony, pref.balconyOrTerrace, 'balcony');
  add(l.cellar, pref.cellar, 'cellar');
  add(l.parking, pref.parking, 'parking');
  add(l.renovated, pref.recentlyRenovated, 'renovated');
  add(l.billsIncluded, pref.billsIncluded, 'bills incl.');
  add(l.contactType === 'private', pref.privateOwnerNotAgency, 'private owner');

  // Money: reward headroom under the ceiling, up to 20 points.
  if (Number.isFinite(l.estimatedTotalPerMonth)) {
    const headroom = config.budget.maxTotalPerMonth - l.estimatedTotalPerMonth;
    if (headroom > 0) {
      const pts = Math.min(20, Math.round(headroom / 15));
      score += pts;
      if (pts >= 3) why.push(`EUR ${headroom} under budget +${pts}`);
    }
  }

  // Space, gently - avoids a 45 m2 flat outranking a 90 m2 one on features alone.
  if (Number.isFinite(l.surfaceSqm) && l.surfaceSqm > 55) {
    const pts = Math.min(10, Math.round((l.surfaceSqm - 55) / 6));
    score += pts;
  }

  // Confidence penalties: an ad we had to guess about should not top the list.
  if (l.furnished == null) {
    score -= 8;
    why.push('furnishing unclear -8');
  }
  if (l.bedrooms == null) {
    score -= 10;
    why.push('bedrooms unclear -10');
  }
  if (l.costConfidence === 'estimated') score -= 3;
  if (!l.photos?.length) score -= 5;

  // Scam / lead-farm signals. Heavy on purpose: a suspected fraudulent ad is
  // cheap and feature-complete, so without this it would otherwise win on
  // every other dimension and top the report.
  if (l.credibilityPenalty) {
    score -= l.credibilityPenalty;
    why.push(`credibility -${l.credibilityPenalty}`);
  }

  l.score = Math.round(score);
  l.scoreWhy = why;
  return l.score;
}

/**
 * Split the pool into matches / nearby / rejected.
 *
 * "nearby" holds listings that clear every hard filter but sit outside the 12
 * target zones. They go in their own report section unless zones.strict is set,
 * because a great flat two streets over is still worth seeing.
 */
export function applyFilters(listings, config) {
  const enabledKeys = config.zones.targets.map((t) => t.key);
  const matched = [];
  const nearby = [];
  const rejected = [];

  for (const l of listings) {
    const reason = rejectReason(l, config);
    if (reason) {
      rejected.push({ listing: l, reason });
      continue;
    }

    l.zoneMatch = matchZone(l, {
      enabledKeys,
      gpsFallbackRadiusMeters: config.zones.gpsFallbackRadiusMeters,
    });

    if (l.zoneMatch) {
      scoreListing(l, config);
      matched.push(l);
    } else if (!config.zones.strict) {
      l.nearest = nearestZoneDistance(l);
      scoreListing(l, config);
      nearby.push(l);
    } else {
      rejected.push({ listing: l, reason: 'outside target zones' });
    }
  }

  matched.sort((a, b) => b.score - a.score);
  nearby.sort((a, b) => b.score - a.score);

  return { matched, nearby, rejected };
}

/** Tally rejection reasons so the report can show where the pool went. */
export function summariseRejections(rejected) {
  const counts = new Map();
  for (const r of rejected) {
    // Collapse numeric variants ("3 bedroom(s), want 2") into one bucket.
    const key = r.reason
      .replace(/^\d+ bedroom\(s\).*/, 'wrong bedroom count')
      .replace(/^over budget.*/, 'over budget')
      .replace(/^\d+ m2 too small$/, 'too small')
      .replace(/^\d+ m2 too large$/, 'too large');
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}
