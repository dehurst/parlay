import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSnaps, findPlayer, starterHistory, teamCode, nextUp, usualShare, gamesPlayed, outsnapped, lastSeason } from '../src/starters.js';

const HEAD = 'game_id,pfr_game_id,season,game_type,week,player,pfr_player_id,position,team,opponent,offense_snaps,offense_pct,defense_snaps,defense_pct,st_snaps,st_pct';
// [week, name, id, pos, team, off%, def%]
const csv = (rows) => [HEAD, ...rows.map(([w, n, id, pos, team, o, d]) => `g,g,2026,REG,${w},${n},${id},${pos},${team},X,0,${o},0,${d},0,0`)].join('\n');

const teams = parseSnaps(csv([
  // QB: the Week 1 starter got hurt, the backup took over.
  [1, 'Vet Passer', 'vp', 'QB', 'BUF', 1, 0], [2, 'Vet Passer', 'vp', 'QB', 'BUF', 1, 0],
  [1, 'Back Up', 'bu', 'QB', 'BUF', 0, 0], [3, 'Back Up', 'bu', 'QB', 'BUF', 1, 0], [4, 'Back Up', 'bu', 'QB', 'BUF', 1, 0],
  // CB: a rookie passed a healthy veteran, who still plays a little.
  [1, 'Old Corner', 'oc', 'CB', 'BUF', 0, 0.9], [2, 'Old Corner', 'oc', 'CB', 'BUF', 0, 0.9], [4, 'Old Corner', 'oc', 'CB', 'BUF', 0, 0.2],
  [1, 'Rookie Corner', 'rc', 'CB', 'BUF', 0, 0.1], [3, 'Rookie Corner', 'rc', 'CB', 'BUF', 0, 0.9], [4, 'Rookie Corner', 'rc', 'CB', 'BUF', 0, 0.95],
  // LT: started every game, listed under a new first name later.
  [1, 'DeAundre Tackle', 'dt', 'T', 'BUF', 1, 0], [2, 'DeAundre Tackle', 'dt', 'T', 'BUF', 1, 0],
  [3, 'Dee Tackle', 'dt', 'T', 'BUF', 1, 0], [4, 'Dee Tackle', 'dt', 'T', 'BUF', 1, 0],
  // TE: started Week 1, hurt Weeks 2-3, back for Week 4.
  [1, 'Tight End', 'te', 'TE', 'BUF', 0.8, 0], [4, 'Tight End', 'te', 'TE', 'BUF', 0.85, 0],
  // RB: listed first but splits carries.
  [1, 'Split Back', 'sb', 'RB', 'BUF', 0.3, 0], [2, 'Split Back', 'sb', 'RB', 'BUF', 0.3, 0],
  [3, 'Split Back', 'sb', 'RB', 'BUF', 0.35, 0], [4, 'Split Back', 'sb', 'RB', 'BUF', 0.3, 0],
  // Traded: played for Miami earlier.
  [1, 'Moved Guard', 'mg', 'G', 'MIA', 1, 0],
]));
const hist = (name, opts) => starterHistory(teams, 'BUF', { name, skipped: [] }, opts);

test('snap counts group by player id, so a renamed player stays one player', () => {
  assert.equal(teams.BUF.players.filter((p) => p.names.has('Dee Tackle')).length, 1);
  assert.equal(findPlayer(teams.BUF, 'Dee Tackle').pct[1], 1);
  assert.deepEqual(teams.BUF.weeks, [1, 2, 3, 4]);
});

test('a starter in every game since Week 1, with each week’s snaps', () => {
  const h = hist('Dee Tackle');
  assert.equal(h.tag, 'week1');
  assert.equal(h.since, 1);
  assert.deepEqual(h.timeline, [{ week: 1, pct: 100 }, { week: 2, pct: 100 }, { week: 3, pct: 100 }, { week: 4, pct: 100 }]);
});

test('a starter who missed games and has played since is a regular again, not back', () => {
  const h = hist('Tight End');
  assert.equal(h.tag, 'week1');
  assert.equal(h.since, 4);
  assert.deepEqual(h.missed, [2, 3]);
  assert.equal(h.timeline[1].pct, null);
});

test('a listed starter playing well under half the snaps is part-time', () => {
  assert.equal(hist('Split Back').tag, 'part');
});

test('a backup filling in for an injured starter', () => {
  const h = hist('Back Up', { injuries: new Map([['Vet Passer', 'Injured Reserve']]), roster: ['Vet Passer', 'Back Up'] });
  assert.equal(h.tag, 'fillin');
  assert.equal(h.since, 3);
  assert.equal(h.replaced, 'Vet Passer');
  assert.equal(h.replacedStatus, 'Injured Reserve');
});

