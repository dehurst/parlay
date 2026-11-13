import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseGames, teamPlayers, totalOf, statsOf } from '../src/playerstats.js';

const HEAD = 'player_id,player_display_name,position,position_group,headshot_url,season,week,season_type,game_id,team,opponent_team,receptions,targets,receiving_yards,target_share,def_tackles_solo,def_tackle_assists,def_sacks,fantasy_points_ppr';
const row = (id, name, pos, group, week, team, opp, rec, tgt, yds, share, extra = '0,0,0') =>
  `${id},${name},${pos},${group},"https://x/f_auto,q_auto/a",2026,${week},REG,2026_${String(week).padStart(2, '0')}_${opp}_${team},${team},${opp},${rec},${tgt},${yds},${share},${extra},${yds / 10 + rec}`;

const csv = [HEAD,
  row('A', 'Al Wide', 'WR', 'WR', 1, 'CIN', 'TB', 5, 8, 60, 0.25),
  row('A', 'Al Wide', 'WR', 'WR', 2, 'CIN', 'HOU', 7, 9, 90, 0.3),
  // Week 3: bye. Week 4: missed it hurt. Weeks 5-6 played.
  row('A', 'Al Wide', 'WR', 'WR', 5, 'CIN', 'PIT', 2, 4, 20, 0.1),
  row('A', 'Al Wide', 'WR', 'WR', 6, 'CIN', 'BAL', 9, 12, 130, 0.4),
  row('B', 'Bo Line', 'LB', 'LB', 6, 'CIN', 'BAL', 0, 0, 0, 0, '4,3,1.5'),
  // Traded: played for CLE, now on CIN.
  row('C', 'Cy Moved', 'TE', 'TE', 1, 'CLE', 'DAL', 3, 4, 30, 0.1),
  row('C', 'Cy Moved', 'TE', 'TE', 6, 'CIN', 'BAL', 1, 2, 10, 0.05),
  // Was on CIN, now gone.
  row('D', 'Di Gone', 'WR', 'WR', 1, 'CIN', 'TB', 1, 1, 5, 0.03),
  row('D', 'Di Gone', 'WR', 'WR', 6, 'NYJ', 'MIA', 1, 1, 5, 0.03),
  // Postseason and team rows are skipped.
  `X,Team,,,"",2026,6,REG,g,CIN,BAL,0,0,0,0,0,0,0,0`,
].join('\n');

test('game lines: regular season players only, tackles add solo and assisted', () => {
  const games = parseGames(csv);
  assert.equal(games.length, 9);
  const lb = games.find((g) => g.id === 'B');
  assert.equal(lb.stats.tkl, 7);
  assert.equal(lb.stats.sacks, 1.5);
  assert.equal(lb.home, true);
});

test('form is the last 3 games played, newest first, skipping byes and missed games', () => {
  const [wr] = teamPlayers(parseGames(csv), 'CIN', { season: 2026 }).filter((p) => p.id === 'A');
  assert.deepEqual(wr.form.map((g) => g.week), [6, 5, 2]);
  assert.equal(wr.season.games, 4);
  assert.equal(wr.season.stats.recYds, 300);
  assert.equal(wr.season.stats.tgtShare, (0.25 + 0.3 + 0.1 + 0.4) / 4); // shares are averaged
});

test('a team lists who plays there now (trades follow the player), by position', () => {
  const players = teamPlayers(parseGames(csv), 'CIN', { season: 2026 });
  assert.deepEqual(players.map((p) => p.id), ['A', 'C', 'B']);
  const te = players.find((p) => p.id === 'C');
  assert.equal(te.season.games, 2); // his CLE game counts toward his season
});

test('career adds this season to past seasons, and never counts a season twice', () => {
  const past = { A: { seasons: [2022, 2025], n: 4, games: 60, stats: { recYds: 3000, rec: 200 } } };
  const [wr] = teamPlayers(parseGames(csv), 'CIN', { career: past, season: 2026 });
  assert.equal(wr.career.games, 64);
  assert.equal(wr.career.seasons, 5);
  assert.equal(wr.career.from, 2022);
  assert.equal(wr.career.stats.recYds, 3300);
  const already = { A: { ...past.A, seasons: [2022, 2026] } };
  const [again] = teamPlayers(parseGames(csv), 'CIN', { career: already, season: 2026 });
  assert.equal(again.career.stats.recYds, 300);
  assert.equal(again.career.from, 2026);
});

