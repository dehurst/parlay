import { test } from 'node:test';
import assert from 'node:assert/strict';
import { americanToDecimal, decimalToAmerican, estFairProb } from '../src/odds-math.js';
import { demoSchedule, parseScoreboard, makeGame, matchKey } from '../src/schedule.js';
import { parseLines } from '../src/oddsapi.js';
import { loadEnvFile } from '../src/env.js';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tally, buildParlays, priceParlay } from '../src/parlay.js';
import { weekWindow, weekLabel } from '../src/week.js';

test('odds conversions', () => {
  assert.equal(americanToDecimal(-110).toFixed(4), '1.9091');
  assert.equal(americanToDecimal(150), 2.5);
  assert.equal(decimalToAmerican(2.5), 150);
  assert.equal(decimalToAmerican(1.5), -200);
  assert.equal(estFairProb(-110).toFixed(2), '0.50');
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

test('parses the ESPN scoreboard shape', () => {
  const games = parseScoreboard({
    events: [{
      id: '401772', date: '2026-10-18T17:00Z',
      competitions: [{
        status: { type: { state: 'pre' } },
        competitors: [
          { homeAway: 'home', team: { displayName: 'Kansas City Chiefs', shortDisplayName: 'Chiefs' } },
          { homeAway: 'away', team: { displayName: 'Denver Broncos', shortDisplayName: 'Broncos' } },
        ],
      }],
    }],
  }, '2026-10-13');
  assert.deepEqual(games, [{
    id: '2026-10-13-broncos-at-chiefs', commence: '2026-10-18T17:00:00.000Z',
    home: 'Kansas City Chiefs', away: 'Denver Broncos', homeShort: 'Chiefs', awayShort: 'Broncos', state: 'pre',
  }]);
});

test('the same game gets the same ID from either source', () => {
  const espn = makeGame({ weekKey: '2026-10-13', home: 'San Francisco 49ers', away: 'Los Angeles Rams', homeShort: '49ers', awayShort: 'Rams', commence: '2026-10-18T20:25Z' });
  const odds = makeGame({ weekKey: '2026-10-13', home: 'San Francisco 49ers', away: 'Los Angeles Rams', commence: '2026-10-18T20:25:00Z' });
  assert.equal(espn.id, odds.id);
  assert.equal(espn.id, '2026-10-13-rams-at-49ers');
  assert.equal(matchKey('Los Angeles Rams', 'San Francisco 49ers'), matchKey('Rams', '49ers'));
});

test('parses FanDuel lines from The Odds API', () => {
  const lines = parseLines([{
    home_team: 'Kansas City Chiefs', away_team: 'Denver Broncos',
    bookmakers: [
      { key: 'draftkings', markets: [{ key: 'h2h', outcomes: [{ name: 'Kansas City Chiefs', price: -999 }] }] },
      { key: 'fanduel', markets: [
        { key: 'h2h', outcomes: [{ name: 'Kansas City Chiefs', price: -180 }, { name: 'Denver Broncos', price: 152 }] },
        { key: 'spreads', outcomes: [{ name: 'Kansas City Chiefs', price: -112, point: -3.5 }, { name: 'Denver Broncos', price: -108, point: 3.5 }] },
        { key: 'totals', outcomes: [{ name: 'Over', price: -110, point: 44.5 }, { name: 'Under', price: -110, point: 44.5 }] },
      ] },
    ],
  }, { home_team: 'Buffalo Bills', away_team: 'Miami Dolphins', bookmakers: [] }], 'fanduel');
  assert.deepEqual(Object.keys(lines), ['broncos@chiefs']);
  assert.deepEqual(lines['broncos@chiefs'], {
    ml: { home: { point: null, price: -180 }, away: { point: null, price: 152 } },
    spread: { home: { point: -3.5, price: -112 }, away: { point: 3.5, price: -108 } },
    total: { over: { point: 44.5, price: -110 }, under: { point: 44.5, price: -110 } },
  });
});

test('loads a .env file without overriding real env vars', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'parlay-')), '.env');
  writeFileSync(file, '# comment\nPARLAY_T1=abc\nPARLAY_T2 = "quoted"\nPARLAY_T3=from-file\n');
  process.env.PARLAY_T3 = 'real';
  loadEnvFile(file);
  assert.equal(process.env.PARLAY_T1, 'abc');
  assert.equal(process.env.PARLAY_T2, 'quoted');
  assert.equal(process.env.PARLAY_T3, 'real');
  loadEnvFile(join(tmpdir(), 'does-not-exist.env'));
});

function fixture() {
  const games = demoSchedule({ key: '2026-09-22', start: new Date('2026-09-22T12:00:00Z') });
  const gamesById = new Map(games.map((g) => [g.id, g]));
  const id = (i) => games[i].id;
  const pick = (i, market, side, point = null, price = -110) => ({ key: `${id(i)}|${market}|${side}`, point, price });
  return { gamesById, id, pick };
}