test('a player who passed a healthy veteran earned the job', () => {
  const h = hist('Rookie Corner', { roster: ['Old Corner', 'Rookie Corner'] });
  assert.equal(h.tag, 'earned');
  assert.equal(h.since, 3);
  assert.equal(h.replaced, 'Old Corner');
});

test('someone still starting elsewhere on the side is not the one replaced', () => {
  assert.equal(hist('Rookie Corner', { roster: ['Old Corner'], starters: ['Old Corner', 'Rookie Corner'] }).tag, 'new');
});

test('listed behind a sidelined player counts as a fill-in', () => {
  const h = starterHistory(teams, 'BUF', { name: 'Back Up', skipped: [{ name: 'Vet Passer', status: 'Out' }] });
  assert.equal(h.tag, 'fillin');
  assert.equal(h.replacedStatus, 'Out');
});

test('a player who was on another team this season is a trade', () => {
  assert.deepEqual(hist('Moved Guard'), { tag: 'trade', from: 'MIA' });
});

test('unknown players and teams give no tag', () => {
  assert.equal(hist('Nobody Here'), null);
  assert.equal(starterHistory(teams, 'KC', { name: 'Dee Tackle', skipped: [] }), null);
});

test('team codes come from nicknames', () => {
  assert.equal(teamCode('Los Angeles Rams'), 'LA');
  assert.equal(teamCode('San Francisco 49ers'), 'SF');
});

test('back means returning this week: he sat out the team’s last game', () => {
  const t = parseSnaps(csv([
    [1, 'Star Back', 'sb', 'RB', 'PHI', 0.71, 0], [2, 'Star Back', 'sb', 'RB', 'PHI', 0.72, 0], [3, 'Star Back', 'sb', 'RB', 'PHI', 0.07, 0],
    [1, 'Late Back', 'lb', 'WR', 'PHI', 0.9, 0], [2, 'Late Back', 'lb', 'WR', 'PHI', 0.9, 0], [5, 'Late Back', 'lb', 'WR', 'PHI', 0.9, 0],
    [4, 'Other', 'o', 'QB', 'PHI', 1, 0], [5, 'Other', 'o', 'QB', 'PHI', 1, 0], [6, 'Other', 'o', 'QB', 'PHI', 1, 0],
  ]));
  const h = starterHistory(t, 'PHI', { name: 'Star Back', skipped: [] });
  assert.equal(h.tag, 'back');
  assert.deepEqual(h.missed, [4, 5, 6]);
  assert.deepEqual(starterHistory(t, 'PHI', { name: 'Late Back', skipped: [] }).missed, [6]);
});

test('each lost job goes to only one replacement', () => {
  const taken = new Set();
  const first = starterHistory(teams, 'BUF', { name: 'Rookie Corner', skipped: [] }, { roster: ['Old Corner'], taken });
  assert.equal(first.replaced, 'Old Corner');
  assert.ok(taken.has('Old Corner'));
  const again = starterHistory(teams, 'BUF', { name: 'Rookie Corner', skipped: [] }, { roster: ['Old Corner'], taken });
  assert.equal(again.tag, 'new');
});

test('the next man up is the healthy player with the most snaps all season', () => {
  const t = parseSnaps(csv([
    [1, 'Lead Back', 'lb', 'RB', 'DEN', 0.7, 0], [2, 'Lead Back', 'lb', 'RB', 'DEN', 0.7, 0],
    [1, 'Hurt Back', 'hb', 'RB', 'DEN', 0.5, 0], [2, 'Hurt Back', 'hb', 'RB', 'DEN', 0.5, 0],
    [1, 'Cut Back', 'cb', 'RB', 'DEN', 0.45, 0], [2, 'Cut Back', 'cb', 'RB', 'DEN', 0.45, 0],
    [1, 'Third Back', 'tb', 'RB', 'DEN', 0.2, 0], [2, 'Third Back', 'tb', 'RB', 'DEN', 0.4, 0],
    [1, 'Full Back', 'fb', 'FB', 'DEN', 0.9, 0], [2, 'Full Back', 'fb', 'FB', 'DEN', 0.9, 0],
  ]));
  const pick = nextUp(t, 'DEN', ['RB'], {
    exclude: ['Lead Back'], injuries: new Map([['Hurt Back', 'Out']]), roster: ['Lead Back', 'Hurt Back', 'Third Back', 'Full Back'],
  });
  assert.equal(pick.name, 'Third Back');
  assert.equal(pick.season, 30);
  assert.deepEqual(pick.skipped, [{ name: 'Hurt Back', status: 'Out' }]);
  assert.equal(nextUp(t, 'KC', ['RB']), null);
});

