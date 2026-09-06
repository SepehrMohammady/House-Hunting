/**
 * Tests for the conversions the whole report depends on.
 *
 * Every case here came from a real bug or a real listing found while building
 * this - they are regression guards, not illustrations.
 *
 * Run: npm test
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  inferBedrooms,
  detectFurnished,
  detectElevator,
  detectAirConditioning,
  detectBillsIncluded,
  extractCondoFees,
  parsePrice,
  parseSurface,
  estimateTotalCost,
} from '../src/normalize.js';

import { matchZone, haversineMeters, norm } from '../src/zones.js';

/* ----------------------------- bedrooms ----------------------------- */

test('Italian room counts convert to bedrooms', () => {
  // "locali" counts the living room too: this is the conversion that decides
  // whether the user sees 1-bedroom flats by mistake.
  assert.equal(inferBedrooms({ text: 'bilocale arredato' }), 1);
  assert.equal(inferBedrooms({ text: 'trilocale con balcone' }), 2);
  assert.equal(inferBedrooms({ text: 'quadrilocale ristrutturato' }), 3);
  assert.equal(inferBedrooms({ text: 'monolocale centro' }), 0);
});

test('an explicit bedroom count beats the typology word', () => {
  assert.equal(inferBedrooms({ text: 'appartamento con 2 camere da letto' }), 2);
  assert.equal(inferBedrooms({ text: 'ampio con 3 camere' }), 3);
});

test('portal bedroom field is trusted when consistent with room count', () => {
  // A trilocale with only one bedroom is real and common - trusting the portal
  // here is what keeps those out of a 2-bedroom search.
  assert.equal(inferBedrooms({ explicitBedrooms: '2', rooms: '3' }), 2);
  assert.equal(inferBedrooms({ explicitBedrooms: '1', rooms: '3' }), 1);
  assert.equal(inferBedrooms({ explicitBedrooms: '3', rooms: '4' }), 3);
});

test('portal bedroom field is rejected when it leaves no living room', () => {
  // Real Immobiliare data: "Bilocale ... 2 locali" reported bedRoomsNumber 2.
  // Two bedrooms in a two-room flat is impossible, so fall back to the text.
  assert.equal(inferBedrooms({ explicitBedrooms: '2', rooms: '2', text: 'bilocale' }), 1);
  assert.equal(inferBedrooms({ explicitBedrooms: '1', rooms: '1', text: 'monolocale' }), 0);
});

test('vague room buckets do not produce a confident bedroom count', () => {
  assert.equal(inferBedrooms({ rooms: '5+', text: 'appartamento' }), null);
});

/* ----------------------------- features ----------------------------- */

test('furnished detection handles Italian negation', () => {
  assert.equal(detectFurnished('appartamento completamente arredato'), true);
  assert.equal(detectFurnished('ammobiliato con gusto'), true);
  // The bug this guards: a substring test reads "non arredato" as furnished.
  assert.equal(detectFurnished('appartamento non arredato'), false);
  assert.equal(detectFurnished('da arredare'), false);
  // "Partly furnished" is genuinely ambiguous - unknown, not a yes.
  assert.equal(detectFurnished('parzialmente arredato'), null);
  assert.equal(detectFurnished('appartamento luminoso'), null);
});

test('elevator detection handles Italian negation', () => {
  assert.equal(detectElevator('palazzo con ascensore'), true);
  assert.equal(detectElevator('terzo piano senza ascensore'), false);
  // No mention at all is unknown, not a definitive 'no lift'.
  assert.equal(detectElevator('primo piano'), null);
});

test('air conditioning detection covers the common phrasings', () => {
  assert.equal(detectAirConditioning('aria condizionata in ogni stanza'), true);
  assert.equal(detectAirConditioning('climatizzatore installato'), true);
  assert.equal(detectAirConditioning('pompa di calore'), true);
  // Heating is not cooling - and silence about A/C means unknown.
  assert.equal(detectAirConditioning('riscaldamento autonomo'), null);
  assert.equal(detectAirConditioning('senza aria condizionata'), false);
});

test('bills-included phrasings are recognised', () => {
  assert.equal(detectBillsIncluded('affitto 800 euro spese incluse'), true);
  assert.equal(detectBillsIncluded('750 tutto incluso'), true);
  assert.equal(detectBillsIncluded('canone 700 euro'), false);
});

test('condo fees are extracted only when plausible monthly figures', () => {
  assert.equal(extractCondoFees('spese condominiali 90 euro al mese'), 90);
  // 1200 would be an annual figure - rejected rather than silently wrong.
  assert.equal(extractCondoFees('spese condominiali 1200 annue'), null);
});

/* ------------------------------ numbers ------------------------------ */

test('Italian number formats parse correctly', () => {
  // "." is a thousands separator in Italian, so 1.250 is 1250, not 1.25.
  assert.equal(parsePrice('1.250 €/mese'), 1250);
  assert.equal(parsePrice('700 €'), 700);
  assert.equal(parsePrice(950), 950);
  assert.equal(parsePrice(null), null);
  assert.equal(parseSurface('55 mq'), 55);
  assert.equal(parseSurface('93 m²'), 93);
});