test('groups picks of the same bet and uses the most common line', () => {
  const { gamesById, pick } = fixture();
  const t = tally({
    Ann: [pick(1, 'spread', 'home', -3)],
    Ben: [pick(1, 'spread', 'home', -3)],
    Cal: [pick(1, 'spread', 'home', -3.5, -105)],
  }, gamesById);
  assert.equal(t.length, 1);
  assert.equal(t[0].label, 'Chiefs -3');
  assert.equal(t[0].price, -110);
  assert.equal(t[0].pickers.length, 3);
  assert.equal(t[0].lines.length, 2);
});

test('builds parlays only from majority picks, one leg per game', () => {
  const { gamesById, id, pick } = fixture();
  const picks = {
    Ann: [pick(1, 'ml', 'home', null, -180), pick(2, 'spread', 'home', -4), pick(3, 'total', 'over', 51.5), pick(4, 'ml', 'away', null, 120)],
    Ben: [pick(1, 'ml', 'home', null, -180), pick(2, 'spread', 'home', -4), pick(3, 'total', 'over', 51.5), pick(5, 'ml', 'home', null, -250)],
    Cal: [pick(1, 'ml', 'home', null, -175), pick(2, 'spread', 'home', -4), pick(1, 'total', 'under', 44.5)],
    Dee: [pick(1, 'ml', 'home', null, -180), pick(3, 'total', 'over', 51), pick(1, 'total', 'under', 44.5)],
  };
  const result = buildParlays(tally(picks, gamesById), 4);
  assert.equal(result.need, 3);
  assert.deepEqual(result.consensus.map((s) => s.label), ['Chiefs ML', 'Eagles -4', 'Over 51.5']);
  assert.equal(result.consensus[0].price, -180);
  for (const opt of result.options) {
    const gameIds = opt.legs.map((l) => l.gameId);
    assert.equal(new Set(gameIds).size, gameIds.length, `${opt.name} repeats a game`);
    assert.ok(opt.legs.length >= 2);
  }
  const sigs = result.options.map((o) => o.legs.map((l) => l.key).sort().join());
  assert.equal(new Set(sigs).size, sigs.length);
  assert.ok(result.options.length >= 3);
  // Game 1 is already in the consensus via the ML, so its 2/4 under isn't "one vote away".
  assert.ok(result.almost.every((s) => s.gameId !== id(1)));
});

test('skips games that already kicked off', () => {
  const { gamesById, id, pick } = fixture();
  const both = [pick(0, 'spread', 'home', -6.5), pick(1, 'spread', 'home', -3.5)];
  const { consensus, options } = buildParlays(tally({ Ann: both, Ben: both }, gamesById), 2, {
    startedIds: new Set([id(0)]),
  });
  assert.deepEqual(consensus.map((s) => s.gameId), [id(1)]);
  assert.equal(options.length, 0);
});

test('no picks means no parlays', () => {
  assert.deepEqual(buildParlays([], 0).options, []);
});

test('asks ESPN for each day of the week and merges the games', async () => {
  const { fetchEspnSchedule } = await import('../src/schedule.js');
  const realFetch = globalThis.fetch;
  const asked = [];
  const board = (date, home, away) => ({ events: [{ id: home, date, competitions: [{ status: { type: { state: 'pre' } }, competitors: [
    { homeAway: 'home', team: { displayName: home, shortDisplayName: home.split(' ').pop() } },
    { homeAway: 'away', team: { displayName: away, shortDisplayName: away.split(' ').pop() } },
  ] }] }] });
  globalThis.fetch = async (url) => {
    const day = new URL(url).searchParams.get('dates');
    asked.push(day);
    if (day === '20261015') return Response.json(board('2026-10-16T00:15Z', 'Buffalo Bills', 'Miami Dolphins'));
    if (day === '20261018') return Response.json(board('2026-10-18T17:00Z', 'Kansas City Chiefs', 'Denver Broncos'));
    return Response.json({ events: [] });
  };
  try {
    const games = await fetchEspnSchedule({ key: '2026-10-13', start: new Date('2026-10-13T12:00:00Z') });
    assert.deepEqual(asked, ['20261013', '20261014', '20261015', '20261016', '20261017', '20261018', '20261019']);
    assert.deepEqual(games.map((g) => g.id), ['2026-10-13-dolphins-at-bills', '2026-10-13-broncos-at-chiefs']);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('demo schedules are dropped on restart so real sources get retried', async () => {
  const { Store } = await import('../src/store.js');
  const file = join(mkdtempSync(join(tmpdir(), 'parlay-')), 'db.json');
  writeFileSync(file, JSON.stringify({ schedule: {
    a: { source: 'demo', demo: true, games: [] },
    b: { source: 'ESPN', games: [] },
  } }));
  assert.deepEqual(Object.keys(new Store(file).data.schedule), ['b']);
});
