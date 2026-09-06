/**
 * Idealista.it - via a real browser.
 *
 * Idealista fronts everything with DataDome, which plain HTTP cannot pass: the
 * server returns a JS challenge instead of listings. So this adapter drives a
 * real Chromium through Playwright.
 *
 * Two things matter for getting through:
 *   1. A PERSISTENT profile. DataDome issues a clearance cookie once you pass;
 *      reusing the profile means later runs usually skip the challenge entirely.
 *   2. headless:false. Headless Chromium is markedly easier to fingerprint.
 *      Configurable, but the default is a visible window for a reason.
 *
 * This source is best-effort by design. If the challenge wins, it logs and
 * returns an empty list - the other three portals still produce a report.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROFILE_DIR = path.resolve(__dirname, '..', '..', 'data', '.browser-profile');

const LIST_URL = 'https://www.idealista.it/affitto-case/genova-genova/';

/**
 * Recover the street and neighbourhood from an Idealista title.
 *
 * Titles follow a consistent shape:
 *   "Appartamento in Via Filippo Palizzi, 8, Quarto, Genova"
 *   "Quadrilocale in Via Ausonia, Castelletto, Genova"
 * i.e. "<typology> in <street>[, <number>], <zone>, Genova".
 *
 * Worth parsing rather than dumping the whole title into `address`: the zone
 * feeds neighbourhood matching, and the bare street name is what lets the
 * de-duplicator recognise the same flat on another portal, since Idealista
 * publishes neither coordinates nor a phone number to match on.
 */
export function parseIdealistaTitle(title) {
  const empty = { address: title || null, microzone: null };
  if (!title) return empty;

  const afterIn = title.split(/\bin\b/i).slice(1).join(' in ').trim();
  if (!afterIn) return empty;

  const parts = afterIn
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length < 2) return empty;

  // Drop the trailing city name.
  if (/^genova$/i.test(parts[parts.length - 1])) parts.pop();
  if (!parts.length) return empty;

  // What remains ends with the neighbourhood; a bare number is the house number.
  const microzone = parts.length > 1 ? parts.pop() : null;
  const houseNumber = parts.length > 1 && /^\d+$/.test(parts[parts.length - 1]) ? parts.pop() : null;
  const street = parts.join(', ');

  return {
    address: [street, houseNumber].filter(Boolean).join(' ') || title,
    microzone: microzone || null,
  };
}

