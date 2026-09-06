#!/usr/bin/env node
/**
 * Genoa house finder - entry point.
 *
 * Pipeline: fetch every enabled portal -> normalise -> dedupe across portals ->
 * filter and score -> diff against the last run -> build HTML -> save (and email
 * once that is switched on).
 *
 * A failure in one source must never lose the whole report, so each adapter is
 * isolated and its failure is recorded as a per-source status line instead.
 *
 * Flags:
 *   --only=subito,casa   run just these sources
 *   --no-email           force-skip email regardless of config
 *   --open               open the finished report in the default browser
 *   --quiet              only warnings and the summary
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';

import { fetchImmobiliare } from './sources/immobiliare.js';
import { fetchSubito } from './sources/subito.js';
import { fetchCasa } from './sources/casa.js';
import { fetchIdealista } from './sources/idealista.js';

import { enrich, parsePrice, parseSurface } from './normalize.js';
import { dedupe } from './dedupe.js';
import { assessCredibility } from './credibility.js';
import { enrichFullText } from './enrich.js';
import { applyFilters, rejectReason, scoreListing } from './filter.js';
import { loadStore, saveStore, markChanges } from './store.js';
import { buildReport, writeReport } from './report.js';
import { sendReport } from './mailer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

/* ------------------------------- plumbing ------------------------------- */

const argv = process.argv.slice(2);
const hasFlag = (f) => argv.includes(f);
const flagValue = (name) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};

const quiet = hasFlag('--quiet');
const log = {
  step: (m) => !quiet && console.log(`  ${m}`),
  info: (m) => console.log(m),
  warn: (m) => console.warn(`  ! ${m}`),
};

function loadConfig() {
  const raw = fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8');
  const cfg = JSON.parse(raw);
  // Strip the _comment / _note documentation keys so they never reach logic.
  const clean = (o) => {
    if (Array.isArray(o)) return o.map(clean);
    if (o && typeof o === 'object') {
      return Object.fromEntries(
        Object.entries(o)
          .filter(([k]) => !k.startsWith('_'))
          .map(([k, v]) => [k, clean(v)])
      );
    }
    return o;
  };
  return clean(cfg);
}

const SOURCES = [
  { key: 'immobiliare', name: 'Immobiliare.it', run: fetchImmobiliare },
  { key: 'subito', name: 'Subito.it', run: fetchSubito },
  { key: 'casa', name: 'Casa.it', run: fetchCasa },
  { key: 'idealista', name: 'Idealista.it', run: fetchIdealista },
];

/* --------------------------------- main --------------------------------- */

