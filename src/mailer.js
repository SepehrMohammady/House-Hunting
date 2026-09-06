/**
 * Email delivery - wired up but switched off.
 *
 * The report currently lands in reports/. To start emailing it:
 *   1. copy .env.example to .env and fill in the SMTP values
 *   2. set email.enabled = true in config.json
 * Nothing else changes; the orchestrator already calls this.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENV_PATH = path.resolve(__dirname, '..', '.env');

/**
 * Minimal .env reader.
 *
 * Deliberately not a dependency: this needs to run from a scheduled task on a
 * bare machine, and one less package is one less thing to break at 06:00.
 */
export function loadEnv() {
  const env = { ...process.env };
  try {
    for (const line of fs.readFileSync(ENV_PATH, 'utf8').split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq < 0) continue;
      const key = trimmed.slice(0, eq).trim();
      let val = trimmed.slice(eq + 1).trim();
      // Strip one layer of surrounding quotes if present.
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      if (!(key in process.env)) env[key] = val; // real env wins over the file
    }
  } catch {
    /* no .env file - fine while email is disabled */
  }
  return env;
}

export async function sendReport({ html, config, stats, runAt, log }) {
  if (!config.email.enabled) {
    log.step('email: disabled in config - report saved to disk only');
    return { sent: false, reason: 'disabled' };
  }

  if (config.email.onlyIfNewListings && stats.newCount === 0) {
    log.step('email: nothing new since last run - not sending');
    return { sent: false, reason: 'no new listings' };
  }

  const env = loadEnv();
  const missing = ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS'].filter((k) => !env[k]);
  if (missing.length) {
    log.warn(`email: missing ${missing.join(', ')} in .env - report saved to disk only`);
    return { sent: false, reason: 'missing credentials' };
  }

  // The recipient lives in .env, not config.json: this repository is public and
  // an email address in a committed file is an address in everyone's clone.
  const recipient = env.REPORT_EMAIL_TO || config.email.to;
  if (!recipient) {
    log.warn('email: no recipient - set REPORT_EMAIL_TO in .env');
    return { sent: false, reason: 'no recipient' };
  }

  let nodemailer;
  try {
    nodemailer = (await import('nodemailer')).default;
  } catch {
    log.warn('email: nodemailer not installed - run "npm install"');
    return { sent: false, reason: 'nodemailer missing' };
  }

  const port = parseInt(env.SMTP_PORT || '587', 10);
  const transport = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port,
    secure: port === 465, // 465 is implicit TLS; 587 upgrades via STARTTLS
    auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
  });

  const date = runAt.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    timeZone: 'Europe/Rome',
  });
  const time = runAt.toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Europe/Rome',
  });

  const newPart = stats.newCount ? `${stats.newCount} new, ` : '';
  const subject = `${config.email.subjectPrefix} ${newPart}${stats.matchedCount} matches - ${date} ${time}`;

  try {
    const info = await transport.sendMail({
      from: env.SMTP_FROM || env.SMTP_USER,
      to: recipient,
      subject,
      html,
      text:
        `${stats.matchedCount} listings matched your criteria ` +
        `(${stats.newCount} new since the last run). ` +
        `Open this email in HTML to see the full report.`,
    });
    log.step(`email: sent (${info.messageId})`);
    return { sent: true, messageId: info.messageId };
  } catch (err) {
    log.warn(`email: send failed - ${err.message}`);
    return { sent: false, reason: err.message };
  }
}
