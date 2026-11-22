import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLines } from '../src/oddsapi.js';

test('lines keep the book\'s add-to-bet-slip links when it sends them', () => {
  const fd = (s) => `https://sportsbook.fanduel.com/addToBetslip?marketId[0]=42.1&selectionId[0]=${s}`;
  const lines = parseLines([{
    home_team: 'Kansas City Chiefs', away_team: 'Denver Broncos',
    bookmakers: [{ key: 'fanduel', markets: [
      { key: 'spreads', outcomes: [
        { name: 'Kansas City Chiefs', point: -3.5, price: -110, link: fd(1) },
        { name: 'Denver Broncos', point: 3.5, price: -110, link: 'javascript:alert(1)' }, // not https: dropped
      ] },
      { key: 'h2h', outcomes: [{ name: 'Kansas City Chiefs', price: -180 }, { name: 'Denver Broncos', price: 150 }] },
    ] }],
  }], 'fanduel');
  const game = Object.values(lines)[0];
  assert.deepEqual(game.spread.home, { point: -3.5, price: -110, link: fd(1) });
  assert.deepEqual(game.spread.away, { point: 3.5, price: -110 });
  assert.deepEqual(game.ml.home, { point: null, price: -180 }); // no link sent: none kept
});
