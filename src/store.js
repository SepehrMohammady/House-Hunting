/**
 * Run-to-run memory, kept in data/seen.json.
 *
 * Three runs a day only helps if the report can say what CHANGED since the last
 * one - otherwise you re-read the same 40 flats every time. This tracks:
 *   - which listings are new since you last looked
 *   - which ones dropped their asking rent (a strong signal the flat is not moving)
 *   - which ones have since disappeared
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STORE_PATH = path.resolve(__dirname, '..', 'data', 'seen.json');

export function loadStore() {
  try {
    const raw = fs.readFileSync(STORE_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return { seen: parsed.seen || {}, lastRun: parsed.lastRun || null };
  } catch {
    return { seen: {}, lastRun: null }; // first run, or the file was corrupted
  }
}

export function saveStore(store) {
  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
  fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2), 'utf8');
}

/**
 * Annotate listings with isNew / priceDrop, then update the store in place.
 * Returns counts for the report header.
 */
export function markChanges(listings, store) {
  const now = new Date().toISOString();
  const seen = store.seen;
  let newCount = 0;
  let dropCount = 0;

  for (const l of listings) {
    const prev = seen[l.id];

    if (!prev) {
      l.isNewSinceLastRun = true;
      newCount++;
      seen[l.id] = { firstSeen: now, lastSeen: now, rent: l.rentPerMonth };
      continue;
    }

    l.isNewSinceLastRun = false;
    l.firstSeen = prev.firstSeen;

    // Days on market is the other thing worth knowing at a glance.
    const ageMs = Date.now() - new Date(prev.firstSeen).getTime();
    l.daysListed = Math.max(0, Math.floor(ageMs / 86400000));

    if (
      Number.isFinite(prev.rent) &&
      Number.isFinite(l.rentPerMonth) &&
      l.rentPerMonth < prev.rent
    ) {
      l.priceDrop = { from: prev.rent, to: l.rentPerMonth };
      dropCount++;
    }

    seen[l.id] = {
      firstSeen: prev.firstSeen,
      lastSeen: now,
      // Keep the lowest rent we have ever seen so a later rebound still reads as
      // a drop against the original asking price.
      rent: Number.isFinite(l.rentPerMonth) ? Math.min(l.rentPerMonth, prev.rent ?? l.rentPerMonth) : prev.rent,
    };
  }

  // Forget listings not seen for 30 days so the file does not grow forever.
  const cutoff = Date.now() - 30 * 86400000;
  for (const [id, rec] of Object.entries(seen)) {
    if (new Date(rec.lastSeen).getTime() < cutoff) delete seen[id];
  }

  store.lastRun = now;
  return { newCount, dropCount };
}
