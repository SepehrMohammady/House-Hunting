/**
 * Uploads the published archive to the web server over SSH.
 *
 * Everything identifying - host, user, path, key - comes from .env, which is
 * git-ignored. Nothing about the destination is committed, because this
 * repository is public.
 *
 * Authentication is SSH key only. `BatchMode=yes` guarantees the process can
 * never sit waiting on a password prompt, which matters when this runs
 * unattended at 06:00: a hung scheduled task is worse than a failed one.
 *
 * Only what changed is sent - the new report plus the regenerated index - so a
 * run transfers a couple of hundred KB rather than the whole archive.
 *
 * If the scanner itself runs on the web server, skip all of this: point
 * publish.localDir straight at the served directory and leave upload disabled.
 */

import { execFile } from 'node:child_process';
import path from 'node:path';
import { loadEnv } from './mailer.js';

const run = (cmd, args, timeoutMs = 60000) =>
  new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout, stderr: stderr || (err && err.message) || '' });
    });
  });

/** Shared ssh/scp options. Key-only, never interactive. */
function sshOptions(env, forScp) {
  const opts = [
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=15',
    // Trust the key on first contact, then pin it. A scheduled job cannot answer
    // an interactive host-key prompt, and refusing to connect at all would mean
    // the first run after any server rebuild silently stops publishing.
    '-o', 'StrictHostKeyChecking=accept-new',
  ];
  if (env.VPS_SSH_KEY) opts.push('-i', env.VPS_SSH_KEY);
  if (env.VPS_PORT) opts.push(forScp ? '-P' : '-p', String(env.VPS_PORT));
  return opts;
}

/**
 * Report filenames already sitting on the server.
 *
 * Both machines publish into one archive: the server on its schedule, and this
 * one for the portal the server's address cannot reach. Each therefore holds
 * reports the other has never seen, and the index is regenerated from scratch
 * on every run, so each side has to be told about the other's.
 *
 * A failure here is not worth stopping for. The index is then merely
 * incomplete until the next run on either machine rebuilds it.
 */
export async function listRemoteReports({ config, log }) {
  if (!config.publish?.upload?.enabled) return [];

  const env = loadEnv();
  if (!env.VPS_HOST || !env.VPS_USER || !env.VPS_PATH) return [];

  const remote = env.VPS_PATH.replace(/\/+$/, '');
  const res = await run(
    'ssh',
    [
      ...sshOptions(env, false),
      `${env.VPS_USER}@${env.VPS_HOST}`,
      `ls -1 '${remote}/reports' 2>/dev/null || true`,
    ],
    30000
  );

  if (!res.ok) {
    log.warn('upload: could not list the server reports - the index may miss its runs');
    return [];
  }

  return res.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((f) => /^report-.*\.html$/.test(f));
}

export async function uploadArchive({ publishResult, config, log }) {
  if (!config.publish?.upload?.enabled) return { uploaded: false, reason: 'disabled' };
  if (!publishResult?.published) return { uploaded: false, reason: 'nothing published' };

  const env = loadEnv();
  const missing = ['VPS_HOST', 'VPS_USER', 'VPS_PATH'].filter((k) => !env[k]);
  if (missing.length) {
    log.warn(`upload: missing ${missing.join(', ')} in .env - archive stays local`);
    return { uploaded: false, reason: 'not configured' };
  }

  const target = `${env.VPS_USER}@${env.VPS_HOST}`;
  const remote = env.VPS_PATH.replace(/\/+$/, '');
  const sshOpts = sshOptions(env, false);
  const scpOpts = sshOptions(env, true);

  // Make sure the destination exists before copying into it.
  const mk = await run('ssh', [...sshOpts, target, `mkdir -p '${remote}/reports'`]);
  if (!mk.ok) {
    log.warn(`upload: cannot reach the server - ${mk.stderr.trim().split('\n')[0]}`);
    return { uploaded: false, reason: 'ssh failed' };
  }

  const localReport = path.join(publishResult.publishDir, 'reports', publishResult.reportFile);
  const localIndex = publishResult.indexPath;

  const sentReport = await run(
    'scp',
    [...scpOpts, localReport, `${target}:${remote}/reports/`],
    120000
  );
  if (!sentReport.ok) {
    log.warn(`upload: report transfer failed - ${sentReport.stderr.trim().split('\n')[0]}`);
    return { uploaded: false, reason: 'scp failed' };
  }

  // The unlock page. Tiny, and only changes when its styling does, but sending
  // it every run means a fresh server needs no manual seeding. Not fatal if it
  // fails - the archive itself is already up.
  const sentLogin = await run(
    'scp',
    [...scpOpts, publishResult.loginPath, `${target}:${remote}/`],
    60000
  );
  if (!sentLogin.ok) {
    log.warn(`upload: login page transfer failed - ${sentLogin.stderr.trim().split('\n')[0]}`);
  }

  // The index goes last: until it lands, the site still shows the previous run
  // rather than linking a report that has not finished uploading.
  const sentIndex = await run('scp', [...scpOpts, localIndex, `${target}:${remote}/`], 60000);
  if (!sentIndex.ok) {
    log.warn(`upload: index transfer failed - ${sentIndex.stderr.trim().split('\n')[0]}`);
    return { uploaded: false, reason: 'scp failed' };
  }

  // Mirror local pruning so the server does not accumulate reports forever.
  if (publishResult.pruned > 0) {
    await run('ssh', [
      ...sshOpts,
      target,
      // Delete anything older than the retention window. Bounded by name pattern
      // so a mistyped path cannot turn this into a wider delete.
      `find '${remote}/reports' -maxdepth 1 -name 'report-*.html' -mtime +${config.publish.keepDays} -delete 2>/dev/null || true`,
    ]);
  }

  log.step(`upload: published ${publishResult.reportFile} and refreshed the index`);
  return { uploaded: true };
}
