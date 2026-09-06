# Genoa House Finder

Scans four Italian rental portals three times a day for **2-bedroom furnished
flats in your 12 target areas of Genoa, under €1000/month all-in**, and writes a
single tidy HTML report with photos, full details and contact numbers.

```
npm install
npm run install-browser     # one-time, for Idealista
npm start                   # run now, writes reports/latest.html
```

---

## What it searches

| Source | How | Typical yield |
|---|---|---|
| **Immobiliare.it** | Internal JSON API | ~300 ads — richest data: exact bedrooms, lift flag, neighbourhood tags, agency phone |
| **Subito.it** | Public search API | ~200 ads — best for **private landlords** (no agency commission) and structured furnished / A-C flags |
| **Casa.it** | Embedded page state | ~160 ads — full descriptions and agency phone |
| **Idealista.it** | Real browser (Playwright) | ~120 ads — sits behind DataDome bot protection, so it needs Chromium |

Roughly 780 ads per run, collapsing to ~580 distinct flats after cross-portal
duplicates are merged.

**Facebook Marketplace is not included.** It requires a logged-in session, and
automating a personal account there risks losing the account. Worth checking by
hand — it does carry private listings the portals don't.

## Your criteria

Everything lives in [`config.json`](config.json), which is commented throughout.

- **2 bedrooms.** Italian ads count *total rooms* (`locali`), so two bedrooms is
  a **trilocale** (3 locali). Searching for "2" returns one-bedroom flats. The
  conversion is handled for you, and 3-bedroom flats are kept too when they fit
  the budget (`allowBedroomsPlusOne`).
- **€1000/month all-in.** Portals advertise *rent only*. The report adds condo
  fees (`spese condominiali`) and utilities to show a realistic total, and says
  whether each figure was stated or estimated. Ads that say `spese incluse` are
  detected and not charged twice.
- **Furnished** — required. Ads explicitly marked `non arredato` are dropped;
  `parzialmente arredato` is treated as unknown, not as a yes.
- **Lift and air conditioning** — preferences, not filters. They push a listing
  up the ranking rather than excluding everything without them. A/C is rare in
  Genoa (~9% of matches), so requiring it would empty the report.

## Contract type and residenza

No portal offers a filter for either, so both are read from the ad text
([`src/contract.js`](src/contract.js)). **Long-term leases only** — these are
excluded when the ad says so:

| Excluded | Why |
|---|---|
| **Contratto transitorio** | Capped at 18 months, needs a documented temporary reason, no right of renewal |
| **Short-term / tourist** | `affitti brevi`, `locazione turistica`, seasonal, weekly, `trasfertisti` |
| **Students only** | `contratto per studenti universitari` — restricted to enrolled students |

On a live run that removed **20 transitorio, 9 short-term and 5 students-only**
listings that had otherwise passed every filter.

Subito ads carrying a **CIN** (Codice Identificativo Nazionale) are treated as
short-term regardless of wording — Italian law requires one for tourist lets, so
it is a fact about the listing rather than a claim in its prose.

Detection is negation-aware. A real ad reading *"SOLAMENTE USO STUDENTI, NO
TRASFERTISTI"* is a student let advertising that it refuses short-stay workers;
matching `trasfertisti` naively classified it as the opposite.

### Residenza

Whether you may register your official residence at the address — needed for
**permesso di soggiorno, tessera sanitaria and carta d'identità**. Some landlords
refuse it to avoid tax and paperwork, and rarely volunteer that until asked.

Every listing carries one of two chips:

- **residenza offered** — the ad says so explicitly. Worth a large ranking boost;
  it is uncommon and expensive to discover you cannot get it after signing.
- **residenza: ask** — the ad is silent, which is the overwhelming majority.
  Treated as a question to put to the landlord, never as a no.

Ads that *explicitly refuse* residenza are dropped. Set `contract.residenza` to
`"required"` in `config.json` to keep only ads that confirm it in writing — but
expect very few results, since almost nobody states it.

Where a chip reads **"residenza: ask (ad text limited)"**, the source gave only a
headline rather than the full ad, so "not stated" is weaker evidence than usual.
That is nearly always Immobiliare, whose list API returns just a marketing
caption. The run tries to open those ads in a browser to read the full body, but
Immobiliare's bot protection refuses detail pages more often than not; when it
does, the run gives up after three attempts and moves on. Set
`sources.immobiliare.fetchFullText: false` to skip the attempt entirely.

### Your 12 areas

Eight are tagged directly by the portals: Albaro, Piazza Manin, Carignano, Molo,
Foce, San Martino, San Vincenzo. The rest are streets or landmarks that no portal
tags — Via Assarotti, Via XX Settembre, Corso Europa, Brignole, Via Torti — so
those are matched on the address text and GPS position instead.

