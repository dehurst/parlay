import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gradeLeg, gradeParlay, singleProfit } from '../src/grading.js';
import { parseEspnScores, easternDay } from '../src/results.js';
import { computeStats } from '../src/stats.js';
import { createStore, RedisStore, FileStore } from '../src/store.js';

const final = (homeScore, awayScore) => ({ homeScore, awayScore });

test('grades spreads, totals, and moneylines', () => {
  const r = final(24, 20); // home wins by 4
  assert.equal(gradeLeg({ key: 'g|spread|home', point: -3.5 }, r), 'win');
  assert.equal(gradeLeg({ key: 'g|spread|home', point: -4 }, r), 'push');
  assert.equal(gradeLeg({ key: 'g|spread|home', point: -6.5 }, r), 'loss');
  assert.equal(gradeLeg({ key: 'g|spread|away', point: 4.5 }, r), 'win');
  assert.equal(gradeLeg({ key: 'g|spread|away', point: 3.5 }, r), 'loss');
  assert.equal(gradeLeg({ key: 'g|total|over', point: 43.5 }, r), 'win');
  assert.equal(gradeLeg({ key: 'g|total|under', point: 44 }, r), 'push');
  assert.equal(gradeLeg({ key: 'g|total|under', point: 43.5 }, r), 'loss');
  assert.equal(gradeLeg({ key: 'g|ml|home', point: null }, r), 'win');
  assert.equal(gradeLeg({ key: 'g|ml|away', point: null }, r), 'loss');
  assert.equal(gradeLeg({ key: 'g|ml|away', point: null }, final(20, 20)), 'push');
  assert.equal(gradeLeg({ key: 'g|ml|away', point: null }, undefined), 'pending');
});

test('grades parlays, dropping pushed legs', () => {
  const leg = (grade, price = -110) => ({ grade, price });
  assert.deepEqual(gradeParlay([leg('win'), leg('loss'), leg('pending')], 10), { status: 'lost', returned: 0 });
  assert.deepEqual(gradeParlay([leg('win'), leg('pending')], 10), { status: 'pending', returned: null });
  assert.deepEqual(gradeParlay([leg('push'), leg('push')], 10), { status: 'push', returned: 10 });
  assert.equal(gradeParlay([leg('win'), leg('win')], 10).returned.toFixed(2), '36.45');
  // A push turns a 3-leg parlay into a 2-leg one.
  assert.equal(gradeParlay([leg('win'), leg('push'), leg('win')], 10).returned.toFixed(2), '36.45');
  assert.equal(singleProfit(-110, 'win').toFixed(2), '9.09');
  assert.equal(singleProfit(150, 'loss'), -10);
});

test('reads final scores from ESPN and ignores unfinished games', () => {
  const board = { events: [
    { date: '2026-10-18T17:00Z', competitions: [{ status: { type: { completed: true } }, competitors: [
      { homeAway: 'home', score: '27', team: { displayName: 'Kansas City Chiefs' } },
      { homeAway: 'away', score: '17', team: { displayName: 'Denver Broncos' } },
    ] }] },
    { date: '2026-10-18T20:25Z', competitions: [{ status: { type: { completed: false } }, competitors: [
      { homeAway: 'home', score: '7', team: { displayName: 'San Francisco 49ers' } },
      { homeAway: 'away', score: '3', team: { displayName: 'Los Angeles Rams' } },
    ] }] },
  ] };
  assert.deepEqual(parseEspnScores(board, '2026-10-13'), { '2026-10-13-broncos-at-chiefs': { homeScore: 27, awayScore: 17 } });
  // Thursday 8:15pm ET is Friday in UTC but Thursday on ESPN's scoreboard.
  assert.equal(easternDay('2026-10-16T00:15:00Z'), '20261015');
});