/* ---------------------------- cost model ---------------------------- */

const budget = {
  maxTotalPerMonth: 1000,
  assumedUtilitiesPerMonth: 110,
  assumedCondoFeesPerMonth: 90,
};

test('all-in cost adds assumed condo fees and utilities to advertised rent', () => {
  const r = estimateTotalCost({ rentPerMonth: 700 }, budget);
  assert.equal(r.total, 900);
  assert.equal(r.confidence, 'estimated');
});

test('stated condo fees are used instead of the assumption', () => {
  const r = estimateTotalCost({ rentPerMonth: 700, condoFeesPerMonth: 50 }, budget);
  assert.equal(r.total, 860);
  assert.equal(r.confidence, 'partly-estimated');
});

test('bills-included ads are not charged twice', () => {
  const r = estimateTotalCost({ rentPerMonth: 950, billsIncluded: true }, budget);
  assert.equal(r.total, 950);
  assert.equal(r.confidence, 'stated');
});

/* ------------------------------ zones ------------------------------ */

test('exact neighbourhood tags match with full confidence', () => {
  const m = matchZone({ microzone: 'Albaro', address: 'Via Puggia' });
  assert.equal(m.zone.key, 'albaro');
  assert.equal(m.confidence, 1.0);
});

test("a neighbouring district's own tag is not overruled by nearby coordinates", () => {
  // Pre' sits a few hundred metres from Molo. An earlier version labelled every
  // Pre' flat "Molo" on GPS proximity alone.
  const m = matchZone({
    microzone: 'Prè',
    address: 'Vico di Santa Fede',
    title: 'Trilocale Vico di Santa Fede, Prè, Genova',
    lat: 44.4105,
    lon: 8.9295,
  });
  assert.ok(m === null || m.zone.key !== 'molo', 'Pre must not be reported as Molo');
});

test('a street inside a larger district still matches when coordinates are close', () => {
  // Via Assarotti is inside Castelletto; the address names the street.
  const m = matchZone({
    microzone: 'Castelletto',
    address: 'Via Assarotti 12',
    title: 'Trilocale via Assarotti, Castelletto, Genova',
  });
  assert.equal(m.zone.key, 'assarotti');
});

test('city-centroid coordinates never drive a zone match', () => {
  // Subito returns the same comune centroid for every Genoa ad. Trusting it put
  // Sampierdarena and Molassana flats in Molo.
  const m = matchZone({
    title: 'Sampierdarena trilocale arredato',
    address: 'Genova',
    lat: 44.411493,
    lon: 8.932688,
    coarseLocation: true,
  });
  assert.equal(m, null, 'coarse coordinates must not match any zone');
});

test('agency framing that contradicts the portal tag is kept but marked disputed', () => {
  // Real ad: a Staglieno flat headlined "Manin inizio Montaldo".
  const m = matchZone({
    microzone: 'Staglieno',
    address: 'Via Leonardo Montaldo',
    title: 'Trilocale via Leonardo Montaldo 24, Staglieno, Genova',
    caption: 'Manin inizio Montaldo 6 vani silenziosi con balcone',
  });
  assert.equal(m.zone.key, 'manin');
  assert.equal(m.disputed, true);
  assert.ok(m.confidence < 0.5, 'disputed matches must rank below solid ones');
});

test('combined district labels do not claim the half we did not ask for', () => {
  // The macrozone "Albaro, Sturla" must not turn a Sturla flat into Albaro.
  const m = matchZone({ microzone: 'Sturla', macrozone: 'Albaro, Sturla', address: 'Via Pontetti' });
  assert.ok(m === null || m.zone.key !== 'albaro', 'Sturla must not be reported as Albaro');
});

test('haversine distance is sane for known Genoa points', () => {
  // Piazza De Ferrari to Piazza Manin is roughly 1.4 km.
  const d = haversineMeters(44.4053, 8.9375, 44.4166, 8.9497);
  assert.ok(d > 1200 && d < 1800, `expected ~1.4km, got ${Math.round(d)}m`);
});

test('accents and apostrophes normalise consistently', () => {
  assert.equal(norm('Prè'), 'pre');
  assert.equal(norm("Sant'Ilario"), 'sant ilario');
  assert.equal(norm('  SAN   MARTINO '), 'san martino');
});

/* --------------------------- source parsing --------------------------- */

import { parseIdealistaTitle } from '../src/sources/idealista.js';
import { dedupe } from '../src/dedupe.js';

test('Idealista titles yield a street and a neighbourhood', () => {
  // Idealista publishes no address or zone field, so the title is the only
  // source for both - and the street is what makes de-duplication possible.
  assert.deepEqual(parseIdealistaTitle('Appartamento in Via Filippo Palizzi, 8, Quarto, Genova'), {
    address: 'Via Filippo Palizzi 8',
    microzone: 'Quarto',
  });
  assert.deepEqual(parseIdealistaTitle('Quadrilocale in Via Ausonia, Castelletto, Genova'), {
    address: 'Via Ausonia',
    microzone: 'Castelletto',
  });
  assert.deepEqual(parseIdealistaTitle('Trilocale in Salita di Coccagna, 6, Molo, Genova'), {
    address: 'Salita di Coccagna 6',
    microzone: 'Molo',
  });
});

