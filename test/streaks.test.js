import { test } from 'node:test';
import assert from 'node:assert/strict';
import { standing, streakBook, streakFor } from '../src/streaks.js';

const range = (n, f) => Array.from({ length: n }, (_, i) => f(i));

test('top and bottom 10, with a tie counted only if all of it fits', () => {
  const values = range(30, (i) => i); // 0..29
  assert.deepEqual(standing(values, 29), { rank: 1, of: 30, hot: true, cold: false });
  assert.deepEqual(standing(values, 0), { rank: 30, of: 30, hot: false, cold: true });
  assert.equal(standing(values, 15).hot || standing(values, 15).cold, false);
  // A big tie at zero isn't the bottom 10.
  assert.equal(standing([...range(15, () => 0), ...range(15, (i) => i + 1)], 0).cold, false);
  // Low is good (sack rate): the lowest is hot.
  assert.equal(standing(values, 0, true).hot, true);
  // Too few to compare: neither.
  assert.equal(standing(range(12, (i) => i), 11).hot, undefined);
});

// 30 running backs over three weeks; Hot Back leads every week, Cold Back
// trails, and Streaky Back is great twice and middling once.
const teams = {};
const weekly = [];
for (let i = 0; i < 30; i++) {
  const team = `T${i}`;
  const name = i === 0 ? 'Hot Back' : i === 1 ? 'Cold Back' : i === 2 ? 'Streaky Back' : `Back ${i}`;
  teams[team] = { weeks: [1, 2, 3], players: [{ name, names: new Set([name]), pos: 'RB', group: 'RB', pct: { 1: 0.7, 2: 0.7, 3: 0.7 } }] };
  for (const week of [1, 2, 3]) {
    const yds = i === 0 ? 200 : i === 1 ? 5 : i === 2 ? (week === 2 ? 60 : 150) : 50 + i;
    // Cold Back has no stat line in Week 2 (no carries): that's 0 yards.
    if (!(i === 1 && week === 2)) weekly.push({ week, team, name, group: 'RB', rushYds: yds });
  }
}
const book = streakBook(teams, weekly, []);
const rb = (i) => streakFor(book, teams, { group: 'RB', code: `T${i}`, snapsPlayer: teams[`T${i}`].players[0] });

test('on offense, two straight games in the top 10 is on fire, bottom 10 ice cold', () => {
  assert.equal(rb(0).kind, 'hot');
  assert.equal(rb(0).metric, 'rush yds');
  assert.deepEqual(rb(0).games.map((g) => g.week), [2, 3]);
  assert.deepEqual(rb(0).games.map((g) => g.rank), [1, 1]);
  assert.equal(rb(1).kind, 'cold');
  assert.equal(rb(1).games[0].value, 0); // no stat line in Week 2: 0 yards
  // Great in Week 3 but middling in Week 2: no streak.
  assert.equal(rb(2), null);
  assert.equal(rb(15), null);
});

test('on defense it takes three straight games', () => {
  // 30 linebackers: Two-Game Backer led Weeks 2 and 3 but was middling in Week 1.
  const t = {};
  const w = [];
  for (let i = 0; i < 30; i++) {
    const team = `D${i}`;
    const name = i === 0 ? 'Two-Game Backer' : i === 1 ? 'Three-Game Backer' : `Backer ${i}`;
    t[team] = { weeks: [1, 2, 3], players: [{ name, names: new Set([name]), pos: 'ILB', group: 'LB', pct: { 1: 0.9, 2: 0.9, 3: 0.9 } }] };
    for (const week of [1, 2, 3]) w.push({ week, team, name, group: 'LB', tackles: i === 1 ? 15 : i === 0 ? (week === 1 ? 5 : 15) : 3 + (i % 8) });
  }
  const b = streakBook(t, w, []);
  const lb = (i) => streakFor(b, t, { group: 'LB', code: `D${i}`, snapsPlayer: t[`D${i}`].players[0] });
  assert.equal(lb(1).kind, 'hot');
  assert.equal(lb(1).games.length, 3);
  assert.equal(lb(0), null);
});

test('a game he barely played breaks the streak', () => {
  teams.T0.players[0].pct[2] = 0.2;
  assert.equal(rb(0), null);
  teams.T0.players[0].pct[2] = 0.7;
});

test('the offensive line is judged as a unit, by sacks per dropback', () => {
  const t = {};
  const w = [];
  for (let i = 0; i < 28; i++) {
    const team = `L${i}`;
    t[team] = { weeks: [1, 2], players: [] };
    // L0 is never sacked; L1 is sacked the most; the rest in between.
    for (const week of [1, 2]) w.push({ week, team, name: `QB ${i}`, group: 'QB', dropbacks: 40, sacked: i === 0 ? 0 : i === 1 ? 9 : 1 + (i % 5) });
  }
  const b = streakBook(t, w, []);
  assert.equal(streakFor(b, t, { group: 'OL', code: 'L0' }).kind, 'hot');
  assert.equal(streakFor(b, t, { group: 'OL', code: 'L1' }).kind, 'cold');
  assert.deepEqual(streakFor(b, t, { group: 'OL', code: 'L1' }).games.map((g) => g.value), [22.5, 22.5]);
});
