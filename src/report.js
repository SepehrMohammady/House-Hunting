/**
 * HTML report builder.
 *
 * Written for email clients, not browsers: table layout, inline styles, no
 * flexbox or grid, no external CSS. Gmail strips most <style> blocks and all
 * modern layout, so anything structural has to be inline on the element.
 * It still reads fine as a standalone file in a browser.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { summariseRejections } from './filter.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

/* --------------------------- small helpers --------------------------- */

export const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

export const eur = (n) => (Number.isFinite(n) ? `€ ${n.toLocaleString('it-IT')}` : '—');

export const C = {
  ink: '#1a1d21',
  muted: '#6b7280',
  line: '#e5e7eb',
  bg: '#f6f7f9',
  card: '#ffffff',
  good: '#0f7b3f',
  goodBg: '#e6f4ec',
  warn: '#9a4b00',
  warnBg: '#fdf0e3',
  cool: '#1e4fa3',
  coolBg: '#e8effb',
  dim: '#6b7280',
  dimBg: '#f1f2f4',
};

function badge(text, bg, fg) {
  return (
    `<span style="display:inline-block;padding:2px 7px;margin:0 4px 4px 0;` +
    `border-radius:10px;background:${bg};color:${fg};font-size:11px;` +
    `font-weight:600;white-space:nowrap;">${esc(text)}</span>`
  );
}

/** Tri-state feature chip: true = green, false = struck out, null = unknown. */
function feature(label, value) {
  if (value === true) return badge(label, C.goodBg, C.good);
  if (value === false) return badge(`no ${label}`, C.dimBg, C.dim);
  return badge(`${label}?`, C.dimBg, C.dim);
}

/* ------------------------------ listing row ------------------------------ */

function photoCell(l) {
  const src = l.photos?.[0];
  if (!src) {
    return (
      `<td width="170" style="padding:12px;vertical-align:top;">` +
      `<div style="width:158px;height:118px;background:${C.dimBg};border-radius:6px;` +
      `color:${C.muted};font-size:11px;text-align:center;line-height:118px;">no photo</div></td>`
    );
  }
  return (
    `<td width="170" style="padding:12px;vertical-align:top;">` +
    `<a href="${esc(l.url)}" style="text-decoration:none;">` +
    `<img src="${esc(src)}" width="158" alt="" ` +
    `style="width:158px;height:118px;object-fit:cover;border-radius:6px;display:block;border:1px solid ${C.line};"></a></td>`
  );
}

function detailsCell(l) {
  const zone = l.zoneMatch
    ? `${l.zoneMatch.zone.label}`
    : l.nearest
      ? `${l.nearest.zone.label} +${l.nearest.meters}m`
      : 'Genova';

  const bits = [];
  if (l.bedrooms != null) bits.push(`${l.bedrooms} bed`);
  else bits.push('beds ?');
  if (Number.isFinite(l.surfaceSqm)) bits.push(`${l.surfaceSqm} m&sup2;`);
  if (l.bathrooms) bits.push(`${esc(l.bathrooms)} bath`);
  if (l.floor) bits.push(esc(l.floor));

  const flags = [];
  if (l.isNewSinceLastRun) flags.push(badge('NEW', C.goodBg, C.good));
  if (l.priceDrop)
    flags.push(badge(`price cut ${eur(l.priceDrop.from)} -> ${eur(l.priceDrop.to)}`, C.warnBg, C.warn));
  if (l.daysListed >= 21) flags.push(badge(`listed ${l.daysListed}d`, C.dimBg, C.dim));
  if (l.alsoOn?.length) flags.push(badge(`also on ${l.alsoOn.length + 1} sites`, C.coolBg, C.cool));

  return (
    `<td style="padding:12px 12px 12px 0;vertical-align:top;">` +
    `${flags.join('')}${flags.length ? '<br>' : ''}` +
    `<a href="${esc(l.url)}" style="color:${C.ink};font-size:14px;font-weight:600;text-decoration:none;">` +
    `${esc((l.title || 'Untitled listing').slice(0, 95))}</a>` +
    `<div style="color:${C.cool};font-size:12px;font-weight:600;margin-top:3px;">${esc(zone)}` +
    (l.address ? `<span style="color:${C.muted};font-weight:400;"> &middot; ${esc(l.address)}</span>` : '') +
    `</div>` +
    `<div style="color:${C.muted};font-size:12px;margin-top:4px;">${bits.join(' &middot; ')}</div>` +
    `<div style="margin-top:7px;">` +
    feature('furnished', l.furnished) +
    feature('lift', l.elevator) +
    feature('A/C', l.airConditioning) +
    (l.balcony === true ? badge('balcony', C.dimBg, C.dim) : '') +
    `</div>` +
    contractRow(l) +
    `<div style="color:${C.muted};font-size:11px;margin-top:5px;">` +
    `${esc(l.source)}` +
    (l.zoneMatch ? ` &middot; matched by ${esc(l.zoneMatch.via)}` : '') +
    `</div>` +
    warningBlock(l) +
    `</td>`
  );
}

