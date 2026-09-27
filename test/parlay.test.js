import { test } from 'node:test';
import assert from 'node:assert/strict';
import { americanToDecimal, decimalToAmerican, fairProb } from '../src/odds-math.js';
import { normalizeEvents, demoEvents } from '../src/odds.js';
import { tally, buildParlays, priceParlay } from '../src/parlay.js';
import { weekWindow, weekLabel } from '../src/week.js';

test('odds conversions', () => {
  assert.equal(americanToDecimal(-110).toFixed(4), '1.9091');
  assert.equal(americanToDecimal(150), 2.5);
  assert.equal(decimalToAmerican(2.5), 150);
  assert.equal(decimalToAmerican(1.5), -200);
  assert.equal(fairProb(-110, -110), 0.5);
});

test('two -110 legs price at about +264', () => {
  const leg = { price: -110, fairProb: 0.5 };
  const p = priceParlay([leg, leg], 10);
  assert.equal(p.american, 264);
  assert.equal(p.payout.toFixed(2), '36.45');
  assert.equal(p.hitProb, 0.25);
  assert.ok(p.ev < 0);
});

test('week window runs Tuesday to Tuesday and labels the week', () => {
  const win = weekWindow(new Date('2026-09-27T18:00:00Z')); // a Sunday
  assert.equal(win.key, '2026-09-22');
  assert.equal(weekLabel(win), 'Week 3');
  assert.equal(weekWindow(new Date('2026-09-22T11:00:00Z')).key, '2026-09-15');
});

function fixture() {
  const start = new Date('2026-09-22T12:00:00Z');
  const games = normalizeEvents(demoEvents(start), 'demo');
  const selections = new Map();
  for (const g of games) for (const s of g.selections) selections.set(s.key, { ...s, commence: g.commence });
  const k = (i, market, side) => `demo-2026-09-22-${i}|${market}|${side}`;
  return { selections, k, now: new Date('2026-09-22T13:00:00Z') };
}

test('normalizes the API shape into six selections per game', () => {
  const { selections } = fixture();
  assert.equal(selections.size, 13 * 6);
});

test('builds parlays only from majority picks, one leg per game', () => {
  const { selections, k, now } = fixture();
  const picks = {
    Ann: [k(1, 'ml', 'home'), k(2, 'spread', 'home'), k(3, 'total', 'over'), k(4, 'ml', 'away')],
    Ben: [k(1, 'ml', 'home'), k(2, 'spread', 'home'), k(3, 'total', 'over'), k(5, 'ml', 'home')],
    Cal: [k(1, 'ml', 'home'), k(2, 'spread', 'home'), k(1, 'total', 'under')],
    Dee: [k(1, 'ml', 'home'), k(3, 'total', 'over'), k(1, 'total', 'under')],
  };
  const result = buildParlays(tally(picks, selections), 4, { now });
  assert.equal(result.need, 3);
  // Game 1 has two majority plays (ML 4/4, under 2/4 doesn't count) -> only ML.
  assert.deepEqual(result.consensus.map((s) => s.key), [k(1, 'ml', 'home'), k(2, 'spread', 'home'), k(3, 'total', 'over')]);
  for (const opt of result.options) {
    const gameIds = opt.legs.map((l) => l.gameId);
    assert.equal(new Set(gameIds).size, gameIds.length, `${opt.name} repeats a game`);
    assert.ok(opt.legs.length >= 2);
  }
  // No duplicate leg sets across options.
  const sigs = result.options.map((o) => o.legs.map((l) => l.key).sort().join());
  assert.equal(new Set(sigs).size, sigs.length);
  // Game 1 is already in the consensus via the ML, so its 2/4 under isn't "one vote away".
  assert.ok(result.almost.every((s) => s.gameId !== 'demo-2026-09-22-1'));
});

test('unanimous option only includes plays everyone took', () => {
  const { selections, k, now } = fixture();
  const picks = {
    Ann: [k(1, 'ml', 'home'), k(2, 'spread', 'home'), k(3, 'total', 'over')],
    Ben: [k(1, 'ml', 'home'), k(2, 'spread', 'home')],
    Cal: [k(1, 'ml', 'home'), k(2, 'spread', 'home'), k(3, 'total', 'over')],
  };
  const { options } = buildParlays(tally(picks, selections), 3, { now });
  const unanimous = options.find((o) => o.name === 'Everybody Agrees');
  assert.deepEqual(unanimous.legs.map((l) => l.key), [k(1, 'ml', 'home'), k(2, 'spread', 'home')]);
});

test('skips games that already kicked off', () => {
  const { selections, k } = fixture();
  const picks = { Ann: [k(0, 'ml', 'home'), k(1, 'ml', 'home')], Ben: [k(0, 'ml', 'home'), k(1, 'ml', 'home')] };
  // Game 0 is the Thursday game; by Friday it's locked.
  const { consensus, options } = buildParlays(tally(picks, selections), 2, { now: new Date('2026-09-25T12:00:00Z') });
  assert.deepEqual(consensus.map((s) => s.key), [k(1, 'ml', 'home')]);
  assert.equal(options.length, 0);
});

test('no picks means no parlays', () => {
  const r = buildParlays([], 0);
  assert.deepEqual(r.options, []);
});
