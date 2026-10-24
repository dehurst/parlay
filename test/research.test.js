import { test } from 'node:test';
import assert from 'node:assert/strict';
import { homeLine, parseSeasonWeek, buildTeams, parseGameTeamStats, seasonYear } from '../src/research.js';

const ev = (date, home, away, hs, as, odds, completed = true, id) => ({
  id,
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
// A team's box score line, ESPN's "X-Y" format for the paired stats.
const boxTeam = (homeAway, { totalYards, passYards, rushYards, third, fourth, rz, sacks, penalties, turnovers, possession }) => ({
  homeAway,
  statistics: [
    { name: 'totalYards', displayValue: String(totalYards) },
    { name: 'netPassingYards', displayValue: String(passYards) },
    { name: 'rushingYards', displayValue: String(rushYards) },
    { name: 'thirdDownEff', displayValue: third },
    { name: 'fourthDownEff', displayValue: fourth },
    { name: 'redZoneAttempts', displayValue: rz },
    { name: 'sacksYardsLost', displayValue: sacks },
    { name: 'totalPenaltiesYards', displayValue: penalties },
    { name: 'turnovers', displayValue: String(turnovers) },
    { name: 'possessionTime', displayValue: possession },
  ],
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

test('parses a box score into offense numbers for each side', () => {
  const summary = {
    boxscore: {
      teams: [
        boxTeam('home', { totalYards: 366, passYards: 316, rushYards: 50, third: '4-10', fourth: '0-1', rz: '2-2', sacks: '0-0', penalties: '7-57', turnovers: 3, possession: '20:39' }),
        boxTeam('away', { totalYards: 419, passYards: 178, rushYards: 241, third: '7-13', fourth: '0-1', rz: '3-5', sacks: '1-11', penalties: '14-92', turnovers: 0, possession: '39:21' }),
      ],
    },
  };
  const stats = parseGameTeamStats(summary);
  assert.equal(stats.home.totalYds, 366);
  assert.equal(stats.home.turnovers, 3);
  assert.equal(stats.away.sacks, 1);
  assert.equal(stats.away.sackYds, 11);
  assert.equal(stats.away.rzConv, 3);
  assert.equal(stats.away.rzAtt, 5);
  assert.equal(stats.away.possessionSecs, 39 * 60 + 21);
  assert.equal(parseGameTeamStats({ boxscore: { teams: [] } }), null);
});

test('builds offense and defense yards/sacks/turnovers/downs from box scores', () => {
  const games = [
    // KC beats DEN at home: KC's offense gained 400 total/280 pass/120 rush, took 1 sack,
    // forced 2 turnovers; DEN's offense (what KC's defense allowed) gained 300/200/100,
    // took 3 sacks (KC's defense made 3), gave up 2 turnovers (KC forced 2).
    ...parseSeasonWeek({ events: [ev('2026-09-13T17:00Z', KC, DEN, 27, 17, { details: 'KC -3.5', overUnder: 47.5 }, true, 'g1')] }, 1),
  ];
  const boxscores = {
    g1: {
      home: { totalYds: 400, passYds: 280, rushYds: 120, thirdConv: 6, thirdAtt: 12, fourthConv: 1, fourthAtt: 1, rzConv: 2, rzAtt: 3, sacks: 1, sackYds: 7, penalties: 5, penaltyYds: 40, turnovers: 0, possessionSecs: 1800 },
      away: { totalYds: 300, passYds: 200, rushYds: 100, thirdConv: 4, thirdAtt: 11, fourthConv: 0, fourthAtt: 2, rzConv: 1, rzAtt: 2, sacks: 3, sackYds: 20, penalties: 6, penaltyYds: 50, turnovers: 2, possessionSecs: 1800 },
    },
  };
  const teams = buildTeams(games, () => null, boxscores);
  const kc = teams.find((t) => t.abbr === 'KC');
  const den = teams.find((t) => t.abbr === 'DEN');
  assert.equal(kc.advGames, 1);
  assert.equal(kc.ydsPerGame, 400);
  assert.equal(kc.passYdsPerGame, 280);
  assert.equal(kc.rushYdsPerGame, 120);
  assert.equal(kc.ydsAllowedPerGame, 300); // what DEN's offense gained against KC's defense
  assert.equal(kc.sacksAllowedPerGame, 1); // KC's offense took 1 sack
  assert.equal(kc.sacksMadePerGame, 3); // KC's defense made 3 (DEN's sacks taken)
  assert.equal(kc.giveawaysPerGame, 0);
  assert.equal(kc.takeawaysPerGame, 2);
  assert.equal(kc.turnoverMargin, 2);
  assert.equal(kc.thirdDownPct, 50); // 6/12
  assert.equal(kc.thirdDownPctAllowed, (4 / 11) * 100);
  assert.equal(kc.redZonePct, (2 / 3) * 100);
  // DEN is the mirror image.
  assert.equal(den.ydsPerGame, 300);
  assert.equal(den.ydsAllowedPerGame, 400);
  assert.equal(den.sacksMadePerGame, 1);
  assert.equal(den.sacksAllowedPerGame, 3);
  // With only two teams in the sample, KC leads every offensive yardage stat (rank 1)
  // and allows the fewest yards (rank 1).
  assert.equal(kc.ydsPerGameRank, 1);
  assert.equal(kc.ydsAllowedPerGameRank, 1);
  assert.equal(den.ydsPerGameRank, 2);
});