test('a starter who missed the opener is not filling in for someone he started next to', () => {
  const t = parseSnaps(csv([
    ...[1, 2, 3, 4, 5].map((w) => [w, 'Hurt Teammate', 'ht', 'DE', 'LA', 0, 0.65]),
    ...[2, 3, 4, 5, 6].map((w) => [w, 'Late Starter', 'ls', 'DE', 'LA', 0, 0.6]),
    [6, 'Filler', 'f', 'DE', 'LA', 0, 0.1],
  ]));
  const h = starterHistory(t, 'LA', { name: 'Late Starter', skipped: [] }, { injuries: new Map([['Hurt Teammate', 'Injured Reserve']]) });
  assert.equal(h.tag, 'week1');
  assert.deepEqual(h.missed, [1]);
});

test('usual share uses last season for someone who has barely played this year', () => {
  const now = parseSnaps(csv([[1, 'Star End', 'se', 'LB', 'LA', 0, 0.62], [1, 'Regular', 'r', 'DE', 'LA', 0, 0.5], [2, 'Regular', 'r', 'DE', 'LA', 0, 0.7]]));
  const last = parseSnaps(csv([[1, 'Star End', 'se', 'DE', 'CLE', 0, 0.8], [2, 'Star End', 'se', 'DE', 'CLE', 0, 0.84], [1, 'Regular', 'r', 'DE', 'LA', 0, 0.2]]));
  assert.equal(usualShare(now, last, 'LA', 'Star End').toFixed(2), '0.82');
  assert.equal(usualShare(now, last, 'LA', 'Regular'), 0.6);
  assert.equal(usualShare(now, last, 'LA', 'Nobody'), null);
});

test('games played this season, for telling who was hurt before Week 1', () => {
  const t = parseSnaps(csv([[1, 'Played Once', 'po', 'RB', 'ARI', 0.6, 0], [2, 'Every Game', 'eg', 'RB', 'ARI', 0.5, 0], [1, 'Every Game', 'eg', 'RB', 'ARI', 0.5, 0]]));
  assert.equal(gamesPlayed(t, 'ARI', 'Played Once'), 1);
  assert.equal(gamesPlayed(t, 'ARI', 'Every Game'), 2);
  assert.equal(gamesPlayed(t, 'ARI', 'Out All Year'), 0);
});

test('out-snapped: a hurt player who started while the newer starter sat ranks ahead of him', () => {
  const t = parseSnaps(csv([
    [1, 'Rookie Starter', 'rs', 'WR', 'SF', 0.32, 0],
    [1, 'Vet Receiver', 'vr', 'WR', 'SF', 0.63, 0], [2, 'Vet Receiver', 'vr', 'WR', 'SF', 0.31, 0],
    [3, 'Late Bloomer', 'lb', 'WR', 'SF', 0.28, 0], [4, 'Late Bloomer', 'lb', 'WR', 'SF', 0.76, 0],
    [1, 'Hurt Starter', 'hs', 'WR', 'SF', 0.7, 0], [3, 'Hurt Starter', 'hs', 'WR', 'SF', 0.7, 0],
    [1, 'Was Hurt', 'wh', 'WR', 'SF', 0.6, 0], [2, 'Was Hurt', 'wh', 'WR', 'SF', 0.6, 0], [4, 'Was Hurt', 'wh', 'WR', 'SF', 0.6, 0],
  ]));
  assert.equal(outsnapped(t, 'SF', 'Rookie Starter', 'Late Bloomer'), true);
  assert.equal(outsnapped(t, 'SF', 'Vet Receiver', 'Late Bloomer'), true);
  assert.equal(outsnapped(t, 'SF', 'Late Bloomer', 'Rookie Starter'), false);
  // Week 3, after Was Hurt had started playing, doesn't count against him.
  assert.equal(outsnapped(t, 'SF', 'Hurt Starter', 'Was Hurt'), false);
  assert.deepEqual(lastSeason(null, 'SF', 'Rookie Starter'), null);
});

test('out-snapped: never for linemen who both start, or over a regular back from injury', () => {
  const t = parseSnaps(csv([
    [1, 'Star Tackle', 'st', 'T', 'BAL', 1, 0], [2, 'Star Tackle', 'st', 'T', 'BAL', 0.79, 0],
    [1, 'Hurt Guard', 'hg', 'G', 'BAL', 1, 0], [2, 'Hurt Guard', 'hg', 'G', 'BAL', 1, 0],
    [1, 'Rookie Back', 'rb', 'RB', 'BAL', 0.48, 0], [2, 'Rookie Back', 'rb', 'RB', 'BAL', 0.4, 0],
  ]));
  assert.equal(outsnapped(t, 'BAL', 'Hurt Guard', 'Star Tackle'), false);
  // Hasn't played this year, but was a regular last season: he was hurt.
  assert.equal(outsnapped(t, 'BAL', 'Rookie Back', 'Healed Runner', 0.5), false);
  assert.equal(outsnapped(t, 'BAL', 'Rookie Back', 'Healed Runner', 0.1), true);
});