async function main() {
  const runAt = new Date();
  const config = loadConfig();

  const only = flagValue('only');
  const onlyKeys = only ? only.split(',').map((s) => s.trim()) : null;

  log.info(`\nGenoa house finder - ${runAt.toLocaleString('en-GB', { timeZone: 'Europe/Rome' })} (Rome)`);
  log.info(
    `Looking for ${config.property.bedrooms}-bedroom furnished flats up to ` +
      `EUR ${config.budget.maxTotalPerMonth}/month all-in\n`
  );

  // ---- 1. Fetch ----------------------------------------------------------
  const all = [];
  const sourceStats = [];

  for (const src of SOURCES) {
    const cfg = config.sources[src.key];
    if (!cfg?.enabled) continue;
    if (onlyKeys && !onlyKeys.includes(src.key)) continue;

    const t0 = Date.now();
    try {
      const { listings, blocked, skipped } = await src.run(config, log);
      all.push(...listings);
      sourceStats.push({
        name: src.name,
        count: listings.length,
        blocked: !!blocked,
        skipped: !!skipped,
        ms: Date.now() - t0,
      });
    } catch (err) {
      // One broken portal must not cost us the whole report.
      log.warn(`${src.key}: unexpected failure - ${err.message}`);
      sourceStats.push({ name: src.name, count: 0, blocked: true, error: err.message, ms: Date.now() - t0 });
    }
  }

  log.info(`\nCollected ${all.length} raw listings`);

  // ---- 2. Normalise ------------------------------------------------------
  for (const l of all) {
    // Sources hand back mixed types ("700 €", "55 mq", 1000) - coerce first,
    // because every downstream comparison assumes numbers.
    l.rentPerMonth = parsePrice(l.rentPerMonth);
    l.surfaceSqm = parseSurface(l.surfaceSqm);
    enrich(l, config);
  }

  // ---- 3. Credibility ----------------------------------------------------
  // Runs on the whole batch: bulk-posting is only visible in aggregate.
  const cred = assessCredibility(all);
  if (cred.suspicious || cred.bulk) {
    log.info(
      `Flagged ${cred.suspicious} probable scam ads, ${cred.bulk} from bulk posters`
    );
  }

  // ---- 4. Dedupe ---------------------------------------------------------
  const { listings: unique, removed } = dedupe(all);
  log.info(`Merged ${removed} cross-portal duplicates -> ${unique.length} distinct flats`);

  // ---- 5. Filter and score ----------------------------------------------
  const { matched, nearby, rejected } = applyFilters(unique, config);
  log.info(`${matched.length} match your zones and criteria (${nearby.length} just outside)`);

  // ---- 5b. Full text for the finalists ----------------------------------
  // Immobiliare's list view gives only a headline, and contract type and
  // residenza live in the ad body. Fetching that for every listing would be
  // hundreds of page loads, so it runs here - after filtering, over the short
  // list only - and anything newly revealed as transitorio or short-term is
  // then dropped.
  if (config.sources.immobiliare?.fetchFullText !== false) {
    const { enriched, failed, changed } = await enrichFullText(
      [...matched, ...nearby],
      config,
      log
    );
    if (enriched || failed) {
      log.info(`Read full ad text for ${enriched} listings (${failed} unavailable)`);
    }

    if (changed.length) {
      // Re-apply the hard filters: the fuller text can disqualify a listing that
      // its headline made look fine.
      const recheck = (arr) =>
        arr.filter((l) => {
          const reason = rejectReason(l, config);
          if (reason) {
            rejected.push({ listing: l, reason: `${reason} (found in full ad text)` });
            return false;
          }
          return true;
        });

      const keptMatched = recheck(matched);
      const keptNearby = recheck(nearby);
      const dropped = matched.length - keptMatched.length + (nearby.length - keptNearby.length);

      matched.length = 0;
      matched.push(...keptMatched);
      nearby.length = 0;
      nearby.push(...keptNearby);

      // Scores depend on residenza and contract type, so refresh them.
      for (const l of [...matched, ...nearby]) scoreListing(l, config);
      matched.sort((a, b) => b.score - a.score);
      nearby.sort((a, b) => b.score - a.score);

      if (dropped) log.info(`Dropped ${dropped} more once the full ad text was read`);
    }
  }

  // ---- 6. Diff against the last run -------------------------------------
  const store = loadStore();
  const { newCount, dropCount } = markChanges([...matched, ...nearby], store);
  saveStore(store);
  if (newCount) log.info(`${newCount} are new since the last run`);
  if (dropCount) log.info(`${dropCount} have dropped their rent`);

  // ---- 7. Report ---------------------------------------------------------
  const stats = {
    scanned: all.length,
    deduped: removed,
    matchedCount: matched.length,
    newCount,
    dropCount,
    sources: sourceStats,
  };

  const html = buildReport({ matched, nearby, rejected, stats, config, runAt });
  const [reportPath] = writeReport(html, config, runAt);
  log.info(`\nReport written to ${path.relative(ROOT, reportPath)}`);

  // ---- 8. Email (dormant until configured) ------------------------------
  if (!hasFlag('--no-email')) {
    await sendReport({ html, config, stats, runAt, log });
  }

  // ---- 9. Optionally open it --------------------------------------------
  if (hasFlag('--open') || config.report.openInBrowserAfterRun) {
    const latest = path.join(ROOT, config.report.outputDir, 'latest.html');
    const target = fs.existsSync(latest) ? latest : reportPath;
    if (process.platform === 'win32') {
      // "start" needs an empty title arg first, or a quoted path is read as one.
      execFile('cmd', ['/c', 'start', '', target], () => {});
    } else if (process.platform === 'darwin') {
      execFile('open', [target], () => {});
    } else {
      execFile('xdg-open', [target], () => {});
    }
  }

  // A concise tail so a scheduled run leaves something readable in the log.
  log.info(
    `\nSources: ${sourceStats
      .map((s) => `${s.name} ${s.skipped ? 'skipped' : s.blocked && !s.count ? 'BLOCKED' : s.count}`)
      .join(', ')}`
  );
  log.info(`Done in ${((Date.now() - runAt.getTime()) / 1000).toFixed(1)}s\n`);
}

main().catch((err) => {
  console.error('\nFatal error:', err);
  process.exit(1);
});
