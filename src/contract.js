/**
 * Italian rental contract type and residenza detection.
 *
 * Three things the user needs that no portal exposes as a filter:
 *
 *   1. NOT a "contratto transitorio" - a transitional lease capped at 18 months
 *      that requires a documented temporary reason. It cannot be renewed as of
 *      right, so it is no basis for settling.
 *   2. LONG TERM only - not tourist lets, weekly stays, seasonal lets, or
 *      accommodation aimed at trasfertisti (workers on short assignment).
 *   3. RESIDENZA - whether you may register your official residence at the
 *      address. This is the important one: without it there is no permesso di
 *      soggiorno renewal, no tessera sanitaria, no carta d'identita. Some
 *      landlords refuse it to avoid tax and paperwork, and they rarely
 *      volunteer that until you ask.
 *
 * None of this is a structured field anywhere, so it is read from the ad text.
 * Detection is therefore TRI-STATE and never guesses: a listing that says
 * nothing about residenza is `null` ("ask"), not a yes and not a no. Only an
 * explicit statement produces true or false.
 *
 * Italian contract types, for reference:
 *   4+4  contratto libero      - 4 years + 4 automatic renewal. The standard.
 *   3+2  canone concordato     - 3 + 2, capped rent. Also long term.
 *   transitorio                - 1 to 18 months. Excluded.
 *   studenti universitari      - 6 months to 3 years, enrolled students only.
 *   locazione turistica        - days or weeks. Excluded.
 */

import { norm } from './zones.js';

/* ------------------------- contract classification ------------------------- */

const TRANSITORIO = [
  /\btransitori[oa]\b/,
  /\bcontratto\s+transitori/,
  /\blocazione\s+transitoria\b/,
  /\buso\s+transitorio\b/,
];

const SHORT_TERM = [
  /\baffitt[oi]\s+brev[ei]\b/,
  /\bbrev[ei]\s+(?:periodo|periodi|termine|durata)\b/,
  /\bbreve\s+locazione\b/,
  /\blocazione\s+turistica\b/,
  /\buso\s+turistico\b/,
  /\bturistic[oa]\b/,
  /\bcasa\s+vacanz/,
  /\baffitto\s+vacanz/,
  /\bshort\s*[- ]?\s*(?:rent|term|let|stay)\b/,
  /\bsettimanal[ei]\b/,
  /\bgiornalier[oa]\b/,
  /\bstagional[ei]\b/,
  /\bweek\s*end\b/,
  /\btrasfertist/, // workers on short assignment
  /\bbed\s*(?:and|&)\s*breakfast\b/,
  /\baffittacamere\b/,
  /\bper\s+turisti\b/,
];

const STUDENT_ONLY = [
  /\bsolo\s+student/,
  /\bsolamente\s+(?:uso\s+)?student/,
  /\buso\s+student/,
  /\bper\s+student/,
  /\bcontratto\s+student/,
  /\bstudentess/, // "solo studentesse" - women students only
  /\bad\s+uso\s+studenti\b/,
];

const LONG_TERM = [
  /\b4\s*\+\s*4\b/,
  /\b3\s*\+\s*2\b/,
  /\bquattro\s*\+\s*quattro\b/,
  /\bcontratto\s+liber[oa]\b/,
  /\bcanone\s+concordato\b/,
  /\bconcordato\b/,
  /\bcedolare\s+secca\b/,
  /\blung[oa]\s+(?:periodo|termine|durata)\b/,
  /\blunga\s+locazione\b/,
  /\buso\s+abitativo\b/,
  /\bprima\s+casa\b/,
];

/**
 * Classify the lease.
 *
 * Returns { type, evidence } where type is one of:
 *   'transitorio' | 'short' | 'student' | 'long' | null (not stated)
 *
 * Order matters: the disqualifying types are checked before 'long', because an
 * ad reading "contratto transitorio, no prima casa" contains a long-term phrase
 * and would otherwise be misread as a standard lease.
 */
/**
 * Match `re`, but ignore an occurrence that is negated.
 *
 * Ads routinely say what they will NOT accept: "SOLAMENTE USO STUDENTI, NO
 * TRASFERTISTI" is a long-stay student let advertising that it refuses
 * short-stay workers. A plain test would read "trasfertisti" and classify it as
 * a short let - the exact opposite of what the landlord wrote.
 */
