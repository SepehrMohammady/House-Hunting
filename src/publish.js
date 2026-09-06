/**
 * Publishes reports as a browsable archive.
 *
 * Rather than emailing one report at a time, every run drops its HTML into a
 * publish directory and regenerates an index listing every report kept, newest
 * first. The whole directory is then served from a password-protected path on
 * the user's own site.
 *
 * Access control is deliberately NOT implemented here. A password checked in
 * client-side JavaScript is decoration - the page and its markup are already on
 * the visitor's machine by the time it runs. Protection belongs at the web
 * server, where nginx can refuse the request before any content is sent. That
 * setup lives in docs/deployment.md, and the password never enters this
 * repository, which is public.
 *
 * The index carries no personal data: no address, no email, no domain. It is
 * a list of dates and counts, and the report pages themselves contain only
 * public rental adverts.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { esc, C } from './report.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const MANIFEST = path.resolve(ROOT, 'data', 'reports-index.json');

/* ------------------------------- manifest ------------------------------- */

function loadManifest() {
  try {
    const parsed = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
    return Array.isArray(parsed.reports) ? parsed.reports : [];
  } catch {
    return [];
  }
}

function saveManifest(reports) {
  fs.mkdirSync(path.dirname(MANIFEST), { recursive: true });
  fs.writeFileSync(MANIFEST, JSON.stringify({ reports }, null, 2), 'utf8');
}

/* -------------------------------- index -------------------------------- */

const ROME = 'Europe/Rome';

function fmtDate(iso) {
  return new Date(iso).toLocaleDateString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: ROME,
  });
}

function fmtTime(iso) {
  return new Date(iso).toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: ROME,
  });
}

/** Group reports by calendar day so the archive reads as a diary, not a list. */
function groupByDay(reports) {
  const days = new Map();
  for (const r of reports) {
    const key = fmtDate(r.runAt);
    if (!days.has(key)) days.set(key, []);
    days.get(key).push(r);
  }
  return days;
}

function statCell(value, label, colour = C.ink) {
  return (
    `<td style="padding:0 20px 0 0;">` +
    `<div style="font-size:23px;font-weight:700;color:${colour};">${value}</div>` +
    `<div style="font-size:10px;color:${C.muted};text-transform:uppercase;letter-spacing:.5px;">${esc(label)}</div>` +
    `</td>`
  );
}

