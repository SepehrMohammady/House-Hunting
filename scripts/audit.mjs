/**
 * Diagnostic: run the pipeline and print the result as text instead of HTML.
 *
 * Use this when tuning config.json - it shows why listings were kept or dropped,
 * which the report deliberately does not dwell on.
 *
 *   node scripts/audit.mjs            top matches + rejection tally
 *   node scripts/audit.mjs --zones    per-zone breakdown
 *   node scripts/audit.mjs --rejects  sample of what got filtered out
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { fetchImmobiliare } from '../src/sources/immobiliare.js';
import { fetchSubito } from '../src/sources/subito.js';
import { fetchCasa } from '../src/sources/casa.js';
import { enrich, parsePrice, parseSurface } from '../src/normalize.js';
import { dedupe } from '../src/dedupe.js';
import { assessCredibility } from '../src/credibility.js';
import { applyFilters, summariseRejections } from '../src/filter.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const clean = (o) =>
  Array.isArray(o)
    ? o.map(clean)
    : o && typeof o === 'object'
      ? Object.fromEntries(
          Object.entries(o).filter(([k]) => !k.startsWith('_')).map(([k, v]) => [k, clean(v)])
        )
      : o;

const config = clean(JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8')));
const log = { step: () => {}, warn: (m) => console.error('  !', m), info: () => {} };

const tri = (v) => (v === true ? 'yes' : v === false ? 'NO' : '?');

const all = [];
for (const fn of [fetchImmobiliare, fetchSubito, fetchCasa]) {
  const { listings } = await fn(config, log);
  all.push(...listings);
}

for (const l of all) {
  l.rentPerMonth = parsePrice(l.rentPerMonth);
  l.surfaceSqm = parseSurface(l.surfaceSqm);
  enrich(l, config);
}

const credStats = assessCredibility(all);
const { listings: unique, removed } = dedupe(all);
const { matched, nearby, rejected } = applyFilters(unique, config);

console.log(`\nraw ${all.length} | deduped -${removed} | unique ${unique.length}`);
console.log('flagged:', JSON.stringify(credStats));
console.log(`matched ${matched.length} | nearby ${nearby.length} | rejected ${rejected.length}\n`);

if (process.argv.includes('--rejects')) {
  console.log('=== REJECTION REASONS ===');
  for (const [reason, n] of summariseRejections(rejected)) {
    console.log(`  ${String(n).padStart(4)}  ${reason}`);
  }
  console.log('\n=== SAMPLE REJECTS ===');
  for (const r of rejected.slice(0, 15)) {
    console.log(`  [${r.reason}] ${(r.listing.title || '').slice(0, 60)} - EUR ${r.listing.rentPerMonth}`);
  }
  process.exit(0);
}

if (process.argv.includes('--zones')) {
  const byZone = new Map();
  for (const l of matched) {
    const k = l.zoneMatch.zone.label;
    byZone.set(k, (byZone.get(k) || 0) + 1);
  }
  console.log('=== MATCHES PER ZONE ===');
  for (const t of config.zones.targets) {
    console.log(`  ${String(byZone.get(t.label) || 0).padStart(3)}  ${t.label}`);
  }
  process.exit(0);
}

console.log('=== TOP 20 MATCHES ===');
for (const l of matched.slice(0, 20)) {
  console.log(
    `\n[${String(l.score).padStart(3)}] ${l.zoneMatch.zone.label}  (${l.zoneMatch.via}, conf ${l.zoneMatch.confidence})`
  );
  console.log(`      ${(l.title || '').slice(0, 78)}`);
  console.log(
    `      EUR ${l.rentPerMonth} rent -> ~${l.estimatedTotalPerMonth} all-in [${l.costConfidence}]` +
      ` | ${l.bedrooms ?? '?'} bed | ${l.surfaceSqm ?? '?'} m2`
  );
  console.log(
    `      furnished ${tri(l.furnished)} | lift ${tri(l.elevator)} | A/C ${tri(l.airConditioning)}` +
      ` | ${l.contactType} | photos ${l.photos?.length || 0}`
  );
  console.log(`      ${l.contactName || '-'}  ${l.contactPhone || '(portal msg)'}  | ${l.source}`);
  console.log(`      ${l.url}`);
}

// Data-quality sanity check across the whole matched set.
const pct = (n) => `${Math.round((100 * n) / (matched.length || 1))}%`;
console.log('\n=== COVERAGE ACROSS MATCHES ===');
console.log(`  known bedrooms : ${pct(matched.filter((l) => l.bedrooms != null).length)}`);
console.log(`  furnished=yes  : ${pct(matched.filter((l) => l.furnished === true).length)}`);
console.log(`  lift=yes       : ${pct(matched.filter((l) => l.elevator === true).length)}`);
console.log(`  A/C=yes        : ${pct(matched.filter((l) => l.airConditioning === true).length)}`);
console.log(`  has photo      : ${pct(matched.filter((l) => l.photos?.length).length)}`);
console.log(`  has phone      : ${pct(matched.filter((l) => l.contactPhone).length)}`);
console.log(`  private owner  : ${pct(matched.filter((l) => l.contactType === 'private').length)}`);