test('season stats add up picks, consensus, and parlay money', () => {
  const wk = '2026-10-13';
  const g = (away, home) => ({ id: `${wk}-${away.toLowerCase()}-at-${home.toLowerCase()}`, home, away, homeShort: home, awayShort: away, commence: '2026-10-18T17:00:00Z' });
  const games = [g('Broncos', 'Chiefs'), g('Cowboys', 'Eagles'), g('Rams', 'Niners')];
  const [kc, phi, sf] = games.map((x) => x.id);
  const pick = (id, market, side, point, price = -110) => ({ key: `${id}|${market}|${side}`, point, price });
  const data = {
    schedule: { [wk]: { games } },
    results: { [wk]: { [kc]: final(27, 17), [phi]: final(20, 21) } }, // Rams game not final yet
    picks: { [wk]: {
      Daniel: [pick(kc, 'spread', 'home', -3.5), pick(phi, 'spread', 'home', -4)],
      Asher: [pick(kc, 'spread', 'home', -3.5), pick(sf, 'ml', 'home', null, -150)],
      Matt: [pick(kc, 'spread', 'home', -3.5), pick(phi, 'spread', 'home', -4)],
    } },
    stakes: { [wk]: {
      p1: { name: 'Crowd Favorites', american: 264, legs: [
        { key: `${kc}|spread|home`, gameId: kc, point: -3.5, price: -110 },
        { key: `${phi}|spread|home`, gameId: phi, point: -4, price: -110 },
      ], stakes: { Daniel: 20, Asher: 10 } },
      p2: { name: 'Safest Majority', american: 100, legs: [
        { key: `${kc}|spread|home`, gameId: kc, point: -3.5, price: -110 },
        { key: `${sf}|ml|home`, gameId: sf, point: null, price: -150 },
      ], stakes: { Matt: 5 } },
    } },
  };
  const stats = computeStats(data, ['Daniel', 'Asher', 'Matt']);
  const who = (n) => stats.players.find((p) => p.name === n);
  assert.deepEqual(who('Daniel').picks, { win: 1, loss: 1, push: 0, pending: 0 });
  assert.deepEqual(who('Asher').picks, { win: 1, loss: 0, push: 0, pending: 1 });
  assert.equal(who('Daniel').flatNet.toFixed(2), '-0.91'); // +9.09 - 10
  assert.deepEqual({ ...stats.consensus, flatNet: undefined }, { win: 1, loss: 1, push: 0, pending: 0, flatNet: undefined }); // KC 3/3 won, PHI 2/3 lost
  assert.equal(stats.consensus.flatNet.toFixed(2), '-0.91');
  // p1 lost (Eagles didn't cover); p2 still pending on the Rams game.
  assert.equal(who('Daniel').net, -20);
  assert.equal(who('Asher').net, -10);
  assert.equal(who('Matt').net, 0);
  assert.equal(who('Matt').inPlay, 5);
  assert.deepEqual([stats.parlays.won, stats.parlays.lost, stats.parlays.pending], [0, 1, 1]);
  assert.equal(stats.parlays.net, -30);
  assert.equal(stats.weeks[0].label, 'Week 6');
  assert.equal(stats.weeks[0].net, -30);
});