test('a game he played without a stat (from the snap counts) counts as a zero in his form', () => {
  const snaps = { CIN: { weeks: [1, 2, 4, 5, 6], players: [{ name: 'Al Wide', names: new Set(['Al Wide']), pct: { 1: 0.8, 2: 0.9, 4: 0.7, 5: 0.6, 6: 0.9 } }] } };
  // Somebody on CIN played week 4, so the opponent is known.
  const games = parseGames(`${csv}\n${row('E', 'Ed Else', 'RB', 'RB', 4, 'CIN', 'CLE', 1, 1, 3, 0.02)}`);
  const wr = teamPlayers(games, 'CIN', { snaps, season: 2026 }).find((p) => p.id === 'A');
  assert.deepEqual(wr.form.map((g) => [g.week, g.stats.recYds, !!g.quiet]), [[6, 130, false], [5, 20, false], [4, 0, true]]);
  assert.equal(wr.season.games, 5);
});

test('totals: longest field goal is the best, not the sum', () => {
  const lines = [statsOf({ fg_made: '2', fg_long: '48' }), statsOf({ fg_made: '3', fg_long: '55' })];
  const t = totalOf(lines);
  assert.equal(t.fgm, 5);
  assert.equal(t.fgLong, 55);
});

import { hitRate, impliedProb, defaultLine } from '../public/hitrate.js';

test('hit rate: over beats the line, under misses it, a whole-number line can push', () => {
  assert.deepEqual(hitRate([102, 76, 23, 64], 64.5), { over: 2, under: 2, push: 0, n: 4 });
  assert.deepEqual(hitRate([2, 1, 3, 2], 2), { over: 1, under: 1, push: 2, n: 4 });
});

test('a price becomes the chance it implies', () => {
  assert.equal(impliedProb(-150), 0.6);
  assert.equal(Math.round(impliedProb(200) * 1000), 333);
});

test('with no line typed, start from his average to the nearest half point', () => {
  assert.equal(defaultLine(67.6), 67.5);
  assert.equal(defaultLine(1.4), 1.5);
  assert.equal(defaultLine(0.2), 0.5);
  assert.equal(defaultLine(0), 0.5);
});

test('total TDs count what he scored himself (anytime TD), not what he threw', () => {
  const s = statsOf({ rushing_tds: '1', receiving_tds: '1', special_teams_tds: '1', passing_tds: '3' });
  assert.equal(s.anyTd, 3);
});

test('the full game log is newest first, with games he played without a stat', () => {
  const [wr] = teamPlayers(parseGames(csv), 'CIN', { season: 2026 }).filter((p) => p.id === 'A');
  assert.deepEqual(wr.log.map((g) => g.week), [6, 5, 2, 1]);
});

import { smallPhoto } from '../src/playerstats.js';
import { espnPhoto } from '../src/heatmap.js';

test('headshots: asks the image servers for a small one, not the full-size file', () => {
  assert.equal(smallPhoto('https://static.www.nfl.com/image/upload/f_auto,q_auto/league/abc'),
    'https://static.www.nfl.com/image/upload/f_auto,q_auto,w_160,h_160,c_thumb,g_face/league/abc');
  assert.equal(smallPhoto(''), null);
  assert.equal(espnPhoto({ headshot: { href: 'https://a.espncdn.com/i/headshots/nfl/players/full/42.png' } }),
    'https://a.espncdn.com/combiner/i?img=/i/headshots/nfl/players/full/42.png&w=160&h=116');
  assert.equal(espnPhoto({ id: '7' }), 'https://a.espncdn.com/combiner/i?img=/i/headshots/nfl/players/full/7.png&w=160&h=116');
  assert.equal(espnPhoto(null), null);
});