/**
 * Lease type and residenza.
 *
 * Residenza gets its own prominent chip rather than sitting with the amenities,
 * because it is not a nice-to-have: without it there is no permesso di soggiorno
 * renewal, no tessera sanitaria and no carta d'identita. Ads that explicitly
 * refuse it are already filtered out, so the chip here is either a confirmed
 * yes or a reminder to ask - and "ask" is deliberately styled as an action, not
 * as a neutral unknown, since it must be settled before signing anything.
 */
function contractRow(l) {
  const chips = [];

  if (l.contractType === 'long') {
    chips.push(badge('long-term contract', C.goodBg, C.good));
  }

  if (l.residenza === true) {
    chips.push(badge('residenza offered', C.goodBg, C.good));
  } else {
    // Immobiliare only exposes a short headline, so "not stated" there is much
    // weaker evidence than on a portal that publishes the whole ad body.
    const label =
      l.textDepth === 'headline-only' ? 'residenza: ask (ad text limited)' : 'residenza: ask';
    chips.push(badge(label, C.warnBg, C.warn));
  }

  return `<div style="margin-top:5px;">${chips.join('')}</div>`;
}

/**
 * Fraud / lead-farm warnings.
 *
 * Rendered loud and inline rather than as a quiet footnote: these ads look like
 * the best deals in the report by construction, so the caution has to sit right
 * next to the price that makes them attractive.
 */
function warningBlock(l) {
  if (!l.warnings?.length) return '';
  return (
    `<div style="margin-top:8px;padding:7px 9px;background:${C.warnBg};` +
    `border-left:3px solid ${C.warn};border-radius:3px;">` +
    l.warnings
      .map(
        (w) =>
          `<div style="color:${C.warn};font-size:11px;font-weight:600;line-height:1.45;">&#9888; ${esc(w)}</div>`
      )
      .join('') +
    `</div>`
  );
}

function costCell(l) {
  const b = l.costBreakdown;
  const note =
    l.costConfidence === 'stated'
      ? `<span style="color:${C.good};">bills included</span>`
      : b
        ? `rent ${eur(b.rent)}<br>+ condo ${eur(b.condo)}<br>+ utils ${eur(b.utilities)}`
        : '';

  return (
    `<td width="130" style="padding:12px;vertical-align:top;text-align:right;">` +
    `<div style="font-size:19px;font-weight:700;color:${C.ink};">${eur(l.estimatedTotalPerMonth)}</div>` +
    `<div style="font-size:10px;color:${C.muted};text-transform:uppercase;letter-spacing:.4px;">` +
    `${l.costConfidence === 'stated' ? 'all-in' : 'est. all-in'}</div>` +
    `<div style="font-size:11px;color:${C.muted};margin-top:6px;line-height:1.5;">${note}</div></td>`
  );
}

