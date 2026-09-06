/**
 * Publishes reports as a browsable archive.
 *
 * Rather than emailing one report at a time, every run drops its HTML into a
 * publish directory and regenerates an index listing every report kept, newest
 * first. The whole directory is then served from a password-protected path on
 * the user's own site.
 *
 * Access control is enforced by nginx, not by this code. The login page written
 * here collects a password and stores it in a cookie; nginx compares that cookie
 * and refuses to send any content when it does not match. The distinction
 * matters: a page that downloads the content and then asks JavaScript whether to
 * reveal it protects nothing, because the content already reached the visitor.
 * Here the browser gets a redirect until the cookie is right.
 *
 * Consequently login.html holds no secret and is safe to publish - the password
 * itself lives only in the nginx configuration on the server, never in this
 * repository, which is public. See docs/deployment.md.
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

/* ------------------------------ login page ------------------------------ */

/**
 * The unlock page. Deliberately contains no secret of any kind.
 *
 * It takes a password, stores it in a cookie scoped to this path, and reloads.
 * nginx does the actual comparison and serves nothing until the cookie matches,
 * so this file is inert on its own - publishing it gives nothing away.
 *
 * The cookie is set only for this path, marked Secure so it is never sent over
 * plain HTTP, and SameSite=Lax so another site cannot ride on it. It cannot be
 * HttpOnly, because script has to set it; that is an accepted trade for the
 * password-only prompt, and the pages behind it contain public rental adverts
 * rather than anything sensitive.
 */
function buildLoginPage(config) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${esc(config.report.title)}</title>
<style>
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
       background:${C.bg};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:${C.ink};}
  .card{background:${C.card};border:1px solid ${C.line};border-radius:10px;padding:32px 30px;
        width:340px;max-width:calc(100% - 32px);box-shadow:0 1px 3px rgba(0,0,0,.06);}
  h1{margin:0 0 4px;font-size:19px;}
  p{margin:0 0 20px;font-size:13px;color:${C.muted};}
  input{width:100%;box-sizing:border-box;padding:11px 12px;font-size:15px;
        border:1px solid ${C.line};border-radius:6px;background:#fff;color:${C.ink};}
  input:focus{outline:none;border-color:${C.cool};box-shadow:0 0 0 3px ${C.coolBg};}
  button{width:100%;margin-top:12px;padding:11px;font-size:14px;font-weight:600;
         background:${C.cool};color:#fff;border:0;border-radius:6px;cursor:pointer;}
  .err{margin-top:14px;padding:9px 11px;border-radius:6px;background:${C.warnBg};
       color:${C.warn};font-size:12px;font-weight:600;display:none;}
</style></head>
<body>
  <form class="card" id="f" autocomplete="on">
    <h1>${esc(config.report.title)}</h1>
    <p>Enter the password to view the reports.</p>
    <input id="p" type="password" name="password" placeholder="Password"
           autocomplete="current-password" autofocus>
    <button type="submit">Unlock</button>
    <div class="err" id="e">That password was not accepted. Try again.</div>
  </form>
<script>
  // Arriving here with a cookie already set means the server rejected it.
  if (document.cookie.indexOf('hh=') !== -1) {
    document.getElementById('e').style.display = 'block';
  }
  document.getElementById('f').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var v = document.getElementById('p').value;
    if (!v) return;
    // Stored verbatim, minus the few characters a cookie value cannot hold
    // (RFC 6265 forbids whitespace, comma, semicolon, quote and backslash).
    // Deliberately NOT percent-encoded: the server compares this against the
    // password as written in its config, and encodeURIComponent would turn
    // a password like "abc@123" into "abc%40123", so the two would never match.
    v = v.replace(/[\s",;\\]/g, '');
    // Scope the cookie to this directory only, derived from where this page is
    // actually served. Path=/ would send the password to every other page on
    // the domain, and hard-coding the path would put the deployment location
    // into a public repository.
    var base = window.location.pathname.replace(/[^/]*$/, '');
    // HTTPS only, and not sent on cross-site requests. The server decides
    // whether it is correct; this only stores it.
    document.cookie = 'hh=' + v +
      '; Path=' + base + '; Max-Age=31536000; Secure; SameSite=Lax';
    window.location.replace('./');
  });
</script>
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

  // The unlock page. Regenerated each run so a styling change reaches the
  // server, and cheap enough that keeping it in step is not worth conditioning.
  const loginPath = path.join(publishDir, 'login.html');
  fs.writeFileSync(loginPath, buildLoginPage(config), 'utf8');

  log.step(
    `publish: ${keep.length} reports in ${cfg.localDir}/` +
      (dropped.length ? ` (pruned ${dropped.length})` : '')
  );

  return {
    published: true,
    publishDir,
    indexPath,
    loginPath,
    reportFile: file,
    total: keep.length,
    pruned: dropped.length,
  };
}