function buildIndex(reports, config) {
  const latest = reports[0];
  const days = groupByDay(reports);

  const rows = [];
  for (const [day, entries] of days) {
    rows.push(
      `<tr><td colspan="5" style="padding:18px 14px 6px;font-size:12px;font-weight:700;` +
        `color:${C.muted};text-transform:uppercase;letter-spacing:.6px;">${esc(day)}</td></tr>`
    );

    for (const r of entries) {
      const isLatest = r.file === latest.file;
      const newBadge = r.newCount
        ? `<span style="display:inline-block;padding:1px 7px;border-radius:9px;background:${C.goodBg};` +
          `color:${C.good};font-size:11px;font-weight:700;">${r.newCount} new</span>`
        : `<span style="color:${C.muted};font-size:11px;">&mdash;</span>`;

      const cuts = r.dropCount
        ? `<span style="display:inline-block;padding:1px 7px;border-radius:9px;background:${C.warnBg};` +
          `color:${C.warn};font-size:11px;font-weight:700;">${r.dropCount} cut</span>`
        : `<span style="color:${C.muted};font-size:11px;">&mdash;</span>`;

      rows.push(
        `<tr style="border-bottom:1px solid ${C.line};background:${isLatest ? C.coolBg : C.card};">` +
          `<td style="padding:11px 14px;white-space:nowrap;">` +
          `<a href="reports/${esc(r.file)}" style="color:${C.cool};font-size:14px;font-weight:700;text-decoration:none;">` +
          `${esc(fmtTime(r.runAt))}</a>` +
          (isLatest
            ? `<span style="margin-left:8px;font-size:10px;color:${C.cool};font-weight:700;">LATEST</span>`
            : '') +
          `</td>` +
          `<td style="padding:11px 8px;font-size:14px;font-weight:600;color:${C.ink};">${r.matchedCount}` +
          `<span style="color:${C.muted};font-weight:400;font-size:12px;"> matches</span></td>` +
          `<td style="padding:11px 8px;">${newBadge}</td>` +
          `<td style="padding:11px 8px;">${cuts}</td>` +
          `<td style="padding:11px 14px;text-align:right;">` +
          `<a href="reports/${esc(r.file)}" style="display:inline-block;padding:6px 13px;background:${C.cool};` +
          `color:#fff;border-radius:5px;font-size:12px;font-weight:600;text-decoration:none;">Open</a></td>` +
          `</tr>`
      );
    }
  }

  const generated = new Date().toLocaleString('en-GB', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: ROME,
  });

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${esc(config.report.title)} - Archive</title></head>
<body style="margin:0;padding:0;background:${C.bg};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:${C.ink};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.bg};padding:22px 10px;">
<tr><td align="center">
<table role="presentation" width="820" cellpadding="0" cellspacing="0" style="width:820px;max-width:100%;background:${C.card};border-radius:10px;border:1px solid ${C.line};overflow:hidden;">

  <tr><td colspan="5" style="padding:24px 24px 20px;border-bottom:1px solid ${C.line};">
    <div style="font-size:22px;font-weight:700;">${esc(config.report.title)}</div>
    <div style="font-size:12px;color:${C.muted};margin-top:4px;">
      Updated at 06:00, 12:00 and 18:00 Rome time &middot; ${esc(reports.length)} reports kept
    </div>
    ${
      latest
        ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:18px;"><tr>` +
          statCell(latest.matchedCount, 'in your areas') +
          statCell(latest.newCount, 'new last run', latest.newCount ? C.good : C.ink) +
          statCell(latest.dropCount, 'price cuts', latest.dropCount ? C.warn : C.ink) +
          statCell(latest.scanned, 'ads scanned') +
          `</tr></table>` +
          `<div style="margin-top:18px;">` +
          `<a href="reports/${esc(latest.file)}" style="display:inline-block;padding:10px 18px;background:${C.cool};` +
          `color:#fff;border-radius:6px;font-size:13px;font-weight:700;text-decoration:none;">` +
          `Open latest report &rarr;</a></div>`
        : ''
    }
  </td></tr>

  ${rows.join('')}

  <tr><td colspan="5" style="padding:16px 24px;border-top:1px solid ${C.line};background:${C.bg};font-size:11px;color:${C.muted};line-height:1.6;">
    Reports older than ${config.publish.keepDays} days are removed automatically.<br>
    Prices shown are estimated all-in totals (rent + condo fees + utilities). Always confirm the real
    figure, and whether <strong>residenza</strong> is granted, before signing anything.<br>
    Page generated ${esc(generated)}.
  </td></tr>

</table>
</td></tr></table>
</body></html>`;
}

/* -------------------------------- publish -------------------------------- */

/**
 * Copy this run's report into the publish directory, prune old ones and
 * regenerate the index. Returns a summary for the run log.
 */
export function publishReport({ reportPath, config, stats, runAt, log }) {
  const cfg = config.publish;
  if (!cfg?.enabled) return { published: false, reason: 'disabled' };

  const publishDir = path.resolve(ROOT, cfg.localDir);
  const reportsDir = path.join(publishDir, 'reports');
  fs.mkdirSync(reportsDir, { recursive: true });

  const file = path.basename(reportPath);
  fs.copyFileSync(reportPath, path.join(reportsDir, file));

  // Record this run, newest first.
  let reports = loadManifest().filter((r) => r.file !== file);
  reports.unshift({
    file,
    runAt: runAt.toISOString(),
    matchedCount: stats.matchedCount,
    newCount: stats.newCount,
    dropCount: stats.dropCount,
    scanned: stats.scanned,
  });
  reports.sort((a, b) => new Date(b.runAt) - new Date(a.runAt));

  // Prune by age and by count, then delete the orphaned files.
  const cutoff = Date.now() - (cfg.keepDays ?? 60) * 86400000;
  const keep = reports
    .filter((r) => new Date(r.runAt).getTime() >= cutoff)
    .slice(0, cfg.maxReports ?? 120);

  const dropped = reports.filter((r) => !keep.includes(r));
  for (const r of dropped) {
    fs.rmSync(path.join(reportsDir, r.file), { force: true });
  }

  saveManifest(keep);

  const indexPath = path.join(publishDir, 'index.html');
  fs.writeFileSync(indexPath, buildIndex(keep, config), 'utf8');

  log.step(
    `publish: ${keep.length} reports in ${cfg.localDir}/` +
      (dropped.length ? ` (pruned ${dropped.length})` : '')
  );

  return {
    published: true,
    publishDir,
    indexPath,
    reportFile: file,
    total: keep.length,
    pruned: dropped.length,
  };
}