function contactCell(l) {
  const phones = (l.contactPhones?.length ? l.contactPhones : [l.contactPhone]).filter(Boolean);
  const phoneHtml = phones.length
    ? phones
        .map(
          (p) =>
            `<a href="tel:${esc(String(p).replace(/[^\d+]/g, ''))}" ` +
            `style="color:${C.cool};font-size:13px;font-weight:600;text-decoration:none;">${esc(p)}</a>`
        )
        .join('<br>')
    : `<span style="color:${C.muted};font-size:11px;">via portal message</span>`;

  return (
    `<td width="180" style="padding:12px;vertical-align:top;">` +
    `<div style="font-size:12px;color:${C.ink};font-weight:600;">${esc(l.contactName || 'Not stated')}</div>` +
    `<div style="font-size:11px;color:${C.muted};margin:2px 0 6px;">` +
    `${l.contactType === 'private' ? 'private owner (no commission)' : 'agency'}</div>` +
    phoneHtml +
    `<div style="margin-top:9px;">` +
    `<a href="${esc(l.url)}" style="display:inline-block;padding:7px 12px;background:${C.cool};` +
    `color:#fff;border-radius:5px;font-size:12px;font-weight:600;text-decoration:none;">View listing</a></div>` +
    `</td>`
  );
}

function listingRow(l, idx) {
  const zebra = idx % 2 ? C.bg : C.card;
  return (
    `<tr style="background:${zebra};border-bottom:1px solid ${C.line};">` +
    photoCell(l) +
    detailsCell(l) +
    costCell(l) +
    contactCell(l) +
    `</tr>`
  );
}

function section(title, subtitle, listings, startIdx = 0) {
  if (!listings.length) return '';
  return (
    `<tr><td colspan="4" style="padding:26px 12px 8px;">` +
    `<div style="font-size:16px;font-weight:700;color:${C.ink};">${esc(title)}` +
    `<span style="color:${C.muted};font-weight:400;"> (${listings.length})</span></div>` +
    (subtitle ? `<div style="font-size:12px;color:${C.muted};margin-top:2px;">${esc(subtitle)}</div>` : '') +
    `</td></tr>` +
    listings.map((l, i) => listingRow(l, startIdx + i)).join('')
  );
}

/* ------------------------------ full report ------------------------------ */

export function buildReport({ matched, nearby, rejected, stats, config, runAt }) {
  const cap = config.report.maxListings;
  const top = matched.slice(0, cap);
  const near = nearby.slice(0, Math.max(0, Math.min(12, cap - top.length)));

  const fresh = top.filter((l) => l.isNewSinceLastRun);
  const rest = top.filter((l) => !l.isNewSinceLastRun);

  const when = runAt.toLocaleString('en-GB', {
    dateStyle: 'full',
    timeStyle: 'short',
    timeZone: 'Europe/Rome',
  });

  const sourceLines = stats.sources
    .map((s) => {
      const status = s.skipped
        ? 'skipped'
        : s.blocked && !s.count
          ? 'blocked'
          : `${s.count} ads`;
      const color = s.blocked && !s.count ? C.warn : C.muted;
      return `<span style="color:${color};">${esc(s.name)}: ${esc(status)}</span>`;
    })
    .join(' &nbsp;&middot;&nbsp; ');

  const rejectLines = summariseRejections(rejected)
    .slice(0, 6)
    .map(([reason, n]) => `${esc(reason)} (${n})`)
    .join(', ');

  const statCard = (value, label, color = C.ink) =>
    `<td style="padding:0 18px 0 0;"><div style="font-size:24px;font-weight:700;color:${color};">${value}</div>` +
    `<div style="font-size:11px;color:${C.muted};text-transform:uppercase;letter-spacing:.5px;">${esc(label)}</div></td>`;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(config.report.title)}</title></head>