test('usual share follows a traded player to his old team, by exact name', () => {
  const now = parseSnaps(csv([
    [1, 'Jeffery Simmons', 'js', 'DT', 'TEN', 0, 0.86], [2, 'Jeffery Simmons', 'js', 'DT', 'TEN', 0, 0.88],
    [1, 'Justin Simmons', 'jus', 'S', 'ATL', 0, 0.9],
  ]));
  assert.equal(usualShare(now, null, 'CHI', 'Jeffery Simmons'), 0.87);
  assert.equal(lastSeason(now, 'CHI', 'Jeffery Simmons').games, 2);
});

test('a clear starter last season who left the opener hurt and took the job back is not a fill-in', () => {
  const t = parseSnaps(csv([
    [1, 'Old Starter', 'os', 'QB', 'SEA', 0.1, 0], [3, 'Old Starter', 'os', 'QB', 'SEA', 1, 0], [4, 'Old Starter', 'os', 'QB', 'SEA', 1, 0],
    [1, 'Spot Starter', 'ss', 'QB', 'SEA', 0.9, 0], [2, 'Spot Starter', 'ss', 'QB', 'SEA', 1, 0],
  ]));
  const slot = { name: 'Old Starter', skipped: [] };
  const h = starterHistory(t, 'SEA', slot, { proven: (n) => n === 'Old Starter' });
  assert.equal(h.tag, 'week1');
  assert.deepEqual(h.missed, [1, 2]);
  // Without last season to go on, he looks like the backup taking over.
  assert.notEqual(starterHistory(t, 'SEA', slot).tag, 'week1');
});

test('a starter traded in and eased in on light snaps is a trade, not a part-timer or fill-in', () => {
  const t = parseSnaps(csv([
    // Starter for Arizona Weeks 1-3, traded to Houston, 20% there Weeks 4-5.
    [1, 'Star Wideout', 'sw', 'WR', 'ARI', 0.9, 0], [2, 'Star Wideout', 'sw', 'WR', 'ARI', 0.85, 0], [3, 'Star Wideout', 'sw', 'WR', 'ARI', 0.9, 0],
    [4, 'Star Wideout', 'sw', 'WR', 'HOU', 0.2, 0], [5, 'Star Wideout', 'sw', 'WR', 'HOU', 0.2, 0],
    // Houston's receiver who's now hurt: more snaps than him there.
    [1, 'Hurt Wideout', 'hw', 'WR', 'HOU', 0.7, 0], [2, 'Hurt Wideout', 'hw', 'WR', 'HOU', 0.7, 0], [3, 'Hurt Wideout', 'hw', 'WR', 'HOU', 0.7, 0],
    [4, 'Hurt Wideout', 'hw', 'WR', 'HOU', 0.7, 0], [5, 'Hurt Wideout', 'hw', 'WR', 'HOU', 0.7, 0],
  ]));
  const h = starterHistory(t, 'HOU', { name: 'Star Wideout', skipped: [] });
  assert.equal(h.tag, 'trade');
  assert.equal(h.from, 'ARI');
  assert.equal(h.since, 4);
  assert.deepEqual(h.timeline.map((w) => w.pct), [90, 85, 90, 20, 20]);
  assert.ok(Math.abs(usualShare(t, null, 'HOU', 'Star Wideout') - (0.9 + 0.85 + 0.9) / 3) < 1e-9);
  assert.equal(outsnapped(t, 'HOU', 'Hurt Wideout', 'Star Wideout'), false);
});

test('nobody out-snaps a player traded in who hasn\'t played for his new team yet', () => {
  const t = parseSnaps(csv([
    [1, 'New Nickel', 'nn', 'CB', 'LAC', 0, 0.7], [2, 'New Nickel', 'nn', 'CB', 'LAC', 0, 0.65],
    [1, 'Hurt Corner', 'hc', 'CB', 'NYG', 0, 0.34], [2, 'Hurt Corner', 'hc', 'CB', 'NYG', 0, 0.34],
  ]));
  assert.equal(outsnapped(t, 'NYG', 'Hurt Corner', 'New Nickel'), false);
});