Each listing shows *why* it was matched ("zone tag Albaro", "street name in
address", "235 m from Via Assarotti"). Where an agency's own wording disagrees
with the portal's neighbourhood tag, the report says so rather than picking a
side — a real ad for a flat in Staglieno is headlined *"Manin inizio Montaldo"*.

Flats that pass every other test but fall outside your areas appear in a separate
**"Just outside your areas"** section. Set `zones.strict: true` to hide them.

## Scam protection

Rental fraud is common on open-posting portals. Listings are flagged, not hidden,
when they look wrong:

- **Rent far below market.** Measured against 448 real listings, Genoa runs a
  median of €10/m². Below €6/m² is the bottom ~2.5%.
- **Bulk posters.** In one run, a single advertiser posted 84 of 202 Subito ads —
  every implausibly cheap listing in the feed was theirs.
- **Cheap *and* feature-complete *and* bulk-posted** is treated as a probable
  scam and pushed to the bottom.

Such listings carry a visible warning in the report. **Never pay a deposit before
seeing a flat in person.**

## Scheduling

### Windows (now)

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install-schedule.ps1
```

Registers one task with triggers at **06:00, 12:00 and 18:00**. It catches up a
run the machine slept through, and logs to `data\run.log`.

```powershell
Start-ScheduledTask -TaskName "Genoa House Finder"          # test it now
powershell -File scripts\install-schedule.ps1 -Remove       # uninstall
```

### Linux VPS (later)

```bash
chmod +x scripts/vps-setup.sh && ./scripts/vps-setup.sh
```

Installs a systemd timer on the same schedule and pins the timezone to
`Europe/Rome` so it doesn't drift from Genoa time. On a headless VPS either
disable Idealista or let the script install Chromium's libraries — expect
DataDome to challenge more often from a datacentre IP than from home.

## Email delivery

Currently **off** — reports are written to `reports/`. To switch it on:

1. `cp .env.example .env` and fill in SMTP details (Gmail needs an
   [App Password](https://myaccount.google.com/apppasswords), not your normal one).
2. Set `email.enabled: true` in `config.json`.

It already sends to ``; the report HTML is written for
email clients (table layout, inline styles) so it renders correctly in Gmail.

## Reading the report

- **NEW** — appeared since the last run. Contact these first; good flats in
  Genoa go within days.
- **price cut** — the rent dropped since a previous run. Often means it isn't
  moving, so there may be room to negotiate.
- **also on N sites** — cross-posted, another sign it has been sitting a while.
- **listed 21d+** — on the market a while.
- `furnished?` / `A/C?` — the ad never said. Not a "no": most Italian ads simply
  omit these. Ask when you call.
- **private owner** — no agency commission (usually 1–2 months' rent).
- **residenza: ask** — the ad never mentions it. Raise it on the first call, before
  you view: it decides whether the address can support your permesso di soggiorno.
- **long-term contract** — the ad names a 4+4, 3+2 or canone concordato lease.

## Commands

| Command | What it does |
|---|---|
| `npm start` | Full run, writes the report |
| `npm run open` | Run and open the report in your browser |
| `npm run audit` | Text diagnostics — why listings were kept or dropped |
| `npm run audit -- --zones` | Match count per target area |
| `npm run audit -- --rejects` | What got filtered out, and why |
| `npm test` | 33 tests over the tricky conversions |
| `npm start -- --only=subito` | One source only |

## If a source stops working

Portals change their markup and APIs without warning. One source failing never
kills the report — the run continues and the header shows that source as
`blocked`. `npm run audit` is the fastest way to see what changed.

Idealista is the fragile one. If it starts returning nothing, set
`sources.idealista.headless: false` in `config.json` and run `npm start` — solve
the CAPTCHA once in the window that opens, and the saved browser profile usually
keeps working for days.

## Current state of the market

At the time of writing, **San Vincenzo, Carignano, Via XX Settembre and Corso
Europa returned no matches** — not a bug. The 2-bedroom furnished stock in those
central areas is priced above €1000/month all-in, or is one-bedroom. Most supply
in budget sits in Albaro, Molo, San Martino, Piazza Manin and Via Torti.

Excluding transitorio, short-term and students-only leases removes a further ~35
listings per run, which is why the match count sits near 27 rather than 60. That
is the cost of insisting on a long-term contract, and it is the right trade —
those leases could not have given you residenza or renewal rights anyway.

If you want more results, in order of yield:

1. Raise `budget.maxTotalPerMonth` — the single biggest constraint.
2. Set `property.furnished` to `"preferred"` — many ads simply never state it.
3. Set `contract.excludeStudentOnly: false` if you are enrolled at UniGe.

Do **not** loosen `contract.excludeTransitorio` to get more results: an 18-month
lease with no renewal right is not a home, and it will not support residenza.
