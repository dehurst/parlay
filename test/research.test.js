import { test } from 'node:test';
import assert from 'node:assert/strict';
import { homeLine, parseSeasonWeek, buildTeams, seasonYear } from '../src/research.js';

const ev = (date, home, away, hs, as, odds, completed = true) => ({
  date,
  competitions: [{
    status: { type: { completed } },
    odds: odds ? [odds] : undefined,
    competitors: [
      { homeAway: 'home', score: String(hs), team: { displayName: home[0], abbreviation: home[1], shortDisplayName: home[0].split(' ').pop() } },
      { homeAway: 'away', score: String(as), team: { displayName: away[0], abbreviation: away[1], shortDisplayName: away[0].split(' ').pop() } },
    ],
  }],
});
const KC = ['Kansas City Chiefs', 'KC'];
const DEN = ['Denver Broncos', 'DEN'];
const BUF = ['Buffalo Bills', 'BUF'];

test('reads the spread from ESPN odds for the home team', () => {
  assert.equal(homeLine({ details: 'KC -3.5' }, 'KC', 'DEN'), -3.5);
  assert.equal(homeLine({ details: 'DEN -2' }, 'KC', 'DEN'), 2);
  assert.equal(homeLine({ details: 'EVEN' }, 'KC', 'DEN'), 0);
  assert.equal(homeLine({ spread: 6.5, awayTeamOdds: { favorite: true } }, 'KC', 'DEN'), 6.5);
  assert.equal(homeLine(null, 'KC', 'DEN'), null);
  assert.equal(seasonYear(new Date('2027-01-10T12:00:00Z')), 2026);
});

test('builds records, ATS, over/under, and strength of schedule', () => {
  const games = [
    // Week 1: KC (-3.5) beats DEN 27-17: KC covers, 44 under 47.5.
    ...parseSeasonWeek({ events: [ev('2026-09-13T17:00Z', KC, DEN, 27, 17, { details: 'KC -3.5', overUnder: 47.5 })] }, 1),
    // Week 2: KC at BUF (BUF -2), BUF wins 24-23: KC +2 covers by 1, no total (fallback below).
    ...parseSeasonWeek({ events: [ev('2026-09-20T20:25Z', BUF, KC, 24, 23, { details: 'BUF -2' })] }, 2),
    // Week 3: DEN at KC, not played yet.
    ...parseSeasonWeek({ events: [ev('2026-09-27T17:00Z', KC, DEN, 0, 0, { details: 'KC -7', overUnder: 45 }, false)] }, 3),
  ];
  const teams = buildTeams(games, (g) => (g.week === 2 ? { homeLine: -2, total: 50.5 } : null));
  const kc = teams.find((t) => t.abbr === 'KC');
  assert.deepEqual(kc.record, { w: 1, l: 1, t: 0 });
  assert.deepEqual(kc.home, { w: 1, l: 0, t: 0 });
  assert.deepEqual(kc.ats, { w: 2, l: 0, t: 0 });
  assert.deepEqual(kc.atsFav, { w: 1, l: 0, t: 0 });
  assert.deepEqual(kc.atsDog, { w: 1, l: 0, t: 0 });
  assert.equal(kc.coverAvg, (6.5 + 1) / 2);
  assert.deepEqual(kc.ou, { w: 0, l: 2, t: 0 }); // 44 < 47.5, 47 < 50.5 (fallback total)
  assert.equal(kc.ppg, 25);
  assert.equal(kc.streak, 'L1');
  assert.deepEqual(kc.last5, ['W', 'L']);
  // Opponents so far: DEN (0-1) and BUF (1-0) -> .500; left: DEN (0-1) -> .000.
  assert.equal(kc.sosPlayed, 0.5);
  assert.equal(kc.sosLeft, 0);
  const den = teams.find((t) => t.abbr === 'DEN');
  assert.deepEqual(den.ats, { w: 0, l: 1, t: 0 });
  assert.equal(den.log[0].line, 3.5);
  assert.equal(den.log[1].final, false);
  assert.equal(den.log[1].line, 7);
});
