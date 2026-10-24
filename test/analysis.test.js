import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeWeek, fairChance, parlaysVsSingles } from '../src/analysis.js';

const lines = {
  spread: { home: { point: -3.5, price: -110 }, away: { point: 3.5, price: -110 } },
  ml: { home: { point: null, price: -180 }, away: { point: null, price: 150 } },
  total: { over: { point: 47.5, price: -110 }, under: { point: 47.5, price: -110 } },
};
const game = (id, extra) => ({ id, home: 'Buffalo Bills', away: 'Miami Dolphins', homeShort: 'Bills', awayShort: 'Dolphins', commence: '2026-10-25T17:00:00Z', lines, ...extra });
const noStats = { week: { weeks: [] }, season: { weeks: [] } };

test('win chance takes the book’s cut out of both sides', () => {
  assert.equal(fairChance(lines, 'spread', 'home').toFixed(3), '0.500');
  assert.equal(fairChance(lines, 'ml', 'home').toFixed(3), '0.616'); // -180 vs +150
  // Line moved off the one you got: estimate from your own price.
  assert.equal(fairChance(lines, 'spread', 'home', { point: -2.5, price: -110 }).toFixed(3), '0.501');
});

test('rates your open picks and offers the spread/moneyline alternative', () => {
  const a = analyzeWeek({
    games: [game('g1', { started: false })],
    picks: {},
    myPicks: [{ key: 'g1|spread|home', point: -3.5, price: -110 }, { key: 'g1|total|over', point: 47.5, price: -110 }],
    parlays: [],
    stats: noStats,
  });
  assert.equal(a.mine.length, 2);
  const bills = a.mine.find((m) => m.market === 'spread');
  assert.equal(bills.label, 'Bills -3.5');
  assert.equal(bills.pays.toFixed(2), '19.09');
  assert.equal(bills.alt.label, 'Bills ML');
  assert.equal(bills.alt.pays.toFixed(2), '15.56');
  assert.equal(a.mine.find((m) => m.market === 'total').alt, null);
});

test('looks back: how close misses were and what would have hit', () => {
  // Bills win by 3: -3.5 misses by half a point, but the moneyline wins.
  const g1 = game('g1', { started: true, result: { homeScore: 24, awayScore: 21 } });
  const g2 = { ...game('g2', { started: true, result: { homeScore: 30, awayScore: 10 } }), home: 'Kansas City Chiefs', homeShort: 'Chiefs' };
  const a = analyzeWeek({
    games: [g1, g2],
    picks: { Daniel: [{ key: 'g1|spread|home', point: -3.5, price: -110 }], Matt: [{ key: 'g1|spread|home', point: -3.5, price: -110 }] },
    myPicks: [],
    parlays: [{
      id: 'p', name: 'Crowd Favorites', status: 'lost', total: 30, payout: 109.3,
      legs: [
        { key: 'g1|spread|home', gameId: 'g1', label: 'Bills -3.5', point: -3.5, price: -110, grade: 'loss' },
        { key: 'g2|spread|home', gameId: 'g2', label: 'Chiefs -3.5', point: -3.5, price: -110, grade: 'win' },
      ],
    }],
    stats: noStats,
  });
  assert.equal(a.misses.length, 1);
  assert.deepEqual(a.misses[0].pickers, ['Daniel', 'Matt']);
  assert.equal(a.misses[0].margin, -0.5);
  assert.deepEqual(a.misses[0].alt, { label: 'Bills ML', price: -180 });
  const one = a.oneLegAway[0];
  assert.equal(one.leg.label, 'Bills -3.5');
  assert.equal(one.alt.payout.toFixed(2), (30 * (1 + 100 / 110) * (1 + 100 / 180)).toFixed(2));
});

test('parlays vs. the same money as straight bets', () => {
  const r = parlaysVsSingles([
    { status: 'lost', total: 20, returned: 0, legs: [{ price: -110, grade: 'win' }, { price: -110, grade: 'loss' }] },
    { status: 'pending', total: 50, returned: null, legs: [] },
  ]);
  assert.equal(r.count, 1);
  assert.equal(r.parlayNet, -20);
  assert.equal(r.singlesNet.toFixed(2), '-0.91'); // +$9.09 and -$10
});
