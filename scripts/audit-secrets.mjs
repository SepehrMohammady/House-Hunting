/**
 * Deep secret audit for this repository.
 *
 * Searches EVERY object in the git database, not just what is reachable from a
 * branch. A plain `git log -p` misses blobs left behind by amended commits,
 * aborted rebases and history rewrites, and those objects can still be fetched
 * by SHA from a public repository long after the commit that referenced them is
 * gone.
 *
 * This script itself contains no secret. Values to hunt for are supplied at run
 * time, so it is safe to commit and safe to re-run after any change.
 *
 *   npm run audit:secrets
 *   npm run audit:secrets -- --secret 'the-archive-password'
 *   npm run audit:secrets -- --remote      # clone the public remote and scan that
 *
 * A password given with --secret is also hashed, and the digest searched for
 * too: the archive gate compares an unsalted SHA-256, so a leaked digest is as
 * good as the password itself.
 *
 * Exits non-zero if anything critical is found, so it can gate a commit.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const useRemote = argv.includes('--remote');
const secrets = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--secret' && argv[i + 1]) secrets.push(argv[++i]);
}

/* ------------------------------- workspace ------------------------------- */

// fileURLToPath, not URL.pathname: on Windows the latter yields
// "/C:/Projects/House%20Finder/..." - leading slash and percent-encoded spaces -
// which is not a usable path and makes every spawn fail with ENOENT.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let scanDir = ROOT;
let tempClone = null;

const git = (args, cwd = scanDir) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });

if (useRemote) {
  const url = git(['remote', 'get-url', 'origin']).trim();
  tempClone = fs.mkdtempSync(path.join(os.tmpdir(), 'secret-audit-'));
  console.log(`Cloning ${url.replace(/\/\/.*@/, '//')} to scan what the public actually sees...`);
  execFileSync('git', ['clone', '-q', url, tempClone], { stdio: 'inherit' });
  scanDir = tempClone;
}

/* -------------------------------- needles -------------------------------- */

const needles = [
  // Always checked - these are never legitimate in a public repository.
  { label: 'SSH private key material', re: /BEGIN (OPENSSH|RSA|EC|DSA) PRIVATE KEY/, critical: true },
  { label: 'AWS access key id', re: /\bAKIA[0-9A-Z]{16}\b/, critical: true },
  { label: 'generic api/secret assignment', re: /(api[_-]?key|secret|token)\s*[:=]\s*['"][A-Za-z0-9_\-]{16,}['"]/i, critical: true },
  // Worth a look, but often a legitimate placeholder.
  { label: 'any 64-char hex (possible password digest)', re: /\b[0-9a-f]{64}\b/, critical: false },
  { label: 'SSH public key', re: /ssh-(ed25519|rsa) AAAA[A-Za-z0-9+/]{20}/, critical: false },
  { label: 'email address', re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/, critical: false },
];

// Anything passed with --secret, plus its SHA-256, since the gate treats the
// digest as the credential.
for (const s of secrets) {
  const digest = createHash('sha256').update(s, 'utf8').digest('hex');
  needles.push({ label: 'supplied secret (plaintext)', re: new RegExp(escapeRe(s), 'i'), critical: true });
  needles.push({ label: 'supplied secret (SHA-256 digest)', re: new RegExp(digest, 'i'), critical: true });
  needles.push({ label: 'supplied secret (digest prefix)', re: new RegExp(digest.slice(0, 16), 'i'), critical: true });
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/* --------------------------------- scan --------------------------------- */

const findings = [];
const seen = new Set();

function scan(text, where) {
  for (const n of needles) {
    const m = text.match(n.re);
    if (!m) continue;
    const key = `${n.label}|${where}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const i = Math.max(0, m.index - 40);
    findings.push({
      where,
      needle: n.label,
      critical: n.critical,
      sample: text.slice(i, m.index + m[0].length + 40).replace(/\s+/g, ' ').trim(),
    });
  }
}

console.log('Scanning every git object (reachable and unreachable)...');
const objects = git(['cat-file', '--batch-all-objects', '--batch-check=%(objectname) %(objecttype) %(objectsize)'])
  .split('\n')
  .filter(Boolean)
  .map((l) => l.split(' '));

let blobs = 0;
let commits = 0;
for (const [sha, type, size] of objects) {
  if (type !== 'blob' && type !== 'commit') continue;
  if (Number(size) > 8 * 1024 * 1024) continue;
  let content;
  try {
    content = git(['cat-file', type, sha]);
  } catch {
    continue;
  }
  type === 'blob' ? blobs++ : commits++;
  scan(content, `git object ${sha.slice(0, 10)} (${type})`);
}
console.log(`  ${blobs} blobs, ${commits} commits`);

console.log('Scanning tracked files in the working tree...');
const tracked = git(['ls-files']).split('\n').filter(Boolean);
for (const f of tracked) {
  try {
    scan(fs.readFileSync(path.join(scanDir, f), 'utf8'), `tracked file ${f}`);
  } catch {
    /* binary or unreadable */
  }
}
console.log(`  ${tracked.length} files`);

console.log('Scanning refs, reflog and stash...');
for (const cmd of [
  ['reflog', '--all', '--format=%H %gd %gs'],
  ['for-each-ref', '--format=%(refname) %(objectname)'],
  ['stash', 'list'],
]) {
  try {
    scan(git(cmd), `git ${cmd[0]}`);
  } catch {
    /* nothing to scan */
  }
}

/* -------------------- sensitive files must stay untracked -------------------- */

const mustBeIgnored = [
  '.env',
  'VPS-SETUP-PROMPT.md',
  'publish',
  'data/seen.json',
  'data/run.log',
  'data/reports-index.json',
];
const ignoreProblems = [];
if (!useRemote) {
  for (const f of mustBeIgnored) {
    if (!fs.existsSync(path.join(ROOT, f))) continue;
    let ignored = true;
    try {
      execFileSync('git', ['check-ignore', '-q', f], { cwd: ROOT });
    } catch {
      ignored = false;
    }
    if (!ignored || tracked.includes(f)) ignoreProblems.push(f);
  }
}

/* -------------------------------- report -------------------------------- */

const critical = findings.filter((f) => f.critical);
const other = findings.filter((f) => !f.critical);

console.log('\n' + '='.repeat(74));
console.log(useRemote ? 'SCANNED: fresh clone of the public remote' : 'SCANNED: local repository');
if (!secrets.length) {
  console.log('NOTE: no --secret given, so only generic patterns were checked.');
  console.log('      Pass the archive password to also search for it and its digest.');
}
console.log('-'.repeat(74));

if (!critical.length) {
  console.log('CRITICAL : none');
} else {
  console.log(`CRITICAL : ${critical.length}`);
  for (const f of critical) console.log(`  [${f.needle}] ${f.where}\n     ...${f.sample}...`);
}

if (!other.length) {
  console.log('REVIEW   : none');
} else {
  console.log(`REVIEW   : ${other.length} (may be legitimate placeholders)`);
  for (const f of other) console.log(`  [${f.needle}] ${f.where}\n     ...${f.sample.slice(0, 110)}...`);
}

if (!useRemote) {
  console.log(
    ignoreProblems.length
      ? `IGNORE   : PROBLEM - these are not ignored: ${ignoreProblems.join(', ')}`
      : 'IGNORE   : all sensitive files on disk are correctly ignored'
  );
}
console.log('='.repeat(74));

if (tempClone) fs.rmSync(tempClone, { recursive: true, force: true });
process.exit(critical.length || ignoreProblems.length ? 1 : 0);
