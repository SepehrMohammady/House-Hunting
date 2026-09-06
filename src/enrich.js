/**
 * Full-text enrichment for listings that only gave us a headline.
 *
 * Why this exists: Immobiliare's list API returns just a short marketing caption,
 * and it is the largest source. Contract type and residenza almost never appear
 * in a caption - they sit in the ad body, behind DataDome. Measured on a live
 * run, 14 of 23 finalists were headline-only, and the first two bodies fetched
 * revealed a "transitorio" lease and a students-only let that their captions had
 * not mentioned. Both would otherwise have reached the report as valid matches.
 *
 * Cost control: this runs AFTER filtering, over the finalists only - a couple of
 * dozen page loads rather than the ~300 the full feed would need. It reuses the
 * same browser profile Idealista maintains, so the bot challenge is usually
 * already cleared.
 *
 * Failure is never fatal. If the browser cannot start or a page does not load,
 * the listing keeps whatever the list view gave us and the run continues.
 */

import { PROFILE_DIR, launchOptions } from './browser.js';
import { detectContractType, detectResidenza, textDepth } from './contract.js';
import {
  detectFurnished,
  detectElevator,
  detectAirConditioning,
  detectBillsIncluded,
  extractCondoFees,
  estimateTotalCost,
  textBlob,
} from './normalize.js';

/** Pull the ad body from a rendered Immobiliare detail page. */
async function readDescription(page) {
  // The visible element first - it is already unescaped and readable.
  const visible = await page
    .$eval(
      '[data-tracking-key="description"], .in-readAll, .in-description, .in-descriptionText',
      (el) => el.innerText
    )
    .catch(() => null);
  if (visible && visible.length > 60) return visible;

  // Otherwise dig the string out of the embedded JSON payload.
  const html = await page.content().catch(() => '');
  const m = html.match(/"description":"((?:[^"\\]|\\.){80,8000})"/);
  if (m) {
    return m[1]
      .replace(/\\n/g, ' ')
      .replace(/\\"/g, '"')
      .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
  }
  return null;
}

/**
 * Fetch full ad text for the given listings and re-run the text-derived fields.
 * Mutates in place and returns { enriched, failed, changed }.
 */
export async function enrichFullText(listings, config, log) {
  const targets = listings.filter(
    (l) => l.source === 'Immobiliare.it' && l.textDepth === 'headline-only' && l.url
  );
  if (!targets.length) return { enriched: 0, failed: 0, changed: [] };

  const limit = config.sources.immobiliare.maxFullTextFetches ?? 40;
  const batch = targets.slice(0, limit);

  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    log.warn('enrich: playwright not installed - skipping full-text lookup');
    return { enriched: 0, failed: batch.length, changed: [] };
  }

  let ctx;
  try {
    ctx = await chromium.launchPersistentContext(
      PROFILE_DIR,
      launchOptions(config.sources.immobiliare.headless)
    );
  } catch (err) {
    log.warn(`enrich: could not start browser - ${err.message}`);
    return { enriched: 0, failed: batch.length, changed: [] };
  }

  let enriched = 0;
  let failed = 0;
  let consecutiveFailures = 0;
  const changed = [];

  // DataDome's tolerance for Immobiliare detail pages varies by day and by IP:
  // the same profile that reads them fine one hour is challenged the next. When
  // it is refusing, every request will refuse, so stop after a few rather than
  // grinding through the whole shortlist to collect forty identical failures.
  const GIVE_UP_AFTER = 3;

  try {
    const page = await ctx.newPage();
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    // Images are the bulk of the payload and we only want the text.
    await page.route('**/*.{png,jpg,jpeg,webp,gif,svg,woff,woff2,mp4}', (r) => r.abort());

    for (const l of batch) {
      try {
        await page.goto(l.url, { waitUntil: 'domcontentloaded', timeout: 30000 });

        try {
          const consent = page.locator('#didomi-notice-agree-button');
          if (await consent.isVisible({ timeout: 1500 })) await consent.click();
        } catch {
          /* no banner */
        }

        const desc = await readDescription(page);
        // A non-200 status is not decisive here: DataDome sometimes returns 403
        // on the document while the content still renders. Judge by what we got.
        if (!desc || desc.length < 60) {
          failed++;
          if (++consecutiveFailures >= GIVE_UP_AFTER) {
            log.warn(
              `enrich: Immobiliare is refusing detail pages right now - stopping after ` +
                `${failed} attempts. Contract and residenza for those listings stay ` +
                `"not stated"; the report marks them "ask".`
            );
            break;
          }
          continue;
        }
        consecutiveFailures = 0;

        const before = { contract: l.contractType, residenza: l.residenza };
        l.description = desc;
        l.textDepth = textDepth(l);
        enriched++;

        // Re-derive everything the text feeds, now that we have the whole ad.
        const blob = textBlob(l);

        const c = detectContractType(blob, { hasTouristCode: l.hasTouristCode });
        l.contractType = c.type;
        l.contractEvidence = c.evidence;

        const r = detectResidenza(blob);
        l.residenza = r.allowed;
        l.residenzaEvidence = r.evidence;

        // Only fill genuine gaps - a structured portal flag still outranks prose.
        if (l.furnished == null) l.furnished = detectFurnished(blob);
        if (l.elevator == null) l.elevator = detectElevator(blob);
        if (l.airConditioning == null) l.airConditioning = detectAirConditioning(blob);
        if (l.billsIncluded == null) l.billsIncluded = detectBillsIncluded(blob);
        if (l.condoFeesPerMonth == null) l.condoFeesPerMonth = extractCondoFees(blob);

        // Bills or condo fees found in the body change the all-in total.
        const cost = estimateTotalCost(l, config.budget);
        l.estimatedTotalPerMonth = cost.total;
        l.costConfidence = cost.confidence;
        l.costBreakdown = cost.breakdown;

        if (before.contract !== l.contractType || before.residenza !== l.residenza) {
          changed.push({
            title: l.title,
            contract: l.contractType,
            residenza: l.residenza,
          });
        }

        await page.waitForTimeout(config.network.requestDelayMs);
      } catch (err) {
        failed++;
        if (++consecutiveFailures >= GIVE_UP_AFTER) break;
      }
    }
  } catch (err) {
    log.warn(`enrich: ${err.message}`);
  } finally {
    await ctx.close().catch(() => {});
  }

  return { enriched, failed, changed };
}