export async function fetchIdealista(config, log) {
  const cfg = config.sources.idealista;
  const listings = [];

  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    log.warn(
      'idealista: playwright is not installed - run "npm install" then "npm run install-browser". Skipping.'
    );
    return { listings, blocked: true, skipped: true };
  }

  let context;
  try {
    context = await chromium.launchPersistentContext(PROFILE_DIR, {
      headless: cfg.headless === true,
      viewport: { width: 1440, height: 900 },
      locale: 'it-IT',
      timezoneId: 'Europe/Rome',
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      args: [
        // Removes the main automation giveaway that DataDome checks for.
        '--disable-blink-features=AutomationControlled',
        '--no-sandbox',
      ],
    });
  } catch (err) {
    log.warn(`idealista: could not launch browser - ${err.message}. Skipping.`);
    return { listings, blocked: true, skipped: true };
  }

  try {
    const page = await context.newPage();

    // Hide navigator.webdriver, which the stock automation build leaves true.
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    for (let p = 1; p <= cfg.maxPages; p++) {
      // Idealista encodes filters in the path, not the query string, and the
      // token is `con-prezzo_<max>` - `con-prezzo-fino_<max>` 404s. Their own
      // filter links step in 50s, so the cap is rounded to match.
      const cap = Math.round(config.budget.searchRentCap / 50) * 50;
      const base = `${LIST_URL}con-prezzo_${cap}/`;
      const url = p === 1 ? base : `${base}lista-${p}.htm`;

      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });

      // Cookie banner blocks the list on a fresh profile.
      try {
        const consent = page.locator('#didomi-notice-agree-button');
        if (await consent.isVisible({ timeout: 3000 })) await consent.click();
      } catch {
        /* banner absent - fine */
      }

      // Either the results land, or we are staring at a challenge page.
      try {
        await page.waitForSelector('article.item', { timeout: 15000 });
      } catch {
        const title = await page.title().catch(() => '');
        const body = (await page.content().catch(() => '')).slice(0, 400);
        if (/datadome|captcha|geo\.captcha/i.test(body) || /accesso|robot/i.test(title)) {
          log.warn(
            `idealista: DataDome challenge on page ${p}. ` +
              (cfg.headless
                ? 'Try headless:false in config.json.'
                : 'Solve the CAPTCHA in the open window - the profile is saved for next time.')
          );
          // Give a human a chance to solve it while the window is visible.
          if (!cfg.headless) {
            const solved = await page
              .waitForSelector('article.item', { timeout: 90000 })
              .then(() => true)
              .catch(() => false);
            if (!solved) break;
          } else break;
        } else {
          log.warn(`idealista: no results on page ${p} (may be the last page)`);
          break;
        }
      }

      const pageItems = await page.$$eval('article.item', (nodes) =>
        nodes.map((el) => {
          const txt = (sel) => el.querySelector(sel)?.textContent?.trim() || null;
          const link = el.querySelector('a.item-link');
          const details = [...el.querySelectorAll('.item-detail')].map((d) =>
            d.textContent.trim()
          );
          const imgs = [...el.querySelectorAll('picture img, .item-multimedia img')]
            .map((i) => i.getAttribute('src') || i.getAttribute('data-service'))
            .filter((s) => s && s.startsWith('http'));
          return {
            id: el.getAttribute('data-element-id') || link?.getAttribute('href') || null,
            href: link?.getAttribute('href') || null,
            title: link?.textContent?.trim() || null,
            price: txt('.item-price'),
            details,
            description: txt('.item-description'),
            phone: txt('.item-not-clickable-phone') || txt('.icon-phone'),
            images: imgs,
          };
        })
      );

      if (!pageItems.length) break;

      for (const it of pageItems) {
        // Details is an unlabelled mixed list, e.g.
        //   ["6 locali", "100 m²", "7º piano con ascensore", "6 ore"]
        // The last entry is how long ago it was posted, not a property feature.
        const roomsTxt = it.details.find((d) => /local/i.test(d));
        const sizeTxt = it.details.find((d) => /m²|mq/i.test(d));
        const floorTxt = it.details.find((d) => /piano|rialzato|seminterrato/i.test(d));

        // Idealista folds the lift into the floor string rather than giving it
        // its own field: "7º piano con ascensore" / "2º piano senza ascensore".
        let elevator = null;
        if (floorTxt) {
          if (/senza ascensore/i.test(floorTxt)) elevator = false;
          else if (/con ascensore/i.test(floorTxt)) elevator = true;
        }

        listings.push({
          id: `idealista:${it.id || it.href}`,
          source: 'Idealista.it',
          url: it.href ? new URL(it.href, 'https://www.idealista.it').href : null,
          title: it.title,
          caption: null,
          description: it.description,

          rentPerMonth: it.price, // "1.000€/mese" - parsed downstream
          billsIncluded: null,

          rooms: roomsTxt ? parseInt(roomsTxt, 10) : null,
          explicitBedrooms: null,
          surfaceSqm: sizeTxt,
          bathrooms: null,
          floor: floorTxt,

          furnished: null,
          elevator,
          airConditioning: null,

          // Idealista has no separate address or zone field, but its title is
          // reliably structured, so we recover both from it.
          ...parseIdealistaTitle(it.title),
          macrozone: null,
          lat: null,
          lon: null,

          contactName: null,
          contactPhone: it.phone,
          contactPhones: it.phone ? [it.phone] : [],
          contactType: 'agency',
          agencyUrl: null,

          photos: it.images.slice(0, config.report.photosPerListing + 2),
          rawFeatures: it.details,
        });
      }

      log.step(`idealista: page ${p} -> ${pageItems.length} ads (total ${listings.length})`);
      await page.waitForTimeout(config.network.requestDelayMs + 800);
    }
  } catch (err) {
    log.warn(`idealista: ${err.message}`);
  } finally {
    await context.close().catch(() => {});
  }

  return { listings, blocked: listings.length === 0 };
}