test('uses Upstash Redis when its env vars are set', async () => {
  assert.ok(createStore({}, '/tmp/x.json') instanceof FileStore);
  assert.throws(() => createStore({ VERCEL: '1' }, '/tmp/x.json'), /Upstash Redis/);
  const store = createStore({ KV_REST_API_URL: 'https://example.upstash.io/', KV_REST_API_TOKEN: 't0k' }, '/tmp/x.json');
  assert.ok(store instanceof RedisStore);

  const realFetch = globalThis.fetch;
  const db = new Map();
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, auth: opts.headers.authorization });
    const [cmd, key, value] = JSON.parse(opts.body);
    if (cmd === 'SET') db.set(key, value);
    return Response.json({ result: cmd === 'GET' ? db.get(key) ?? null : 'OK' });
  };
  try {
    await store.load();
    assert.deepEqual(store.data.picks, {});
    store.data.picks.w = { Daniel: [{ key: 'a|ml|home', point: null, price: -110 }] };
    store.data.lines = { '2026-01-01': {}, '2026-10-13': {} };
    await store.save('2026-10-13');
    const other = createStore({ UPSTASH_REDIS_REST_URL: 'https://example.upstash.io', UPSTASH_REDIS_REST_TOKEN: 't0k' }, '');
    await other.load();
    assert.equal(other.data.picks.w.Daniel.length, 1);
    assert.deepEqual(Object.keys(other.data.lines), ['2026-10-13']); // old weeks' lines pruned
    assert.equal(calls[0].url, 'https://example.upstash.io');
    assert.equal(calls[0].auth, 'Bearer t0k');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('reads season records from ESPN', async () => {
  const { parseEspnRecords } = await import('../src/schedule.js');
  const board = { events: [{ competitions: [{ competitors: [
    { team: { displayName: 'Houston Texans' }, records: [{ name: 'overall', type: 'total', summary: '3-2' }, { name: 'Home', type: 'home', summary: '2-0' }] },
    { team: { displayName: 'Jacksonville Jaguars' }, records: [{ name: 'Road', type: 'road', summary: '1-1' }, { name: 'overall', type: 'total', summary: '4-1-1' }] },
    { team: { displayName: 'New York Jets' } },
  ] }] }] };
  assert.deepEqual(parseEspnRecords(board), { texans: '3-2', jaguars: '4-1-1' });
});

test('a placed parlay pays what the sportsbook said, not the estimate', async () => {
  const { actualDecimal } = await import('../src/grading.js');
  // Daniel's slip: -156, -290, -122 = x4.0158; $15 pays $60.24.
  const legs = [{ grade: 'win', price: -156 }, { grade: 'win', price: -290 }, { grade: 'win', price: -110 }];
  const estimate = legs.reduce((d, l) => d * (1 + 100 / -l.price), 1); // site priced the total at -110
  const p = { decimal: estimate, placed: { payout: 60.24 }, stakes: { Daniel: 10, Asher: 5 } };
  const real = actualDecimal(p, 15);
  assert.equal((15 * real).toFixed(2), '60.24');
  assert.equal(gradeParlay(legs, 15, real / estimate).returned.toFixed(2), '60.24');
  assert.equal(gradeParlay(legs, 10, real / estimate).returned.toFixed(2), '40.16'); // Daniel's share
  // A pushed leg shrinks the real payout in proportion.
  const pushed = [legs[0], legs[1], { grade: 'push', price: -110 }];
  assert.equal(gradeParlay(pushed, 15, real / estimate).returned.toFixed(2), (60.24 / 1.9091).toFixed(2));
  // Without an entered payout, the estimate is used.
  assert.equal(actualDecimal({ decimal: 2.5 }, 15), 2.5);
});

test('season stats use the entered payout', () => {
  const wk = '2026-10-13';
  const games = [
    { id: 'a', home: 'Eagles', away: 'Panthers', homeShort: 'Eagles', awayShort: 'Panthers', commence: '2026-10-18T17:00:00Z' },
    { id: 'b', home: 'Colts', away: 'Titans', homeShort: 'Colts', awayShort: 'Titans', commence: '2026-10-18T17:00:00Z' },
  ];
  const data = {
    schedule: { [wk]: { games } },
    results: { [wk]: { a: final(17, 24), b: final(27, 10) } },
    picks: {},
    stakes: { [wk]: { x: {
      name: 'Custom', american: 200, decimal: 3,
      legs: [{ key: 'a|ml|away', gameId: 'a', price: 100, point: null }, { key: 'b|ml|home', gameId: 'b', price: -200, point: null }],
      stakes: { Daniel: 10 },
      placed: { by: 'Daniel', at: 0, payout: 28 },
    } } },
  };
  const daniel = computeStats(data, ['Daniel']).players[0];
  assert.equal(daniel.returned.toFixed(2), '28.00');
  assert.equal(daniel.net.toFixed(2), '18.00');
});

test('stats can be narrowed to one week', () => {
  const game = (wk) => ({ id: `${wk}-g`, home: 'Eagles', away: 'Giants', homeShort: 'Eagles', awayShort: 'Giants', commence: `${wk}T17:00:00Z` });
  const pick = (wk) => ({ key: `${wk}-g|ml|home`, point: null, price: 100 });
  const data = {
    schedule: { '2026-10-06': { games: [game('2026-10-06')] }, '2026-10-13': { games: [game('2026-10-13')] } },
    results: { '2026-10-06': { '2026-10-06-g': final(24, 10) }, '2026-10-13': { '2026-10-13-g': final(10, 24) } },
    picks: { '2026-10-06': { Daniel: [pick('2026-10-06')] }, '2026-10-13': { Daniel: [pick('2026-10-13')] } },
    stakes: {},
  };
  const season = computeStats(data, ['Daniel']);
  assert.deepEqual([season.players[0].picks.win, season.players[0].picks.loss], [1, 1]);
  assert.equal(season.weeks.length, 2);
  const one = computeStats(data, ['Daniel'], { week: '2026-10-06' });
  assert.deepEqual([one.players[0].picks.win, one.players[0].picks.loss], [1, 0]);
  assert.deepEqual(one.weeks.map((w) => w.key), ['2026-10-06']);
  assert.equal(computeStats(data, ['Daniel'], { week: '2026-09-29' }).weeks.length, 0);
});