<body style="margin:0;padding:0;background:${C.bg};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:${C.ink};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.bg};padding:20px 10px;">
<tr><td align="center">
<table role="presentation" width="900" cellpadding="0" cellspacing="0" style="width:900px;max-width:100%;background:${C.card};border-radius:10px;border:1px solid ${C.line};overflow:hidden;">

  <tr><td colspan="4" style="padding:22px 24px 18px;border-bottom:1px solid ${C.line};">
    <div style="font-size:21px;font-weight:700;">${esc(config.report.title)}</div>
    <div style="font-size:12px;color:${C.muted};margin-top:3px;">${esc(when)} (Rome time)</div>
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:16px;"><tr>
      ${statCard(matched.length, 'in your areas')}
      ${statCard(fresh.length, 'new since last run', fresh.length ? C.good : C.ink)}
      ${statCard(stats.dropCount, 'price cuts', stats.dropCount ? C.warn : C.ink)}
      ${statCard(stats.scanned, 'ads scanned')}
    </tr></table>
  </td></tr>

  <tr><td colspan="4" style="padding:12px 24px;background:${C.bg};border-bottom:1px solid ${C.line};font-size:11px;color:${C.muted};">
    <strong>Criteria:</strong> ${config.property.bedrooms} bedrooms${config.property.allowBedroomsPlusOne ? ' (3 also shown)' : ''},
    ${esc(config.property.furnished)} furnished, max ${eur(config.budget.maxTotalPerMonth)}/month all-in
    (rent + condo fees + utilities, utilities assumed ${eur(config.budget.assumedUtilitiesPerMonth)}).<br>
    <strong>Contract:</strong> long-term only &mdash;
    ${[
      config.contract?.excludeTransitorio && 'transitorio',
      config.contract?.excludeShortTerm && 'short-term/tourist',
      config.contract?.excludeStudentOnly && 'students-only',
    ]
      .filter(Boolean)
      .join(', ')} excluded.
    Ads that explicitly refuse <strong>residenza</strong> are dropped; where the ad is silent the report says
    &ldquo;ask&rdquo;, so confirm it before signing.<br>
    <strong>Sources:</strong> ${sourceLines}
  </td></tr>

  ${section('New since your last report', 'These appeared in the last few hours - contact these first.', fresh, 0)}
  ${section(fresh.length ? 'Other matches in your areas' : 'Matches in your areas', 'Ranked by fit: zone, lift, air conditioning, and budget headroom.', rest, fresh.length)}
  ${section('Just outside your areas', 'Good on every other criterion, but not in one of your 12 zones.', near, top.length)}

  ${
    !matched.length
      ? `<tr><td colspan="4" style="padding:40px 24px;text-align:center;color:${C.muted};font-size:13px;">
         No listings matched every criterion this run.<br>
         ${rejectLines ? `Closest misses: ${rejectLines}.` : ''}
         </td></tr>`
      : ''
  }

  <tr><td colspan="4" style="padding:18px 24px;border-top:1px solid ${C.line};background:${C.bg};font-size:11px;color:${C.muted};line-height:1.6;">
    Scanned ${stats.scanned} ads, ${stats.deduped} cross-portal duplicates merged,
    ${rejected.length} filtered out${rejectLines ? ` (${rejectLines})` : ''}.<br>
    "Est. all-in" adds assumed condo fees and utilities to the advertised rent, because portals quote rent only.
    Where an ad states its own condo fees we use those instead. Always confirm the real total before signing.<br>
    Generated automatically &middot; ${esc(runAt.toISOString())}
  </td></tr>

</table>
</td></tr></table>
</body></html>`;
}

/** Write the report to reports/ and return the paths written. */
export function writeReport(html, config, runAt) {
  const dir = path.resolve(ROOT, config.report.outputDir);
  fs.mkdirSync(dir, { recursive: true });

  const stamp = runAt
    .toISOString()
    .replace(/[:.]/g, '-')
    .slice(0, 16); // YYYY-MM-DDTHH-mm
  const file = path.join(dir, `report-${stamp}.html`);
  fs.writeFileSync(file, html, 'utf8');

  const written = [file];
  if (config.report.keepLatestCopy) {
    const latest = path.join(dir, 'latest.html');
    fs.writeFileSync(latest, html, 'utf8');
    written.push(latest);
  }
  return written;
}