function matchUnnegated(t, re) {
  const rx = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  for (const m of t.matchAll(rx)) {
    const before = t.slice(Math.max(0, m.index - 14), m.index);
    if (/\b(?:no|non|niente|escluso|esclusi|vietato|mai)\s+(?:\w+\s+)?$/.test(before)) {
      continue; // negated - this is a refusal, not an offer
    }
    return m;
  }
  return null;
}

export function detectContractType(text, opts = {}) {
  const t = norm(text);

  // Subito exposes a CIN (Codice Identificativo Nazionale). Italian law requires
  // one for short-term tourist lets, so its presence is a structured fact rather
  // than a guess and outranks anything the wording claims.
  if (opts.hasTouristCode) {
    return { type: 'short', evidence: 'has a CIN tourist-rental code' };
  }

  for (const re of TRANSITORIO) {
    const m = matchUnnegated(t, re);
    if (m) return { type: 'transitorio', evidence: `ad says "${m[0]}"` };
  }
  for (const re of SHORT_TERM) {
    const m = matchUnnegated(t, re);
    if (m) return { type: 'short', evidence: `ad says "${m[0]}"` };
  }
  for (const re of STUDENT_ONLY) {
    const m = matchUnnegated(t, re);
    if (m) return { type: 'student', evidence: `students only ("${m[0]}")` };
  }
  for (const re of LONG_TERM) {
    const m = matchUnnegated(t, re);
    if (m) return { type: 'long', evidence: `ad says "${m[0]}"` };
  }
  return { type: null, evidence: null };
}

/* ------------------------------- residenza ------------------------------- */

// Checked first and decisive. "no prima casa" belongs here: refusing to be a
// tenant's primary home is exactly a refusal of residenza.
const RESIDENZA_NO = [
  /\bno\s+residenz/,
  /\bnon\s+si\s+concede\s+(?:la\s+)?residenz/,
  /\bnon\s+si\s+da\s+(?:la\s+)?residenz/,
  /\bsenza\s+residenz/,
  /\bniente\s+residenz/,
  /\besclusa\s+(?:la\s+)?residenz/,
  /\bresidenza\s+non\s+concess/,
  /\bnon\s+idone[oa]\s+(?:per\s+)?(?:la\s+)?residenz/,
  /\bno\s+prima\s+casa\b/,
  /\bnon\s+prima\s+casa\b/,
];

const RESIDENZA_YES = [
  /\bsi\s+concede\s+(?:la\s+)?residenz/,
  /\bpossibilita\s+di\s+residenz/,
  /\bpossibile\s+(?:la\s+)?residenz/,
  /\bconcede\s+(?:la\s+)?residenz/,
  /\bcon\s+residenz/,
  /\banche\s+residenz/,
  /\bresidenza\s+(?:si|concessa|possibile|ok)\b/,
  /\bidone[oa]\s+(?:per\s+)?(?:la\s+)?residenz/,
  /\bidoneita\s+alloggiativa\b/,
  /\bsi\s+da\s+(?:la\s+)?residenz/,
];

/**
 * Can you register your residence here?
 * true = explicitly offered, false = explicitly refused, null = not stated.
 *
 * Null is by far the most common answer and is reported as "ask", not as a no -
 * most landlords simply never mention it.
 */
export function detectResidenza(text) {
  const t = norm(text);
  for (const re of RESIDENZA_NO) {
    const m = t.match(re);
    if (m) return { allowed: false, evidence: `ad says "${m[0]}"` };
  }
  for (const re of RESIDENZA_YES) {
    const m = t.match(re);
    if (m) return { allowed: true, evidence: `ad says "${m[0]}"` };
  }
  return { allowed: null, evidence: null };
}

/**
 * How much of the ad text we actually had to work with.
 *
 * Immobiliare's list API returns only a short marketing caption - its full
 * description sits behind DataDome - so a "not stated" from Immobiliare is much
 * weaker evidence than one from Subito or Casa, which both publish the whole
 * body. The report uses this so it can distinguish "the landlord did not say"
 * from "we could not see enough of the ad to tell".
 */
export function textDepth(listing) {
  const len = (listing.description || '').length;
  if (len >= 300) return 'full';
  if (len >= 80) return 'partial';
  return 'headline-only';
}