test('a malformed title degrades without throwing', () => {
  assert.equal(parseIdealistaTitle('').address, null);
  assert.equal(parseIdealistaTitle('Appartamento').address, 'Appartamento');
});

test('the same flat on two portals collapses into one entry', () => {
  const merged = dedupe([
    {
      id: 'immobiliare:1', source: 'Immobiliare.it', rentPerMonth: 700, surfaceSqm: 106,
      address: 'Via Napoli 10', contactPhones: ['010 123456'], photos: ['a.jpg'],
    },
    {
      id: 'idealista:2', source: 'Idealista.it', rentPerMonth: 700, surfaceSqm: 106,
      address: 'Via Napoli, 10', contactPhones: [], photos: ['b.jpg', 'c.jpg'],
    },
  ]);
  assert.equal(merged.listings.length, 1);
  assert.equal(merged.removed, 1);
  // The richer source survives, and it records where else the flat appears.
  assert.equal(merged.listings[0].source, 'Immobiliare.it');
  assert.equal(merged.listings[0].alsoOn[0].source, 'Idealista.it');
  // The better photo set wins even though it came from the lower-ranked portal.
  assert.equal(merged.listings[0].photos.length, 2);
});

test('different flats that happen to share rent and size stay separate', () => {
  // The trap: round prices and common sizes collide constantly. Rent+area alone
  // paired 109 of 120 Idealista listings with an unrelated Immobiliare one.
  const merged = dedupe([
    { id: 'a', source: 'Immobiliare.it', rentPerMonth: 800, surfaceSqm: 65, address: 'Via Francesco Sivori 8', contactPhones: [] },
    { id: 'b', source: 'Idealista.it', rentPerMonth: 800, surfaceSqm: 65, address: 'Salita di Coccagna 6', contactPhones: [] },
  ]);
  assert.equal(merged.listings.length, 2);
});

/* ------------------------ contract type & residenza ------------------------ */

import { detectContractType, detectResidenza } from '../src/contract.js';

test('transitorio leases are identified', () => {
  // Capped at 18 months with no right of renewal - excluded by config.
  assert.equal(detectContractType('Centro bilocale arredato contratto transitorio').type, 'transitorio');
  assert.equal(detectContractType('AFFITTO TRANSITORIO GE SAN MARTINO').type, 'transitorio');
  assert.equal(detectContractType('locazione transitoria 12 mesi').type, 'transitorio');
});

test('short-term and tourist lets are identified', () => {
  assert.equal(detectContractType('locazione turistica breve periodo').type, 'short');
  assert.equal(detectContractType('affitti brevi settimanali').type, 'short');
  assert.equal(detectContractType('Appartamento per trasfertisti').type, 'short');
  assert.equal(detectContractType('casa vacanze fronte mare').type, 'short');
});

test('a CIN code outranks the wording', () => {
  // Italian law requires a CIN for short-term tourist lets, so it is a fact
  // about the listing rather than a claim in its prose.
  const r = detectContractType('bellissimo trilocale contratto 4+4', { hasTouristCode: true });
  assert.equal(r.type, 'short');
});

test('a refusal of short lets is not read as an offer of one', () => {
  // Real ad: "SOLAMENTE USO STUDENTI, NO TRASFERTISTI, NO PRIMA CASA".
  // Matching "trasfertisti" without checking for the preceding "NO" classified
  // this as a short let - the opposite of what the landlord wrote.
  assert.equal(detectContractType('SOLAMENTE USO STUDENTI, NO TRASFERTISTI, NO PRIMA CASA').type, 'student');
  assert.equal(detectContractType('no affitti brevi, contratto 4+4 uso abitativo').type, 'long');
});

test('long-term contracts are identified', () => {
  assert.equal(detectContractType('affittasi 4+4 uso abitativo').type, 'long');
  assert.equal(detectContractType('canone concordato 3+2').type, 'long');
  assert.equal(detectContractType('contratto libero con cedolare secca').type, 'long');
});

test('an unstated contract type is not guessed', () => {
  assert.equal(detectContractType('Trilocale arredato con balcone').type, null);
});

test('residenza is tri-state and never inferred from silence', () => {
  assert.equal(detectResidenza('si concede residenza').allowed, true);
  assert.equal(detectResidenza('possibilita di residenza').allowed, true);
  assert.equal(detectResidenza('idoneo per residenza').allowed, true);

  assert.equal(detectResidenza('non si concede la residenza').allowed, false);
  assert.equal(detectResidenza('no residenza').allowed, false);
  // Refusing to be someone's primary home is a refusal of residenza.
  assert.equal(detectResidenza('NO PRIMA CASA').allowed, false);

  // The common case: the landlord simply never says. That is "ask", not "no".
  assert.equal(detectResidenza('Trilocale arredato, ottime condizioni').allowed, null);
});
